import { app, Notification, shell, type BrowserWindow } from 'electron';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { DesktopNotificationPort } from './desktop-notifications.js';

export const NOTIFICATION_CLICKED_CHANNEL = 'studio:notification-clicked';
/** Creates only the application's own shortcut; other shortcuts are untouched. */
export async function prepareNotificationIdentity(appId: string, mainEntry: string): Promise<void> {
  app.setAppUserModelId(appId);
  if (process.platform !== 'win32') return;
  const folder = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const shortcut = path.join(folder, 'HaiYue AIStudio.lnk');
  const description = 'HaiYue AIStudio desktop notifications';
  if (existsSync(shortcut)) {
    try { const existing = shell.readShortcutLink(shortcut); if (existing.appUserModelId !== appId || existing.description !== description) return; }
    catch { return; /* An unreadable existing shortcut is not ours to replace. */ }
  }
  await mkdir(folder, { recursive: true });
  if (!shell.writeShortcutLink(shortcut, 'create', { target: process.execPath, args: app.isPackaged ? '' : `"${mainEntry}"`, cwd: path.dirname(mainEntry), description, appUserModelId: appId })) throw new Error('notifications.identity-unavailable');
}
export function electronNotificationPort(getWindow: () => BrowserWindow | null, disabled = false): DesktopNotificationPort {
  const window = () => { const value = getWindow(); return value && !value.isDestroyed() ? value : null; };
  const attentionHandles = new Set<() => void>();
  return {
    supported: () => !disabled && Notification.isSupported(),
    focused: () => window()?.isFocused() === true,
    show(options, callbacks) {
      const notification = new Notification({ ...options, ...(process.platform === 'darwin' && !options.silent ? { sound: 'Glass' } : {}) });
      notification.on('show', callbacks.shown);
      notification.on('click', callbacks.click); notification.on('close', callbacks.close); notification.on('failed', callbacks.failed);
      notification.show();
      return { close() { notification.removeAllListeners(); notification.close(); } };
    },
    focus() { const value = window(); if (!value) return; if (value.isMinimized()) value.restore(); value.show(); value.focus(); value.flashFrame(false); },
    attention() {
      const value = window();
      if (disabled || !value || value.isFocused()) return { close() {} };
      // A brief Dock bounce is enough; never steal focus or bounce forever.
      const bounce = process.platform === 'darwin' ? app.dock?.bounce('informational') : undefined;
      if (process.platform !== 'darwin') value.flashFrame(true);
      let closed = false;
      const close = () => {
        if (closed) return; closed = true; attentionHandles.delete(close);
        value.removeListener('focus', close); value.removeListener('closed', close);
        if (bounce !== undefined && bounce >= 0) app.dock?.cancelBounce(bounce);
        if (!value.isDestroyed() && attentionHandles.size === 0) value.flashFrame(false);
      };
      attentionHandles.add(close); value.on('focus', close); value.on('closed', close);
      return { close };
    },
    beep() { if (!disabled) shell.beep(); },
    navigate() { const value = window(); if (value && !value.webContents.isDestroyed()) value.webContents.send(NOTIFICATION_CLICKED_CHANNEL); },
  };
}
