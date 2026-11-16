// Окна эффектов экрана (трава сверху, волна снизу): только получают настройки и состояние музыки.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fx', {
  onSettings: (cb) => ipcRenderer.on('fx-settings', (_e, d) => cb(d)),
  onMedia: (cb) => ipcRenderer.on('fx-media', (_e, d) => cb(d)),
  onRun: (cb) => ipcRenderer.on('fx-run', (_e, on) => cb(on)),
  onHover: (cb) => ipcRenderer.on('fx-hover', (_e, p) => cb(p)),
  ready: () => ipcRenderer.send('fx-ready')
});
