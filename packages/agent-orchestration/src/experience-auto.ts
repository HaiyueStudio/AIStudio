import { asStableId, parseAgentReview, parseExperienceAutoStatus, parseExperienceSuggestion, type AgentExperienceV1, type AgentReviewV1, type ExperienceAutoStatusV1, type ExperienceSuggestionV1, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import { scanRetainedEvents, type ConversationOperationLog } from '@haiyue/ai-studio-operation-log';

export interface ExperienceAnalysisResult {
  readonly value: ExperienceSuggestionV1;
  readonly metadata: Omit<NonNullable<AgentReviewV1['deep']>,'summary'|'findings'>;
}
interface AutoOptions {
  projectId: StableId; log: ConversationOperationLog;
  busy(): boolean;
  snapshot(): Promise<{revision:number;libraryRevision:number;candidate:boolean;entries:readonly AgentExperienceV1[]}>;
  read(taskId: StableId): Promise<AgentReviewV1>;
  analyze(report: AgentReviewV1, entries: readonly AgentExperienceV1[], signal: AbortSignal): Promise<ExperienceAnalysisResult>;
  apply(report: AgentReviewV1, result: ExperienceAnalysisResult, revision: number, libraryRevision: number, signal: AbortSignal): Promise<boolean>;
  flush(): Promise<void>; changed(): void;
}

/** Event-driven work owned by the project scope. No polling and no automatic retries. */
export class AutoExperienceCandidates {
  private readonly abort = new AbortController();
  private current: AbortController | null = null;
  private pending: Promise<void> | null = null;
  private requested = false;
  private cursor = 0;
  private epoch = 0;
  private ready = false;
  private readonly attempted = new Set<string>();
  private readonly queued = new Map<StableId,Pick<AgentReviewV1,'taskId'|'taskRevision'|'sourceDigest'> & {artifactId:StableId}>();
  private status: ExperienceAutoStatusV1;
  constructor(private readonly options: AutoOptions) {
    this.status = {schemaVersion:1,projectId:options.projectId,taskId:null,sourceDigest:null,taskRevision:0,status:'idle',summary:'任务结束后，有新增完整证据时自动整理；候选需人工验证和发布。',usageLabel:null};
  }
  async initialize(): Promise<void> {
    try { await this.restore(); this.ready = true; }
    catch {
      this.abort.signal.throwIfAborted();
      this.status = {...this.status,status:'failed',summary:'自动整理记录无法读取，已停止自动分析；请检查或恢复项目记录。'};
    }
  }
  private async restore(): Promise<void> {
    let enabled = false;
    for await (const event of scanRetainedEvents(this.options.log,['agent/experience-ai-enabled','agent/experience-ai-status'],0)) {
      this.abort.signal.throwIfAborted(); if (event.correlation.projectId !== this.options.projectId) continue;
      if (event.kind === 'agent/experience-ai-enabled') {
        if (event.payload.schemaVersion !== 1) throw new Error('自动整理版本不兼容。');
        if (!enabled) this.cursor = event.sequence+1; enabled = true;
      }
      else {
        const status = parseExperienceAutoStatus(event.payload);
        if (status.projectId !== this.options.projectId) throw new Error('自动整理记录与项目不一致。');
        this.status = status;
        if (status.taskId) this.attempted.add(key(status));
      }
    }
    if (!enabled) {
      const event = await this.options.log.append({kind:'agent/experience-ai-enabled',source:asStableId('studio.experience'),severity:'info',correlation:{projectId:this.options.projectId},payload:{schemaVersion:1},artifactRefs:[]},{signal:this.abort.signal});
      this.cursor = event.sequence+1; await this.options.flush();
    }
    if (this.status.status === 'running') this.status = {...this.status,status:'cancelled',summary:'上次自动整理被中断；相同证据不会重复调用模型。'};
  }
  view(): ExperienceAutoStatusV1 { return structuredClone(this.status); }
  observe(): void {
    if (!this.ready || this.abort.signal.aborted) return;
    if (this.options.busy()) { this.cancel(); return; }
    this.requested = true;
    if (this.pending) return;
    this.pending = this.drain().catch(() => {
      if (!this.abort.signal.aborted) { this.status = {...this.status,status:'failed',summary:'自动整理未完成，原有经验与候选保持不变。'}; this.options.changed(); }
    }).finally(() => { this.pending = null; });
  }
  cancel(): void { this.epoch++; this.current?.abort(); }
  async dispose(): Promise<void> { this.abort.abort(); this.cancel(); await this.pending; }
  private async drain(): Promise<void> {
    while (this.requested && !this.abort.signal.aborted && !this.options.busy()) {
      this.requested = false;
      const epoch = this.epoch;
      const upper = this.options.log.status().nextSequence;
      for await (const event of scanRetainedEvents(this.options.log,['agent/task-review'],this.cursor)) {
        if (event.sequence >= upper) break;
        this.abort.signal.throwIfAborted(); if (event.correlation.projectId !== this.options.projectId || !event.artifactRefs[0]) continue;
        const {taskId,taskRevision,sourceDigest} = event.payload;
        if (typeof taskId !== 'string' || !Number.isSafeInteger(taskRevision) || Number(taskRevision) < 0 || typeof sourceDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(sourceDigest)) throw new Error('复盘索引无效。');
        const ref = {taskId:asStableId(taskId),taskRevision:Number(taskRevision),sourceDigest,artifactId:event.artifactRefs[0]};
        // Keep only the newest reference per task. Never hydrate already-attempted reports.
        if (this.attempted.has(key(ref))) this.queued.delete(ref.taskId);
        else this.queued.set(ref.taskId,ref);
      }
      this.cursor = upper;
      if (!this.queued.size || this.options.busy()) return;
      const state = await this.options.snapshot();
      if (state.candidate) {
        this.status = {...this.status,status:'waiting',summary:'已有待审阅候选；新增证据已保留，发布或放弃后继续整理。'}; this.options.changed(); return;
      }
      const ref = this.queued.values().next().value!;
      this.queued.delete(ref.taskId);
      const report = parseAgentReview((await this.options.log.readArtifact(ref.artifactId)).value);
      if (report.projectId !== this.options.projectId || key(report) !== key(ref)) throw new Error('复盘来源不一致。');
      if (report.coverage.partial || report.coverage.missing || !report.findings.slice(0,12).some(f => f.recordIds.length)) { this.requested ||= this.queued.size > 0; continue; }
      const current = await this.options.read(report.taskId);
      if (key(current) !== key(report)) { this.requested = this.queued.size > 0; continue; }
      if (this.options.busy() || epoch !== this.epoch) { this.queued.set(report.taskId,ref); return; }
      const controller = new AbortController(); this.current = controller;
      const signal = AbortSignal.any([controller.signal,this.abort.signal]);
      let applied = false;
      try {
        signal.throwIfAborted();
        await this.record(report,'running','正在根据新增任务证据整理候选…',null,signal);
        this.attempted.add(key(report));
        const result = await this.options.analyze(report,state.entries,signal);
        signal.throwIfAborted(); parseExperienceSuggestion(result.value);
        const latest = await this.options.read(report.taskId);
        if (key(latest) !== key(report) || this.options.busy()) throw new Error('来源已变化。');
        const artifact = await this.options.log.putArtifact({schemaVersion:1,report,result} as unknown as JsonObject,{schemaVersion:'agent-experience-suggestion/1'});
        signal.throwIfAborted();
        applied = result.value.proposals.length ? await this.options.apply(report,result,state.revision,state.libraryRevision,signal) : false;
        await this.record(report,applied ? 'completed':'none',result.value.summary,result.metadata.usageLabel,signal,[artifact.id,result.metadata.accountingArtifactId]);
      } catch {
        // Never persist arbitrary backend exception text (it may contain credentials).
        if (!this.abort.signal.aborted) await this.record(report,applied ? 'completed' : controller.signal.aborted ? 'cancelled':'failed',applied ? '候选已保存；整理收尾被中断，请审阅候选。' : controller.signal.aborted ? '整理已取消；相同证据不会重复调用模型。' : '整理失败或来源已变化，未生成新候选。用量记录已按项目保存。',null,this.abort.signal);
      } finally { this.current = null; }
      this.requested ||= this.queued.size > 0;
    }
  }
  private async record(report: AgentReviewV1, status: ExperienceAutoStatusV1['status'], summary: string, usageLabel: string | null, signal: AbortSignal, refs: StableId[] = []): Promise<void> {
    const next = parseExperienceAutoStatus({schemaVersion:1,projectId:this.options.projectId,taskId:report.taskId,taskRevision:report.taskRevision,sourceDigest:report.sourceDigest,status,summary,usageLabel});
    await this.options.log.append({kind:'agent/experience-ai-status',source:asStableId('studio.experience'),severity:status === 'failed' ? 'warning':'info',correlation:{projectId:this.options.projectId},payload:next as unknown as JsonObject,artifactRefs:refs},{signal});
    this.status = next; this.attempted.add(key(report)); await this.options.flush(); this.options.changed();
  }
}
function key(report: {taskId:StableId | null;taskRevision:number;sourceDigest:string | null}): string { return `${report.taskId}:${report.taskRevision}:${report.sourceDigest}`; }
