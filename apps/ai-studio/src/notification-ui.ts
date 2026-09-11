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
  let message: 'ready' | 'unsupported' | 'sent' | 'shown' | 'failed' | 'saved' = 'ready';
  const pause = () => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, 200); lifetime.signal.addEventListener('abort', done, { once: true });
  });
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
    const labelsByState = zh ? { ready: '审批和本轮执行结束时提醒；后台会提醒 Dock 或任务栏。系统通知受系统权限与勿扰设置控制。', unsupported: '当前环境不支持系统通知；后台图标仍可提醒。', sent: '系统尚未确认显示通知，请检查系统通知权限与勿扰设置。', shown: '系统已显示测试通知，提示音遵循声音开关与系统音量。', failed: '通知设置或系统投递失败。请检查系统通知权限与勿扰设置。', saved: '通知偏好已保存在当前设备。' }
      : { ready: 'Alerts for approvals and finished turns; Dock or taskbar attention in background. Banners follow system permissions and Do Not Disturb.', unsupported: 'System notifications are unavailable; background icon attention can still work.', sent: 'Display is not confirmed. Check system notification permissions and Do Not Disturb.', shown: 'The system displayed the test notification. Sound follows your preference and system volume.', failed: 'Settings or system delivery failed. Check system notification permissions and Do Not Disturb.', saved: 'Notification preferences saved on this device.' };
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
    try {
      let result = await ports.invoke('notifications/test');
      for (let attempt = 0; attempt < 15 && result.delivery === 'requested' && !closed; attempt++) {
        await pause(); if (closed) return; result = await ports.invoke('notifications/get');
      }
      message = result.delivery === 'failed' ? 'failed' : result.supported === false ? 'unsupported' : result.delivery === 'shown' ? 'shown' : 'sent';
    }
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
