// Live X profile for the "Made by" card: name, avatar, follower count.
// Vercel caches the response on its CDN for an hour, so the upstream APIs
// are hit at most ~24 times a day no matter how much traffic the site gets.
import { sendJson } from './_redis.js';

const HANDLE = '0xMovez';

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; hop-site/1.0)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

// The _normal avatar is 48 px; the card shows it at up to 112 px on retina screens.
const bigAvatar = (url) => (url ? url.replace('_normal.', '_400x400.') : null);

const SOURCES = [
  async () => {
    const { user: u } = await getJson(`https://api.fxtwitter.com/${HANDLE}`);
    return { name: u?.name, followers: u?.followers, avatar: bigAvatar(u?.avatar_url), verified: Boolean(u?.verification?.verified) };
  },
  async () => {
    const d = await getJson(`https://api.vxtwitter.com/${HANDLE}`);
    // vxtwitter doesn't report verification; leave it unknown rather than "not verified".
    return { name: d.name, followers: d.followers_count, avatar: bigAvatar(d.profile_image_url) };
  },
];

export default async function handler(req, res) {
  // fxtwitter occasionally returns a transient 404, so go round the list twice.
  for (const source of [...SOURCES, ...SOURCES]) {
    try {
      const profile = await source();
      if (Number.isFinite(profile.followers)) {
        return sendJson(res, { handle: HANDLE, ...profile }, 'public, s-maxage=3600, stale-while-revalidate=86400');
      }
    } catch {
      // try the next source
    }
  }
  // Don't pin a failure on the CDN for long; the page falls back to its static text.
  sendJson(res, { handle: HANDLE, name: null, followers: null, avatar: null }, 'public, s-maxage=120');
}
