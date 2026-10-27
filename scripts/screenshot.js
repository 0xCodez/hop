// Captures the renderer UI (with demo data) to a PNG, for checking the design without
// clicking through the real app.
//
//   npx electron scripts/screenshot.js <out.png> [query] [delayMs] [theme] [width] [height]
//
//   query   URL query for index.html, e.g. "demo=offer&platform=darwin" (default "demo=static")
//   delayMs how long to wait before capturing, to catch an animation mid-way (default 1500)
//   theme   light | dark (default light)
//
// Any page HTML file can be captured instead of the app UI by passing a path ending in .html
// as the query, e.g. "site/index.html".
const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [out = 'shot.png', query = 'demo=static', delay = '1500', theme = 'light', width = '480', height = '660'] =
  process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  nativeTheme.themeSource = theme === 'dark' ? 'dark' : 'light';
  const win = new BrowserWindow({
    width: Number(width),
    height: Number(height),
    show: false,
    webPreferences: { offscreen: true },
  });
  const root = path.join(__dirname, '..');
  if (query.endsWith('.html')) {
    await win.loadFile(path.join(root, query));
  } else {
    await win.loadFile(path.join(root, 'src/renderer/index.html'), { search: query });
  }
  await new Promise((resolve) => setTimeout(resolve, Number(delay)));
  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, image.toPNG());
  console.log(`wrote ${path.resolve(out)}`);
  app.quit();
});
