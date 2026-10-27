const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, nativeTheme, shell } = require('electron');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Settings } = require('./settings');
const { Discovery } = require('./discovery');
const { TransferServer, sendFiles } = require('./transfer');

const OFFER_TIMEOUT_MS = 60 * 1000;
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

// HOP_PROFILE=b runs a second, independent copy on the same machine (handy for testing).
const profile = process.env.HOP_PROFILE;
if (profile) app.setPath('userData', path.join(app.getPath('appData'), `Hop-${profile}`));

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
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '../renderer/index.html'), {
    query: { platform: process.platform, material },
  });
  win.once('ready-to-show', () => win.show());

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
      { label: 'Открыть Hop', click: showWindow },
      { label: 'Открыть папку загрузок', click: () => shell.openPath(settings.get('downloadDir')) },
      { type: 'separator' },
      { label: 'Выйти', click: () => app.quit() },
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
    notify(`${offer.from.name} хочет отправить ${offer.fileCount === 1 ? offer.names[0] : `файлов: ${offer.fileCount}`}`);
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
  }));

  ipcMain.handle('hop:send', (_event, peerId, paths) => {
    const peer = discovery.get(peerId);
    if (!peer) throw new Error('Устройство больше не в сети');
    const id = crypto.randomUUID();
    const controller = new AbortController();
    outgoing.set(id, controller);
    sendFiles({
      peer,
      from: selfInfo(),
      paths,
      signal: controller.signal,
      onProgress: (progress) => emit({ type: 'send-progress', id, peerId, ...progress }),
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
      title: 'Выберите, что отправить',
      buttonLabel: 'Отправить',
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
      title: 'Куда сохранять полученные файлы',
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
  settings = new Settings(app.getPath('userData'), {
    name: defaultDeviceName() + (profile ? ` (${profile})` : ''),
    downloadDir: path.join(app.getPath('downloads'), 'Hop'),
  });

  server = new TransferServer({ decide, downloadDir: () => settings.get('downloadDir') });
  const port = await server.start();
  server.on('start', (e) => emit({ type: 'receive-start', ...e }));
  server.on('progress', (e) => emit({ type: 'receive-progress', ...e }));
  server.on('failed', (e) => emit({ type: 'receive-failed', ...e }));
  server.on('done', (e) => {
    emit({ type: 'receive-done', ...e });
    notify(`Получено от ${e.from.name}: ${e.fileCount === 1 ? path.basename(e.paths[0]) : `файлов: ${e.fileCount}`}`);
  });

  discovery = new Discovery({ ...selfInfo(), port });
  discovery.on('change', (peers) => emit({ type: 'peers', peers }));
  discovery.on('error', (err) => console.error('discovery:', err.message));
  discovery.start();

  registerIpc();
  createWindow();
  createTray();
}

if (!profile && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(start);
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
