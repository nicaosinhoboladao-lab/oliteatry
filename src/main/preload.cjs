const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('oliteatry', {
  isDesktop: true,
  platform: process.platform,
  version: '0.1.0',

  saveProject: (json, suggested) => ipcRenderer.invoke('project:save', json, suggested),
  openProject: () => ipcRenderer.invoke('project:open'),
  saveBinary: (data, suggested, filters) => ipcRenderer.invoke('file:save-binary', data, suggested, filters),
  saveText: (text, suggested) => ipcRenderer.invoke('file:save-text', text, suggested),
  importModel: (kind = 'model') => ipcRenderer.invoke('model:open', { kind }),

  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),

  log: (...args) => ipcRenderer.send('log', ...args),
});
