const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shotApi', {
  getImage: () => ipcRenderer.invoke('shot-get'),
  save: (dataUrl) => ipcRenderer.invoke('shot-save', dataUrl),
  copy: (dataUrl) => ipcRenderer.invoke('shot-copy', dataUrl),
  cancel: () => ipcRenderer.send('shot-cancel')
});
