import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { ConversationAttention, ConversationAttentionChange, ConversationAttentionTarget } from '@haiyue/ai-studio-agent-orchestration';
import { DEFAULT_NOTIFICATION_PREFERENCES, parseNotificationPreferences, type NotificationPreferences } from './notification-settings.js';

export interface DesktopNotificationPort {
  supported(): boolean;
  focused(): boolean;
  show(options: { title: string; body: string; silent: boolean }, callbacks: { shown(): void; click(): void; close(): void; failed(): void }): { close(): void };
  focus(): void;
  attention(): { close(): void };
  beep(): void;
  navigate(): void;
}

/** OS effects and device preferences only; task/approval decisions stay upstream. */
export class DesktopNotificationService {
  private preferences = DEFAULT_NOTIFICATION_PREFERENCES;
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly notices = new Map<string, { close(): void }>();
  private target: ConversationAttentionTarget | null = null;
  private delivery: 'idle' | 'requested' | 'shown' | 'failed' | 'unsupported' = 'idle';
  private lastTestAt = -Infinity;
  constructor(private readonly directory: string, private readonly port: DesktopNotificationPort) {}
  async initialize(): Promise<void> {
    try { const value = await readFile(path.join(this.directory, 'notifications.json'), 'utf8'); if (value.length <= 2048) this.preferences = parseNotificationPreferences(JSON.parse(value)); }
    catch { /* Missing/corrupt optional device preferences cannot block startup. */ }
  }
  snapshot() { return { preferences: this.preferences, supported: this.port.supported(), delivery: this.delivery }; }
  async configure(value: unknown): Promise<ReturnType<DesktopNotificationService['snapshot']>> {
    const preferences = parseNotificationPreferences(value);
    const update = this.tail.then(async () => {
      if (this.disposed) throw new Error('Notifications disposed.');
      await mkdir(this.directory, { recursive: true });
      const file = path.join(this.directory, 'notifications.json');
      await writeFile(`${file}.tmp`, JSON.stringify(preferences) + '\n'); await rename(`${file}.tmp`, file);
      if (this.disposed) return;
      this.preferences = preferences;
      // Changes never replay previously suppressed events.
      this.clear();
    });
    this.tail = update.catch(() => undefined); await update; return this.snapshot();
  }
  receive(change: ConversationAttentionChange): void {
    if (this.disposed) return;
    if (change.type === 'withdraw') { this.notices.get(change.id)?.close(); return; }
    if (!this.preferences.enabled || (this.preferences.backgroundOnly && this.port.focused())) return;
    this.show(change.notice);
  }
  test(): ReturnType<DesktopNotificationService['snapshot']> {
    if (this.disposed) throw new Error('Notifications disposed.');
    if (!this.preferences.enabled) throw new Error('notifications.disabled');
    if (Date.now() - this.lastTestAt < 3000) return this.snapshot();
    this.lastTestAt = Date.now();
    this.show(null); return this.snapshot();
  }
  takeTarget(): ConversationAttentionTarget | null { const result = this.target; this.target = null; return result; }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; this.clear(); await this.tail; }
  private clear(): void { for (const notice of [...this.notices.values()]) notice.close(); this.target = null; }
  private show(notice: ConversationAttention | null): void {
    const id = notice?.id ?? 'notification:test';
    if (this.notices.has(id)) return;
    if (notice?.expiresAt !== null && notice?.expiresAt !== undefined && notice.expiresAt <= Date.now()) return;
    while (this.notices.size >= 4) this.notices.values().next().value!.close();
    const zh = this.preferences.language === 'zh-CN';
    const titles = { approval: ['需要审批', 'Approval required'], plan: ['需要确认计划', 'Plan confirmation required'], question: ['需要补充信息', 'Your input is needed'], completed: ['任务已完成', 'Task completed'], 'turn-completed': ['本轮执行已结束', 'Turn finished'], failed: ['任务执行失败', 'Task failed'], blocked: ['任务需要关注', 'Task needs attention'] };
    const title = notice ? titles[notice.kind][zh ? 0 : 1] : zh ? '测试通知' : 'Test notification';
    // Fixed text only: project names, prompts, tool arguments and paths never
    // appear on the lock screen or enter the OS notification history.
    const body = notice ? (zh ? '点击返回 AIStudio 查看详情。' : 'Click to view details in AIStudio.') : (zh ? '系统通知已触发，提示音遵循当前开关和系统设置。' : 'Notification requested. Sound follows your app and system settings.');
    let native: { close(): void } | undefined, attention: { close(): void } | undefined, timer: ReturnType<typeof setTimeout> | undefined, closed = false, shown = false, failed = false;
    const close = () => { if (closed) return; closed = true; if (timer) clearTimeout(timer); this.notices.delete(id); native?.close(); attention?.close(); };
    const fallbackSound = () => { if (this.preferences.sound && !shown) { try { this.port.beep(); } catch { /* Optional OS effect. */ } } };
    this.notices.set(id, { close });
    this.delivery = 'requested';
    timer = setTimeout(close, Math.max(1, Math.min(300_000, (notice?.expiresAt ?? Infinity) - Date.now())));
    // Dock/taskbar attention is a normal reminder, not just an error fallback.
    try { attention = this.port.attention(); } catch { /* A banner may still work. */ }
    if (!this.port.supported()) { this.delivery = 'unsupported'; fallbackSound(); return; }
    try {
      native = this.port.show({ title: `AIStudio · ${title}`, body, silent: !this.preferences.sound }, {
        shown: () => { if (!closed && !this.disposed) { shown = true; this.delivery = 'shown'; } },
        click: () => {
          if (closed || failed || this.disposed || (notice?.expiresAt != null && notice.expiresAt <= Date.now())) return;
          this.target = notice ? { projectId: notice.projectId, documentId: notice.documentId, taskId: notice.taskId, nodeId: notice.nodeId } : null;
          close(); this.port.focus(); this.port.navigate();
        },
        close,
        failed: () => { if (closed || this.disposed || failed) return; failed = true; this.delivery = 'failed'; native?.close(); native = undefined; fallbackSound(); },
      });
      if (closed || failed) { native.close(); native = undefined; }
    } catch { this.delivery = 'failed'; fallbackSound(); }
  }
}
