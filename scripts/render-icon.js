// Renders the app icon (build/icon.png, 1024×1024) from the SVG below.
// Run with: npx electron scripts/render-icon.js [out.png]
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 1024;
const f = (v) => v.toFixed(2);

// Apple's continuous-curvature rounded rect (the macOS icon "squircle"): each corner is three
// cubics whose curvature ramps in from the straight edge instead of jumping like an arc does.
function squircle(x, y, w, h, r) {
  const [a, b, c, d, e, g, k] = [1.528665, 1.088493, 0.868407, 0.631493, 0.074911, 0.372824, 0.16906].map((v) => v * r);
  const X = x + w;
  const Y = y + h;
  return `M${f(x + a)} ${f(y)}H${f(X - a)}`
    + `C${f(X - b)} ${f(y)} ${f(X - c)} ${f(y)} ${f(X - d)} ${f(y + e)}`
    + `C${f(X - g)} ${f(y + k)} ${f(X - k)} ${f(y + g)} ${f(X - e)} ${f(y + d)}`
    + `C${f(X)} ${f(y + c)} ${f(X)} ${f(y + b)} ${f(X)} ${f(y + a)}V${f(Y - a)}`
    + `C${f(X)} ${f(Y - b)} ${f(X)} ${f(Y - c)} ${f(X - e)} ${f(Y - d)}`
    + `C${f(X - k)} ${f(Y - g)} ${f(X - g)} ${f(Y - k)} ${f(X - d)} ${f(Y - e)}`
    + `C${f(X - c)} ${f(Y)} ${f(X - b)} ${f(Y)} ${f(X - a)} ${f(Y)}H${f(x + a)}`
    + `C${f(x + b)} ${f(Y)} ${f(x + c)} ${f(Y)} ${f(x + d)} ${f(Y - e)}`
    + `C${f(x + g)} ${f(Y - k)} ${f(x + k)} ${f(Y - g)} ${f(x + e)} ${f(Y - d)}`
    + `C${f(x)} ${f(Y - c)} ${f(x)} ${f(Y - b)} ${f(x)} ${f(Y - a)}V${f(y + a)}`
    + `C${f(x)} ${f(y + b)} ${f(x)} ${f(y + c)} ${f(x + e)} ${f(y + d)}`
    + `C${f(x + k)} ${f(y + g)} ${f(x + g)} ${f(y + k)} ${f(x + d)} ${f(y + e)}`
    + `C${f(x + c)} ${f(y)} ${f(x + b)} ${f(y)} ${f(x + a)} ${f(y)}Z`;
}

// The hop: a quadratic arc from bottom-left, over the top, landing bottom-right.
const P0 = [150, 830];
const P1 = [470, 70];
const P2 = [840, 760];
const arcAt = (t) => [0, 1].map((i) => (1 - t) ** 2 * P0[i] + 2 * (1 - t) * t * P1[i] + t * t * P2[i]);
const arcTangent = (t) => [0, 1].map((i) => 2 * (1 - t) * (P1[i] - P0[i]) + 2 * t * (P2[i] - P1[i]));

// Comet trail: a filled ribbon along the arc that swells from a hairline to full width.
function trailPath(t1, w0, w1, ease) {
  const left = [];
  const right = [];
  for (let i = 0; i <= 120; i++) {
    const u = i / 120;
    const [x, y] = arcAt(t1 * u);
    const [dx, dy] = arcTangent(t1 * u);
    const len = Math.hypot(dx, dy);
    const half = (w0 + (w1 - w0) * u ** ease) / 2;
    left.push(`${f(x - (dy / len) * half)} ${f(y + (dx / len) * half)}`);
    right.unshift(`${f(x + (dy / len) * half)} ${f(y - (dx / len) * half)}`);
  }
  return `M${left.join('L')}A${w1 / 2} ${w1 / 2} 0 0 1 ${right.join('L')}Z`;
}

const body = squircle(100, 100, 824, 824, 185);
const trail = trailPath(0.43, 2, 104, 1.3);
const trailEnd = arcAt(0.43);

// The file, centred near the top of the hop and tipped forward in the direction of travel.
const W = 268, H = 332, FOLD = 86, R = 32, CX = 508, CY = 432;
const DX = CX - W / 2, DY = CY - H / 2;
const doc = `M${DX + R} ${DY}H${DX + W - FOLD}L${DX + W} ${DY + FOLD}V${DY + H - R}a${R} ${R} 0 0 1 -${R} ${R}`
  + `H${DX + R}a${R} ${R} 0 0 1 -${R} -${R}V${DY + R}a${R} ${R} 0 0 1 ${R} -${R}Z`;
const fold = `M${DX + W - FOLD} ${DY}V${DY + FOLD - 26}a26 26 0 0 0 26 26H${DX + W}Z`;
const tilt = `rotate(9 ${CX} ${CY})`;
const lines = [180, 180, 112].map((w, i) =>
  `<rect x="${DX + 54}" y="${DY + 168 + i * 56}" width="${w}" height="24" rx="12" fill="url(#line)"/>`).join('');

// The rest of the hop still to come, as fading dots towards the landing spot.
const dots = [0, 1, 2, 3, 4, 5].map((i) => {
  const [x, y] = arcAt(0.68 + i * 0.062);
  return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(15 - i * 1.6)}" fill="#fff" opacity="${f(0.9 - i * 0.13)}"/>`;
}).join('');

// Backdrop: the gradient plus two big blurred colour pools. Drawn twice: once as the
// background and once blurred behind the file, which is what makes the file read as frosted glass.
const backdrop = `<path d="${body}" fill="url(#bg)"/>
    <circle cx="220" cy="200" r="260" fill="#c86bff" opacity="0.45" filter="url(#pool)"/>
    <circle cx="840" cy="860" r="300" fill="#2ee6ff" opacity="0.5" filter="url(#pool)"/>`;

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024">
  <defs>
    <clipPath id="bodyClip"><path d="${body}"/></clipPath>
    <clipPath id="docClip"><path d="${doc}" transform="${tilt}"/></clipPath>
    <clipPath id="docClipLocal"><path d="${doc}"/></clipPath>
    <!-- Apple's icon shadow: a soft ambient drop plus a tight contact shadow -->
    <filter id="iconShadow" x="-20%" y="-20%" width="140%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="14"/>
      <feOffset dy="14"/>
      <feComponentTransfer result="ambient"><feFuncA type="linear" slope="0.3"/></feComponentTransfer>
      <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>
      <feOffset dy="3"/>
      <feComponentTransfer result="contact"><feFuncA type="linear" slope="0.18"/></feComponentTransfer>
      <feMerge><feMergeNode in="ambient"/><feMergeNode in="contact"/></feMerge>
    </filter>
    <filter id="pool" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="70"/></filter>
    <filter id="frost" x="0" y="0" width="100%" height="100%"><feGaussianBlur stdDeviation="30"/></filter>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="22"/></filter>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"/></filter>
    <filter id="docShadow" x="-40%" y="-40%" width="180%" height="190%">
      <feDropShadow dx="0" dy="30" stdDeviation="30" flood-color="#160a6e" flood-opacity="0.45"/>
    </filter>
    <linearGradient id="bg" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0" stop-color="#6b5bff"/>
      <stop offset="0.5" stop-color="#2d6cff"/>
      <stop offset="1" stop-color="#139dff"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.18"/>
      <stop offset="0.45" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.55"/>
      <stop offset="0.3" stop-color="#fff" stop-opacity="0.08"/>
      <stop offset="0.75" stop-color="#fff" stop-opacity="0.03"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.25"/>
    </linearGradient>
    <linearGradient id="trail" gradientUnits="userSpaceOnUse" x1="${P0[0]}" y1="${P0[1]}" x2="${f(trailEnd[0])}" y2="${f(trailEnd[1])}">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.4" stop-color="#e8fbff" stop-opacity="0.55"/>
      <stop offset="0.75" stop-color="#fff" stop-opacity="0.95"/>
      <stop offset="1" stop-color="#fff"/>
    </linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.98"/>
      <stop offset="0.6" stop-color="#f5f8ff" stop-opacity="0.84"/>
      <stop offset="1" stop-color="#e2ecff" stop-opacity="0.7"/>
    </linearGradient>
    <linearGradient id="refract" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.55" stop-color="#7fe8ff" stop-opacity="0"/>
      <stop offset="1" stop-color="#7fe8ff" stop-opacity="0.35"/>
    </linearGradient>
    <linearGradient id="glassRim" x1="0" y1="0" x2="0.5" y2="1">
      <stop offset="0" stop-color="#fff"/>
      <stop offset="0.45" stop-color="#fff" stop-opacity="0.25"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0.95"/>
    </linearGradient>
    <linearGradient id="fold" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#c3d0ff"/>
      <stop offset="1" stop-color="#fff"/>
    </linearGradient>
    <linearGradient id="line" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#5b6cff"/>
      <stop offset="1" stop-color="#2a9dff"/>
    </linearGradient>
  </defs>
  <path d="${body}" fill="#000" filter="url(#iconShadow)"/>
  <g clip-path="url(#bodyClip)">
    ${backdrop}
    <path d="${body}" fill="url(#sheen)"/>
    <path d="${trail}" fill="#a9f0ff" filter="url(#glow)" opacity="0.9"/>
    <path d="${trail}" fill="url(#trail)"/>
    ${dots}
    <g filter="url(#docShadow)"><path d="${doc}" transform="${tilt}" fill="#fff"/></g>
    <g clip-path="url(#docClip)"><g filter="url(#frost)">${backdrop}<path d="${trail}" fill="#fff"/></g></g>
    <g transform="${tilt}">
      <path d="${doc}" fill="url(#glass)"/>
      <path d="${fold}" fill="url(#fold)"/>
      ${lines}
      <path d="${doc}" fill="url(#refract)"/>
      <path d="${doc}" fill="none" stroke="#fff" stroke-width="26" opacity="0.55" filter="url(#soft)" clip-path="url(#docClipLocal)"/>
      <path d="${doc}" fill="none" stroke="url(#glassRim)" stroke-width="6"/>
    </g>
    <path d="${body}" fill="none" stroke="url(#rim)" stroke-width="5"/>
  </g>
</svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  await win.loadURL(`data:text/html,${encodeURIComponent(`<body style="margin:0;background:transparent">${svg}</body>`)}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const image = (await win.webContents.capturePage()).resize({ width: SIZE, height: SIZE, quality: 'best' });
  const out = path.resolve(process.argv.slice(2).find((arg) => arg.endsWith('.png')) || path.join(__dirname, '..', 'build', 'icon.png'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.toPNG());
  console.log(`wrote ${out}`);
  app.quit();
});
