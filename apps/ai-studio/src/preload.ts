import { contextBridge, ipcRenderer } from 'electron';
import { STUDIO_CONVERSATION_CHANGED_CHANNEL, STUDIO_IPC_CANCEL_CHANNEL, STUDIO_IPC_CHANNEL, type StudioIpcRequest, type StudioIpcResponse } from './ipc.js';

const api = Object.freeze({
  invoke(request: StudioIpcRequest): Promise<StudioIpcResponse> {
    return ipcRenderer.invoke(STUDIO_IPC_CHANNEL, request) as Promise<StudioIpcResponse>;
  },
  cancel(requestId: string): void { ipcRenderer.send(STUDIO_IPC_CANCEL_CHANNEL, requestId); },
  onConversationChanged(listener: () => void): () => void {
    const handle = (): void => listener();
    ipcRenderer.on(STUDIO_CONVERSATION_CHANGED_CHANNEL, handle);
    return () => ipcRenderer.removeListener(STUDIO_CONVERSATION_CHANGED_CHANNEL, handle);
  },
});

contextBridge.exposeInMainWorld('haiyueStudio', api);
