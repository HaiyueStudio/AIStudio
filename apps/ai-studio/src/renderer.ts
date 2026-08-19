import type { StudioIpcRequest, StudioIpcResponse } from './ipc.js';

declare global {
  interface Window {
    readonly haiyueStudio: Readonly<{
      invoke(request: StudioIpcRequest): Promise<StudioIpcResponse>;
      cancel(requestId: string): void;
    }>;
  }
}

async function boot(): Promise<void> {
  const response = await window.haiyueStudio.invoke({
    schemaVersion: 1,
    id: 'request:renderer-status' as StudioIpcRequest['id'],
    correlationId: 'correlation:renderer-boot' as StudioIpcRequest['correlationId'],
    channel: 'app/status',
    payload: {},
  });
  document.body.dataset.status = response.ok ? 'ready' : 'error';
  document.querySelector('#status')!.textContent = response.ok ? 'AIStudio POC shell ready' : String(response.payload.diagnostic ?? 'Startup failed');
}

void boot();
