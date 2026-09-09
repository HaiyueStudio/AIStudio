// Explicit local smoke: emits one real OS test notification; never runs an Agent.
import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopNotificationService } from '../../dist/desktop-notifications.js';
import { prepareNotificationIdentity, electronNotificationPort } from '../../dist/electron-notifications.js';
const output = fileURLToPath(new URL('../test-output/desktop-notifications/', import.meta.url));
app.setPath('userData', path.join(output, 'user-data'));
app.whenReady().then(async () => {
  await mkdir(output, { recursive: true });
  await prepareNotificationIdentity('studio.haiyue.ai', fileURLToPath(new URL('../../dist/main.js', import.meta.url)));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  const service = new DesktopNotificationService(path.join(output, 'preferences'), electronNotificationPort(() => window));
  await service.initialize(); await service.configure({ schemaVersion: 1, enabled: true, sound: true, backgroundOnly: true, language: 'zh-CN' });
  service.test(); const deadline = Date.now() + 10_000;
  while (service.snapshot().delivery === 'requested' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  const result = { ...service.snapshot(), platform: process.platform, electron: process.versions.electron, nativeShowEvent: service.snapshot().delivery === 'shown', checkedAt: new Date().toISOString() };
  await writeFile(path.join(output, 'native.json'), JSON.stringify(result, null, 2)); console.log(`[notification-native] ${JSON.stringify(result)}`);
  await new Promise(resolve => setTimeout(resolve, 1500)); await service.dispose(); window.destroy(); app.exit(result.nativeShowEvent ? 0 : 1);
}).catch(cause => { console.error(cause); app.exit(1); });
