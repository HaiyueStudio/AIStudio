import { parseAgentReview, type AgentHistoryDetailV1, type AgentReviewFindingV1, type AgentReviewV1, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, redactObject, sha256 } from '@haiyue/ai-studio-operation-log';
import type { ConversationTaskRunReadModel } from '@haiyue/ai-studio-shell/conversation';

export const REVIEW_RULE_VERSION = '1.0.0';
export function analyzeTaskReview(projectId: StableId, task: ConversationTaskRunReadModel, input: readonly AgentHistoryDetailV1[], missing = 0, partial = false): AgentReviewV1 {
  const records = [...new Map(input.map(d => [d.record.id, d])).values()].sort((a,b) => a.record.startedAt.localeCompare(b.record.startedAt) || a.record.id.localeCompare(b.record.id));
  const findings: AgentReviewFindingV1[] = [];
  const groups = new Map<string, AgentHistoryDetailV1[]>();
  const calls = new Map<string, AgentHistoryDetailV1>();
  for (const item of records) {
    if (!['tool-call','tool-result'].includes(item.record.kind)) continue;
    const data = object(item.data);
    const callId = data.toolCallId ?? object(data.result).callId;
    const key = `${item.record.sessionId}:${item.record.turnId}:${typeof callId === 'string' ? callId : item.record.id}`;
    if (!calls.has(key) || item.record.kind === 'tool-result') calls.set(key, item);
  }
  let failed = 0, cancelled = 0, suspended = 0, repeatedFailures = 0;
  const add = (code: string, title: string, detail: string, recommendation: string, rows: readonly AgentHistoryDetailV1[], severity: AgentReviewFindingV1['severity'] = 'warning'): void => {
    if (findings.length < 22) findings.push({ code, title, detail, recommendation, severity, recordIds: rows.slice(0, 8).map(d => d.record.id) });
  };
  for (const item of calls.values()) {
    const data = object(item.data), result = object(data.result), value = object(result.value), error = object(result.error);
    if (value.code === 'barrier.waiting-user' && value.preserved === true || error.code === 'barrier.waiting-user') { suspended++; continue; }
    if (item.record.status === 'cancelled') { cancelled++; continue; }
    if (item.record.status !== 'failed') continue;
    failed++;
    const diagnostic = object(result.diagnostic);
    const code = String(value.code ?? error.code ?? diagnostic.code ?? result.code ?? data.code ?? 'unknown');
    const key = `${item.record.toolId ?? 'unknown'} · ${code}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  for (const [key, rows] of groups) {
    const repeated = rows.length > 1; repeatedFailures += Math.max(0, rows.length - 1);
    add(repeated ? 'repeated-tool-failure' : 'tool-failure', `${repeated ? '重复失败' : '工具失败'}：${key}`, `观察到 ${rows.length} 次失败调用；调用与结果仅计一次。`, /arguments|payload|schema|revision|stale/iu.test(key) ? '调用前读取工具参数约束及当前版本；先修正参数或重新读取状态，再决定是否重试。' : '查看引用记录中的参数与错误结果，先确认根因；不要无条件重复调用。', rows);
  }
  const environmental = records.filter(d => d.record.kind === 'diagnostic' && /(?:codex\.(?:server|transport|auth)|network|timeout|rate.limit|session\.sequence|backend\.unavailable)/iu.test(String(object(d.data).code ?? '')));
  if (environmental.length) add('environment', '运行环境或连接异常', `${environmental.length} 条相关诊断；不据此判定游戏功能或 Agent 能力失败。`, '先检查连接、认证及会话状态，恢复后从已有进度继续。', environmental);
  const reads = new Map<string, AgentHistoryDetailV1[]>();
  let mutationEpoch = 0;
  for (const d of calls.values()) {
    if (!['tool.search','project.snapshot','engine.capabilities.describe'].includes(d.record.toolId ?? '')) { mutationEpoch++; continue; }
    if (d.record.status !== 'completed') continue;
    const key = `${mutationEpoch}:${d.record.toolId}:${canonicalStringify(object(d.data).parameters ?? null)}`;
    reads.set(key, [...(reads.get(key) ?? []), d]);
  }
  for (const rows of reads.values()) if (rows.length >= 3) add('repeated-read', `重复读取：${rows[0]!.record.toolId}`, `连续阶段内相同参数成功读取 ${rows.length} 次。这是可检查的低效线索，不代表调用一定无用。`, '检查能否复用当前版本的已有结果；版本或权限变化后仍应重新读取。', rows, 'info');
  const userMessages = records.filter(d => d.record.kind === 'text' && object(d.data).role === 'user');
  if (userMessages.length > 1) add('user-follow-up', '用户补充了需求', `该任务包含 ${userMessages.length} 条用户输入；仅记录补充事实，不自动推断为纠错。`, '复核后续输入是否已合并进计划与验收条件。', userMessages.slice(1), 'info');
  const unverified = task.acceptance.filter(a => a.required && a.status !== 'pass');
  if (unverified.length) add('acceptance-incomplete', '验收尚未全部通过', `${unverified.length} 项必需验收未通过，任务状态为 ${task.status}。`, '依据保留的验收证据定位缺口；完成复测前不要将其作为成功经验复用。', []);
  if (['blocked','failed'].includes(task.status) && task.terminalDiagnostic) add('task-stopped', '任务未完成', task.terminalDiagnostic.slice(0,2000), '先查看结束时的诊断和已完成产物，再决定如何恢复。', records.filter(d => d.record.kind === 'diagnostic').slice(-8));
  if (task.status === 'completed' && task.acceptance.length && !unverified.length) add('verified-completion', '任务的必需验收已通过', `${task.acceptance.filter(a => a.required).length} 项必需验收通过；本报告没有额外执行测试。`, '可人工整理为经验候选；只有在独立任务中复验后才考虑复用。', records.filter(d => d.record.kind === 'completion').slice(-1), 'info');
  const slow = [...calls.values()].filter(d => (d.record.durationMs ?? 0) >= 30_000);
  const unresolved = [...calls.values()].filter(d => ['pending','streaming'].includes(d.record.status));
  if (unresolved.length) add('unresolved-call', '部分调用缺少最终结果', `${unresolved.length} 次调用没有保留可确认的结束结果；不能判定已成功或失败。`, '查看任务中断与会话诊断，核对实际项目状态，避免重复执行结果不明的写入。', unresolved);
  if (slow.length) add('slow-call', '存在耗时较长的工具调用', `${slow.length} 次调用耗时至少 30 秒（可能包含等待，不能直接归因于工具性能）。`, '结合执行时间与等待审批记录，区分正常等待、网络耗时与可优化操作。', slow, 'info');
  const wanted = new Set(findings.flatMap(f => f.recordIds));
  const selected = [...records.filter(d => wanted.has(d.record.id)), ...records.filter(d => !wanted.has(d.record.id))].slice(0, 300);
  const allowed = new Set(selected.map(d => d.record.id));
  const sourceDigest = sha256(canonicalStringify({ ruleVersion: REVIEW_RULE_VERSION, taskId: task.taskId, revision: task.revision, records: records.map(d => [d.record.id, d.record.dataArtifactId, d.record.status]), missing, partial }));
  const report: AgentReviewV1 = {
    schemaVersion: 1, ruleVersion: REVIEW_RULE_VERSION, projectId, taskId: task.taskId, taskRevision: task.revision, title: task.title,
    outcome: task.status as AgentReviewV1['outcome'], generatedAt: new Date().toISOString(), sourceDigest,
    coverage: { records: records.length, missing, partial: partial || missing > 0 || records.some(d => object(d.data).legacyRecord === true), omittedEvidence: Math.max(0, records.length - selected.length) },
    metrics: { toolCalls: calls.size, failed, cancelled, suspended, repeatedFailures, userMessages: userMessages.length, durationMs: Math.max(0, Date.parse(task.updatedAt) - Date.parse(task.startedAt)), repairs: task.repairIteration },
    findings: findings.map(f => ({ ...f, recordIds: f.recordIds.filter(id => allowed.has(id)) })),
    evidence: selected.map(({record:r}) => ({ recordId:r.id, kind:r.kind, toolId:r.toolId, status:r.status, startedAt:r.startedAt, durationMs:r.durationMs })), deep:null,
  };
  return parseAgentReview(redactObject(report as unknown as JsonObject).value);
}
function object(value: unknown): JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}; }
