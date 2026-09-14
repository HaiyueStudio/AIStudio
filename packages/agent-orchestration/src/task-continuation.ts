import { verificationRoute } from './task-acceptance.js';
import type { ConversationTaskRunReadModel } from '@haiyue/ai-studio-shell/conversation';

/** A bounded checkpoint, not a full scene snapshot or another copy of the task contract. */
export function taskContinuationRequest(run: ConversationTaskRunReadModel): string {
  const pending = run.acceptance.filter(item => item.required && (item.status !== 'pass' || item.evidenceIds.length === 0));
  const checkpoint: Record<string, unknown> = {
    taskId: run.taskId, request: run.requestSummary.slice(0, 1000), documentRevision: run.documentRevision, status: run.status,
    requiredRemaining: pending.length, retainedEvidenceCount: run.evidence.length,
    criteria: [], omittedCriteria: pending.length,
  };
  const criteria: unknown[] = [];
  for (const item of pending) {
    const next = { verification: verificationRoute(item), id: item.id, label: item.label.slice(0, 160), assertion: item.assertion.slice(0, 512), assertionTruncated: item.assertion.length > 512, status: item.status, diagnostic: item.diagnostic?.slice(0, 200) ?? null };
    if (Buffer.byteLength(JSON.stringify({ ...checkpoint, criteria: [...criteria, next] })) > 6144) break;
    criteria.push(next);
  }
  checkpoint.criteria = criteria; checkpoint.omittedCriteria = pending.length - criteria.length;
  // Keep compatible evidence references across approval/model turns. Do not mix
  // different Play instances or imply that a retained preview is still running.
  const current = run.evidence.filter(item => item.provenanceStatus === 'current' && item.documentRevision === run.documentRevision);
  const latest = current.at(-1);
  const retained: unknown[] = [];
  for (const item of current.filter(item => item.playId === latest?.playId).slice(-16).reverse()) {
    const next = { id: item.id, type: item.type, tick: item.tick, playId: item.playId };
    if (Buffer.byteLength(JSON.stringify({ ...checkpoint, retainedEvidence: [...retained, next] })) > 6144) break;
    retained.push(next);
  }
  if (retained.length) checkpoint.retainedEvidence = retained;
  return [
    'Continue the same approved task from the current project checkpoint; a completed backend turn is not a completed game.',
    JSON.stringify(checkpoint),
    'Check the current revision once; scope any missing reads to affected entities/scripts. Reuse known tool schemas and documentation until an API question or validation error requires another lookup. Preserve completed work; do not recreate the project or request the same plan again.',
    'If the next operation requires approval, invoke that tool so Studio can present the actual approval request. Do not stop merely because a future operation may need approval; never bypass or broaden approval scope.',
    'Use retained compatible evidence for task.evaluate before repeating tests. For evidence selection errors, correct ids using the approved criterion ids and included observationIds; do not restart Play. Validate/start Play only when fresh tests are needed. Missing signal paths require checking the producer payload, not editing correct gameplay. Stop Play after testing. Do not weaken approved criteria or invent passing evidence.',
  ].join('\n\n');
}

export function incompleteAcceptanceDetail(run: ConversationTaskRunReadModel): string {
  const pending = run.acceptance.filter(item => item.required && (item.status !== 'pass' || item.evidenceIds.length === 0));
  return `任务尚未验收完成：${pending.length} 项必需标准未通过，已保留 ${run.evidence.length} 份证据。${pending.slice(0, 3).map(item => item.label).join('；')}。继续将从当前项目开启新的执行回合，补齐工作与验收，不重放旧工具调用。`;
}
