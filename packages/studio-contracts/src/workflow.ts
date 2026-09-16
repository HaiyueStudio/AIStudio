import type { JsonObject } from './index.js';

/** Advisory plan metadata. Only Host registry and validated arguments authorize work. */
export type PlanTaskV1 = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly inputs: readonly string[];
  readonly artifacts: readonly string[];
  readonly readScopes: readonly string[];
  readonly writeScopes: readonly string[];
  readonly verification: readonly string[];
  readonly budget: Readonly<{ toolCalls: number; wallTimeMs: number }>;
  readonly estimatedWorkMs: number | null;
}

/** Complete admission envelope; arguments are literal, never output-binding expressions. */
export interface ToolBatchInputV1 {
  readonly schemaVersion: 1;
  readonly nodes: readonly Readonly<{
    id: string;
    toolId: string;
    toolVersion: string;
    arguments: JsonObject;
    dependsOn: readonly string[];
    estimatedWorkMs: number | null;
    onFailure: 'cancel-dependents' | 'stop-batch';
  }>[];
}

const idSchema = { type: 'string', minLength: 3, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]+$' };
const refsSchema = { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 512 } };
const estimateSchema = { anyOf: [{ type: 'integer', minimum: 1, maximum: 60_000 }, { type: 'null' }] };
export const PLAN_TASK_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'id', 'dependsOn', 'inputs', 'artifacts', 'readScopes', 'writeScopes', 'verification', 'budget', 'estimatedWorkMs'],
  properties: { schemaVersion: { const: 1 }, id: idSchema,
    dependsOn: { type: 'array', maxItems: 19, uniqueItems: true, items: idSchema },
    inputs: refsSchema, artifacts: refsSchema, readScopes: refsSchema, writeScopes: refsSchema, verification: refsSchema,
    budget: { type: 'object', additionalProperties: false, required: ['toolCalls', 'wallTimeMs'], properties: {
      toolCalls: { type: 'integer', minimum: 1, maximum: 64 }, wallTimeMs: { type: 'integer', minimum: 1, maximum: 60_000 },
    } }, estimatedWorkMs: estimateSchema,
  },
}) as JsonObject;
export const TOOL_BATCH_INPUT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, required: ['schemaVersion', 'nodes'],
  properties: { schemaVersion: { const: 1 }, nodes: { type: 'array', minItems: 1, maxItems: 32, items: {
    type: 'object', additionalProperties: false, required: ['id', 'toolId', 'toolVersion', 'arguments', 'dependsOn', 'estimatedWorkMs', 'onFailure'],
    properties: { id: idSchema, toolId: idSchema, toolVersion: { type: 'string', minLength: 1, maxLength: 32 },
      arguments: { type: 'object', maxProperties: 256 }, dependsOn: { type: 'array', maxItems: 31, uniqueItems: true, items: idSchema },
      estimatedWorkMs: estimateSchema, onFailure: { enum: ['cancel-dependents', 'stop-batch'] },
    },
  } } },
}) as JsonObject;

export function isPlanTaskV1(value: unknown): value is PlanTaskV1 {
  return record(value) && exact(value, ['schemaVersion', 'id', 'dependsOn', 'inputs', 'artifacts', 'readScopes', 'writeScopes', 'verification', 'budget', 'estimatedWorkMs'])
    && value.schemaVersion === 1 && id(value.id) && refs(value.dependsOn, 19, id)
    && ['inputs', 'artifacts', 'readScopes', 'writeScopes', 'verification'].every(key => refs(value[key], 20, text))
    && record(value.budget) && exact(value.budget, ['toolCalls', 'wallTimeMs'])
    && integer(value.budget.toolCalls, 64) && integer(value.budget.wallTimeMs, 60_000) && estimate(value.estimatedWorkMs);
}
export function isToolBatchInputV1(value: unknown): value is ToolBatchInputV1 {
  return record(value) && exact(value, ['schemaVersion', 'nodes']) && value.schemaVersion === 1
    && Array.isArray(value.nodes) && value.nodes.length > 0 && value.nodes.length <= 32
    && value.nodes.every(node => record(node) && exact(node, ['id', 'toolId', 'toolVersion', 'arguments', 'dependsOn', 'estimatedWorkMs', 'onFailure'])
      && id(node.id) && id(node.toolId) && typeof node.toolVersion === 'string' && node.toolVersion.length > 0 && node.toolVersion.length <= 32
      && record(node.arguments) && Object.keys(node.arguments).length <= 256 && refs(node.dependsOn, 31, id)
      && estimate(node.estimatedWorkMs) && ['cancel-dependents', 'stop-batch'].includes(String(node.onFailure)))
    && isAcyclicTaskGraph(value.nodes as ToolBatchInputV1['nodes']);
}
export function isAcyclicTaskGraph(nodes: readonly Readonly<{ id: string; dependsOn: readonly string[] }>[]): boolean {
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length || nodes.some(node => node.dependsOn.some(dep => !byId.has(dep)))) return false;
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return false;
    if (visited.has(key)) return true;
    visiting.add(key);
    if (!byId.get(key)!.dependsOn.every(visit)) return false;
    visiting.delete(key); visited.add(key); return true;
  };
  return nodes.every(node => visit(node.id));
}
function record(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function exact(v: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key)); }
function id(v: unknown): v is string { return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(v); }
function text(v: unknown): v is string { return typeof v === 'string' && v.length > 0 && v.length <= 512; }
function integer(v: unknown, max: number): boolean { return Number.isSafeInteger(v) && Number(v) >= 1 && Number(v) <= max; }
function estimate(v: unknown): boolean { return v === null || integer(v, 60_000); }
function refs(v: unknown, max: number, check: (v: unknown) => boolean): boolean { return Array.isArray(v) && v.length <= max && new Set(v).size === v.length && v.every(check); }
