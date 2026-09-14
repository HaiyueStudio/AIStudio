import { toolFailureFeedback } from './tool-correction.js';
import { asStableId, type StableId, type JsonObject } from '@haiyue/ai-studio-contracts';
import { ConservativeTokenEstimator, type CompactionSummaryRequestV1 } from '@haiyue/ai-studio-agent-runtime';
import type { GameToolPreparation, GameToolApproval } from '@haiyue/ai-studio-game-authoring-tools';
import { canonicalStringify, sha256 } from '@haiyue/ai-studio-operation-log';
import type { ConversationIntent } from '@haiyue/ai-studio-shell/conversation';
import { PLAN_TOOL_ID } from './plan-policy.js';
import { isRecord, numberField } from './value-utils.js';

/** Only visible task facts and actual tool arguments; never infer a model's private reasoning. */
export function queryRequestDescription(toolId: string, args: JsonObject): string {
  const short = (value: unknown, max = 160) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : '';
  if (toolId === 'engine.docs.search') {
    const scope = ({ 'studio-script': '运行脚本 API', authoring: '编辑器创作工具', 'engine-native': '引擎原生 API', all: '全部引擎文档' } as Record<string, string>)[String(args.surface)] ?? '运行脚本与编辑器创作文档';
    return `引擎文档：${short(args.query) || '未提供搜索关键词'}；范围：${scope}`;
  }
  if (toolId === 'tool.search') return `工具能力：${short(args.text) || '未提供搜索关键词'}`;
  const scope = isRecord(args.scope) ? args.scope : {};
  const ids = Array.isArray(scope.entityIds) ? scope.entityIds : [];
  const sections = Array.isArray(args.projection) ? args.projection.join('、') : '场景概况';
  return `${toolId === 'scene.diff' ? '场景变化' : '场景数据'}：${short(sections, 100)}；范围：${ids.length ? `${ids.length} 个指定物体` : short(scope.sceneId) || '当前场景'}`;
}

export function queryAllowancePrompt(input: { toolId: string; requested: number; limit: number; goal: string; phase?: string; plan?: string; agentMessage?: string; queries: readonly string[] }): string {
  const short = (value: string, max: number) => { const text = value.replace(/\s+/gu, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
  const phase = ({ planning: '制定方案', editing: '编辑场景与脚本', validating: '检查代码', playing: '运行交互测试', evaluating: '逐项验收', repairing: '修复发现的问题' } as Record<string, string>)[input.phase ?? ''] ?? '检索任务所需信息';
  return [
    `本次希望查询 ${input.requested} 条，当前上限为 ${input.limit} 条。是否扩大查询额度？`,
    `当前任务：${short(input.goal || '当前创作任务', 240)}`,
    `当前阶段：${phase}`,
    ...(input.plan ? [`已确认方案：${short(input.plan, 180)}`] : []),
    input.agentMessage ? `AI 最近说明（公开内容节选）：${short(input.agentMessage, 360)}` : 'AI 尚未提供单独的查询原因；下方展示本次实际检索内容。',
    ...input.queries.slice(0, 4).map((query, index) => `${index ? '并行检索' : '本次检索'}：${short(query, 220)}`),
    ...(input.queries.length > 4 ? [`另有 ${input.queries.length - 4} 项并行检索沿用本次额度。`] : []),
    input.toolId === 'engine.docs.search' ? '数量表示匹配的文档条目，结果按大小分页返回；并非一次读取这些文档的全部正文。' : '结果按大小分页返回；更多结果会增加处理时间与上下文用量。',
    '选择按上限查询也会继续任务。同一任务中该工具不超过本次数量的查询将沿用你的选择。',
  ].join('\n');
}

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
  if (projection === 'digest-only') return Object.freeze({ status: typeof value.status === 'string' ? value.status : 'completed', projection, digest, byteLength, ...toolFailureFeedback(value) });
  const resultValue = isRecord(value.value) ? value.value : value;
  return Object.freeze({ status: typeof value.status === 'string' ? value.status : 'completed', projection, digest, byteLength, keys: Object.freeze(Object.keys(resultValue).sort().slice(0, 32)), ...toolFailureFeedback(value) });
}
export function toolArgumentSummary(toolId: StableId, args: JsonObject): string {
  const raw = args as Record<string, unknown>;
  if (toolId === PLAN_TOOL_ID) return `准备提交“${typeof raw.title === 'string' ? raw.title : '总体实现方案'}”供用户确认。`;
  if (toolId === 'entity.create') {
    const kind = String(raw.kind ?? 'entity');
    const category = ['cube', 'rounded-box', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron'].includes(kind) ? `几何体 ${kind}` : kind.endsWith('-light') ? `光源 ${kind}` : '逻辑节点';
    return `准备创建${category}${typeof raw.name === 'string' ? `“${raw.name}”` : ''}。`;
  }
  if (toolId === 'transform.set') return `更新 ${String(raw.entityId ?? '物体')} 的位置、旋转和缩放${isRecord(raw.transform) ? '：' + JSON.stringify(raw.transform).slice(0, 400) : ''}。`;
  if (toolId === 'material.set') return `为 ${String(raw.entityId ?? '选中的几何体')} 设置 ${String(raw.material ?? '引擎')} 材质${Array.isArray(raw.color) ? '，颜色 ' + raw.color.join(', ') : ''}。`;
  if (toolId === 'script.propose') return `校验 ${String(raw.entityId ?? '目标物体')} 的脚本提案，能力：${Array.isArray(raw.capabilities) ? raw.capabilities.join('、') : '默认'}。`;
  if (toolId === 'script.apply') return `提交已校验脚本提案 ${String(raw.proposalId ?? '')}。`;
  if (toolId === 'preview.validate') return '准备校验项目运行计划。';
  if (toolId === 'preview.start') return '准备启动隔离预览。';
  if (toolId === 'preview.stop') return '准备停止隔离预览。';
  const labels: Record<string, string> = { query: '检索', entityId: '对象', sceneId: '场景', name: '名称', type: '类型', kind: '种类', limit: '数量', count: '数量', assetId: '资源', action: '操作', ref: '文档引用', id: '文档', surface: '范围' };
  const fields = Object.entries(labels).flatMap(([key, label]) => typeof raw[key] === 'string' || typeof raw[key] === 'number' ? [`${label}：${String(raw[key]).slice(0, 240)}`] : []);
  return `${toolId}${fields.length ? ' · ' + fields.join(' · ') : ' · 当前项目'}。`;
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
    const warnings = diagnostics.filter((item) => isRecord(item) && item.severity === 'warning');
    if (!errors && warnings.length) return `脚本提案${proposal}编译通过，但有 ${warnings.length} 项警告：${warnings.slice(0, 2).map(item => isRecord(item) ? String(item.message ?? item.code).slice(0, 400) : '').join('；')}`;
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
  if (Array.isArray(raw.matches)) return `检索到 ${raw.matches.length} 项${raw.total !== undefined ? ` / 共 ${raw.total} 项` : ''}：${raw.matches.slice(0, 4).map(item => isRecord(item) ? String(item.title ?? item.name ?? item.id ?? '') : '').filter(Boolean).join('、')}`;
  if (Array.isArray(raw.entities)) return `返回 ${raw.entities.length} 个对象：${raw.entities.slice(0, 4).map(item => isRecord(item) ? String(item.name ?? item.id ?? '') : '').filter(Boolean).join('、')}`;
  if (typeof raw.title === 'string') return `已读取“${raw.title}”${Array.isArray(raw.blocks) ? ` · ${raw.blocks.length} 段文档` : ''}`;
  if (typeof raw.count === 'number') return `返回 ${raw.count} 项结果${raw.truncated === true ? '（已截断）' : ''}`;
  return fallback;
}
