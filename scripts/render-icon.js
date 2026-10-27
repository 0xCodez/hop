// Renders the app icon (build/icon.png, 1024×1024) from the SVG below.
// Run with: npx electron scripts/render-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 1024;

// macOS-style squircle with the standard 100px margin; a hop arc between two devices.
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6ad4ff"/>
      <stop offset="0.55" stop-color="#1a8cff"/>
      <stop offset="1" stop-color="#0a5ce6"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.32"/>
      <stop offset="0.5" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#001a4d" flood-opacity="0.35"/>
    </filter>
    <filter id="glyph" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#00337a" flood-opacity="0.35"/>
    </filter>
  </defs>
  <g filter="url(#shadow)">
    <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)"/>
  </g>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#shine)"/>
  <g filter="url(#glyph)" fill="#fff" stroke="#fff" stroke-linecap="round" stroke-linejoin="round">
    <!-- dotted hop trail (first 88% of the arc M318 588 Q512 236 706 520), landing in a chevron -->
    <path d="M318 588 Q488.7 278.2 659.4 461" fill="none" stroke-width="50" stroke-dasharray="0 88"/>
    <path d="M672 556 L712 596 L752 556" fill="none" stroke-width="40"/>
    <!-- laptop (Mac) -->
    <rect x="240" y="652" width="156" height="102" rx="14" fill="none" stroke-width="26"/>
    <rect x="212" y="768" width="212" height="22" rx="11" stroke-width="0"/>
    <!-- monitor (PC) -->
    <rect x="628" y="640" width="168" height="114" rx="14" fill="none" stroke-width="26"/>
    <path d="M712 766 V790 M676 792 H748" fill="none" stroke-width="24"/>
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
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.toPNG());
  console.log(`wrote ${out}`);
  app.quit();
});
