import { asStableId, type StableId, type JsonObject } from '@haiyue/ai-studio-contracts';
import { ConservativeTokenEstimator, type CompactionSummaryRequestV1 } from '@haiyue/ai-studio-agent-runtime';
import type { GameToolPreparation, GameToolApproval } from '@haiyue/ai-studio-game-authoring-tools';
import { canonicalStringify, sha256 } from '@haiyue/ai-studio-operation-log';
import type { ConversationIntent } from '@haiyue/ai-studio-shell/conversation';
import { PLAN_TOOL_ID } from './plan-policy.js';
import { isRecord, numberField } from './value-utils.js';

export function approvalContent(preparation: GameToolPreparation, approval: GameToolApproval): JsonObject {
  return Object.freeze({
    approvalId: approval.approvalId, toolCallId: approval.toolCallId, toolId: approval.toolId, toolVersion: approval.toolVersion,
    target: approval.target, effect: approval.effect, risk: approval.risk, argumentsSummary: preparation.preview.summary,
    previewDiff: preparation.preview.diff, baseRevision: approval.baseRevision, argsDigest: presentationDigest(approval.argumentsDigest),
    previewDigest: presentationDigest(approval.previewDigest), ...(approval.expiresAt ? { expiresAt: approval.expiresAt } : {}),
    scope: approval.decision === 'allow-always' ? 'project-session' : 'operation', decision: approval.decision,
  });
}
export function presentationDigest(value: string): string { return value.startsWith('sha256:') ? value : `sha256:${value}`; }
export function intentLogPayload(intent: ConversationIntent): JsonObject {
  if (intent.type === 'conversation/send') return Object.freeze({ type: intent.type, backendId: intent.backendId, promptDigest: sha256(intent.prompt), promptBytes: Buffer.byteLength(intent.prompt) });
  return Object.freeze({
    type: intent.type,
    ...('backendId' in intent ? { backendId: intent.backendId } : {}),
    ...('approvalId' in intent ? { approvalId: intent.approvalId, decision: intent.decision } : {}),
    ...('sessionId' in intent ? { sessionId: intent.sessionId } : {}),
    ...('requestId' in intent ? { requestId: intent.requestId } : {}),
  });
}
export function localCompactionSummary(request: CompactionSummaryRequestV1): string {
  const estimator = new ConservativeTokenEstimator();
  const source = [
    'Session summary (local extractive fallback; consult retained evidence for exact values).',
    ...request.messages.map((message) => `[${message.role}] ${message.content.replace(/\s+/gu, ' ').trim()}`),
  ].join('\n');
  if (source.length === 0) return 'No compactable session content.';

  const targetTokens = Math.max(1, Math.min(request.targetSummaryTokens, request.maximumSummaryTokens));
  if (estimator.estimate(source, request.model) <= targetTokens) return source;

  const characters = [...source];
  let low = 1;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join('').trimEnd()}\n[summary truncated at a stable local boundary]`;
    if (estimator.estimate(candidate, request.model) <= targetTokens) low = middle;
    else high = middle - 1;
  }
  return `${characters.slice(0, low).join('').trimEnd()}\n[summary truncated at a stable local boundary]`;
}
export function questionOptions(value: unknown): readonly JsonObject[] {
  if (!Array.isArray(value)) return Object.freeze([Object.freeze({ id: asStableId('option:continue'), label: 'Continue' })]);
  return Object.freeze(value.slice(0, 8).map((_, index) => Object.freeze({ id: asStableId(`option:${index + 1}`), label: `Option ${index + 1}` })));
}
export function terminalStatus(value: unknown): 'completed' | 'cancelled' | 'failed' | 'interrupted' { return value === 'completed' || value === 'cancelled' || value === 'failed' || value === 'interrupted' ? value : 'failed'; }
export function completionSummary(status: 'completed' | 'cancelled' | 'failed' | 'interrupted', toolFacts: readonly string[], blockers: readonly string[]): string {
  const completed = toolFacts.length ? `Completed: ${toolFacts.join(' | ')}` : 'Completed: no Studio tool changes.';
  const incomplete = blockers.length ? ` Incomplete or blocked: ${blockers.join(' | ')}` : ' Incomplete or blocked: none.';
  return `${status}. ${completed}${incomplete}`.slice(0, 4_096);
}
export function boundedJson(value: JsonObject): string { const text = JSON.stringify(value); return text.length > 2_000 ? `${text.slice(0, 1_997)}...` : text; }
export function projectToolModelResult(value: JsonObject, projection: 'summary' | 'digest-only'): JsonObject {
  const serialized = canonicalStringify(value); const digest = sha256(serialized); const byteLength = Buffer.byteLength(serialized);
  if (projection === 'digest-only') return Object.freeze({ status: typeof value.status === 'string' ? value.status : 'completed', projection, digest, byteLength });
  const resultValue = isRecord(value.value) ? value.value : value;
  return Object.freeze({ status: typeof value.status === 'string' ? value.status : 'completed', projection, digest, byteLength, keys: Object.freeze(Object.keys(resultValue).sort().slice(0, 32)) });
}
export function toolArgumentSummary(toolId: StableId, args: JsonObject): string {
  const raw = args as Record<string, unknown>;
  if (toolId === PLAN_TOOL_ID) return `准备提交“${typeof raw.title === 'string' ? raw.title : '总体实现方案'}”供用户确认。`;
  if (toolId === 'entity.create') {
    const kind = String(raw.kind ?? 'entity');
    const category = ['cube', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron'].includes(kind) ? `几何体 ${kind}` : kind.endsWith('-light') ? `光源 ${kind}` : '逻辑节点';
    return `准备创建${category}${typeof raw.name === 'string' ? `“${raw.name}”` : ''}。`;
  }
  if (toolId === 'transform.set') return '准备更新物体的位置、旋转和缩放。';
  if (toolId === 'material.set') return '准备为选中的几何体应用引擎材质。';
  if (toolId === 'script.propose') return '准备校验一份新的控制脚本提案。';
  if (toolId === 'script.apply') return '准备提交已经通过校验的脚本。';
  if (toolId === 'preview.validate') return '准备校验项目运行计划。';
  if (toolId === 'preview.start') return '准备启动隔离预览。';
  if (toolId === 'preview.stop') return '准备停止隔离预览。';
  return `准备调用 ${toolId}。`;
}
export function toolResultSummary(toolId: StableId, status: 'completed' | 'rejected' | 'cancelled' | 'failed', value: JsonObject, fallback: string): string {
  const raw = value as Record<string, unknown>;
  if (status !== 'completed') {
    if (raw.decision === 'expired') return '授权已过期，操作未执行。请重新批准重新校验后的操作。';
    if (status === 'cancelled' || raw.decision === 'cancel') return '操作已取消，没有修改项目。';
    if (raw.decision === 'reject') return '操作已被拒绝，没有修改项目。';
    return `操作未执行：${fallback}`;
  }

  const entity = isRecord(raw.entity) ? raw.entity : null;
  const entityName = entity && typeof entity.name === 'string' ? `“${entity.name}”` : '物体';
  const revision = typeof raw.revision === 'number' ? ` · 项目 r${raw.revision}` : '';
  if (toolId === 'project.snapshot') return `已读取项目“${typeof raw.name === 'string' ? raw.name : '未命名'}” · r${typeof raw.revision === 'number' ? raw.revision : '?'}${raw.dirty === true ? ' · 有未保存修改' : ''}`;
  if (toolId === 'scene.list-entities') return `已读取场景 · ${Array.isArray(raw.entities) ? raw.entities.length : 0} 个物体${raw.truncated === true ? '（结果已截断）' : ''}`;
  if (toolId === 'entity.get') return `已读取${entityName}${revision}`;
  if (toolId === 'entity.create') return `已创建${entityName}${revision}`;
  if (toolId === 'entity.rename') return `已重命名为${entityName}${revision}`;
  if (toolId === 'transform.set') return `已更新${entityName}的 Transform${revision}`;
  if (toolId === 'material.set') return `已更新${entityName}的材质${revision}`;
  if (toolId === 'script.get') {
    const script = isRecord(raw.script) ? raw.script : null;
    return `已读取脚本${script && typeof script.name === 'string' ? `“${script.name}”` : ''}${script && typeof script.textRevision === 'number' ? ` · 文本 r${script.textRevision}` : ''}`;
  }
  if (toolId === 'diagnostics.query') return `已读取 ${typeof raw.count === 'number' ? raw.count : 0} 条诊断记录。`;
  if (toolId === 'script.propose') {
    const diagnostics = Array.isArray(raw.diagnostics) ? raw.diagnostics : [];
    const errors = diagnostics.filter((item) => isRecord(item) && item.severity === 'error').length;
    const proposal = typeof raw.proposalId === 'string' ? ` ${raw.proposalId}` : '';
    return errors > 0 ? `脚本提案${proposal}有 ${errors} 个错误，提案已保留，需要修改后重新校验。` : `脚本提案${proposal}校验通过并已保留 · +${numberField(raw.addedLines)}/-${numberField(raw.removedLines)} 行`;
  }
  if (toolId === 'script.apply') return `脚本已提交${typeof raw.textRevision === 'number' ? ` · 文本 r${raw.textRevision}` : ''}${revision}`;
  if (toolId === 'preview.validate') {
    const diagnostics = Array.isArray(raw.diagnostics) ? raw.diagnostics : [];
    const errors = diagnostics.filter((item) => isRecord(item) && item.severity === 'error').length;
    return errors > 0 ? `运行计划校验失败 · ${errors} 个错误` : '运行计划校验通过。';
  }
  if (toolId === 'preview.start') return '隔离预览已启动。';
  if (toolId === 'preview.stop') return '隔离预览已停止并完成资源清理。';
  return fallback;
}
