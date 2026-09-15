import { asStableId, type JsonObject, type ToolBatchNodeV1, type ToolBatchRequestV1 } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, sha256 } from '@haiyue/ai-studio-operation-log';
import { classifyToolConcurrency, requiresSerialOrder } from './classify.js';
import { ToolBatchProtocolError } from './types.js';
import type { GameToolDefinition } from '../types.js';

export interface LegacyToolRequest {
  readonly toolCallId: string;
  readonly toolId: string;
  readonly toolVersion?: string;
  readonly arguments?: JsonObject;
  readonly dependsOn?: readonly string[];
  readonly expectedRevision?: number | null;
  readonly outputProjection?: ToolBatchNodeV1['outputProjection'];
  readonly onFailure?: ToolBatchNodeV1['onFailure'];
}

export interface NormalizeToolBatchInput {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly calls: readonly LegacyToolRequest[];
  readonly maxConcurrency?: number;
  readonly maxResultBytes?: number;
  readonly createdAt?: string;
}

export function normalizeToolBatchRequest(input: NormalizeToolBatchInput, definitions: readonly GameToolDefinition[]): ToolBatchRequestV1 {
  if (!Array.isArray(input.calls) || input.calls.length < 1 || input.calls.length > 64) throw new ToolBatchProtocolError('tool-batch.node-limit', 'A tool batch must contain between 1 and 64 nodes.');
  const byTool = new Map(definitions.map((definition) => [definition.id, definition]));
  const nodes = input.calls.map((call, index): ToolBatchNodeV1 => {
    const toolCallId = stable(call.toolCallId, 'tool call id');
    const toolId = stable(call.toolId, 'tool id');
    const args = record(call.arguments);
    const classification = classifyToolConcurrency(byTool.get(toolId), args);
    const expectedRevision = call.expectedRevision ?? integerOrNull(args.baseRevision);
    return Object.freeze({
      id: nodeId(toolCallId),
      toolCallId,
      toolId,
      toolVersion: typeof call.toolVersion === 'string' && call.toolVersion.length > 0 ? call.toolVersion : '1.0.0',
      arguments: args,
      dependsOn: Object.freeze((call.dependsOn ?? Object.freeze([] as string[])).map((value: string) => value.startsWith('node:') ? stable(value, 'dependency node id') : nodeId(stable(value, 'dependency tool call id')))),
      expectedRevision,
      executionClass: classification.executionClass,
      effects: classification.effects,
      effectKeys: classification.effectKeys.map((value) => asStableId(value)),
      outputProjection: call.outputProjection ?? 'full',
      onFailure: call.onFailure ?? (index === input.calls.length - 1 ? 'cancel-dependents' : 'cancel-dependents'),
    });
  });
  const request: ToolBatchRequestV1 = Object.freeze({
    schemaVersion: 1,
    id: stable(input.id, 'batch id'),
    sessionId: stable(input.sessionId, 'session id'),
    turnId: stable(input.turnId, 'turn id'),
    nodes: Object.freeze(nodes),
    maxConcurrency: boundedInteger(input.maxConcurrency ?? 4, 1, 16, 'maxConcurrency'),
    maxResultBytes: boundedInteger(input.maxResultBytes ?? 1024 * 1024, 1, 16 * 1024 * 1024, 'maxResultBytes'),
    createdAt: timestamp(input.createdAt),
  });
  validateToolBatchRequest(request);
  return request;
}

export function validateToolBatchRequest(request: ToolBatchRequestV1): void {
  if (request.schemaVersion !== 1) throw new ToolBatchProtocolError('tool-batch.version-unsupported', 'Tool batch schemaVersion must be 1.');
  stable(request.id, 'batch id'); stable(request.sessionId, 'session id'); stable(request.turnId, 'turn id'); timestamp(request.createdAt);
  if (request.nodes.length < 1 || request.nodes.length > 64) throw new ToolBatchProtocolError('tool-batch.node-limit', 'A tool batch must contain between 1 and 64 nodes.');
  boundedInteger(request.maxConcurrency, 1, 16, 'maxConcurrency');
  boundedInteger(request.maxResultBytes, 1, 16 * 1024 * 1024, 'maxResultBytes');
  const ids = new Set<string>(); const calls = new Set<string>();
  for (const node of request.nodes) {
    stable(node.id, 'node id'); stable(node.toolCallId, 'tool call id'); stable(node.toolId, 'tool id');
    if (typeof node.toolVersion !== 'string' || node.toolVersion.length < 1 || node.toolVersion.length > 64) throw new ToolBatchProtocolError('tool-batch.version-invalid', `Node ${node.id} has an invalid tool version.`);
    try { canonicalStringify(node.arguments); } catch { throw new ToolBatchProtocolError('tool-batch.arguments-invalid', `Node ${node.id} arguments are not bounded JSON.`); }
    if (node.expectedRevision !== null && (!Number.isSafeInteger(node.expectedRevision) || node.expectedRevision < 0)) throw new ToolBatchProtocolError('tool-batch.revision-invalid', `Node ${node.id} has an invalid expected revision.`);
    if (!EXECUTION_CLASSES.has(node.executionClass) || !OUTPUT_PROJECTIONS.has(node.outputProjection) || !FAILURE_POLICIES.has(node.onFailure)) throw new ToolBatchProtocolError('tool-batch.node-invalid', `Node ${node.id} has an unsupported scheduling value.`);
    if (node.effects.length < 1 || node.effects.length > 7 || new Set(node.effects).size !== node.effects.length || node.effects.some((effect) => !EFFECTS.has(effect))) throw new ToolBatchProtocolError('tool-batch.effect-invalid', `Node ${node.id} has invalid effects.`);
    if (node.dependsOn.length > 63 || new Set(node.dependsOn).size !== node.dependsOn.length || node.effectKeys.length > 256 || new Set(node.effectKeys).size !== node.effectKeys.length) throw new ToolBatchProtocolError('tool-batch.node-invalid', `Node ${node.id} has duplicate or oversized dependency/effect keys.`);
    for (const key of node.effectKeys) stable(key, 'effect key');
    for (const dependency of node.dependsOn) stable(dependency, 'dependency node id');
    if (ids.has(node.id) || calls.has(node.toolCallId)) throw new ToolBatchProtocolError('tool-batch.node-duplicate', 'Tool batch node and tool call ids must be unique.');
    ids.add(node.id); calls.add(node.toolCallId);
    if (node.executionClass === 'parallel-read' && (node.effects.length !== 1 || node.effects[0] !== 'observe')) throw new ToolBatchProtocolError('tool-batch.concurrency-unsafe', `Node ${node.id} cannot run in parallel with its declared effects.`);
  }
  for (const node of request.nodes) for (const dependency of node.dependsOn) if (!ids.has(dependency)) throw new ToolBatchProtocolError('tool-batch.dependency-missing', `Node ${node.id} depends on missing node ${dependency}.`);
  validateEffectiveDag(request.nodes);
}

function validateEffectiveDag(nodes: readonly ToolBatchNodeV1[]): void {
  const effective = new Map<string, Set<string>>(nodes.map((node) => [node.id, new Set(node.dependsOn)]));
  nodes.forEach((node, index) => {
    for (let prior = 0; prior < index; prior += 1) {
      if (requiresSerialOrder(nodes[prior]!, node)) effective.get(node.id)?.add(nodes[prior]!.id);
    }
  });
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new ToolBatchProtocolError('tool-batch.cycle', 'Tool batch dependency and barrier graph contains a cycle.');
    if (visited.has(id)) return;
    visiting.add(id); for (const dependency of effective.get(id) ?? []) visit(dependency); visiting.delete(id); visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}

function stable(value: string, label: string): ReturnType<typeof asStableId> {
  if (typeof value !== 'string' || value.length < 3 || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]+$/u.test(value)) throw new ToolBatchProtocolError('tool-batch.id-invalid', `${label} is invalid.`);
  return asStableId(value);
}
function nodeId(toolCallId: string): ReturnType<typeof asStableId> { const candidate = `node:${toolCallId}`; return asStableId(candidate.length <= 128 ? candidate : `node:${sha256(toolCallId)}`); }
function record(value: JsonObject | undefined): JsonObject { return value && typeof value === 'object' && !Array.isArray(value) ? Object.freeze({ ...value }) : Object.freeze({}); }
function integerOrNull(value: unknown): number | null { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null; }
function boundedInteger(value: number, minimum: number, maximum: number, label: string): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ToolBatchProtocolError('tool-batch.limit-invalid', `${label} is outside its allowed range.`); return value; }
function timestamp(value: string | undefined): string { const result = value ?? new Date().toISOString(); if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u.test(result) || !Number.isFinite(Date.parse(result))) throw new ToolBatchProtocolError('tool-batch.timestamp-invalid', 'createdAt must be a canonical UTC timestamp.'); return result; }
const EXECUTION_CLASSES = new Set(['parallel-read', 'exclusive-mutation', 'approval-barrier', 'runtime-barrier', 'trusted-code-barrier', 'unknown-exclusive']);
const EFFECTS = new Set(['observe', 'document-mutation', 'runtime-control', 'trusted-code', 'approval', 'external-side-effect', 'unknown']);
const OUTPUT_PROJECTIONS = new Set(['full', 'summary', 'digest-only']);
const FAILURE_POLICIES = new Set(['cancel-dependents', 'stop-batch']);
