// Numbers for /dashboard. Locked behind DASHBOARD_PASSWORD (Vercel env var), sent in a header.
import { timingSafeEqual, createHash } from 'node:crypto';
import { pipeline, connected, day, sendJson } from './_redis.js';

const HASHES = ['pages', 'src', 'cty', 'dev', 'os', 'dl', 'dlw', 'clicks'];
const LIVE_WINDOW = 5 * 60 * 1000;
const RELEASES_URL = 'https://api.github.com/repos/0xCodez/hop/releases?per_page=30';
const RELEASES_TTL = 10 * 60 * 1000;

const same = (a, b) => {
  const h = (s) => createHash('sha256').update(String(s)).digest();
  return timingSafeEqual(h(a), h(b));
};

// Downloads straight from GitHub Releases, which also count people who skip the site.
// Cached per function instance so a busy dashboard stays well under GitHub's 60 req/hour limit.
let releasesCache = { at: 0, data: null };
async function releases() {
  if (releasesCache.data && Date.now() - releasesCache.at < RELEASES_TTL) return releasesCache.data;
  try {
    const res = await fetch(RELEASES_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'hop-dashboard' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`github ${res.status}`);
    const list = await res.json();
    const data = list
      .filter((r) => !r.draft)
      .map((r) => ({
        tag: r.tag_name,
        date: r.published_at,
        assets: Object.fromEntries(
          r.assets
            .map((a) => [a.name.replace(/^Hop-|\.(dmg|exe)$/g, ''), a.download_count])
            .filter(([name]) => /^(mac-arm64|mac-x64|windows-x64)$/.test(name)),
        ),
      }));
    releasesCache = { at: Date.now(), data };
    return data;
  } catch {
    return releasesCache.data; // stale beats nothing; null if GitHub never answered
  }
}

export default async function handler(req, res) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return sendJson(res, { error: 'no-password' }, 'no-store', 503);
  if (!same(req.headers['x-dash-key'] || '', password)) return sendJson(res, { error: 'unauthorized' }, 'no-store', 401);

  const params = new URL(req.url, 'http://x').searchParams;
  const n = Math.min(Math.max(parseInt(params.get('days'), 10) || 30, 1), 90);
  const days = Array.from({ length: n }, (_, i) => day(new Date(Date.now() - (n - 1 - i) * 864e5)));
  const now = Date.now();

  const cmds = [];
  for (const d of days) {
    cmds.push(['GET', `pv:${d}`], ['PFCOUNT', `uv:${d}`], ['PFCOUNT', `dlu:${d}`]);
    for (const h of HASHES) cmds.push(['HGETALL', `${h}:${d}`]);
  }
  cmds.push(['PFCOUNT', ...days.map((d) => `uv:${d}`)]); // unique visitors over the whole range
  cmds.push(['PFCOUNT', ...days.map((d) => `dlu:${d}`)]); // unique downloaders over the whole range
  cmds.push(['ZREMRANGEBYSCORE', 'live', 0, now - LIVE_WINDOW], ['ZCOUNT', 'live', now - LIVE_WINDOW, '+inf']);

  let out;
  let gh;
  try {
    [out, gh] = await Promise.all([pipeline(cmds), releases()]);
  } catch {
    return sendJson(res, { error: 'storage' }, 'no-store', 502);
  }

  const per = 3 + HASHES.length;
  const totals = Object.fromEntries(HASHES.map((h) => [h, {}]));
  const series = days.map((d, i) => {
    const row = out.slice(i * per, i * per + per);
    const byHash = {};
    HASHES.forEach((h, j) => {
      const flat = row[3 + j] || [];
      byHash[h] = {};
      for (let k = 0; k < flat.length; k += 2) {
        byHash[h][flat[k]] = +flat[k + 1];
        totals[h][flat[k]] = (totals[h][flat[k]] || 0) + +flat[k + 1];
      }
    });
    return { d, pv: +row[0] || 0, uv: +row[1] || 0, dlu: +row[2] || 0, dl: byHash.dl };
  });
  const tail = out.slice(days.length * per);
  const top = (o, limit = 50) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

  sendJson(
    res,
    {
      storage: connected ? 'upstash' : 'memory',
      days: n,
      visitors: +tail[0] || 0,
      downloaders: +tail[1] || 0,
      pageviews: series.reduce((s, r) => s + r.pv, 0),
      downloads: Object.values(totals.dl).reduce((s, v) => s + v, 0),
      online: +tail[3] || 0,
      series,
      pages: top(totals.pages),
      sources: top(totals.src),
      countries: top(totals.cty),
      devices: top(totals.dev),
      systems: top(totals.os),
      platforms: top(totals.dl),
      places: top(totals.dlw),
      clicks: top(totals.clicks),
      releases: gh,
    },
    'no-store',
  );
}
