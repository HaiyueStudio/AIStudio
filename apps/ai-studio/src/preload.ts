import { contextBridge, ipcRenderer } from 'electron';
import { STUDIO_IPC_CANCEL_CHANNEL, STUDIO_IPC_CHANNEL, type StudioIpcRequest, type StudioIpcResponse } from './ipc.js';

const api = Object.freeze({
  invoke(request: StudioIpcRequest): Promise<StudioIpcResponse> {
    return ipcRenderer.invoke(STUDIO_IPC_CHANNEL, request) as Promise<StudioIpcResponse>;
  },
  cancel(requestId: string): void { ipcRenderer.send(STUDIO_IPC_CANCEL_CHANNEL, requestId); },
});

contextBridge.exposeInMainWorld('haiyueStudio', api);
