import { asStableId, type StableId, type JsonObject, type TaskSpecV2, type ObservationArtifactV2, type EvaluationResultV2 } from '@haiyue/ai-studio-contracts';
import type { TaskAccount } from '@haiyue/ai-studio-agent-runtime';
import { BoundedPlaytestTask, PlaytestLoopError } from '@haiyue/ai-studio-game-authoring-tools';
import { sha256 } from '@haiyue/ai-studio-operation-log';
import { normalizeTaskAccounting, type ConversationTaskPhase, type ConversationTaskRunReadModel, type ConversationTaskAcceptanceReadModel, type ConversationTaskAccountingReadModel } from '@haiyue/ai-studio-shell/conversation';
import type { PlanAcceptanceProposal } from './plan-policy.js';
import { isRecord } from './value-utils.js';

let taskTimelineSequence = 0;
export function taskTimeline(phase: ConversationTaskPhase, status: 'active' | 'complete' | 'warning' | 'error', title: string, detail: string, coordinates: Readonly<{ turnId?: StableId | null; toolCallId?: StableId | null; playId?: StableId | null; tick?: number | null }> = {}): ConversationTaskRunReadModel['timeline'][number] {
  taskTimelineSequence += 1; const at = new Date().toISOString();
  return Object.freeze({ id: asStableId(`timeline:${sha256(`${at}:${taskTimelineSequence}:${title}`).slice(7, 31)}`), at, phase, status, title: title.slice(0, 160), detail: detail.slice(0, 1_024), turnId: coordinates.turnId ?? null, toolCallId: coordinates.toolCallId ?? null, playId: coordinates.playId ?? null, tick: coordinates.tick ?? null });
}
export function taskTitle(prompt: string): string { const first = prompt.trim().split(/\r?\n/u)[0] ?? 'Agent task'; return first.length > 80 ? `${first.slice(0, 77)}…` : first || 'Agent task'; }
export function acceptanceReadModel(value: PlanAcceptanceProposal, id: StableId): ConversationTaskAcceptanceReadModel { return Object.freeze({ id, label: value.label, assertion: value.assertion, category: value.category, required: value.required, visibility: 'agent', status: 'pending', evidenceIds: Object.freeze([]), diagnostic: null }); }
export function acceptanceLabel(assertion: string): string {
  const match = /^evidence ([a-z-]+)/u.exec(assertion); return match ? `${match[1]} 验收` : '验收标准';
}
export function taskSpecFromPlan(active: Readonly<{ taskId: StableId; goal: string; account: TaskAccount }>, acceptance: readonly PlanAcceptanceProposal[]): TaskSpecV2 {
  const criteria = acceptance.map((item, index) => Object.freeze({ id: asStableId(`acceptance:${active.taskId}:${index + 1}`), required: item.required, visibility: 'agent' as const, category: item.category, assertion: item.assertion }));
  const requiredCapabilities = new Set<TaskSpecV2['requiredCapabilities'][number]>(['task.evaluate']);
  for (const item of acceptance) {
    if (/^evidence screenshot/u.test(item.assertion)) requiredCapabilities.add('play.capture');
    if (/^evidence (?:state|event-trace|runtime-errors|performance|visual-analysis|lifecycle)/u.test(item.assertion)) requiredCapabilities.add('play.inspect');
  }
  return Object.freeze({ schemaVersion: 2, id: active.taskId, request: active.goal.slice(0, 20_000), visibleConstraints: Object.freeze([]), budgetId: active.account.options.budget.id, requiredCapabilities: Object.freeze([...requiredCapabilities]), acceptance: Object.freeze(criteria) });
}
export function taskSpecFromRun(run: ConversationTaskRunReadModel): TaskSpecV2 {
  const requiredCapabilities = new Set<TaskSpecV2['requiredCapabilities'][number]>(['task.evaluate']);
  for (const item of run.acceptance) { if (item.category === 'visual') requiredCapabilities.add('play.capture'); else requiredCapabilities.add('play.inspect'); }
  return Object.freeze({ schemaVersion: 2, id: run.taskId, request: run.requestSummary, visibleConstraints: Object.freeze([]), budgetId: asStableId(`budget:${run.taskId}`), requiredCapabilities: Object.freeze([...requiredCapabilities]), acceptance: Object.freeze(run.acceptance.map((item) => Object.freeze({ id: item.id, required: item.required, visibility: item.visibility, category: item.category, assertion: item.assertion }))) });
}
export function productPhaseForTool(toolId: StableId): Extract<ConversationTaskPhase, 'editing' | 'validating' | 'playing' | 'evaluating'> | null {
  if (toolId === 'preview.validate') return 'validating';
  if (toolId === 'preview.start' || toolId === 'play.start' || toolId === 'play.step' || toolId === 'play.input' || toolId === 'play.pointer-gesture' || toolId === 'play.inspect' || toolId === 'play.capture' || toolId === 'play.stop' || toolId === 'preview.stop') return 'playing';
  if (toolId === 'task.evaluate') return 'evaluating';
  if (['entity.create', 'entity.rename', 'transform.set', 'material.set', 'component.add', 'component.update', 'component.remove', 'script.apply', 'script.propose', 'camera.set'].includes(toolId)) return 'editing';
  return null;
}
export function productToolTitle(toolId: StableId): string {
  if (toolId === 'task.evaluate') return '正在逐项验收';
  if (toolId.startsWith('play.') || toolId.startsWith('preview.')) return '正在运行与采集证据';
  return '正在编辑项目';
}
export function advancePlaytest(playtest: BoundedPlaytestTask, target: Extract<ConversationTaskPhase, 'editing' | 'validating' | 'playing' | 'evaluating'>): void {
  // Rechecking a preview is an observation, not a rollback into an editable phase.
  // Keep the evidence/repair lifecycle at its current stage.
  if (target === 'validating' && ['playing', 'evaluating'].includes(playtest.snapshot().phase)) return;
  for (let guard = 0; guard < 5 && playtest.snapshot().phase !== target; guard += 1) {
    const phase = playtest.snapshot().phase;
    if (phase === 'planning' || phase === 'repairing' || phase === 'evaluating' && target === 'editing') playtest.advance('editing');
    else if (phase === 'editing' && target !== 'editing') playtest.advance('validating');
    else if (phase === 'validating' && target === 'editing') playtest.advance('editing');
    else if (phase === 'validating' && (target === 'playing' || target === 'evaluating')) playtest.advance('playing');
    else if (phase === 'playing' && target === 'evaluating') playtest.advance('evaluating');
    else break;
  }
  if (playtest.snapshot().phase !== target) throw new PlaytestLoopError('task.transition-invalid', `Cannot enter ${target} from ${playtest.snapshot().phase}.`);
}
export function observationArtifacts(value: JsonObject): readonly ObservationArtifactV2[] {
  const candidates: unknown[] = [];
  if (isRecord(value.observation)) candidates.push(value.observation);
  if (Array.isArray(value.observations)) candidates.push(...value.observations);
  const values: ObservationArtifactV2[] = [];
  for (const item of candidates) {
    if (!isRecord(item) || item.schemaVersion !== 2 || !['state', 'event-trace', 'runtime-errors', 'performance', 'screenshot', 'visual-analysis', 'lifecycle'].includes(String(item.type))
      || typeof item.id !== 'string' || typeof item.taskId !== 'string' || typeof item.turnId !== 'string' || typeof item.playId !== 'string' || !Number.isSafeInteger(item.documentRevision)
      || !Number.isSafeInteger(item.tick) || !Number.isSafeInteger(item.frame) || typeof item.capturedAt !== 'string' || !Number.isSafeInteger(item.byteLength) || typeof item.producerVersion !== 'string') continue;
    values.push(item as unknown as ObservationArtifactV2);
  }
  return Object.freeze(values);
}
export function evaluationResult(value: JsonObject, taskId: StableId): EvaluationResultV2 {
  if (value.schemaVersion !== 2 || value.taskId !== taskId || typeof value.id !== 'string' || !['pass', 'fail', 'blocked'].includes(String(value.status)) || !Array.isArray(value.acceptanceResults)
    || !Array.isArray(value.usageRecordIds) || !Array.isArray(value.costRecordIds) || typeof value.completedAt !== 'string' || typeof value.evaluatorVersion !== 'string') throw new PlaytestLoopError('task.evaluation-invalid', 'Evaluator returned an invalid task result.');
  const results = value.acceptanceResults.map((item) => {
    if (!isRecord(item) || typeof item.acceptanceId !== 'string' || !['pass', 'fail', 'blocked'].includes(String(item.status)) || !Array.isArray(item.evidenceIds) || !item.evidenceIds.every((id) => typeof id === 'string')) throw new PlaytestLoopError('task.evaluation-invalid', 'Evaluator returned an invalid acceptance result.');
    return Object.freeze({ acceptanceId: asStableId(item.acceptanceId), status: item.status as 'pass' | 'fail' | 'blocked', evidenceIds: Object.freeze(item.evidenceIds.map((id) => asStableId(id as string))), diagnostic: typeof item.diagnostic === 'string' ? item.diagnostic.slice(0, 512) : null });
  });
  return Object.freeze({ schemaVersion: 2, id: asStableId(value.id), taskId, evaluatorVersion: value.evaluatorVersion.slice(0, 96), status: value.status as EvaluationResultV2['status'], acceptanceResults: Object.freeze(results), budgetStatus: ['within', 'soft-exceeded', 'hard-exceeded'].includes(String(value.budgetStatus)) ? value.budgetStatus as EvaluationResultV2['budgetStatus'] : 'within', usageRecordIds: Object.freeze((value.usageRecordIds as unknown[]).filter((id): id is string => typeof id === 'string').map((id) => asStableId(id))), costRecordIds: Object.freeze((value.costRecordIds as unknown[]).filter((id): id is string => typeof id === 'string').map((id) => asStableId(id))), turns: Object.freeze([]), tools: Object.freeze([]), completedAt: value.completedAt });
}
export function repairRequest(task: TaskSpecV2, evaluation: EvaluationResultV2, iteration: number): string {
  const failed = evaluation.acceptanceResults.filter((item) => item.status !== 'pass');
  return ['Continue the same visible task with a bounded evidence-led repair.', `Repair iteration: ${iteration}.`, `Failed acceptance: ${JSON.stringify(failed.map((item) => ({ acceptanceId: item.acceptanceId, evidenceIds: item.evidenceIds, diagnostic: item.diagnostic })))}`, 'Check whether a failed condition belongs to an earlier test stage: use task.evaluate acceptanceEvidence to select that stage’s retained observation (same Play and revision), rather than modifying correct gameplay or requiring playing and won at the same tick. Re-inspect the authoritative revision, change only causes supported by the cited evidence, run Play again as needed, collect fresh same-revision evidence (play.capture returns a matching screenshot/state bundle; use its observations together), and call task.evaluate with the approved criteria. Do not repeat an unchanged repair.'].join('\n');
}
export function taskAccountingProjection(snapshot: ReturnType<TaskAccount['reconcile']>): ConversationTaskAccountingReadModel {
  const value = normalizeTaskAccounting({ taskId: snapshot.taskId, budget: snapshot.budget, budgetStatus: snapshot.budgetDecision.status, usage: snapshot.usage, cost: snapshot.cost });
  if (!value) throw new Error('Task accounting projection is invalid.');
  return value;
}
