// Stand-in for the Electron bridge so the UI can be opened in a plain browser to work on
// the design. Does nothing inside the app, where preload.js provides window.hop.
if (!window.hop) {
  const listeners = new Set();
  const emit = (event) => setTimeout(() => listeners.forEach((fn) => fn(event)), 0);
  const mac = { id: 'demo-mac', name: 'MacBook Pro — Лев', platform: 'darwin', address: '192.168.0.12', port: 1 };
  const scenario = new URLSearchParams(location.search).get('demo') || 'live';

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

  window.hop = {
    init: async () => ({
      self: { id: 'demo-pc', name: 'LEV-PC', platform: 'win32' },
      peers: scenario === 'empty' ? [] : scenario === 'live' ? [] : [mac],
      downloadDir: 'C:\\Users\\lev9e\\Downloads\\Hop',
      trustedCount: 0,
    }),
    send: async (peerId) => {
      const id = `demo-${Date.now()}`;
      simulateSend(id, peerId, 48 * 1024 * 1024);
      return id;
    },
    cancel: async () => {},
    replyToOffer: async (id, accepted) => {
      if (!accepted) return;
      const total = 24 * 1024 * 1024;
      emit({ type: 'receive-start', id, from: mac, fileCount: 3, totalBytes: total });
      let sent = 0;
      const timer = setInterval(() => {
        sent = Math.min(total, sent + total / 20);
        emit({ type: 'receive-progress', id, from: mac, sent, total });
        if (sent >= total) {
          clearInterval(timer);
          emit({ type: 'receive-done', id, from: mac, fileCount: 3, totalBytes: total, paths: ['C:\\Users\\lev9e\\Downloads\\Hop\\Отпуск'] });
        }
      }, 120);
    },
    pick: async () => ['C:\\Users\\lev9e\\Desktop\\Презентация.key'],
    reveal: async () => {},
    openDownloads: async () => {},
    chooseDownloadDir: async () => 'C:\\Users\\lev9e\\Downloads\\Hop',
    rename: async (name) => name.trim(),
    forgetTrusted: async () => 0,
    pathForFile: (file) => file.name,
    onEvent: (fn) => {
      listeners.add(fn);
      if (scenario === 'live') setTimeout(() => emit({ type: 'peers', peers: [mac] }), 1400);
      if (scenario === 'offer') {
        setTimeout(
          () =>
            emit({
              type: 'offer',
              offer: { id: 'demo-offer', from: mac, fileCount: 3, totalBytes: 24 * 1024 * 1024, names: ['Отпуск', 'notes.md', 'IMG_2041.HEIC'] },
            }),
          600,
        );
      }
      return () => listeners.delete(fn);
    },
  };
}
