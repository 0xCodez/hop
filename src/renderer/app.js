const api = window.hop;
const params = new URLSearchParams(location.search);
document.body.classList.add(`platform-${params.get('platform') || 'web'}`, `material-${params.get('material') || 'none'}`);

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'),
  peers: $('peers'),
  meAvatar: $('meAvatar'),
  meName: $('meName'),
  meNameInput: $('meNameInput'),
  hint: $('hint'),
  hintTitle: $('hintTitle'),
  hintSub: $('hintSub'),
  sheets: $('sheets'),
  openDownloads: $('openDownloads'),
  changeDir: $('changeDir'),
  forgetTrusted: $('forgetTrusted'),
  trustedDot: $('trustedDot'),
  dropLabel: $('dropLabel'),
};

const RING_LENGTH = 295.31; // 2π·47, matches the ring's circle radius

const glyphs = {
  laptop:
    '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M5 6.2A1.7 1.7 0 0 1 6.7 4.5h10.6A1.7 1.7 0 0 1 19 6.2v8.8H5z"/><path d="M2.6 17.2h18.8l-.5 1.1a1.6 1.6 0 0 1-1.5 1H4.6a1.6 1.6 0 0 1-1.5-1z" fill="currentColor" stroke="none"/></svg>',
  desktop:
    '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><rect x="3" y="4" width="18" height="12.5" rx="1.8"/><path d="M9.5 20h5M12 16.5V20"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
};

const glyphFor = (platform) => (platform === 'darwin' ? glyphs.laptop : glyphs.desktop);

const state = {
  self: null,
  peers: new Map(), // id -> peer
  activity: new Map(), // peerId -> { dir: 'out' | 'in', id, stage, sent, total, result }
  downloadDir: '',
  trustedCount: 0,
  dropTarget: null,
};

// ---------- formatting ----------

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const plural = new Intl.PluralRules('ru-RU');

function formatBytes(bytes) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${number.format(value)} ${units[unit]}`;
}

function pluralize(n, one, few, many) {
  const form = plural.select(n);
  return `${n} ${form === 'one' ? one : form === 'few' ? few : many}`;
}

const files = (n) => pluralize(n, 'файл', 'файла', 'файлов');
const percent = (sent, total) => (total ? Math.floor((sent / total) * 100) : 100);

function shortPath(dir) {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join(' › ');
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

function text(tag, className, value) {
  const node = el(tag, className);
  node.textContent = value;
  return node;
}

// ---------- radar layout ----------

function stageGeometry() {
  const stage = els.stage.getBoundingClientRect();
  const { width } = stage;
  // Cards at the bottom push the radar up instead of covering it.
  const sheetsTop = els.sheets.children.length ? els.sheets.getBoundingClientRect().top : stage.bottom;
  const height = Math.min(stage.height, sheetsTop - stage.top - 12);
  const cy = Math.max(170, height * 0.6);
  // An ellipse: side peers must stay inside the window, peers above can go further out.
  const rx = Math.max(110, Math.min(width / 2 - 64, 200));
  const ry = Math.max(120, Math.min(cy - 76, 200));
  return { width, height, cx: width / 2, cy, rx, ry };
}

// Few peers sit on the upper arc (like AirDrop's "above you" layout); many fill the circle.
function anglesFor(count) {
  if (count === 1) return [-90];
  if (count <= 3) return Array.from({ length: count }, (_, i) => -150 + (120 / (count - 1)) * i);
  return Array.from({ length: count }, (_, i) => -90 + (360 / count) * i);
}

function layout() {
  const { cx, cy, rx, ry } = stageGeometry();
  els.stage.style.setProperty('--cy', `${cy}px`);
  const nodes = [...els.peers.querySelectorAll('.peer:not(.leave)')];
  anglesFor(nodes.length).forEach((deg, i) => {
    const rad = (deg * Math.PI) / 180;
    nodes[i].style.left = `${cx + Math.cos(rad) * rx}px`;
    nodes[i].style.top = `${cy + Math.sin(rad) * ry}px`;
  });
}

// ---------- peers ----------

function peerNode(id) {
  return els.peers.querySelector(`.peer[data-id="${CSS.escape(id)}"]`);
}

function createPeerNode(peer) {
  const node = el('button', 'peer enter');
  node.dataset.id = peer.id;
  node.innerHTML = `
    <div class="avatar ${peer.platform}">
      <svg class="ring" viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="47"/><circle class="bar" cx="50" cy="50" r="47"/></svg>
      ${glyphFor(peer.platform)}
      <span class="badge">${glyphs.check}</span>
    </div>`;
  node.append(text('div', 'name', peer.name), el('div', 'status'));
  node.addEventListener('animationend', () => node.classList.remove('enter'), { once: true });
  node.addEventListener('click', () => onPeerClick(peer.id));
  return node;
}

function renderPeers() {
  const seen = new Set();
  for (const peer of state.peers.values()) {
    seen.add(peer.id);
    let node = peerNode(peer.id);
    if (!node) {
      node = createPeerNode(peer);
      els.peers.append(node);
    }
    node.querySelector('.name').textContent = peer.name;
    node.title = `${peer.name} — ${peer.address}`;
    renderActivity(peer.id);
  }
  for (const node of els.peers.querySelectorAll('.peer:not(.leave)')) {
    if (seen.has(node.dataset.id)) continue;
    node.classList.add('leave');
    node.addEventListener('animationend', () => node.remove(), { once: true });
  }
  layout();
  renderHint();
}

function renderHint() {
  const count = state.peers.size;
  els.hint.classList.toggle('searching', count === 0);
  if (count === 0) {
    els.hintTitle.textContent = 'Ищем устройства рядом';
    els.hintSub.textContent = 'Откройте Hop на другом компьютере в той же сети Wi-Fi';
  } else {
    els.hintTitle.textContent = 'Перетащите файлы на устройство';
    els.hintSub.textContent = 'или нажмите на него, чтобы выбрать файлы';
  }
}

function renderActivity(peerId) {
  const node = peerNode(peerId);
  if (!node) return;
  const act = state.activity.get(peerId);
  const status = node.querySelector('.status');
  const bar = node.querySelector('.ring .bar');
  status.className = 'status';
  node.classList.remove('busy', 'waiting', 'success', 'cancellable');
  bar.style.strokeDashoffset = RING_LENGTH;

  if (!act) {
    status.textContent = '';
    return;
  }
  if (act.result === 'done') {
    node.classList.add('success');
    status.classList.add('green');
    status.textContent = act.dir === 'out' ? 'Отправлено' : 'Получено';
  } else if (act.result === 'declined') {
    status.classList.add('red');
    status.textContent = 'Отклонено';
  } else if (act.result === 'failed') {
    status.classList.add('red');
    status.textContent = 'Не удалось';
  } else if (act.stage === 'waiting') {
    node.classList.add('busy', 'waiting', 'cancellable');
    status.textContent = 'Ожидание ответа';
  } else {
    node.classList.add('busy');
    if (act.dir === 'out') node.classList.add('cancellable');
    status.classList.add('blue');
    const p = percent(act.sent, act.total);
    status.textContent = `${act.dir === 'out' ? 'Отправка' : 'Получение'} · ${p}%`;
    bar.style.strokeDashoffset = RING_LENGTH * (1 - p / 100);
  }
}

function setActivity(peerId, act) {
  clearTimeout(state.activity.get(peerId)?.timer);
  if (act) state.activity.set(peerId, act);
  else state.activity.delete(peerId);
  renderActivity(peerId);
}

// A finished state (sent / declined / failed) lingers for a moment, then clears.
function settleActivity(peerId, result, dir) {
  const act = { ...(state.activity.get(peerId) || {}), dir, result };
  setActivity(peerId, act);
  act.timer = setTimeout(() => {
    if (state.activity.get(peerId) === act) setActivity(peerId, null);
  }, 3500);
}

function busy(peerId) {
  const act = state.activity.get(peerId);
  return act && !act.result;
}

async function onPeerClick(peerId) {
  const act = state.activity.get(peerId);
  if (act && !act.result && act.dir === 'out') {
    api.cancel(act.id);
    return;
  }
  if (busy(peerId)) return;
  const paths = await api.pick();
  if (paths.length) {
    const avatar = peerNode(peerId)?.querySelector('.avatar');
    const from = els.meAvatar.getBoundingClientRect();
    await fly(paths, { x: from.left + from.width / 2, y: from.top + from.height / 2 }, avatar);
    send(peerId, paths);
  }
}

async function send(peerId, paths) {
  setActivity(peerId, { dir: 'out', stage: 'waiting', sent: 0, total: 0 });
  try {
    const id = await api.send(peerId, paths);
    const act = state.activity.get(peerId);
    if (act && !act.result) act.id = act.id || id;
  } catch (err) {
    settleActivity(peerId, 'failed', 'out');
    toast(err.message.replace(/^.*Error: /, ''));
  }
}

// ---------- the "hop" animation ----------

function baseName(p) {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

function extLabel(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1, dot + 4).toUpperCase() : '';
}

// A little card flies from `from` to the target avatar along an arc, then the avatar "gulps" it.
function fly(paths, from, targetAvatar) {
  if (!targetAvatar) return Promise.resolve();
  const name = baseName(paths[0]);
  const flyer = el('div', 'flyer');
  flyer.append(text('div', 'file', paths.length > 1 ? paths.length : extLabel(name)));
  flyer.append(text('span', '', paths.length > 1 ? `${baseName(paths[0])} и ещё ${paths.length - 1}` : name));
  document.body.append(flyer);

  const box = flyer.getBoundingClientRect();
  const to = targetAvatar.getBoundingClientRect();
  const x0 = from.x - box.width / 2;
  const y0 = from.y - box.height / 2;
  const x1 = to.left + to.width / 2 - box.width / 2;
  const y1 = to.top + to.height / 2 - box.height / 2;
  const lift = Math.min(140, 60 + Math.abs(x1 - x0) * 0.4);
  const ctrlX = (x0 + x1) / 2;
  const ctrlY = Math.min(y0, y1) - lift;

  const frames = [];
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease-in-out
    const x = (1 - e) ** 2 * x0 + 2 * (1 - e) * e * ctrlX + e ** 2 * x1;
    const y = (1 - e) ** 2 * y0 + 2 * (1 - e) * e * ctrlY + e ** 2 * y1;
    const scale = 1 - 0.7 * e ** 1.6;
    frames.push({ transform: `translate(${x}px, ${y}px) scale(${scale})`, opacity: t > 0.85 ? (1 - t) / 0.15 : 1 });
  }

  return new Promise((resolve) => {
    const anim = flyer.animate(frames, { duration: 720, easing: 'linear', fill: 'forwards' });
    anim.onfinish = () => {
      flyer.remove();
      targetAvatar.classList.remove('gulp');
      void targetAvatar.offsetWidth; // restart the animation
      targetAvatar.classList.add('gulp');
      resolve();
    };
  });
}

// ---------- drag & drop ----------

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

function soleTarget() {
  return state.peers.size === 1 ? [...state.peers.keys()][0] : null;
}

function updateDropLabel() {
  const target = state.dropTarget || soleTarget();
  if (state.peers.size === 0) els.dropLabel.textContent = 'Нет устройств рядом';
  else if (target) els.dropLabel.textContent = `Отпустите — и файлы улетят на ${state.peers.get(target)?.name}`;
  else els.dropLabel.textContent = 'Наведите на устройство';
}

function setDropTarget(id) {
  if (state.dropTarget === id) return;
  if (state.dropTarget) peerNode(state.dropTarget)?.classList.remove('target');
  state.dropTarget = id;
  if (id) peerNode(id)?.classList.add('target');
  updateDropLabel();
}

function endDrag() {
  dragDepth = 0;
  document.body.classList.remove('dragging');
  setDropTarget(null);
}

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (dragDepth++ === 0) {
    document.body.classList.add('dragging');
    updateDropLabel();
  }
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (!hasFiles(e)) return;
  const peer = document.elementFromPoint(e.clientX, e.clientY)?.closest('.peer:not(.leave)');
  const id = peer?.dataset.id || null;
  e.dataTransfer.dropEffect = id || soleTarget() ? 'copy' : 'none';
  setDropTarget(id && !busy(id) ? id : null);
});

window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) endDrag();
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  const target = state.dropTarget || soleTarget();
  endDrag();
  const paths = [...(e.dataTransfer?.files || [])].map((file) => api.pathForFile(file)).filter(Boolean);
  if (!paths.length) return;
  if (!target) {
    toast(state.peers.size ? 'Отпустите файлы прямо на устройство' : 'Рядом пока нет устройств');
    return;
  }
  if (busy(target)) {
    toast('Подождите, пока закончится текущая передача');
    return;
  }
  const avatar = peerNode(target)?.querySelector('.avatar');
  fly(paths, { x: e.clientX, y: e.clientY }, avatar).then(() => send(target, paths));
});

// ---------- sheets: incoming offers and progress ----------

function sheetHead(from, title, sub) {
  const head = el('div', 'sheet-head');
  head.append(el('div', `avatar ${from.platform || ''}`, glyphFor(from.platform)));
  const body = el('div', 'sheet-text');
  body.append(text('div', 'sheet-title', title));
  const subNode = text('div', 'sheet-sub', sub);
  body.append(subNode);
  head.append(body);
  return { head, subNode };
}

function closeSheet(sheet) {
  if (!sheet.isConnected || sheet.classList.contains('out')) return;
  sheet.classList.add('out');
  sheet.addEventListener('animationend', () => {
    sheet.remove();
    document.body.classList.toggle('has-sheet', els.sheets.children.length > 0);
    layout();
  });
}

function addSheet(sheet) {
  els.sheets.append(sheet);
  document.body.classList.add('has-sheet');
  layout();
  return sheet;
}

function showOffer(offer) {
  const sheet = el('div', 'sheet');
  sheet.dataset.offer = offer.id;
  const what = offer.fileCount === 1 && offer.names.length === 1 ? offer.names[0] : files(offer.fileCount);
  const { head } = sheetHead(offer.from, `${offer.from.name} хочет отправить`, `${what} · ${formatBytes(offer.totalBytes)}`);
  sheet.append(head);

  if (offer.names.length > 1 || offer.fileCount > 1) {
    const chips = el('div', 'chips');
    for (const name of offer.names.slice(0, 6)) chips.append(text('span', 'chip', name));
    if (offer.names.length > 6) chips.append(text('span', 'chip', `ещё ${offer.names.length - 6}`));
    sheet.append(chips);
  }

  const check = el('label', 'check');
  const box = document.createElement('input');
  box.type = 'checkbox';
  check.append(box, document.createTextNode('Всегда принимать с этого устройства'));
  sheet.append(check);

  const actions = el('div', 'actions');
  const decline = text('button', 'btn', 'Отклонить');
  const accept = text('button', 'btn primary', 'Принять');
  actions.append(decline, accept);
  sheet.append(actions);

  decline.addEventListener('click', () => {
    api.replyToOffer(offer.id, false);
    closeSheet(sheet);
  });
  accept.addEventListener('click', () => {
    api.replyToOffer(offer.id, true, box.checked ? { id: offer.from.id, name: offer.from.name } : null);
    if (box.checked) setTrustedCount(state.trustedCount + 1);
    closeSheet(sheet);
  });

  addSheet(sheet);
  accept.focus();
}

const incoming = new Map(); // transfer id -> { sheet, bar, sub }

function showIncoming(e) {
  const sheet = el('div', 'sheet');
  const { head, subNode } = sheetHead(e.from, `Получение от ${e.from.name}`, `${files(e.fileCount)} · ${formatBytes(e.totalBytes)}`);
  const progress = el('div', 'progress', '<span></span>');
  sheet.append(head, progress);
  addSheet(sheet);
  incoming.set(e.id, { sheet, bar: progress.firstChild, sub: subNode, total: e.totalBytes, fileCount: e.fileCount });
}

function finishIncoming(e) {
  const item = incoming.get(e.id);
  incoming.delete(e.id);
  if (!item) return;
  item.sheet.classList.add('done');
  item.bar.style.width = '100%';
  item.sheet.querySelector('.sheet-title').textContent = `Получено от ${e.from.name}`;
  item.sub.textContent = e.fileCount === 1 ? baseName(e.paths[0]) : `${files(e.fileCount)} · ${formatBytes(e.totalBytes)}`;
  const actions = el('div', 'actions');
  const close = text('button', 'btn', 'Готово');
  const show = text('button', 'btn primary', 'Показать в папке');
  actions.append(close, show);
  item.sheet.append(actions);
  close.addEventListener('click', () => closeSheet(item.sheet));
  show.addEventListener('click', () => {
    api.reveal(e.paths[0]);
    closeSheet(item.sheet);
  });
  setTimeout(() => closeSheet(item.sheet), 12000);
}

function failIncoming(e) {
  const item = incoming.get(e.id);
  incoming.delete(e.id);
  if (item) closeSheet(item.sheet);
  toast(`Передача от ${e.from.name} прервалась`);
}

function toast(message) {
  const node = text('div', 'toast', message);
  addSheet(node);
  setTimeout(() => closeSheet(node), 3200);
}

// ---------- events from the main process ----------

function handle(event) {
  switch (event.type) {
    case 'peers': {
      state.peers = new Map(event.peers.map((p) => [p.id, p]));
      renderPeers();
      break;
    }
    case 'send-progress': {
      const act = state.activity.get(event.peerId);
      if (!act || act.result) break;
      Object.assign(act, { id: event.id, stage: event.stage, sent: event.sent, total: event.total });
      renderActivity(event.peerId);
      break;
    }
    case 'send-done':
      settleActivity(event.peerId, 'done', 'out');
      break;
    case 'send-failed':
      if (event.cancelled) setActivity(event.peerId, null);
      else if (event.declined) settleActivity(event.peerId, 'declined', 'out');
      else {
        settleActivity(event.peerId, 'failed', 'out');
        toast(`Не удалось отправить: ${event.error}`);
      }
      break;
    case 'offer':
      showOffer(event.offer);
      break;
    case 'offer-expired': {
      const sheet = els.sheets.querySelector(`[data-offer="${CSS.escape(event.id)}"]`);
      if (sheet) closeSheet(sheet);
      break;
    }
    case 'receive-start':
      showIncoming(event);
      if (state.peers.has(event.from.id)) {
        setActivity(event.from.id, { dir: 'in', id: event.id, stage: 'sending', sent: 0, total: event.totalBytes });
      }
      break;
    case 'receive-progress': {
      const item = incoming.get(event.id);
      if (item) {
        const p = percent(event.sent, event.total);
        item.bar.style.width = `${p}%`;
        item.sub.textContent = `${formatBytes(event.sent)} из ${formatBytes(event.total)} · ${p}%`;
      }
      const act = state.activity.get(event.from.id);
      if (act?.dir === 'in' && !act.result) {
        act.sent = event.sent;
        renderActivity(event.from.id);
      }
      break;
    }
    case 'receive-done': {
      finishIncoming(event);
      const avatar = peerNode(event.from.id)?.querySelector('.avatar');
      if (avatar) {
        const box = avatar.getBoundingClientRect();
        fly(event.paths, { x: box.left + box.width / 2, y: box.top + box.height / 2 }, els.meAvatar);
        settleActivity(event.from.id, 'done', 'in');
      }
      break;
    }
    case 'receive-failed':
      failIncoming(event);
      if (state.activity.get(event.from.id)?.dir === 'in') settleActivity(event.from.id, 'failed', 'in');
      break;
  }
}

// ---------- this device + footer ----------

function renderSelf() {
  els.meAvatar.innerHTML = glyphFor(state.self.platform);
  els.meName.textContent = state.self.name;
}

function startRename() {
  els.meNameInput.value = state.self.name;
  els.meName.hidden = true;
  els.meNameInput.hidden = false;
  els.meNameInput.focus();
  els.meNameInput.select();
}

async function commitRename(save) {
  if (els.meNameInput.hidden) return;
  els.meNameInput.hidden = true;
  els.meName.hidden = false;
  if (save && els.meNameInput.value.trim() && els.meNameInput.value.trim() !== state.self.name) {
    state.self.name = await api.rename(els.meNameInput.value);
    renderSelf();
  }
}

els.meName.addEventListener('click', startRename);
els.meNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') commitRename(true);
  if (e.key === 'Escape') commitRename(false);
});
els.meNameInput.addEventListener('blur', () => commitRename(true));

function renderDownloads() {
  els.openDownloads.textContent = shortPath(state.downloadDir);
  els.openDownloads.title = state.downloadDir;
}

function setTrustedCount(count) {
  state.trustedCount = count;
  els.forgetTrusted.hidden = els.trustedDot.hidden = count === 0;
  els.forgetTrusted.textContent = `Доверенные: ${count} — сбросить`;
}

els.openDownloads.addEventListener('click', () => api.openDownloads());
els.changeDir.addEventListener('click', async () => {
  state.downloadDir = await api.chooseDownloadDir();
  renderDownloads();
});
els.forgetTrusted.addEventListener('click', async () => setTrustedCount(await api.forgetTrusted()));

window.addEventListener('resize', layout);

async function main() {
  const data = await api.init();
  state.self = data.self;
  state.downloadDir = data.downloadDir;
  state.peers = new Map(data.peers.map((p) => [p.id, p]));
  renderSelf();
  renderDownloads();
  setTrustedCount(data.trustedCount);
  renderPeers();
  api.onEvent(handle);
}

main();
