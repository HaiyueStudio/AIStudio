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
  return [
    'Continue the same approved task from the current project checkpoint; a completed backend turn is not a completed game.',
    JSON.stringify(checkpoint),
    'Re-inspect the authoritative project revision and finish only the missing work. Preserve completed entities, resources and scripts; do not recreate the project or request the same plan again.',
    'If the next operation requires approval, invoke that tool so Studio can present the actual approval request. Do not stop merely because a future operation may need approval; never bypass or broaden approval scope.',
    'Validate scripts, start authorized Play, exercise the required interactions, collect readable same-revision evidence, and call task.evaluate. Inspect its per-criterion results (including any omitted above), repair supported failures within budget, and stop Play after testing. Do not weaken approved criteria or invent passing evidence.',
  ].join('\n\n');
}

export function incompleteAcceptanceDetail(run: ConversationTaskRunReadModel): string {
  const pending = run.acceptance.filter(item => item.required && (item.status !== 'pass' || item.evidenceIds.length === 0));
  return `任务尚未验收完成：${pending.length} 项必需标准未通过，已保留 ${run.evidence.length} 份证据。${pending.slice(0, 3).map(item => item.label).join('；')}。继续将从当前项目开启新的执行回合，补齐工作与验收，不重放旧工具调用。`;
}
