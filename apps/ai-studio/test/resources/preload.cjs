const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('resourceBridge', Object.freeze({ current: () => ipcRenderer.invoke('g06-resource-current'), intent: value => ipcRenderer.invoke('g06-resource-intent', value) }));
