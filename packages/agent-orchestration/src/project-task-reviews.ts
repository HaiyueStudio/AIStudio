import { parseExperienceHistoryQuery, asStableId, parseAgentReview, type AgentHistoryDetailV1, type AgentHistoryRecordV1, type AgentReviewV1, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import { scanRetainedEvents, type ConversationOperationLog, type DurableOperationEvent } from '@haiyue/ai-studio-operation-log';
import type { ConversationTaskRunReadModel } from '@haiyue/ai-studio-shell/conversation';
import { analyzeTaskReview, REVIEW_RULE_VERSION } from './task-review-rules.js';

export interface TaskReviewOptions {
  readonly projectId: StableId;
  readonly log: ConversationOperationLog;
  snapshot(): Readonly<{busy:boolean;taskRuns:readonly ConversationTaskRunReadModel[]}>;
  flush(): Promise<void>;
  changed(): void;
  deepen(report: AgentReviewV1, signal: AbortSignal): Promise<NonNullable<AgentReviewV1['deep']>>;
}
/** Per-project, derived reports stored in the existing portable operation journal. */
export class ProjectTaskReviews {
  private readonly index = new Map<StableId,DurableOperationEvent>();
  private indexPromise: Promise<void> | null = null;
  private listRevision = 0;
  private readonly reports = new Map<StableId, AgentReviewV1>();
  private readonly abort = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private initialized = false;
  private requested = false;
  private scheduled = false;
  private error: string | null = null;
  private version = 0;
  private deep: { controller: AbortController; promise: Promise<AgentReviewV1> } | null = null;
  constructor(private readonly options: TaskReviewOptions) {}

  observe(): void {
    if (this.abort.signal.aborted) return;
    if (this.options.snapshot().busy) { this.cancelDeep(); return; }
    this.requested = true;
    if (this.scheduled) return;
    this.scheduled = true;
    this.tail = this.tail.then(async () => {
      const previousVersion = this.version, previousError = this.error, initialized = this.initialized;
      try { while (this.requested && !this.abort.signal.aborted) { this.requested = false; this.error = null; await this.refresh(); } }
      catch (cause) { if (!this.abort.signal.aborted) this.error = cause instanceof Error ? cause.message : '复盘生成失败'; }
      finally { this.scheduled = false; if (previousVersion !== this.version || previousError !== this.error || initialized !== this.initialized) this.options.changed(); }
    });
  }
  async list(cursor?: string) {
    parseExperienceHistoryQuery({projectId:this.options.projectId,...(cursor ? {cursor} : {})});
    this.observe(); await this.tail; await this.initializeIndex(); this.abort.signal.throwIfAborted();
    const [revision,offset] = cursor ? cursor.split(':').map(Number) : [this.listRevision,0];
    if (revision !== this.listRevision || !Number.isSafeInteger(offset) || offset > this.index.size) throw new Error('复盘列表已变化，请返回第一页。');
    const items = [...this.index.entries()].sort((a,b) => b[1].sequence-a[1].sequence), records = [];
    for (const [taskId,event] of items.slice(offset,offset+50)) {
      try { const r = await this.loadReport(taskId); records.push({taskId:r.taskId,taskRevision:r.taskRevision,title:r.title,outcome:r.outcome,generatedAt:r.generatedAt,findingCount:r.findings.length,hasDeep:r.deep !== null}); }
      catch { records.push({taskId,taskRevision:0,title:'无法读取的历史复盘',outcome:'unknown',generatedAt:event.timestamp,findingCount:0,hasDeep:false}); this.error = '部分历史复盘损坏或版本不兼容，原记录已保留。'; }
    }
    this.abort.signal.throwIfAborted();
    return {projectId:this.options.projectId,error:this.error,records,total:items.length,nextCursor:offset+50 < items.length ? String(revision)+':'+String(offset+50) : null};
  }
  async read(taskId: StableId): Promise<AgentReviewV1> { await this.tail; await this.initializeIndex(); return this.loadReport(taskId); }
  private initializeIndex(): Promise<void> {
    return this.indexPromise ??= (async () => {
      for await (const event of scanRetainedEvents(this.options.log,['agent/task-review'],0)) {
        this.abort.signal.throwIfAborted(); if (event.correlation.projectId !== this.options.projectId) continue;
        if (typeof event.payload?.taskId !== 'string') { this.error = '部分历史复盘索引无效，原记录已保留。'; continue; }
        const taskId = asStableId(event.payload.taskId); this.index.set(taskId,event); this.listRevision = Math.max(this.listRevision,event.sequence+1);
      }
      this.initialized = true;
    })();
  }
  private async loadReport(taskId: StableId): Promise<AgentReviewV1> {
    this.abort.signal.throwIfAborted();
    const cached = this.reports.get(taskId); if (cached) return cached;
    const event = this.index.get(taskId); if (!event) throw new Error('此任务的规则复盘尚未生成，请等待任务结束后刷新。');
    if (!event.artifactRefs[0]) throw new Error('历史复盘内容缺失，原记录已保留。');
    const report = parseAgentReview((await this.options.log.readArtifact(event.artifactRefs[0])).value); this.abort.signal.throwIfAborted();
    if (report.projectId !== this.options.projectId || report.taskId !== taskId || report.taskRevision !== event.payload.taskRevision || report.sourceDigest !== event.payload.sourceDigest) throw new Error('历史复盘与项目来源不一致。');
    if (this.index.get(taskId) !== event) return this.loadReport(taskId);
    this.cache(report); return report;
  }
  private cache(report: AgentReviewV1): void {
    this.reports.delete(report.taskId); this.reports.set(report.taskId,report);
    while (this.reports.size > 100) this.reports.delete(this.reports.keys().next().value!);
  }
  async deepen(taskId: StableId, signal: AbortSignal): Promise<AgentReviewV1> {
    if (this.deep) throw new Error('已有深度复盘正在执行。');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once:true });
    if (signal.aborted) abort();
    const promise = (async () => {
      const report = await this.read(taskId);
      controller.signal.throwIfAborted();
      this.assertCurrent(report);
      const result = await this.options.deepen(report, controller.signal);
      controller.signal.throwIfAborted(); this.abort.signal.throwIfAborted();
      this.assertCurrent(report);
      if (this.reports.get(taskId)?.sourceDigest !== report.sourceDigest) throw new Error('任务证据已变化，请刷新后重新复盘。');
      const next = parseAgentReview({ ...report, deep: result });
      await this.save(next, controller.signal);
      this.options.changed(); return next;
    })();
    this.deep = { controller, promise };
    try { return await promise; } finally { signal.removeEventListener('abort', abort); if (this.deep?.controller === controller) this.deep = null; }
  }
  cancelDeep(): void { this.deep?.controller.abort(); }
  async dispose(): Promise<void> { this.abort.abort(); this.cancelDeep(); await Promise.allSettled([this.tail, ...(this.deep ? [this.deep.promise] : [])]); }

  private assertCurrent(report: AgentReviewV1): void {
    const snapshot = this.options.snapshot(), task = snapshot.taskRuns.find(r => r.taskId === report.taskId);
    if (snapshot.busy || task && (task.revision !== report.taskRevision || !['completed','failed','blocked','cancelled'].includes(task.status))) throw new Error('任务仍在执行或证据已变化，请等待任务结束并刷新复盘。');
  }

  private async refresh(): Promise<void> {
    if (this.options.snapshot().busy) return;
    await this.options.flush(); this.abort.signal.throwIfAborted();
    if (this.options.snapshot().busy) return;
    await this.initializeIndex();
    const tasks = [];
    for (const task of this.options.snapshot().taskRuns ?? []) {
      if (!['completed','failed','blocked','cancelled'].includes(task.status)) continue;
      let previous: AgentReviewV1 | null = null;
      if (this.index.has(task.taskId)) {
        try { previous = await this.loadReport(task.taskId); }
        catch { this.error = '部分历史复盘损坏或版本不兼容，原记录已保留。'; continue; }
      }
      if (previous?.taskRevision !== task.revision || previous?.ruleVersion !== REVIEW_RULE_VERSION) tasks.push(task);
    }
    if (!tasks.length) return;
    const taskIds = new Set(tasks.map(task => task.taskId));
    const turns = new Map<string, StableId>(), truncated = new Set<StableId>();
    for await (const event of scanRetainedEvents(this.options.log,['conversation/task-projected'],0)) {
      this.abort.signal.throwIfAborted();
      if (event.correlation.projectId === this.options.projectId && typeof event.payload.taskId === 'string' && taskIds.has(event.payload.taskId as StableId) && event.correlation.turnId) turns.set(event.correlation.sessionId+':'+event.correlation.turnId,event.payload.taskId as StableId);
    }
    const byTask = new Map<StableId, Map<StableId, AgentHistoryRecordV1>>();
    for await (const event of scanRetainedEvents(this.options.log,['agent/execution-record'],0)) {
      this.abort.signal.throwIfAborted(); if (event.correlation.projectId !== this.options.projectId) continue;
      const raw = event.payload.record;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const record = raw as unknown as AgentHistoryRecordV1;
      if (record.projectId !== this.options.projectId || typeof record.id !== 'string' || typeof record.dataArtifactId !== 'string') continue;
      const taskId = typeof event.payload.taskId === 'string' ? event.payload.taskId as StableId : turns.get(record.sessionId+':'+record.turnId);
      if (!taskId || !taskIds.has(taskId)) continue;
      let items = byTask.get(taskId); if (!items) byTask.set(taskId,items = new Map()); items.delete(record.id); items.set(record.id,record);
      if (items.size > 5000) { items.delete(items.keys().next().value!); truncated.add(taskId); }
    }
    for (const task of tasks) {
      this.abort.signal.throwIfAborted(); if (this.options.snapshot().busy) return;
      const records = [...(byTask.get(task.taskId)?.values() ?? [])];
      const details: AgentHistoryDetailV1[] = []; let missing = 0, bytes = 0;
      const bounded = records.slice(-5000);
      for (const [index,record] of bounded.entries()) {
        this.abort.signal.throwIfAborted();
        try {
          const data = (await this.options.log.readArtifact(record.dataArtifactId)).value;
          bytes += Buffer.byteLength(JSON.stringify(data),'utf8');
          if (bytes > 8 * 1024 * 1024) { missing += bounded.length - index; break; }
          details.push({ schemaVersion:1, projectId:this.options.projectId, record, data });
        }
        catch { missing++; }
      }
      const report = analyzeTaskReview(this.options.projectId,task,details,missing,this.options.log.status().retainedFromSequence > 0 || truncated.has(task.taskId) || !records.length);
      if (this.options.snapshot().busy || this.options.snapshot().taskRuns?.find(r => r.taskId === task.taskId)?.revision !== task.revision) continue;
      await this.save(report, this.abort.signal);
    }
  }
  private async save(report: AgentReviewV1, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); this.abort.signal.throwIfAborted();
    const artifact = await this.options.log.putArtifact(report as unknown as JsonObject, { schemaVersion:'agent-task-review/1' });
    signal.throwIfAborted(); this.abort.signal.throwIfAborted();
    const event = await this.options.log.append({ kind:'agent/task-review', severity:'info', source:asStableId('studio.task-review'), correlation:{projectId:this.options.projectId}, payload:{taskId:report.taskId, taskRevision:report.taskRevision, sourceDigest:report.sourceDigest}, artifactRefs:[artifact.id, ...(report.deep ? [report.deep.accountingArtifactId] : [])] }, {signal});
    this.index.set(report.taskId,event); this.listRevision = Math.max(this.listRevision,event.sequence+1); this.cache(report);
    this.version++;
  }
}
