'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const REQUEST_CHANNEL = 'studio:request';
const CANCEL_CHANNEL = 'studio:cancel';
contextBridge.exposeInMainWorld('haiyueStudio', Object.freeze({
  invoke(request) { return ipcRenderer.invoke(REQUEST_CHANNEL, request); },
  cancel(requestId) { ipcRenderer.send(CANCEL_CHANNEL, requestId); },
}));
