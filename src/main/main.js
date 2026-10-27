const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, nativeTheme, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Settings } = require('./settings');
const { Discovery } = require('./discovery');
const { TransferServer, sendFiles } = require('./transfer');

const OFFER_TIMEOUT_MS = 60 * 1000;
const SHOW_FALLBACK_MS = 4000;
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

// HOP_PROFILE=b runs a second, independent copy on the same machine (handy for testing).
const profile = process.env.HOP_PROFILE;
if (profile) app.setPath('userData', path.join(app.getPath('appData'), `Hop-${profile}`));

// Startup log, so a launch that silently hangs can be diagnosed:
// macOS ~/Library/Logs/Hop/main.log, Windows %APPDATA%\Hop\logs\main.log.
const logFile = path.join(app.getPath('logs'), 'main.log');
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${line}\n`);
  } catch {
    // Logging must never take the app down.
  }
}
process.on('uncaughtException', (err) => log('uncaughtException:', err.stack || err));
process.on('unhandledRejection', (err) => log('unhandledRejection:', err?.stack || err));
log(`launch v${app.getVersion()} ${process.platform} ${process.arch} os=${os.release()} electron=${process.versions.electron}`);

let win = null;
let tray = null;
let quitting = false;
let settings;
let discovery;
let server;
const outgoing = new Map(); // local transfer id -> AbortController
const pendingOffers = new Map(); // offer id -> resolve(accepted)

function defaultDeviceName() {
  if (isMac) {
    try {
      return execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim();
    } catch {
      // Fall through to the hostname.
    }
  }
  return os.hostname().replace(/\.local$/, '');
}

// Native translucency: vibrancy on macOS, acrylic on Windows 11 22H2+, solid elsewhere.
function windowMaterial() {
  if (isMac) return 'vibrancy';
  if (isWindows && Number(os.release().split('.')[2]) >= 22621) return 'acrylic';
  return 'none';
}

function emit(event) {
  win?.webContents.send('hop:event', event);
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function notify(body) {
  if (win?.isFocused() || !Notification.isSupported()) return;
  const n = new Notification({ title: 'Hop', body, silent: false });
  n.on('click', showWindow);
  n.show();
}

// “IMG_2041.HEIC” for a single file, “3 files” otherwise.
function describeFiles(count, firstName) {
  return count === 1 && firstName ? `“${firstName}”` : `${count} ${count === 1 ? 'file' : 'files'}`;
}

const THEMES = ['system', 'light', 'dark'];

// The window chrome the CSS can't reach: Windows caption buttons and the solid fallback background.
function applyThemeToWindow() {
  if (!win) return;
  const dark = nativeTheme.shouldUseDarkColors;
  if (isWindows) win.setTitleBarOverlay({ color: '#00000000', symbolColor: dark ? '#ffffff' : '#1d1d1f', height: 52 });
  if (windowMaterial() === 'none') win.setBackgroundColor(dark ? '#1c1c1e' : '#f5f5f7');
}

function createWindow() {
  const material = windowMaterial();
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 480,
    height: 660,
    minWidth: 400,
    minHeight: 580,
    title: 'Hop',
    show: false,
    icon: path.join(__dirname, '../../build/icon.png'),
    backgroundColor: material === 'none' ? (dark ? '#1c1c1e' : '#f5f5f7') : '#00000000',
    ...(isMac && {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 20 },
      vibrancy: 'under-window',
      visualEffectState: 'active',
    }),
    ...(isWindows && {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#ffffff' : '#1d1d1f', height: 52 },
      ...(material === 'acrylic' && { backgroundMaterial: 'acrylic' }),
    }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  log(`window created, material=${material}`);
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '../renderer/index.html'), {
    query: { platform: process.platform, material },
  });
  win.once('ready-to-show', () => {
    log('ready-to-show');
    win.show();
  });
  // If the renderer never reports ready (GPU or helper trouble), show the window anyway
  // rather than leaving the app running with nothing on screen.
  setTimeout(() => {
    if (win && !win.isVisible()) {
      log('ready-to-show did not fire, showing window anyway');
      win.show();
    }
  }, SHOW_FALLBACK_MS);
  win.webContents.on('did-finish-load', () => log('renderer loaded'));
  win.webContents.on('did-fail-load', (_e, code, desc) => log('renderer failed to load:', code, desc));
  win.webContents.on('render-process-gone', (_e, details) => log('renderer gone:', JSON.stringify(details)));
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') log('renderer console:', event.message);
  });

  // Keep running in the background so the other computer can still send files here.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on('closed', () => {
    win = null;
  });
}

function createTray() {
  // macOS has the Dock icon for this; Windows needs a tray icon once the window is hidden.
  if (!isWindows) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, '../../build/icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Hop');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Hop', click: showWindow },
      { label: 'Show Received Files', click: () => shell.openPath(settings.get('downloadDir')) },
      { type: 'separator' },
      { label: 'Quit Hop', click: () => app.quit() },
    ]),
  );
  tray.on('click', showWindow);
}

// Called by the transfer server for every incoming offer.
function decide(offer) {
  const trusted = settings.get('trusted');
  if (trusted[offer.from.id]) {
    settings.set('trusted', { ...trusted, [offer.from.id]: offer.from.name });
    return Promise.resolve(true);
  }

  if (!win) createWindow();
  emit({ type: 'offer', offer });
  if (!win.isFocused()) {
    win.flashFrame(true);
    notify(`${offer.from.name} would like to share ${describeFiles(offer.fileCount, offer.names[0])}.`);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingOffers.delete(offer.id);
      emit({ type: 'offer-expired', id: offer.id });
      resolve(false);
    }, OFFER_TIMEOUT_MS);
    pendingOffers.set(offer.id, (accepted) => {
      clearTimeout(timer);
      pendingOffers.delete(offer.id);
      resolve(accepted);
    });
  });
}

function selfInfo() {
  return { id: settings.get('id'), name: settings.get('name'), platform: process.platform };
}

function registerIpc() {
  ipcMain.handle('hop:init', () => ({
    self: selfInfo(),
    peers: discovery.list(),
    downloadDir: settings.get('downloadDir'),
    trustedCount: Object.keys(settings.get('trusted')).length,
    theme: settings.get('theme'),
  }));

  // The page's prefers-color-scheme, vibrancy and acrylic all follow nativeTheme.themeSource.
  ipcMain.handle('hop:set-theme', (_event, theme) => {
    if (!THEMES.includes(theme)) return settings.get('theme');
    settings.set('theme', theme);
    nativeTheme.themeSource = theme;
    return theme;
  });

  ipcMain.handle('hop:send', (_event, peerId, paths) => {
    const peer = discovery.get(peerId);
    if (!peer) throw new Error('This device is no longer online.');
    const id = crypto.randomUUID();
    const controller = new AbortController();
    outgoing.set(id, controller);
    sendFiles({
      peer,
      from: selfInfo(),
      paths,
      signal: controller.signal,
      onProgress: (progress) => {
        discovery.touch(peerId);
        emit({ type: 'send-progress', id, peerId, ...progress });
      },
    })
      .then((result) => emit({ type: 'send-done', id, peerId, ...result }))
      .catch((err) =>
        emit({
          type: 'send-failed',
          id,
          peerId,
          declined: err.code === 'DECLINED',
          cancelled: controller.signal.aborted,
          error: err.message,
        }),
      )
      .finally(() => outgoing.delete(id));
    return id;
  });

  ipcMain.handle('hop:cancel', (_event, id) => outgoing.get(id)?.abort());

  ipcMain.handle('hop:offer-reply', (_event, id, accepted, trust) => {
    const resolve = pendingOffers.get(id);
    if (!resolve) return;
    win?.flashFrame(false);
    if (accepted && trust?.id) {
      settings.set('trusted', { ...settings.get('trusted'), [trust.id]: trust.name });
    }
    resolve(Boolean(accepted));
  });

  ipcMain.handle('hop:pick', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose Files to Send',
      buttonLabel: 'Send',
      // Windows can't mix files and folders in one dialog; macOS can.
      properties: ['openFile', 'multiSelections', ...(isMac ? ['openDirectory'] : [])],
    });
    return canceled ? [] : filePaths;
  });

  ipcMain.handle('hop:reveal', (_event, target) => {
    const root = settings.get('downloadDir');
    if (typeof target === 'string' && path.resolve(target).startsWith(root)) shell.showItemInFolder(target);
  });

  ipcMain.handle('hop:open-downloads', () => shell.openPath(settings.get('downloadDir')));

  ipcMain.handle('hop:choose-download-dir', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose Where to Save Received Files',
      buttonLabel: 'Choose',
      defaultPath: settings.get('downloadDir'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!canceled && filePaths[0]) settings.set('downloadDir', filePaths[0]);
    return settings.get('downloadDir');
  });

  ipcMain.handle('hop:rename', (_event, name) => {
    const clean = String(name || '').trim().slice(0, 40);
    if (clean) {
      settings.set('name', clean);
      discovery.update({ name: clean });
    }
    return settings.get('name');
  });

  ipcMain.handle('hop:forget-trusted', () => {
    settings.set('trusted', {});
    return 0;
  });
}

async function start() {
  log('app ready');
  settings = new Settings(app.getPath('userData'), {
    name: defaultDeviceName() + (profile ? ` (${profile})` : ''),
    downloadDir: path.join(app.getPath('downloads'), 'Hop'),
    theme: 'system',
  });
  if (!THEMES.includes(settings.get('theme'))) settings.set('theme', 'system');
  nativeTheme.themeSource = settings.get('theme');
  nativeTheme.on('updated', applyThemeToWindow);

  server = new TransferServer({ decide, downloadDir: () => settings.get('downloadDir') });
  const port = await server.start();
  log(`transfer server on port ${port}`);
  server.on('start', (e) => {
    discovery.touch(e.from.id);
    emit({ type: 'receive-start', ...e });
  });
  server.on('progress', (e) => {
    discovery.touch(e.from.id);
    emit({ type: 'receive-progress', ...e });
  });
  server.on('failed', (e) => emit({ type: 'receive-failed', ...e }));
  server.on('done', (e) => {
    emit({ type: 'receive-done', ...e });
    notify(`${e.from.name} sent you ${describeFiles(e.fileCount, path.basename(e.paths[0]))}.`);
  });

  discovery = new Discovery({ ...selfInfo(), port });
  discovery.on('change', (peers) => emit({ type: 'peers', peers }));
  discovery.on('error', (err) => log('discovery error:', err.message));
  discovery.start();
  log('discovery started');

  registerIpc();
  createWindow();
  createTray();
}

if (!profile && !app.requestSingleInstanceLock()) {
  log('another Hop is already running; handing over to it');
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('child-process-gone', (_e, details) => log('child process gone:', JSON.stringify(details)));
  app.whenReady()
    .then(start)
    .catch((err) => {
      log('startup failed:', err.stack || err);
      dialog.showErrorBox('Hop couldn’t start', String(err.stack || err));
      app.exit(1);
    });
  app.on('activate', showWindow);
  app.on('before-quit', () => {
    quitting = true;
    discovery?.stop();
    server?.stop();
  });
  // The window only hides on close, so this fires on real quits (or if it ever crashes).
  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
}
