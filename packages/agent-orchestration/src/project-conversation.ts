import { asStableId, type AgentHistoryDetailV1, type AgentHistoryPageV1, type StableId } from '@haiyue/ai-studio-contracts';
import type { ConversationOperationLog } from '@haiyue/ai-studio-operation-log';
import type { ConversationReplaySnapshot } from '@haiyue/ai-studio-shell/conversation';
import { StudioConversationHost, type ConversationHostOptions } from './conversation-host.js';

export interface ConversationProjectBinding {
  readonly projectId: StableId | null;
  readonly documentId: StableId | null;
  /** Opaque location identity supplied by the platform adapter. */
  readonly storageKey: string | null;
}
export interface ProjectHistoryScope {
  readonly log: ConversationOperationLog;
  query(input?: Readonly<{ cursor?: string; limit?: number }>): Promise<AgentHistoryPageV1>;
  detail(id: StableId): Promise<AgentHistoryDetailV1>;
  relocate(binding: ConversationProjectBinding): Promise<void>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}
export interface ProjectConversationOptions {
  resolveProject(): ConversationProjectBinding;
  openHistory(binding: ConversationProjectBinding): Promise<ProjectHistoryScope>;
  hostOptions(binding: ConversationProjectBinding, log: ConversationOperationLog): ConversationHostOptions;
}

/** Owns project transitions; platform code supplies locations, storage and editor adapters. */
export class ProjectConversationController {
  private host: StudioConversationHost | null = null;
  private history: ProjectHistoryScope | null = null;
  private binding: ConversationProjectBinding | null = null;
  private hostSubscription: Readonly<{ dispose(): void }> | null = null;
  private readonly listeners = new Set<() => void>();
  private pending: Promise<void> = Promise.resolve();
  private revision = 0;
  private changing = false;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private settings: ReturnType<StudioConversationHost['settings']> | undefined;

  constructor(private readonly options: ProjectConversationOptions) {}

  initialize(): Promise<void> { return this.syncProject(); }
  syncProject(): Promise<void> {
    const run = this.pending.then(async () => {
      this.assertActive();
      const binding = this.options.resolveProject();
      if (this.host && this.binding?.projectId === binding.projectId && this.binding.documentId === binding.documentId) {
        if (this.binding.storageKey !== binding.storageKey) await this.history!.relocate(binding);
        this.binding = binding; this.changing = false; this.changed(); return;
      }
      this.changing = true; this.changed();
      await this.releaseProject();
      const history = await this.options.openHistory(binding);
      let host: StudioConversationHost | null = null;
      try {
        this.assertActive();
        host = new StudioConversationHost({ ...this.options.hostOptions(binding, history.log), ...(this.settings ? { initialSettings: this.settings } : {}), recordProjectId: binding.projectId ?? asStableId('project:workspace-empty'), idPrefix: `scope:${crypto.randomUUID()}` });
        await host.initialize();
        this.assertActive();
        this.history = history; this.host = host; this.binding = binding;
        this.hostSubscription = host.subscribe(() => this.changed());
        this.changing = false; this.changed();
      } catch (cause) { await host?.dispose().catch(() => undefined); await history.dispose(); throw cause; }
    });
    this.pending = run.catch(() => undefined);
    return run;
  }

  /** Called before the editor replaces a Document, while its old authority is still available. */
  async prepareProjectChange(): Promise<void> {
    this.changing = true; this.changed();
    const run = this.pending.then(async () => { this.changing = true; await this.releaseProject(); });
    this.pending = run.catch(() => undefined);
    await run;
  }

  async dispatch(value: unknown, signal?: AbortSignal): Promise<void> {
    this.assertActive();
    if (this.changing) throw new Error('项目记录正在切换，请稍后重试。');
    await this.pending;
    if (!this.host || this.changing) throw new Error('项目记录尚未就绪。');
    await this.host.dispatch(value, signal);
  }

  replay(): ConversationReplaySnapshot & Readonly<{ projectId: StableId | null; historyStorage: 'project' | 'unsaved' | 'none' }> {
    this.assertActive();
    const snapshot = this.host?.replay() ?? { connection: 'connected' as const, busy: false, backendId: null, backends: [], taskAccounting: null, taskRuns: [], executionGraphs: [], events: [] };
    return Object.freeze({ ...snapshot, projectId: this.binding?.projectId ?? null, historyStorage: !this.binding?.projectId ? 'none' : this.binding.storageKey ? 'project' : 'unsaved', revision: this.revision, busy: snapshot.busy || this.changing });
  }

  subscribe(listener: () => void): Readonly<{ dispose(): void }> {
    this.assertActive(); this.listeners.add(listener);
    return Object.freeze({ dispose: () => { this.listeners.delete(listener); } });
  }
  cancelPending(reason?: string): void { this.host?.cancelPending(reason); }

  async queryHistory(projectId: StableId | null, input: Readonly<{ cursor?: string; limit?: number }>): Promise<AgentHistoryPageV1> {
    await this.pending; this.assertProject(projectId);
    await this.host?.flushRecords(); this.assertProject(projectId);
    if (!projectId || !this.history) return Object.freeze({ schemaVersion: 1, projectId: null, records: [], total: 0, nextCursor: null, storage: 'none' });
    return this.history.query(input);
  }
  async readHistory(projectId: StableId, id: StableId): Promise<AgentHistoryDetailV1> {
    await this.pending; this.assertProject(projectId);
    await this.host?.flushRecords(); this.assertProject(projectId);
    if (!this.history) throw new Error('项目执行记录尚未就绪。');
    return this.history.detail(id);
  }

  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.disposed = true; this.changing = true;
      await this.pending; await this.releaseProject(); this.listeners.clear();
    })();
  }

  private async releaseProject(): Promise<void> {
    const host = this.host; const history = this.history;
    if (host) this.settings = host.settings();
    this.hostSubscription?.dispose(); this.hostSubscription = null;
    this.host = null; this.history = null;
    try { await host?.dispose(); }
    finally { try { await history?.flush(); } finally { await history?.dispose(); } }
    this.changed();
  }
  private assertProject(projectId: StableId | null): void {
    this.assertActive();
    if (this.changing || projectId !== (this.binding?.projectId ?? null)) throw new Error('项目已切换，请重新读取执行记录。');
  }
  private assertActive(): void { if (this.disposed) throw new Error('Project conversation controller is disposed.'); }
  private changed(): void { this.revision += 1; if (!this.disposed) for (const listener of this.listeners) { try { listener(); } catch { /* View observers cannot own transitions. */ } } }
}
