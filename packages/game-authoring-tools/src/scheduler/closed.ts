import { asStableId, isToolBatchInputV1, TOOL_BATCH_INPUT_SCHEMA, type JsonObject, type ToolBatchRequestV1 } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, sha256 } from '@haiyue/ai-studio-operation-log';
import { resolveModelToolInvocation } from '../catalog/invocation.js';
import type { GameToolDefinition } from '../types.js';
import { normalizeToolBatchRequest } from './normalize.js';
import { requiresSerialOrder } from './classify.js';
import { ToolBatchProtocolError } from './types.js';

export const MODEL_TOOL_BATCH_DEFINITION = Object.freeze({
  id: asStableId('studio.tool.batch'),
  description: 'Submit one complete bounded DAG of registered tools with already known literal arguments. Each node uses an exact discovered toolId/toolVersion; dependsOn names node IDs in this envelope, including forward references. No output interpolation, nested batch, script or runtime calls. For unknown returned IDs or revisions use the next batch. Independent low-risk edits at one exact baseRevision may share a transaction; document commits remain serial. Each member retains validation, plan/scoped approval, task budget, audit and result. estimatedWorkMs is an advisory estimate (null if unknown); unknown or unprofitable scheduling stays serial. Simple single operations should use their native tool directly.',
  inputSchema: TOOL_BATCH_INPUT_SCHEMA,
});

export function resolveClosedToolBatch(value: unknown, coordinates: { id: string; sessionId: string; turnId: string }, definitions: readonly GameToolDefinition[]) {
  if (!isToolBatchInputV1(value)) throw new ToolBatchProtocolError('tool-batch.input-invalid', 'Expected a version 1 closed DAG with unique IDs, existing dependencies and bounded literal arguments.');
  if (Buffer.byteLength(canonicalStringify(value as unknown as JsonObject)) > 512 * 1024) throw new ToolBatchProtocolError('tool-batch.input-limit', 'Batch arguments exceed 512 KiB.');
  const ids = new Map(value.nodes.map(node => [node.id, `call:${sha256(`${coordinates.id}:${node.id}`)}`]));
  const calls = value.nodes.map(node => {
    const target = resolveModelToolInvocation({ toolId: node.toolId, toolVersion: node.toolVersion, arguments: node.arguments }, definitions);
    const definition = definitions.find(item => item.id === target.toolId)!;
    if (definition.effect === 'trusted-code' || definition.effect === 'runtime-start' || /^(?:script|play|preview)\./u.test(target.toolId))
      throw new ToolBatchProtocolError('tool-batch.barrier-unsupported', 'Script and runtime operations require separate native calls after the batch result.');
    return { toolCallId: ids.get(node.id)!, ...target, dependsOn: node.dependsOn.map(id => ids.get(id)!), onFailure: node.onFailure };
  });
  const request = normalizeToolBatchRequest({ ...coordinates, calls }, definitions);
  const estimates = value.nodes.map(node => node.estimatedWorkMs);
  const schedule = explainBatchSchedule(request, estimates);
  return Object.freeze({ request: Object.freeze({ ...request, maxConcurrency: schedule.strategy === 'parallel' ? 4 : 1 }), schedule,
    members: Object.freeze(value.nodes.map((node, index) => Object.freeze({ id: node.id, toolCallId: request.nodes[index]!.toolCallId }))),
  });
}

/** Estimates select an optimization only. Safety edges always come from trusted normalized nodes. */
export function explainBatchSchedule(request: ToolBatchRequestV1, estimates: readonly (number | null)[]) {
  const edges = request.nodes.map((node, index) => [...new Set([
    ...node.dependsOn, ...request.nodes.slice(0, index).filter(prior => requiresSerialOrder(prior, node)).map(prior => prior.id),
  ])]);
  const known = estimates.length === request.nodes.length && estimates.every(ms => ms !== null && Number.isSafeInteger(ms) && ms > 0);
  let serialMs: number | null = null, parallelMs: number | null = null;
  if (known) {
    serialMs = estimates.reduce<number>((sum, ms) => sum + ms!, 0);
    const finish = new Map<string, number>();
    const lanes = [0, 0, 0, 0];
    while (finish.size < request.nodes.length) {
      let advanced = false;
      request.nodes.forEach((node, index) => {
        if (finish.has(node.id) || !edges[index]!.every(id => finish.has(id))) return;
        const lane = lanes.indexOf(Math.min(...lanes));
        lanes[lane] = Math.max(lanes[lane]!, ...edges[index]!.map(id => finish.get(id)!)) + estimates[index]!;
        finish.set(node.id, lanes[lane]!); advanced = true;
      });
      if (!advanced) throw new ToolBatchProtocolError('tool-batch.cycle', 'Effective scheduling graph contains a cycle.');
    }
    parallelMs = Math.max(...lanes);
  }
  const overheadMs = request.nodes.length * 2;
  const savingsMs = serialMs === null || parallelMs === null ? null : serialMs - parallelMs - overheadMs;
  const strategy = savingsMs !== null && savingsMs > 0 ? 'parallel' : 'serial';
  return Object.freeze({ strategy, serialMs, parallelMs, overheadMs, savingsMs, estimateSource: 'model-advisory',
    reason: !known ? 'estimate-unknown' : strategy === 'parallel' ? 'positive-estimated-benefit' : 'no-estimated-benefit',
    nodes: request.nodes.map((node, index) => ({ id: node.id, dependsOn: node.dependsOn, waitsFor: edges[index]!,
      reason: node.dependsOn.length ? 'explicit-dependency' : edges[index]!.length ? 'registry-effect-or-snapshot-barrier' : node.executionClass === 'parallel-read' ? 'independent-read' : node.executionClass,
    })),
  });
}
