const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('hop', {
  init: () => ipcRenderer.invoke('hop:init'),
  send: (peerId, paths) => ipcRenderer.invoke('hop:send', peerId, paths),
  cancel: (id) => ipcRenderer.invoke('hop:cancel', id),
  replyToOffer: (id, accepted, trust) => ipcRenderer.invoke('hop:offer-reply', id, accepted, trust),
  pick: () => ipcRenderer.invoke('hop:pick'),
  reveal: (target) => ipcRenderer.invoke('hop:reveal', target),
  openDownloads: () => ipcRenderer.invoke('hop:open-downloads'),
  chooseDownloadDir: () => ipcRenderer.invoke('hop:choose-download-dir'),
  rename: (name) => ipcRenderer.invoke('hop:rename', name),
  forgetTrusted: () => ipcRenderer.invoke('hop:forget-trusted'),
  // Dropped File objects no longer carry .path; Electron resolves it here.
  pathForFile: (file) => webUtils.getPathForFile(file),
  onEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('hop:event', listener);
    return () => ipcRenderer.off('hop:event', listener);
  },
});
