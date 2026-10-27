// Stand-in for the Electron bridge so the UI can be opened in a plain browser to work on
// the design. Does nothing inside the app, where preload.js provides window.hop.
//
//   ?demo=live    no devices at first, one appears after a moment (default)
//   ?demo=empty   nobody around
//   ?demo=static  one device
//   ?demo=many    three devices, one of each kind
//   ?demo=offer   an incoming offer
//   ?demo=receive an incoming transfer starts right away
//   ?demo=burst   the hop burst fires ~600 ms after load, then every few seconds
//   ?demo=drag    files are held over the device (bridge, magnetic aura)
//   ?demo=drop    files are dragged in, dropped, and sent
//   ?demo=pick    the device is clicked and a file picked, so the chip flies from this device
//   &platform=darwin|win32 picks which computer this is; the peer is the other one.
if (!window.hop) {
  const listeners = new Set();
  const emit = (event) => setTimeout(() => listeners.forEach((fn) => fn(event)), 0);
  const params = new URLSearchParams(location.search);
  const scenario = params.get('demo') || 'live';
  const onMac = params.get('platform') === 'darwin';

  const mac = { id: 'demo-mac', name: 'Lev’s MacBook Pro', platform: 'darwin', address: '192.168.0.12', port: 1 };
  const pc = { id: 'demo-pc', name: 'LEV-PC', platform: 'win32', address: '192.168.0.20', port: 1 };
  const imac = { id: 'demo-imac', name: 'Anna’s iMac', platform: 'darwin', address: '192.168.0.17', port: 1 };
  const nas = { id: 'demo-nas', name: 'studio-server', platform: 'linux', address: '192.168.0.31', port: 1 };
  const self = onMac ? mac : pc;
  const peer = onMac ? pc : mac;
  const downloads = onMac ? '/Users/lev/Downloads/Hop' : 'C:\\Users\\lev9e\\Downloads\\Hop';
  const sep = onMac ? '/' : '\\';
  const initialPeers = { empty: [], live: [], many: [peer, imac, nas] }[scenario] || [peer];

  function simulateSend(id, peerId, total) {
    let sent = 0;
    emit({ type: 'send-progress', id, peerId, stage: 'waiting', sent, total });
    setTimeout(() => {
      const timer = setInterval(() => {
        sent = Math.min(total, sent + total / 25);
        emit({ type: 'send-progress', id, peerId, stage: 'sending', sent, total });
        if (sent >= total) {
          clearInterval(timer);
          emit({ type: 'send-done', id, peerId, fileCount: 1, total });
        }
      }, 120);
    }, 1200);
  }

  function simulateReceive(id) {
    const total = 24 * 1000 * 1000;
    emit({ type: 'receive-start', id, from: peer, fileCount: 3, totalBytes: total });
    let sent = 0;
    const timer = setInterval(() => {
      sent = Math.min(total, sent + total / 20);
      emit({ type: 'receive-progress', id, from: peer, sent, total });
      if (sent >= total) {
        clearInterval(timer);
        emit({ type: 'receive-done', id, from: peer, fileCount: 3, totalBytes: total, paths: [`${downloads}${sep}Vacation`] });
      }
    }, 120);
  }

  // Real drag events with a real File, so the page's own drag & drop code runs.
  function drag(type, dataTransfer) {
    const avatar = document.querySelector('.peer .avatar');
    if (!avatar) return;
    const box = avatar.getBoundingClientRect();
    const clientX = box.left + box.width * 0.62;
    const clientY = box.top + box.height * 0.6;
    const target = document.elementFromPoint(clientX, clientY) || document.body;
    target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX, clientY, dataTransfer }));
  }

  function simulateDrag(dropAfter) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['demo'], 'IMG_2041.HEIC', { type: 'image/heic' }));
    drag('dragenter', dataTransfer);
    drag('dragover', dataTransfer);
    if (dropAfter) setTimeout(() => drag('drop', dataTransfer), dropAfter);
  }

  window.hop = {
    init: async () => ({ self, peers: initialPeers, downloadDir: downloads, trustedCount: 0, theme: 'system' }),
    setTheme: async (theme) => theme,
    send: async (peerId) => {
      const id = `demo-${Date.now()}`;
      simulateSend(id, peerId, 48 * 1000 * 1000);
      return id;
    },
    cancel: async () => {},
    replyToOffer: async (id, accepted) => {
      if (accepted) simulateReceive(id);
    },
    pick: async () => [onMac ? '/Users/lev/Desktop/Keynote.key' : 'C:\\Users\\lev9e\\Desktop\\Keynote.key'],
    reveal: async () => {},
    openDownloads: async () => {},
    chooseDownloadDir: async () => downloads,
    rename: async (name) => name.trim(),
    forgetTrusted: async () => 0,
    pathForFile: (file) => file.name,
    onEvent: (fn) => {
      listeners.add(fn);
      if (scenario === 'live') setTimeout(() => emit({ type: 'peers', peers: [peer] }), 1400);
      if (scenario === 'offer') {
        setTimeout(
          () =>
            emit({
              type: 'offer',
              offer: { id: 'demo-offer', from: peer, fileCount: 3, totalBytes: 24 * 1000 * 1000, names: ['Vacation', 'notes.md', 'IMG_2041.HEIC'] },
            }),
          600,
        );
      }
      if (scenario === 'receive') setTimeout(() => simulateReceive('demo-receive'), 600);
      if (scenario === 'burst') {
        const fire = () => emit({ type: 'demo-burst', peerId: peer.id });
        setTimeout(() => {
          fire();
          setInterval(fire, 3200);
        }, 600);
      }
      if (scenario === 'drag') setTimeout(() => simulateDrag(0), 500);
      if (scenario === 'drop') setTimeout(() => simulateDrag(900), 400);
      if (scenario === 'pick') setTimeout(() => document.querySelector('.peer')?.click(), 500);
      return () => listeners.delete(fn);
    },
  };
}
