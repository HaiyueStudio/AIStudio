import { BrowserWindow } from 'electron';
import { drawCanvasTexture, normalizeCanvasTextureRecipe, type CanvasTextureRecipe } from '@haiyue/ai-studio-game-authoring-tools';

/** Platform adapter. Each request owns its isolated Canvas window and destroys it on every exit. */
export async function renderCanvasTexture(value: CanvasTextureRecipe, signal: AbortSignal): Promise<Uint8Array> {
  const recipe = normalizeCanvasTextureRecipe(value); signal.throwIfAborted();
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
  const destroy = () => { if (!window.isDestroyed()) window.destroy(); };
  signal.addEventListener('abort', destroy, { once: true });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  try {
    await window.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; connect-src \'none\'"><title>Texture Canvas</title>'));
    signal.throwIfAborted();
    // The only executable source is our fixed renderer; JSON recipe values remain data.
    const encoded: unknown = await window.webContents.executeJavaScript(`(${drawCanvasTexture.toString()})(${JSON.stringify(recipe)})`);
    signal.throwIfAborted();
    if (typeof encoded !== 'string' || !encoded.startsWith('data:image/png;base64,') || encoded.length > 28 * 1024 * 1024) throw new Error('Canvas returned invalid PNG data.');
    return new Uint8Array(Buffer.from(encoded.slice('data:image/png;base64,'.length), 'base64'));
  } finally { signal.removeEventListener('abort', destroy); destroy(); }
}
