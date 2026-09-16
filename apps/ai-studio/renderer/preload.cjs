'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const REQUEST_CHANNEL = 'studio:request';
const CANCEL_CHANNEL = 'studio:cancel';
const PREVIEW_PENDING_CHANNEL = 'studio:preview-pending';
const CONVERSATION_CHANGED_CHANNEL = 'studio:conversation-changed';
contextBridge.exposeInMainWorld('haiyueStudio', Object.freeze({
  invoke(request) { return ipcRenderer.invoke(REQUEST_CHANNEL, request); },
  cancel(requestId) { ipcRenderer.send(CANCEL_CHANNEL, requestId); },
  onNotificationClicked(listener) {
    if (typeof listener !== 'function') throw new TypeError('Notification listener must be a function.');
    const handle = () => listener();
    ipcRenderer.on('studio:notification-clicked', handle);
    return () => ipcRenderer.removeListener('studio:notification-clicked', handle);
  },
  onPreviewPending(listener) {
    if (typeof listener !== 'function') throw new TypeError('Preview listener must be a function.');
    const handle = () => listener();
    ipcRenderer.on(PREVIEW_PENDING_CHANNEL, handle);
    return () => ipcRenderer.removeListener(PREVIEW_PENDING_CHANNEL, handle);
  },
  onConversationChanged(listener) {
    if (typeof listener !== 'function') throw new TypeError('Conversation listener must be a function.');
    const handle = () => listener();
    ipcRenderer.on(CONVERSATION_CHANGED_CHANNEL, handle);
    return () => ipcRenderer.removeListener(CONVERSATION_CHANGED_CHANNEL, handle);
  },
}));
