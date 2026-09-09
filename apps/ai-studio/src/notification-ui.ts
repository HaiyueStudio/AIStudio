import type { JsonObject } from '@haiyue/ai-studio-contracts';
import type { StudioIpcMethod } from './ipc.js';
import { parseNotificationPreferences, type NotificationPreferences } from './notification-settings.js';

export function mountNotificationSettings(document: Document, parent: HTMLElement, ports: {
  desktop: boolean;
  language(): 'zh-CN' | 'en';
  invoke(method: StudioIpcMethod, payload?: JsonObject): Promise<JsonObject>;
}) {
  const lifetime = new AbortController(); let closed = false, busy = false, preferences: NotificationPreferences | null = null, supported = false;
  const root = document.createElement('fieldset'); root.id = 'notification-settings';
  root.innerHTML = '<legend></legend><label><input type="checkbox" data-notification="enabled"><span></span></label><label><input type="checkbox" data-notification="sound"><span></span></label><label><input type="checkbox" data-notification="backgroundOnly"><span></span></label><button type="button" id="notification-test"></button><p role="status" aria-live="polite"></p>';
  parent.append(root);
  const status = root.querySelector('p')!, button = root.querySelector('button')!;
  const inputs = [...root.querySelectorAll<HTMLInputElement>('input')];
  let message: 'ready' | 'unsupported' | 'sent' | 'failed' | 'saved' = 'ready';
  function render(): void {
    if (closed) return;
    const zh = ports.language() === 'zh-CN';
    root.querySelector('legend')!.textContent = zh ? '通知与声音' : 'Notifications and sound';
    const labels = zh ? ['系统通知', '播放提示音', '仅在后台提醒'] : ['System notifications', 'Play notification sound', 'Notify only in background'];
    inputs.forEach((input, index) => {
      input.nextElementSibling!.textContent = labels[index];
      input.checked = preferences?.[input.dataset.notification as 'enabled' | 'sound' | 'backgroundOnly'] ?? false;
      input.disabled = busy || !preferences || !ports.desktop || (index > 0 && !preferences.enabled);
    });
    button.textContent = zh ? '测试通知' : 'Test notification'; button.disabled = busy || !preferences?.enabled || !supported;
    const labelsByState = zh ? { ready: '遵循系统通知、勿扰和声音设置。', unsupported: '当前环境不支持桌面通知。', sent: '已请求系统通知；请检查桌面通知和声音设置。', failed: '通知设置或发送失败，请重试。', saved: '通知偏好已保存在当前设备。' }
      : { ready: 'Follows system notification, Do Not Disturb and sound settings.', unsupported: 'Desktop notifications are unavailable here.', sent: 'System notification requested; check your notification and sound settings.', failed: 'Could not save settings or send the notification. Please retry.', saved: 'Notification preferences saved on this device.' };
    status.textContent = labelsByState[message];
  }
  async function save(next: NotificationPreferences): Promise<void> {
    if (closed || busy) return;
    busy = true; render();
    try { const result = await ports.invoke('notifications/set', { preferences: { ...next } }); if (closed) return; preferences = parseNotificationPreferences(result.preferences); supported = result.supported === true; message = 'saved'; }
    catch { message = 'failed'; }
    finally { busy = false; render(); }
  }
  for (const input of inputs) input.addEventListener('change', () => {
    if (preferences) void save({ ...preferences, [input.dataset.notification!]: input.checked, language: ports.language() });
  }, { signal: lifetime.signal });
  button.addEventListener('click', () => { void (async () => {
    busy = true; render();
    try { const result = await ports.invoke('notifications/test'); message = result.delivery === 'failed' ? 'failed' : result.supported === false ? 'unsupported' : 'sent'; }
    catch { message = 'failed'; } finally { busy = false; render(); }
  })(); }, { signal: lifetime.signal });
  const ready = (async () => {
    if (!ports.desktop) { message = 'unsupported'; render(); return; }
    try { const result = await ports.invoke('notifications/get'); if (closed) return; preferences = parseNotificationPreferences(result.preferences); supported = result.supported === true; message = supported ? 'ready' : 'unsupported'; render(); if (preferences.language !== ports.language()) await save({ ...preferences, language: ports.language() }); }
    catch { message = 'failed'; render(); }
  })();
  render();
  return { ready, refreshLocale() { render(); if (preferences && preferences.language !== ports.language()) void save({ ...preferences, language: ports.language() }); }, dispose() { closed = true; lifetime.abort(); root.remove(); } };
}
