const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { EventEmitter } = require('node:events');

const MAX_OFFER_BYTES = 8 * 1024 * 1024;
const MAX_ITEMS = 50000;
const SESSION_IDLE_MS = 2 * 60 * 1000;
const PROGRESS_INTERVAL_MS = 100;
const SKIPPED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

// ---------- path safety ----------

// Makes one path segment from the other OS safe to create here, or returns null to reject it.
function sanitizeSegment(segment) {
  const clean = segment
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (!clean) return null;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(clean)) return `_${clean}`;
  return clean;
}

// Splits a relative path sent by a peer into safe segments. Rejects anything that could
// escape the download folder ('..', absolute paths, empty names).
function safeSegments(relPath) {
  const parts = String(relPath).split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return null;
  const clean = parts.map(sanitizeSegment);
  return clean.includes(null) ? null : clean;
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// "photo.jpg" -> "photo (1).jpg" when the name is taken, the way Finder and Explorer do it.
async function uniqueName(dir, name) {
  if (!(await exists(path.join(dir, name)))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!(await exists(path.join(dir, candidate)))) return candidate;
  }
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function throttle(fn, ms) {
  let last = 0;
  return (force) => {
    const now = Date.now();
    if (force || now - last >= ms) {
      last = now;
      fn();
    }
  };
}

// ---------- receiving ----------

// HTTP server that receives files from peers.
//
// Flow: POST /offer (metadata, waits for the user to accept) -> PUT /file for each file
// -> the transfer finishes when every file has arrived. POST /cancel aborts it.
//
// Events: 'start', 'progress', 'done', 'failed' — each with the transfer id and sender.
class TransferServer extends EventEmitter {
  // decide(offer) -> Promise<boolean>: ask the user (or the trust list) whether to accept.
  // downloadDir() -> string: where accepted files go.
  constructor({ decide, downloadDir }) {
    super();
    this.decide = decide;
    this.downloadDir = downloadDir;
    this.sessions = new Map();
  }

  start(port = 0) {
    this.server = http.createServer((req, res) => {
      this.route(req, res).catch((err) => {
        if (!res.headersSent) reply(res, 500, { error: err.message });
        else res.destroy();
      });
    });
    // Large files can take a while on slow Wi-Fi; never time out an active upload.
    this.server.requestTimeout = 0;
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '0.0.0.0', () => resolve(this.server.address().port));
    });
  }

  stop() {
    for (const session of this.sessions.values()) this.fail(session, 'Receiver closed');
    this.server?.close();
  }

  async route(req, res) {
    const url = new URL(req.url, 'http://hop');
    if (req.method === 'POST' && url.pathname === '/offer') return this.handleOffer(req, res);
    if (req.method === 'PUT' && url.pathname === '/file') return this.handleFile(req, res, url);
    if (req.method === 'POST' && url.pathname === '/cancel') return this.handleCancel(req, res, url);
    reply(res, 404, { error: 'Not found' });
  }

  async handleOffer(req, res) {
    const body = await readJson(req, MAX_OFFER_BYTES);
    const { transferId, from, items } = body || {};
    if (typeof transferId !== 'string' || !from?.id || !Array.isArray(items) || !items.length || items.length > MAX_ITEMS) {
      return reply(res, 400, { error: 'Bad offer' });
    }
    if (this.sessions.has(transferId)) return reply(res, 409, { error: 'Duplicate transfer' });

    const parsed = [];
    for (const item of items) {
      const segments = safeSegments(item?.path);
      const size = Number(item?.size ?? 0);
      if (!segments || !Number.isSafeInteger(size) || size < 0) return reply(res, 400, { error: 'Bad item' });
      parsed.push({ segments, size: item.dir ? 0 : size, dir: Boolean(item.dir) });
    }

    const files = parsed.filter((item) => !item.dir);
    const offer = {
      id: transferId,
      from: { id: String(from.id), name: String(from.name || 'Unknown').slice(0, 64), platform: from.platform },
      fileCount: files.length,
      totalBytes: files.reduce((sum, item) => sum + item.size, 0),
      // A preview of the top-level names, for the "Accept?" card.
      names: [...new Set(parsed.map((item) => item.segments[0]))].slice(0, 20),
    };

    // If the sender gives up waiting (closes the request), treat it as a decline.
    let senderGone = false;
    res.on('close', () => {
      if (!res.writableEnded) senderGone = true;
    });
    const accepted = await this.decide(offer);
    if (senderGone) return;
    if (!accepted) return reply(res, 403, { accepted: false });

    const root = this.downloadDir();
    await fsp.mkdir(root, { recursive: true });

    // Rename clashing top-level entries once, so a whole folder lands as "Photos (1)".
    const tops = new Map();
    for (const item of parsed) {
      const top = item.segments[0];
      if (!tops.has(top)) tops.set(top, await uniqueName(root, top));
    }
    for (const item of parsed) {
      item.dest = path.join(root, tops.get(item.segments[0]), ...item.segments.slice(1));
      if (!item.dest.startsWith(root + path.sep)) return reply(res, 400, { error: 'Bad path' });
      if (item.dir) await fsp.mkdir(item.dest, { recursive: true });
    }

    const session = {
      ...offer,
      token: crypto.randomBytes(24).toString('hex'),
      items: parsed,
      received: 0,
      done: new Set(),
      paths: [...tops.values()].map((name) => path.join(root, name)),
    };
    session.report = throttle(() => {
      this.emit('progress', { id: session.id, from: session.from, sent: session.received, total: session.totalBytes });
    }, PROGRESS_INTERVAL_MS);
    this.sessions.set(session.id, session);
    this.touch(session);
    this.emit('start', { id: session.id, from: session.from, fileCount: session.fileCount, totalBytes: session.totalBytes });

    reply(res, 200, { accepted: true, token: session.token });
    if (session.fileCount === 0) this.finish(session);
  }

  async handleFile(req, res, url) {
    const session = this.sessions.get(url.searchParams.get('t'));
    if (!session || req.headers['x-hop-token'] !== session.token) return reply(res, 403, { error: 'Unknown transfer' });
    const index = Number(url.searchParams.get('i'));
    const item = session.items[index];
    if (!item || item.dir || session.done.has(index)) return reply(res, 400, { error: 'Bad file index' });

    const partial = `${item.dest}.hop-part`;
    let bytes = 0;
    try {
      await fsp.mkdir(path.dirname(item.dest), { recursive: true });
      req.on('data', (chunk) => {
        bytes += chunk.length;
        session.received += chunk.length;
        this.touch(session);
        session.report();
      });
      await pipeline(req, fs.createWriteStream(partial));
      if (bytes !== item.size) throw new Error('File arrived incomplete');
      await fsp.rename(partial, item.dest);
    } catch (err) {
      await fsp.rm(partial, { force: true });
      this.fail(session, err.message);
      if (!res.headersSent) reply(res, 400, { error: err.message });
      return;
    }

    session.done.add(index);
    reply(res, 200, { ok: true });
    if (session.done.size === session.fileCount) this.finish(session);
  }

  async handleCancel(req, res, url) {
    const session = this.sessions.get(url.searchParams.get('t'));
    if (!session || req.headers['x-hop-token'] !== session.token) return reply(res, 403, { error: 'Unknown transfer' });
    this.fail(session, 'Cancelled by sender');
    reply(res, 200, { ok: true });
  }

  touch(session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => this.fail(session, 'Sender stopped responding'), SESSION_IDLE_MS);
  }

  finish(session) {
    if (!this.sessions.delete(session.id)) return;
    clearTimeout(session.idleTimer);
    session.report(true);
    this.emit('done', {
      id: session.id,
      from: session.from,
      fileCount: session.fileCount,
      totalBytes: session.totalBytes,
      paths: session.paths,
    });
  }

  fail(session, error) {
    if (!this.sessions.delete(session.id)) return;
    clearTimeout(session.idleTimer);
    this.emit('failed', { id: session.id, from: session.from, error });
  }
}

// ---------- sending ----------

// Expands dropped files and folders into a flat list of items with paths relative to
// the dropped entry (always '/'-separated, so Windows and macOS agree).
async function collectItems(paths) {
  const items = [];
  async function visit(abs, rel) {
    const stat = await fsp.stat(abs);
    if (stat.isDirectory()) {
      items.push({ path: rel, dir: true, size: 0 });
      const entries = await fsp.readdir(abs);
      for (const entry of entries.sort()) {
        if (SKIPPED_FILES.has(entry)) continue;
        await visit(path.join(abs, entry), `${rel}/${entry}`);
      }
    } else if (stat.isFile()) {
      items.push({ path: rel, abs, size: stat.size });
    }
  }
  for (const p of paths) await visit(p, path.basename(p));
  return items;
}

function request(peer, { method, urlPath, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: peer.address, port: peer.port, method, path: urlPath, headers, signal },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          let json = {};
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // Non-JSON error body; the status code is enough.
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('error', reject);
    if (body && typeof body.pipe === 'function') {
      body.on('error', (err) => req.destroy(err));
      body.pipe(req);
    } else {
      req.end(body);
    }
  });
}

class DeclinedError extends Error {
  constructor() {
    super('Declined');
    this.code = 'DECLINED';
  }
}

// Sends files and folders to a peer.
// onProgress({ stage: 'waiting' | 'sending', sent, total, fileCount }) is called as it goes.
async function sendFiles({ peer, from, paths, onProgress = () => {}, signal }) {
  const items = await collectItems(paths);
  if (!items.length) throw new Error('Nothing to send');

  const transferId = crypto.randomUUID();
  const fileCount = items.filter((item) => !item.dir).length;
  const total = items.reduce((sum, item) => sum + item.size, 0);
  onProgress({ stage: 'waiting', sent: 0, total, fileCount });

  const offer = await request(peer, {
    method: 'POST',
    urlPath: '/offer',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transferId, from, items: items.map(({ abs, ...item }) => item) }),
    signal,
  });
  if (offer.status === 403) throw new DeclinedError();
  if (offer.status !== 200) throw new Error(offer.json.error || `Peer refused (${offer.status})`);
  const { token } = offer.json;

  let sent = 0;
  const report = throttle(() => onProgress({ stage: 'sending', sent, total, fileCount }), PROGRESS_INTERVAL_MS);
  report(true);

  try {
    for (const [index, item] of items.entries()) {
      if (item.dir) continue;
      const stream = fs.createReadStream(item.abs);
      stream.on('data', (chunk) => {
        sent += chunk.length;
        report();
      });
      const res = await request(peer, {
        method: 'PUT',
        urlPath: `/file?t=${transferId}&i=${index}`,
        headers: { 'x-hop-token': token, 'content-length': item.size, 'content-type': 'application/octet-stream' },
        body: stream,
        signal,
      });
      if (res.status !== 200) throw new Error(res.json.error || `Upload failed (${res.status})`);
    }
  } catch (err) {
    // Tell the receiver to clean up; it may already be gone, so ignore failures.
    request(peer, { method: 'POST', urlPath: `/cancel?t=${transferId}`, headers: { 'x-hop-token': token } }).catch(() => {});
    throw err;
  }

  report(true);
  return { fileCount, total };
}

module.exports = { TransferServer, sendFiles, collectItems, safeSegments, DeclinedError };
