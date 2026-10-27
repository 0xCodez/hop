const api = window.hop;
const fx = window.hopFx;
const params = new URLSearchParams(location.search);
document.body.classList.add(`platform-${params.get('platform') || 'web'}`, `material-${params.get('material') || 'none'}`);

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'),
  peers: $('peers'),
  me: $('me'),
  meAvatar: $('meAvatar'),
  meName: $('meName'),
  meNameInput: $('meNameInput'),
  meCaption: $('meCaption'),
  hint: $('hint'),
  hintTitle: $('hintTitle'),
  hintSub: $('hintSub'),
  sheets: $('sheets'),
  openDownloads: $('openDownloads'),
  changeDir: $('changeDir'),
  forgetTrusted: $('forgetTrusted'),
  themeSwitch: $('themeSwitch'),
  trustedDot: $('trustedDot'),
  dropLabel: $('dropLabel'),
};

const RING_LENGTH = 295.31; // 2π·47, matches the ring's circle radius
const FLY_MS = 760;

const glyphs = {
  // The Apple logo, drawn on Apple's own graphite tile.
  darwin:
    '<svg class="logo apple" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>',
  // The Windows 11 logo: four equal panes.
  win32:
    '<svg class="logo windows" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M2 2h9.5v9.5H2zm10.5 0H22v9.5h-9.5zM2 12.5h9.5V22H2zm10.5 0H22V22h-9.5z"/></svg>',
  other:
    '<svg class="logo generic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12.5" rx="1.8"/><path d="M9.5 20h5M12 16.5V20"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
};

const platformClass = (platform) => (platform === 'darwin' || platform === 'win32' ? platform : 'other');
const glyphFor = (platform) => glyphs[platformClass(platform)];

const state = {
  self: null,
  peers: new Map(), // id -> peer
  activity: new Map(), // peerId -> { dir: 'out' | 'in', id, stage, sent, total, result }
  downloadDir: '',
  trustedCount: 0,
  dropTarget: null,
};

// ---------- formatting ----------

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const plural = new Intl.PluralRules('en-US');

// Base 1000, like Finder and the rest of Apple's software.
function formatBytes(bytes) {
  if (bytes < 1000) return `${bytes} ${plural.select(bytes) === 'one' ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${number.format(value)} ${units[unit]}`;
}

const pluralize = (n, one, other) => `${n} ${plural.select(n) === 'one' ? one : other}`;
const files = (n) => pluralize(n, 'file', 'files');
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

function centerOf(node) {
  const box = node.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2, r: box.width / 2 };
}

// ---------- radar layout ----------

function stageGeometry() {
  // Layout boxes, not getBoundingClientRect: the burst briefly scales the stage, and peers
  // must settle where the untransformed stage puts them.
  const width = els.stage.clientWidth;
  const stageTop = els.stage.offsetTop;
  const stageHeight = els.stage.clientHeight;
  // Cards at the bottom push the radar up instead of covering it.
  const sheetsTop = els.sheets.children.length ? els.sheets.offsetTop : stageTop + stageHeight;
  const height = Math.min(stageHeight, sheetsTop - stageTop - 12);
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

const peerAvatar = (id) => peerNode(id)?.querySelector('.avatar');

function createPeerNode(peer) {
  const node = el('button', 'peer enter');
  node.dataset.id = peer.id;
  node.innerHTML = `
    <div class="tile">
      <span class="aura"></span>
      <svg class="ring" viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="47"/><circle class="bar" cx="50" cy="50" r="47"/></svg>
      <div class="avatar ${platformClass(peer.platform)}">${glyphFor(peer.platform)}</div>
      <span class="badge">${glyphs.check}</span>
    </div>`;
  node.append(text('div', 'name', peer.name), el('div', 'status'));
  node.addEventListener('animationend', (e) => e.target === node && node.classList.remove('enter'));
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
    node.addEventListener('animationend', (e) => e.target === node && node.remove());
  }
  layout();
  renderHint();
}

function renderHint() {
  const count = state.peers.size;
  els.hint.classList.toggle('searching', count === 0);
  if (count === 0) {
    els.hintTitle.textContent = 'Looking for nearby devices';
    els.hintSub.textContent = 'Open Hop on another computer on the same Wi‑Fi network.';
  } else {
    els.hintTitle.textContent = 'Drag files onto a device to send them';
    els.hintSub.textContent = 'Or click a device to choose files.';
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
    status.textContent = act.dir === 'out' ? 'Sent' : 'Received';
  } else if (act.result === 'declined') {
    status.classList.add('red');
    status.textContent = 'Declined';
  } else if (act.result === 'failed') {
    status.classList.add('red');
    status.textContent = 'Failed';
  } else if (act.stage === 'waiting') {
    node.classList.add('busy', 'waiting', 'cancellable');
    status.textContent = 'Waiting…';
  } else {
    node.classList.add('busy');
    if (act.dir === 'out') node.classList.add('cancellable');
    status.classList.add('blue');
    const p = percent(act.sent, act.total);
    status.textContent = `${act.dir === 'out' ? 'Sending' : 'Receiving'} · ${p}%`;
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
    await fly(paths, centerOf(els.meAvatar), peerAvatar(peerId), { burst: true });
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

// ---------- the "hop" ----------

function baseName(p) {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

function extLabel(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1, dot + 4).toUpperCase() : '';
}

// The burst: light blooms from the avatar and washes over the window, and everything on
// the radar gives a little as the wave passes through it.
function burstAt(x, y) {
  fx.burst(x, y);
  if (fx.reduced()) return;
  els.stage.style.transformOrigin = `${x - els.stage.offsetLeft}px ${y - els.stage.offsetTop}px`;
  els.stage.animate(
    [{ scale: '1' }, { scale: '0.988', offset: 0.12 }, { scale: '1.01', offset: 0.4 }, { scale: '0.998', offset: 0.72 }, { scale: '1' }],
    { duration: 1150, easing: 'ease-in-out' },
  );
  for (const node of els.stage.querySelectorAll('.peer:not(.leave), .me')) {
    const c = centerOf(node.querySelector('.avatar'));
    const dx = c.x - x;
    const dy = c.y - y;
    const dist = Math.hypot(dx, dy);
    if (dist < 24) {
      node.animate([{ scale: '1' }, { scale: '1.07', offset: 0.3 }, { scale: '0.98', offset: 0.65 }, { scale: '1' }], {
        duration: 650,
        easing: 'ease-out',
      });
      continue;
    }
    const push = Math.max(4, 12 - dist / 50);
    const ux = (dx / dist) * push;
    const uy = (dy / dist) * push;
    node.animate(
      [
        { translate: '0 0', scale: '1' },
        { translate: `${ux}px ${uy}px`, scale: '1.04', offset: 0.28 },
        { translate: `${-ux * 0.35}px ${-uy * 0.35}px`, scale: '0.99', offset: 0.62 },
        { translate: '0 0', scale: '1' },
      ],
      { duration: 760, delay: Math.max(0, fx.arrival(x, y, dist) - 80), easing: 'ease-out' },
    );
  }
}

function burstFrom(avatar) {
  if (!avatar) return;
  const c = centerOf(avatar);
  burstAt(c.x, c.y);
}

function gulp(avatar) {
  avatar.classList.remove('gulp');
  void avatar.offsetWidth; // restart the animation
  avatar.classList.add('gulp');
}

// A little card flies from `from` to the target avatar along an arc, trailing light,
// and the avatar "gulps" it. With `burst`, the hop fires as it lands.
function fly(paths, from, targetAvatar, { burst = false } = {}) {
  if (!targetAvatar) return Promise.resolve();
  const name = baseName(paths[0]);
  const flyer = el('div', 'flyer');
  flyer.append(text('div', 'file', paths.length > 1 ? paths.length : extLabel(name)));
  flyer.append(text('span', '', paths.length > 1 ? `${name} and ${paths.length - 1} more` : name));
  document.body.append(flyer);

  const box = flyer.getBoundingClientRect();
  const to = centerOf(targetAvatar);
  const land = () => {
    flyer.remove();
    // The peer may have left mid-flight; a detached avatar would burst from the corner.
    if (!targetAvatar.isConnected) return;
    gulp(targetAvatar);
    if (burst) burstFrom(targetAvatar);
  };

  if (fx.reduced()) {
    const x = to.x - box.width / 2;
    const y = to.y - box.height / 2 - 40;
    const anim = flyer.animate(
      [
        { transform: `translate(${x}px, ${y}px)`, opacity: 0 },
        { transform: `translate(${x}px, ${y}px)`, opacity: 1, offset: 0.3 },
        { transform: `translate(${x}px, ${y}px)`, opacity: 0 },
      ],
      { duration: 600, fill: 'forwards' },
    );
    return new Promise((resolve) => {
      anim.onfinish = () => {
        land();
        resolve();
      };
    });
  }

  const x0 = from.x;
  const y0 = from.y;
  const x1 = to.x;
  const y1 = to.y;
  const lift = Math.min(140, 60 + Math.abs(x1 - x0) * 0.4);
  const ctrlX = (x0 + x1) / 2;
  const ctrlY = Math.min(y0, y1) - lift;
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  // Centre of the chip at time t (0..1), shared by the chip and its trail.
  const at = (t) => {
    const e = ease(t);
    return {
      x: (1 - e) ** 2 * x0 + 2 * (1 - e) * e * ctrlX + e ** 2 * x1,
      y: (1 - e) ** 2 * y0 + 2 * (1 - e) * e * ctrlY + e ** 2 * y1,
    };
  };

  const frames = [];
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = at(t);
    const scale = 1 - 0.72 * ease(t) ** 1.6;
    frames.push({
      transform: `translate(${p.x - box.width / 2}px, ${p.y - box.height / 2}px) scale(${scale})`,
      opacity: t > 0.86 ? (1 - t) / 0.14 : 1,
    });
  }

  fx.trail(at, FLY_MS);
  return new Promise((resolve) => {
    const anim = flyer.animate(frames, { duration: FLY_MS, easing: 'linear', fill: 'forwards' });
    anim.onfinish = () => {
      land();
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
  if (state.peers.size === 0) els.dropLabel.textContent = 'No devices nearby';
  else if (target) els.dropLabel.textContent = `Release to send to ${state.peers.get(target)?.name}`;
  else els.dropLabel.textContent = 'Drop onto a device';
}

// While dragging, a beam of light joins this device to wherever the files will go.
function updateBridge() {
  const target = document.body.classList.contains('dragging') ? state.dropTarget || soleTarget() : null;
  if (!target || busy(target)) {
    fx.bridge(null);
    return;
  }
  fx.bridge(() => {
    const avatar = peerAvatar(target);
    if (!avatar) return null;
    const box = avatar.closest('.peer').getBoundingClientRect();
    return { a: centerOf(els.meAvatar), b: { ...centerOf(avatar), box } };
  });
}

function setDropTarget(id) {
  if (state.dropTarget === id) return;
  if (state.dropTarget) {
    const old = peerNode(state.dropTarget);
    old?.classList.remove('target');
    old?.querySelector('.tile').style.removeProperty('translate');
  }
  state.dropTarget = id;
  if (id) peerNode(id)?.classList.add('target');
  updateDropLabel();
  updateBridge();
}

// The hovered device leans a little towards the pointer, as if magnetised.
function magnetize(id, e) {
  const tile = peerNode(id)?.querySelector('.tile');
  if (!tile || fx.reduced()) return;
  const c = centerOf(tile);
  const dx = Math.max(-10, Math.min(10, (e.clientX - c.x) * 0.22));
  const dy = Math.max(-10, Math.min(10, (e.clientY - c.y) * 0.22));
  tile.style.translate = `${dx}px ${dy}px`;
}

function endDrag() {
  dragDepth = 0;
  document.body.classList.remove('dragging');
  setDropTarget(null);
  updateBridge();
}

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (dragDepth++ === 0) {
    document.body.classList.add('dragging');
    updateDropLabel();
    updateBridge();
  }
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (!hasFiles(e)) return;
  const peer = document.elementFromPoint(e.clientX, e.clientY)?.closest('.peer:not(.leave)');
  const id = peer?.dataset.id || null;
  e.dataTransfer.dropEffect = id || soleTarget() ? 'copy' : 'none';
  setDropTarget(id && !busy(id) ? id : null);
  if (state.dropTarget) magnetize(state.dropTarget, e);
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
    toast(state.peers.size ? 'Drop the files right onto a device.' : 'There are no devices nearby yet.');
    return;
  }
  if (busy(target)) {
    toast('Wait for the current transfer to finish.');
    return;
  }
  fly(paths, { x: e.clientX, y: e.clientY }, peerAvatar(target), { burst: true }).then(() => send(target, paths));
});

// ---------- sheets: incoming offers and progress ----------

function sheetHead(from, title, sub) {
  const head = el('div', 'sheet-head');
  head.append(el('div', `avatar ${platformClass(from.platform)}`, glyphFor(from.platform)));
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
  const { head } = sheetHead(offer.from, `${offer.from.name} would like to share`, `${what} · ${formatBytes(offer.totalBytes)}`);
  sheet.append(head);

  if (offer.names.length > 1 || offer.fileCount > 1) {
    const chips = el('div', 'chips');
    for (const name of offer.names.slice(0, 6)) chips.append(text('span', 'chip', name));
    if (offer.names.length > 6) chips.append(text('span', 'chip', `${offer.names.length - 6} more`));
    sheet.append(chips);
  }

  const check = el('label', 'check');
  const box = document.createElement('input');
  box.type = 'checkbox';
  check.append(box, document.createTextNode('Always accept from this device'));
  sheet.append(check);

  const actions = el('div', 'actions');
  const decline = text('button', 'btn', 'Decline');
  const accept = text('button', 'btn primary', 'Accept');
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
  const { head, subNode } = sheetHead(e.from, `Receiving from ${e.from.name}`, `${files(e.fileCount)} · ${formatBytes(e.totalBytes)}`);
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
  item.sheet.querySelector('.sheet-title').textContent = `Received from ${e.from.name}`;
  item.sub.textContent = e.fileCount === 1 ? baseName(e.paths[0]) : `${files(e.fileCount)} · ${formatBytes(e.totalBytes)}`;
  const actions = el('div', 'actions');
  const close = text('button', 'btn', 'Done');
  const show = text('button', 'btn primary', state.self?.platform === 'darwin' ? 'Show in Finder' : 'Show in Folder');
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
  toast(`The transfer from ${e.from.name} was interrupted.`);
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
      updateBridge();
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
        toast(`Couldn’t send: ${event.error}`);
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
    case 'receive-start': {
      showIncoming(event);
      const avatar = peerAvatar(event.from.id);
      if (state.peers.has(event.from.id)) {
        setActivity(event.from.id, { dir: 'in', id: event.id, stage: 'sending', sent: 0, total: event.totalBytes });
      }
      // The light comes from the sender; from the top edge if it isn't on the radar.
      if (avatar) burstFrom(avatar);
      else burstAt(window.innerWidth / 2, 0);
      break;
    }
    case 'receive-progress': {
      const item = incoming.get(event.id);
      if (item) {
        const p = percent(event.sent, event.total);
        item.bar.style.width = `${p}%`;
        item.sub.textContent = `${formatBytes(event.sent)} of ${formatBytes(event.total)} · ${p}%`;
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
      const avatar = peerAvatar(event.from.id);
      if (avatar) {
        fly(event.paths, centerOf(avatar), els.meAvatar);
        settleActivity(event.from.id, 'done', 'in');
      }
      break;
    }
    case 'receive-failed':
      failIncoming(event);
      if (state.activity.get(event.from.id)?.dir === 'in') settleActivity(event.from.id, 'failed', 'in');
      break;
    case 'demo-burst':
      // Only demo.js sends this, so the effect can be captured mid-animation.
      burstFrom(peerAvatar(event.peerId));
      break;
  }
}

// ---------- this device + footer ----------

function renderSelf() {
  const platform = platformClass(state.self.platform);
  els.meAvatar.className = `avatar me-avatar ${platform}`;
  els.meAvatar.innerHTML = glyphFor(state.self.platform);
  els.meName.textContent = state.self.name;
  els.meCaption.textContent = { darwin: 'This Mac', win32: 'This PC' }[platform] || 'This device';
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
  els.forgetTrusted.textContent = `Forget ${pluralize(count, 'trusted device', 'trusted devices')}`;
}

els.openDownloads.addEventListener('click', () => api.openDownloads());
els.changeDir.addEventListener('click', async () => {
  state.downloadDir = await api.chooseDownloadDir();
  renderDownloads();
});
els.forgetTrusted.addEventListener('click', async () => setTrustedCount(await api.forgetTrusted()));

window.addEventListener('resize', layout);

function renderTheme(theme) {
  for (const button of els.themeSwitch.querySelectorAll('button')) {
    const on = button.dataset.theme === theme;
    button.setAttribute('aria-checked', String(on));
    button.tabIndex = on ? 0 : -1;
  }
}

els.themeSwitch.addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-theme]');
  if (button) renderTheme(await api.setTheme(button.dataset.theme));
});

// Arrow keys move between the options, like a native segmented control.
els.themeSwitch.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const buttons = [...els.themeSwitch.querySelectorAll('button')];
  const current = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
  const next = buttons[(current + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
  next.focus();
  next.click();
});

async function main() {
  const data = await api.init();
  renderTheme(data.theme || 'system');
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
