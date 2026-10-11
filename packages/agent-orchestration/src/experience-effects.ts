import { validateAgentTurnConfig } from '@haiyue/ai-studio-agent-runtime';
import { asStableId, parseAgentReview, parseExperienceEffects, parseExperienceOptimizationState, parseExperienceHistoryQuery, parseExperienceSelection, type ExperienceEffectsV1, type ExperienceEffectGroupV1, type StableId } from '@haiyue/ai-studio-contracts';
import { scanRetainedEvents, sha256, type ConversationOperationLog, type DurableOperationEvent } from '@haiyue/ai-studio-operation-log';
import { normalizeTaskAccounting, normalizeTaskRun } from '@haiyue/ai-studio-shell/conversation';

/** Rebuild from the portable project journal. Never infer exposure from a release date. */
export async function readExperienceEffects(log: ConversationOperationLog, projectId: StableId, signal: AbortSignal, cursor?: string): Promise<ExperienceEffectsV1> {
  parseExperienceHistoryQuery({projectId,...(cursor ? {cursor} : {})});
  const sequence = log.status().nextSequence;
  const [revision,offset] = cursor ? cursor.split(':').map(Number) : [sequence,0];
  if (revision !== sequence || !Number.isSafeInteger(offset)) throw new Error('任务记录已变化，请刷新对比。');
  const reviews = new Map<string,DurableOperationEvent>(), runs = new Map<string,DurableOperationEvent>(), accounts = new Map<string,DurableOperationEvent>();
  const releaseRefs = new Map<string,DurableOperationEvent>(), releaseLabels = new Map<string,string>(), releaseLibraries = new Map<string,StableId>();
  const turns = new Map<string,Map<string,DurableOperationEvent>>(), exposures = new Map<string,Map<string,DurableOperationEvent>>();
  for await (const e of scanRetainedEvents(log,['agent/task-review','conversation/task-projected','agent/task-accounting','agent/conversation-indexed','agent/task-turn-bound','agent/experience-optimization-updated'],0)) {
    signal.throwIfAborted();
    if (e.sequence < sequence && e.kind === 'agent/experience-optimization-updated' && e.correlation.projectId === projectId && typeof e.payload.activeReleaseId === 'string') releaseRefs.set(e.payload.activeReleaseId,e);
    if (e.sequence >= sequence || typeof e.payload.taskId !== 'string' || e.correlation.projectId && e.correlation.projectId !== projectId) continue;
    const id = e.payload.taskId;
    if (e.kind === 'agent/task-review') { reviews.delete(id); reviews.set(id,e); }
    if (e.kind === 'agent/task-accounting') accounts.set(id,e);
    if (e.kind === 'conversation/task-projected') runs.set(id,e);
    if (e.kind === 'agent/task-turn-bound' && e.payload.schemaVersion === 1) {
      if (e.correlation.sessionId && e.correlation.turnId) {
        if (!turns.has(id)) turns.set(id,new Map()); turns.get(id)!.set(`${e.correlation.sessionId}/${e.correlation.turnId}`,e);
      }
    }
    if (e.kind === 'agent/conversation-indexed' && e.correlation.sessionId && e.correlation.turnId) {
      if (!exposures.has(id)) exposures.set(id,new Map()); exposures.get(id)!.set(`${e.correlation.sessionId}/${e.correlation.turnId}`,e);
    }
  }
  if (offset! > reviews.size) throw new Error('对比页码无效。');
  const groups = new Map<string,Mutable<ExperienceEffectGroupV1>>(), records: ExperienceEffectsV1['records'][number][] = [];
  let excluded = 0, unreadable = 0, position = 0;
  for (const [taskId,event] of [...reviews].reverse()) {
    signal.throwIfAborted(); const inPage = position >= offset! && position < offset!+20; position++;
    let report;
    try {
      report = parseAgentReview((await log.readArtifact(required(event))).value);
      if (report.projectId !== projectId || report.taskId !== taskId || report.taskRevision !== event.payload.taskRevision || report.sourceDigest !== event.payload.sourceDigest) throw new Error('review mismatch');
    } catch { unreadable++; continue; }
    let note = '', key: string | null = null; const ids = new Set<StableId>();
    try {
      const runEvent = runs.get(taskId); if (!runEvent) throw new Error('缺少任务状态记录');
      const run = normalizeTaskRun((await log.readArtifact(required(runEvent))).value);
      if (run.taskId !== taskId || run.revision !== report.taskRevision || run.revision !== runEvent.payload.revision || run.status !== runEvent.payload.status || run.status !== report.outcome) throw new Error('任务已继续执行或复盘尚未更新');
      if (report.coverage.partial || report.coverage.missing || log.status().retainedFromSequence > 0) throw new Error('任务证据不完整');
      const expected = turns.get(taskId), actual = exposures.get(taskId);
      if (!expected?.size || !actual?.size || !expected.has(`${run.sessionId}/${run.turnId}`) || [...expected.keys()].some(t => !actual.has(t)) || [...actual.keys()].some(t => !expected.has(t))) throw new Error('缺少部分回合的版本归属记录（旧任务或中断回合）');
      for (const bound of expected.values()) {
        const config = validateAgentTurnConfig(bound.payload.config);
        if (config.backendId !== run.backendId || config.model !== run.model.id || config.reasoningEffort !== run.model.reasoningEffort || config.outputTokenLimit !== run.model.outputTokenLimit || config.promptProfile.digest !== run.promptProfile.digest) throw new Error('任务跨模型或提示配置，未计入单一版本样本');
      }
      const versions = new Map<string,string>();
      for (const e of actual.values()) {
        signal.throwIfAborted();
        const attribution = e.payload.experienceAttribution;
        if (!object(attribution) || attribution.schemaVersion !== 1 || !('artifactId' in attribution) || e.payload.backendId !== run.backendId) throw new Error('缺少可靠的经验版本归属记录');
        if (attribution.artifactId === null) { versions.set('none','未引用经验'); continue; }
        if (typeof attribution.artifactId !== 'string' || !e.artifactRefs.includes(asStableId(attribution.artifactId))) throw new Error('经验引用证据缺失');
        const raw = (await log.readArtifact(asStableId(attribution.artifactId))).value;
        if (!object(raw)) throw new Error('经验引用证据损坏');
        const selection = parseExperienceSelection(raw.selection);
        if (selection.projectId !== projectId) throw new Error('经验引用属于其他项目');
        if (!selection.entries.length) { versions.set('none','未引用经验'); continue; }
        selection.entries.forEach(entry => ids.add(entry.experience.id));
        if (selection.releaseId && !releaseLabels.has(selection.releaseId)) {
          const releaseEvent = releaseRefs.get(selection.releaseId); if (!releaseEvent) throw new Error('版本发布记录缺失');
          const state = parseExperienceOptimizationState((await log.readArtifact(required(releaseEvent))).value);
          const release = state.releases.find(r => r.id === selection.releaseId);
          if (state.projectId !== projectId || !release || release.libraryArtifactId !== selection.libraryArtifactId) throw new Error('版本与经验库证据不一致');
          releaseLabels.set(release.id,`v${release.number} · ${release.title}`); releaseLibraries.set(release.id,release.libraryArtifactId);
        }
        if (selection.releaseId && releaseLibraries.get(selection.releaseId) !== selection.libraryArtifactId) throw new Error('版本与经验库证据不一致');
        const version = selection.releaseId ?? `draft:${selection.libraryRevision}:${selection.libraryArtifactId}`;
        versions.set(version,selection.releaseId ? releaseLabels.get(selection.releaseId)! : `未发布经验库 · 修订 ${selection.libraryRevision}`);
      }
      if (versions.size !== 1) throw new Error('任务跨版本，或混合了引用与未引用经验的回合');
      const [version,label] = [...versions][0]!;
      key = sha256(JSON.stringify([version,run.backendId,run.model.id,run.model.reasoningEffort,run.model.outputTokenLimit,run.promptProfile.digest]));
      let group = groups.get(key);
      if (!group) { group = {key,label,backend:run.backendId,model:`${run.model.id} · ${run.model.reasoningEffort} · 提示配置 ${run.promptProfile.digest.slice(7,15)}`,tasks:0,completed:0,failed:0,blocked:0,cancelled:0,toolCalls:0,toolFailures:0,repeatedFailures:0,repairs:0,durationMs:0,inputTokens:0,outputTokens:0,tokenSamples:0,environmentTasks:0}; groups.set(key,group); }
      group.tasks++; group[report.outcome]++; group.toolCalls+=report.metrics.toolCalls; group.toolFailures+=report.metrics.failed;
      group.repeatedFailures+=report.metrics.repeatedFailures; group.repairs+=report.metrics.repairs; group.durationMs+=report.metrics.durationMs;
      if (report.findings.some(f => f.code === 'environment')) group.environmentTasks++;
      try {
        const accountingEvent = accounts.get(taskId);
        if (!accountingEvent || accountingEvent.sequence < Math.max(...[...actual.values()].map(e => e.sequence))) throw new Error('no accounting');
        const account = normalizeTaskAccounting((await log.readArtifact(required(accountingEvent))).value);
        if (account?.taskId === taskId && account.cost.final && account.usage.inputTokens !== null && account.usage.outputTokens !== null) {
          group.inputTokens+=account.usage.inputTokens; group.outputTokens+=account.usage.outputTokens; group.tokenSamples++;
        }
      } catch { /* Missing usage stays unknown and has its own denominator. */ }
      note = `${label} · ${run.backendId} / ${run.model.id}`;
    } catch (cause) { excluded++; note = cause instanceof Error ? cause.message : '证据无法读取'; }
    if (inPage) records.push({report,reviewArtifactId:required(event),groupKey:key,note,experienceIds:[...ids].slice(0,300)});
  }
  signal.throwIfAborted();
  if (log.status().nextSequence !== sequence) throw new Error('任务记录已变化，请刷新对比。');
  return parseExperienceEffects({schemaVersion:1,projectId,generatedAt:new Date().toISOString(),sequence,total:reviews.size,excluded,unreadable,groups:[...groups.values()],records,nextCursor:offset!+20<reviews.size ? `${sequence}:${offset!+20}` : null});
}
type Mutable<T> = {-readonly [K in keyof T]: T[K]};
function object(value: unknown): value is Record<string,unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function required(e: DurableOperationEvent): StableId { if (!e.artifactRefs[0]) throw new Error('记录缺少内容'); return e.artifactRefs[0]; }
