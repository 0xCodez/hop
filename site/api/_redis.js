// Tiny Redis client for the analytics: Upstash REST pipeline when connected
// (env vars are added automatically when Upstash is linked to the Vercel project),
// otherwise an in-memory stand-in so local dev and a not-yet-connected deploy still work.
// The leading underscore keeps Vercel from serving this file as a route.

// Vercel names the vars KV_REST_API_URL, or <PREFIX>_KV_REST_API_URL when a custom prefix is chosen on Connect.
const env = (suffix, fallback) =>
  process.env[suffix] || process.env[fallback] || Object.entries(process.env).find(([k]) => k.endsWith(`_${suffix}`))?.[1];
const URL_ = env('KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL');
const TOKEN = env('KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN');

export const connected = Boolean(URL_ && TOKEN);
export const secret = process.env.ANALYTICS_SALT || TOKEN || 'hop-dev';

// Every key lives under "hop:" so the analytics can share one database with your other projects.
const NS = 'hop:';
const MULTI_KEY = new Set(['PFCOUNT']);
const scoped = ([cmd, ...args]) =>
  MULTI_KEY.has(cmd.toUpperCase()) ? [cmd, ...args.map((k) => NS + k)] : [cmd, NS + args[0], ...args.slice(1)];

// Run several commands in one round trip; returns each command's result in order.
export async function pipeline(cmds) {
  if (!cmds.length) return [];
  cmds = cmds.map(scoped);
  if (!connected) return cmds.map(memory);
  const res = await fetch(`${URL_}/pipeline`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmds),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  return (await res.json()).map((r) => r.result);
}

// ---- in-memory fallback: only the commands the analytics use
const mem = new Map();
const get = (k, make) => {
  if (!mem.has(k)) mem.set(k, make());
  return mem.get(k);
};

function memory([cmd, key, ...a]) {
  switch (cmd.toUpperCase()) {
    case 'INCR': {
      const v = (+mem.get(key) || 0) + 1;
      mem.set(key, v);
      return v;
    }
    case 'GET':
      return mem.has(key) ? String(mem.get(key)) : null;
    case 'EXPIRE':
      return 1;
    case 'PFADD': {
      const s = get(key, () => new Set());
      const n = s.size;
      a.forEach((x) => s.add(x));
      return s.size > n ? 1 : 0;
    }
    case 'PFCOUNT': {
      const u = new Set();
      [key, ...a].forEach((k) => (mem.get(k) || []).forEach((x) => u.add(x)));
      return u.size;
    }
    case 'HINCRBY': {
      const h = get(key, () => new Map());
      const v = (h.get(a[0]) || 0) + +a[1];
      h.set(a[0], v);
      return v;
    }
    case 'HGETALL':
      return [...(mem.get(key) || new Map())].flatMap(([f, v]) => [f, String(v)]);
    case 'ZADD': {
      const z = get(key, () => new Map());
      z.set(a[1], +a[0]);
      return 1;
    }
    case 'ZREMRANGEBYSCORE': {
      const z = mem.get(key);
      if (!z) return 0;
      let n = 0;
      for (const [m, s] of z) {
        if (s >= +a[0] && s <= +a[1]) {
          z.delete(m);
          n++;
        }
      }
      return n;
    }
    case 'ZCOUNT': {
      const z = mem.get(key);
      if (!z) return 0;
      const max = a[1] === '+inf' ? Infinity : +a[1];
      return [...z.values()].filter((s) => s >= +a[0] && s <= max).length;
    }
    default:
      throw new Error(`memory store: ${cmd} not supported`);
  }
}

export const day = (d = new Date()) => d.toISOString().slice(0, 10);

// Vercel parses the body for us; the local dev server hands over the raw stream.
export async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 4000) break;
  }
  return s;
}

export function sendJson(res, body, cacheControl, status = 200) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cacheControl);
  res.statusCode = status;
  res.end(JSON.stringify(body));
}
