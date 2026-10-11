import { asStableId, type AgentHistoryDetailV1, type AgentHistoryPageV1, type StableId } from '@haiyue/ai-studio-contracts';
import type { ConversationOperationLog } from '@haiyue/ai-studio-operation-log';
import type { ConversationReplaySnapshot } from '@haiyue/ai-studio-shell/conversation';
import { StudioConversationHost, type ConversationHostOptions } from './conversation-host.js';
import { ConversationAttentionTracker, type ConversationAttentionChange } from './conversation-attention.js';
import { ProjectTaskReviews } from './project-task-reviews.js';
import { ProjectExperiences } from './project-experiences.js';

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
  private reviews: ProjectTaskReviews | null = null;
  private experiences: ProjectExperiences | null = null;
  private binding: ConversationProjectBinding | null = null;
  private hostSubscription: Readonly<{ dispose(): void }> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly attention = new ConversationAttentionTracker();
  private readonly attentionListeners = new Set<(change: ConversationAttentionChange) => void>();
  private pending: Promise<void> = Promise.resolve();
  private revision = 0;
  private reviewRevision = 0;
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
      let experiences: ProjectExperiences | null = null;
      try {
        this.assertActive();
        if (binding.projectId) {
          experiences = new ProjectExperiences({ projectId:binding.projectId,log:history.log,busy:() => !host || this.changing || host.replay().busy,
            suggest:(report,entries,signal) => { if (!host) throw new Error('模型尚未就绪。'); return host.suggestExperiences(report,entries,signal); },
            review:async taskId => {
              if (!this.reviews) throw new Error('复盘尚未就绪。');
              await this.reviews.list(); const report = await this.reviews.read(taskId);
              const current = host?.reviewTask(taskId);
              if (current && (current.revision !== report.taskRevision || !['completed','failed','blocked','cancelled'].includes(current.status))) throw new Error('来源任务已恢复或发生变化。');
              return report;
            },flush:() => history.flush(),changed:() => { this.reviewRevision++; this.notifyViews(); } });
          await experiences.initialize();
        }
        host = new StudioConversationHost({ ...this.options.hostOptions(binding, history.log), ...(this.settings ? { initialSettings: this.settings } : {}),
          selectExperiences:experiences ? (request,taskId,signal) => experiences!.select(request,taskId,signal) : undefined,
          recordProjectId: binding.projectId ?? asStableId('project:workspace-empty'), idPrefix: `scope:${crypto.randomUUID()}` });
        await host.initialize();
        this.assertActive();
        this.history = history; this.host = host; this.binding = binding; this.experiences = experiences;
        const currentHost = host;
        if (binding.projectId) this.reviews = new ProjectTaskReviews({ projectId:binding.projectId,log:history.log,snapshot:() => ({busy:currentHost.replay().busy,taskRuns:currentHost.reviewTasks()}),flush:async () => { await currentHost.flushRecords(); await history.flush(); },changed:() => { this.reviewRevision++; this.notifyViews(); this.experiences?.observeSuggestions(); },deepen:(report,signal) => currentHost.deepenReview(report,signal) });
        this.hostSubscription = host.subscribe(() => this.changed());
        this.changing = false; this.changed();
      } catch (cause) { await experiences?.dispose(); await host?.dispose().catch(() => undefined); await history.dispose(); throw cause; }
    });
    this.pending = run.catch(() => undefined);
    return run;
  }

  /** Called before the editor replaces a Document, while its old authority is still available. */
  async prepareProjectChange(): Promise<void> {
    this.changing = true; this.experiences?.cancelSuggestions(); this.changed();
    const run = this.pending.then(async () => { this.changing = true; await this.releaseProject(); });
    this.pending = run.catch(() => undefined);
    await run;
  }

  async dispatch(value: unknown, signal?: AbortSignal): Promise<void> {
    this.assertActive();
    if (this.changing) throw new Error('项目记录正在切换，请稍后重试。');
    await this.pending;
    if (!this.host || this.changing) throw new Error('项目记录尚未就绪。');
    this.reviews?.cancelDeep();
    this.experiences?.cancelSuggestions();
    await this.host.dispatch(value, signal);
  }

  previewOwnership(): Readonly<{ revision: number; projectId: StableId | null; taskRuns: ReturnType<StudioConversationHost['previewTasks']> }> {
    this.assertActive();
    return { revision: this.revision, projectId: this.binding?.projectId ?? null, taskRuns: this.changing ? [] : this.host?.previewTasks() ?? [] };
  }

  replay(): ConversationReplaySnapshot & Readonly<{ projectId: StableId | null; historyStorage: 'project' | 'unsaved' | 'none' }> {
    this.assertActive();
    const snapshot = this.host?.replay() ?? { connection: 'connected' as const, busy: false, backendId: null, backends: [], taskAccounting: null, taskRuns: [], executionGraphs: [], events: [] };
    return Object.freeze({ ...snapshot, projectId: this.binding?.projectId ?? null, reviewRevision:this.reviewRevision, historyStorage: !this.binding?.projectId ? 'none' : this.binding.storageKey ? 'project' : 'unsaved', revision: this.revision, busy: snapshot.busy || this.changing });
  }

  subscribe(listener: () => void): Readonly<{ dispose(): void }> {
    this.assertActive(); this.listeners.add(listener);
    return Object.freeze({ dispose: () => { this.listeners.delete(listener); } });
  }
  subscribeAttention(listener: (change: ConversationAttentionChange) => void): Readonly<{ dispose(): void }> {
    this.assertActive(); this.attentionListeners.add(listener);
    return Object.freeze({ dispose: () => { this.attentionListeners.delete(listener); } });
  }
  cancelPending(reason?: string): void { this.experiences?.cancelSuggestions(); this.host?.cancelPending(reason); }

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

  async queryReviews(projectId: StableId, cursor?: string) {
    await this.pending; this.assertProject(projectId);
    if (!this.reviews) throw new Error('项目复盘尚未就绪。');
    const result = await this.reviews.list(cursor); this.assertProject(projectId); return result;
  }
  async readReview(projectId: StableId, taskId: StableId) {
    await this.pending; this.assertProject(projectId);
    if (!this.reviews) throw new Error('项目复盘尚未就绪。');
    const result = await this.reviews.read(taskId); this.assertProject(projectId); return result;
  }
  async deepenReview(projectId: StableId, taskId: StableId, signal: AbortSignal) {
    await this.pending; this.assertProject(projectId);
    if (!this.reviews) throw new Error('项目复盘尚未就绪。');
    this.experiences?.cancelSuggestions();
    const result = await this.reviews.deepen(taskId,signal); this.assertProject(projectId); return result;
  }
  async queryExperiences(projectId: StableId) {
    await this.pending; this.assertProject(projectId);
    if (!this.experiences) throw new Error('项目经验尚未就绪。');
    const result = await this.experiences.list(); this.assertProject(projectId); return result;
  }
  async queryExperienceArchive(projectId: StableId, cursor?: string) {
    await this.pending; this.assertProject(projectId);
    if (!this.experiences) throw new Error('项目经验尚未就绪。');
    const result = await this.experiences.archivePage(cursor); this.assertProject(projectId); return result;
  }
  archiveExperience(projectId: StableId, input: unknown, signal: AbortSignal) {
    return this.experienceChange(projectId,experience => experience.archive(input,signal));
  }
  adoptExperience(projectId: StableId, input: unknown, signal: AbortSignal) {
    return this.experienceChange(projectId, experience => experience.adopt(input,signal));
  }
  setExperienceReuse(projectId: StableId, input: unknown, signal: AbortSignal) {
    return this.experienceChange(projectId, experience => experience.setReuse(input,signal));
  }
  async queryExperienceEffects(projectId: StableId, cursor?: string, signal?: AbortSignal) {
    await this.pending; this.assertProject(projectId);
    if (!this.experiences) throw new Error('项目经验尚未就绪。');
    const result = await this.experiences.effects(cursor,signal); this.assertProject(projectId); return result;
  }
  async queryOptimizations(projectId: StableId, releaseId?: StableId, cursor?: string) {
    await this.pending; this.assertProject(projectId);
    if (!this.experiences) throw new Error('项目经验尚未就绪。');
    const result = await this.experiences.optimizations(releaseId,cursor); this.assertProject(projectId); return result;
  }
  optimizeExperiences(projectId: StableId, input: unknown, signal: AbortSignal) {
    return this.experienceChange(projectId, experience => experience.optimize(input,signal));
  }
  updateExperience(projectId: StableId, id: StableId, revision: number, enabled: boolean, draft: unknown, signal: AbortSignal) {
    return this.experienceChange(projectId, experience => experience.update(id,revision,enabled,draft,signal));
  }
  private experienceChange<T>(projectId: StableId, action: (store: ProjectExperiences) => Promise<T>): Promise<T> {
    const run = this.pending.then(async () => {
      this.assertProject(projectId); if (!this.experiences) throw new Error('项目经验尚未就绪。');
      const result = await action(this.experiences); this.assertProject(projectId); return result;
    });
    this.pending = run.then(() => undefined,() => undefined); return run;
  }

  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.disposed = true; this.changing = true;
      await this.pending; await this.releaseProject(); this.listeners.clear(); this.attentionListeners.clear();
    })();
  }

  private async releaseProject(): Promise<void> {
    const host = this.host; const history = this.history;
    const reviews = this.reviews; this.reviews = null;
    const experiences = this.experiences; this.experiences = null;
    if (host) this.settings = host.settings();
    this.hostSubscription?.dispose(); this.hostSubscription = null;
    this.host = null; this.history = null;
    try { await experiences?.dispose(); await reviews?.dispose(); await host?.dispose(); }
    finally { try { await history?.flush(); } finally { await history?.dispose(); } }
    this.changed();
  }
  private assertProject(projectId: StableId | null): void {
    this.assertActive();
    if (this.changing || projectId !== (this.binding?.projectId ?? null)) throw new Error('项目已切换，请重新读取执行记录。');
  }
  private assertActive(): void { if (this.disposed) throw new Error('Project conversation controller is disposed.'); }
  private changed(): void {
    if (!this.changing && !this.disposed) { this.reviews?.observe(); this.experiences?.observeSuggestions(); }
    const changes = !this.disposed && !this.changing && this.host && this.binding?.projectId && this.binding.documentId
      ? this.attention.update(this.binding.projectId, this.binding.documentId, this.host.replay()) : this.attention.reset();
    for (const change of changes) for (const listener of this.attentionListeners) { try { listener(change); } catch { /* Notifications cannot own task outcomes. */ } }
    this.notifyViews();
  }
  private notifyViews(): void {
    this.revision += 1;
    if (!this.disposed) for (const listener of this.listeners) { try { listener(); } catch { /* View observers cannot own transitions. */ } }
  }
}
