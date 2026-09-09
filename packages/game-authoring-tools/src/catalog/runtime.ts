import { asStableId, type ComponentDefinitionV2, type JsonObject, type M13StableId, type StableId } from '@haiyue/ai-studio-contracts';
import { LocalHashEmbeddingProvider, tokenize } from '@haiyue/ai-studio-agent-runtime';
import type { GameToolDefinition } from '../types.js';
import { MODEL_TOOL_INVOKE_DEFINITION } from './invocation.js';

export const MODEL_CORE_TOOL_IDS: readonly StableId[] = Object.freeze([
  'project.snapshot', 'scene.query', 'scene.diff', 'scene.get-many', 'tool.search',
  'engine.capabilities.describe', 'component.describe', 'diagnostics.query', 'history.query', 'task.evaluate',
].map((id) => asStableId(id)));

export interface ToolCatalogMatch {
  readonly kind: 'tool' | 'component';
  readonly id: StableId;
  readonly title: string;
  readonly capabilityGroup: string;
  readonly score: number;
  readonly reason: string;
  readonly nextTool: StableId;
  readonly effect: string;
  readonly risk: string;
  readonly version?: string;
  readonly requiresApproval?: boolean;
  readonly inputSchema?: JsonObject;
  readonly invocation?: Readonly<{ tool: StableId; toolId: StableId; toolVersion: string }>;
}

export interface ToolSchemaSelection {
  readonly definitions: readonly GameToolDefinition[];
  readonly selectedIds: readonly StableId[];
  readonly coreIds: readonly StableId[];
  readonly expandedIds: readonly StableId[];
  readonly omittedCount: number;
  readonly fixedSchemaBytes: number;
  readonly selectedSchemaBytes: number;
}

interface CapabilityGroup { readonly id: string; readonly aliases: readonly string[]; readonly toolPrefixes: readonly string[]; readonly capabilities: readonly string[]; }

const GROUPS: readonly CapabilityGroup[] = Object.freeze([
  group('behavior', ['behavior', 'logic', 'provenance', 'event', 'explain', '行为', '逻辑', '来源', '事件', '解释'], ['behavior.'], ['behavior']),
  group('scene', ['scene', 'entity', 'hierarchy', 'prefab', '场景', '实体', '层级', '预制体'], ['scene.', 'entity.', 'prefab.'], ['scene', 'hierarchy']),
  group('spatial', ['transform', 'position', 'rotation', 'scale', 'align', 'layout', '变换', '位置', '旋转', '缩放', '对齐', '布局'], ['transform.'], ['transform']),
  group('camera', ['camera', 'view', 'framing', 'orbit', 'follow', 'viewport', '相机', '视角', '镜头', '取景'], ['camera.'], ['camera']),
  group('interaction', ['input', 'keyboard', 'mouse', 'pointer', 'touch', 'gamepad', 'interaction', '输入', '键盘', '鼠标', '触控', '交互'], ['play.input'], ['input']),
  group('gameplay', ['gameplay', 'state', 'trigger', 'score', 'spawn', 'reset', '玩法', '状态', '触发', '计分', '生成', '重开'], ['play.', 'script.'], ['gameplay']),
  group('physics', ['physics', 'collision', 'gravity', 'body', 'raycast', 'overlap', '物理', '碰撞', '重力', '刚体', '射线'], ['play.physics-', 'component.'], ['physics']),
  group('presentation', ['render', 'light', 'material', 'shadow', 'particle', 'effect', 'hud', 'ui', '渲染', '灯光', '材质', '阴影', '粒子', '特效', '界面'], ['material.', 'camera.', 'component.', 'play.capture'], ['render', 'ui']),
  group('assets', ['asset', 'texture', 'model', 'audio', 'animation', '资源', '纹理', '模型', '音频', '动画'], ['asset.'], ['asset']),
  group('validation', ['validate', 'diagnostic', 'preview', 'capture', 'evidence', 'evaluate', '验证', '诊断', '预览', '截图', '证据', '验收'], ['diagnostics.', 'preview.', 'play.inspect', 'play.capture', 'task.evaluate'], ['validation']),
]);

export class ToolCatalogRuntime {
  private readonly embedding = new LocalHashEmbeddingProvider(128);
  private readonly byId: ReadonlyMap<StableId, GameToolDefinition>;
  constructor(private readonly tools: readonly GameToolDefinition[], private readonly components: () => readonly ComponentDefinitionV2[]) {
    this.byId = new Map(tools.map((definition) => [definition.id, definition]));
  }

  search(text: string, options: Readonly<{ limit?: number; includeSchemas?: boolean }> = {}): readonly ToolCatalogMatch[] {
    const query = text.trim(); const limit = options.limit ?? 12;
    if (!query || query.length > 512 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError('Tool catalog query is invalid.');
    return this.rank(query, limit, options.includeSchemas ?? false);
  }

  // Internal task selection receives complete prompts and approved plans, not bounded tool.search arguments.
  private rank(query: string, limit: number, includeSchemas: boolean): readonly ToolCatalogMatch[] {
    const queryTokens = new Set(tokenize(query)); const queryVector = this.embedding.embed(query);
    const toolMatches = this.tools.map((definition) => {
      const group = capabilityGroup(`${definition.id} ${definition.requiredCapabilities.join(' ')}`);
      const candidate = `${definition.id} ${definition.title} ${definition.description} ${definition.requiredCapabilities.join(' ')} ${group.aliases.join(' ')}`;
      const score = semanticScore(query.toLocaleLowerCase(), queryTokens, queryVector, candidate, this.embedding);
      return Object.freeze({ kind: 'tool' as const, id: definition.id, title: definition.title, capabilityGroup: group.id, score, reason: reason(score, group.id), nextTool: definition.id, effect: definition.effect, risk: definition.risk, version: definition.version, requiresApproval: definition.requiresApproval, ...(includeSchemas ? { inputSchema: definition.inputSchema, invocation: Object.freeze({ tool: MODEL_TOOL_INVOKE_DEFINITION.id, toolId: definition.id, toolVersion: definition.version }) } : {}) });
    });
    const componentMatches = this.components().map((definition) => {
      const group = capabilityGroup(`${definition.type} ${definition.capability} ${definition.editor.category}`);
      const candidate = `${definition.type} ${definition.capability} ${definition.editor.label} ${definition.editor.category} ${group.aliases.join(' ')}`;
      const score = semanticScore(query.toLocaleLowerCase(), queryTokens, queryVector, candidate, this.embedding);
      return Object.freeze({ kind: 'component' as const, id: definition.type as StableId, title: definition.editor.label, capabilityGroup: group.id, score, reason: reason(score, group.id), nextTool: asStableId('component.describe'), effect: definition.effect, risk: definition.risk, version: definition.version });
    });
    return Object.freeze([...toolMatches, ...componentMatches].filter((entry) => entry.score > 0.05).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, limit));
  }

  selectDefinitions(request: string, expandedIds: readonly StableId[] = [], limit = 18): ToolSchemaSelection {
    if (!Number.isSafeInteger(limit) || limit < MODEL_CORE_TOOL_IDS.length || limit > 40) throw new TypeError('Tool schema selection limit is invalid.');
    const selected = new Set<StableId>(MODEL_CORE_TOOL_IDS.filter((id) => this.byId.has(id)));
    for (const id of expandedIds) if (this.byId.has(id)) selected.add(id);
    for (const id of explicitIntentToolIds(request)) if (this.byId.has(id) && selected.size < limit) selected.add(id);
    for (const match of this.rank(request.trim() || 'project inspect', Math.max(limit, 24), false)) if (match.kind === 'tool' && selected.size < limit) selected.add(match.id);
    const definitions = Object.freeze(this.tools.filter((definition) => selected.has(definition.id)));
    const fixedSchemaBytes = this.tools.reduce((sum, definition) => sum + schemaBytes(definition), 0);
    const selectedSchemaBytes = definitions.reduce((sum, definition) => sum + schemaBytes(definition), 0);
    return Object.freeze({ definitions, selectedIds: Object.freeze(definitions.map((entry) => entry.id)), coreIds: MODEL_CORE_TOOL_IDS, expandedIds: Object.freeze(expandedIds.filter((id) => selected.has(id))), omittedCount: this.tools.length - definitions.length, fixedSchemaBytes, selectedSchemaBytes });
  }
}

function explicitIntentToolIds(request: string): readonly StableId[] {
  const lower = request.toLocaleLowerCase();
  const ids: StableId[] = [];
  if (/\b(?:screenshot|screen-shot|capture)\b|截图|截屏/u.test(lower)) ids.push(asStableId('play.capture'));
  if (/\b(?:input|keyboard|pointer|touch|mouse|gamepad)\b|输入|键盘|触控|鼠标|点击|拖拽/u.test(lower)) ids.push(asStableId('play.input'));
  return Object.freeze(ids);
}

function semanticScore(query: string, queryTokens: ReadonlySet<string>, queryVector: readonly number[], candidate: string, embedding: LocalHashEmbeddingProvider): number {
  const lower = candidate.toLocaleLowerCase();
  const candidateTokens = new Set(tokenize(lower));
  let overlap = 0; for (const token of queryTokens) if (candidateTokens.has(token)) overlap += 1;
  const lexical = queryTokens.size ? overlap / queryTokens.size : 0;
  const substring = lower.includes(query) ? 1 : 0;
  const vector = Math.max(0, cosine(queryVector, embedding.embed(lower)));
  return Math.min(1, substring * 0.45 + lexical * 0.35 + vector * 0.2);
}
function capabilityGroup(candidate: string): CapabilityGroup { const lower = candidate.toLocaleLowerCase(); return GROUPS.map((entry) => ({ entry, score: [...entry.toolPrefixes, ...entry.capabilities, ...entry.aliases].filter((token) => lower.includes(token)).length })).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))[0]?.entry ?? GROUPS[0]!; }
function group(id: string, aliases: readonly string[], toolPrefixes: readonly string[], capabilities: readonly string[]): CapabilityGroup { return Object.freeze({ id, aliases: Object.freeze([...aliases]), toolPrefixes: Object.freeze([...toolPrefixes]), capabilities: Object.freeze([...capabilities]) }); }
function reason(score: number, groupId: string): string { return `registry-owned hybrid match ${score.toFixed(4)} in capability group ${groupId}`; }
function schemaBytes(definition: GameToolDefinition): number { return Buffer.byteLength(JSON.stringify({ id: definition.id, description: definition.description, inputSchema: definition.inputSchema })); }
function cosine(left: readonly number[], right: readonly number[]): number { let score = 0; for (let index = 0; index < Math.min(left.length, right.length); index += 1) score += left[index]! * right[index]!; return Math.max(-1, Math.min(1, score)); }
