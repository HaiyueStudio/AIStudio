import type { BehaviorTraceArtifactV1, BehaviorTraceV1, ObservationArtifactV2 } from '@haiyue/ai-studio-contracts';
import { BehaviorContractError, behaviorDigest, canonicalJson, checkedJson, freezeProjection, withDigest } from './canonical.js';
import { parseBehaviorRuntimePlan } from './runtime-observer.js';
import { associateBehaviorTrace } from './trace.js';
import { parseBehaviorContract } from './validation.js';

export type BehaviorCaptureMetadata = Pick<ObservationArtifactV2, 'id' | 'taskId' | 'turnId' | 'capturedAt' | 'viewport' | 'device' | 'producerVersion'>;
/** Seal runtime data at the existing trusted observation ingress. A caller cannot
 * choose project, source, scripts, clock or Play provenance through metadata. */
export function sealBehaviorRuntimeCapture(planInput: unknown, manifestInput: unknown, captureInput: unknown, metadata: BehaviorCaptureMetadata): Readonly<{ artifact: BehaviorTraceArtifactV1; closed: boolean }> {
  const plan = parseBehaviorRuntimePlan(planInput), manifest = parseBehaviorContract('behavior-manifest', manifestInput);
  const raw = checkedJson(captureInput, 4 * 1024 * 1024) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 10
    || !['schemaVersion','sourceBindingDigest','manifestDigest','playId','generation','events','truncation','tick','frame','closed'].every(key => Object.hasOwn(raw, key))) throw new BehaviorContractError('behavior.runtime-capture');
  if (!Number.isSafeInteger(raw.tick) || Number(raw.tick) < 0 || !Number.isSafeInteger(raw.frame) || Number(raw.frame) < 0 || typeof raw.closed !== 'boolean') throw new BehaviorContractError('behavior.runtime-clock');
  const { tick, frame, closed, ...body } = raw;
  const trace = parseBehaviorContract('behavior-trace', withDigest(body));
  if (trace.sourceBindingDigest !== plan.sourceBindingDigest || trace.manifestDigest !== plan.manifestDigest || manifest.digest !== plan.manifestDigest || manifest.binding.digest !== plan.sourceBindingDigest
    || trace.playId !== plan.playId || trace.generation !== plan.generation) throw new BehaviorContractError('behavior.runtime-binding');
  const nodes = new Map(manifest.nodes.map(n => [n.id, n])), scripts = new Map(plan.programs.map(p => [p.scriptId, p])), components = new Map(plan.components.map(c => [c.id, c]));
  let priorTick = 0, priorFrame = 0;
  for (const row of trace.events) {
    if (row.tick < priorTick || row.frame < priorFrame || row.tick > Number(tick) || row.frame > Number(frame) || !plan.entityIds.includes(row.entityId)) throw new BehaviorContractError('behavior.runtime-event-clock');
    priorTick = row.tick; priorFrame = row.frame;
    if ((row.scriptId !== null && (scripts.get(row.scriptId)?.entityId !== row.entityId || row.componentId !== null))
      || (row.componentId !== null && (components.get(row.componentId)?.entityId !== row.entityId || row.scriptId !== null))) throw new BehaviorContractError('behavior.runtime-event-owner');
    if (row.nodeId !== null) {
      const node = nodes.get(row.nodeId);
      if (!node || node.source.entityId !== row.entityId || (node.source.kind === 'script' ? node.source.scriptId !== row.scriptId || row.componentId !== null : node.source.componentId !== row.componentId || row.scriptId !== null)) throw new BehaviorContractError('behavior.runtime-event-node');
      // Runtime adapters are external observations, never script/control nodes.
      if (node.source.kind === 'runtime-adapter' || node.kind === 'unknown') throw new BehaviorContractError('behavior.runtime-unproved-node');
      if (row.scriptId !== null && ![scripts.get(row.scriptId)!.entryNodeId, ...scripts.get(row.scriptId)!.instrumentedNodeIds].includes(row.nodeId)) throw new BehaviorContractError('behavior.runtime-uninstrumented-node');
    }
  }
  const observation = parseBehaviorContract('observation-artifact', { schemaVersion: 2, ...metadata, type: 'event-trace', digest: behaviorDigest(trace),
    playId: plan.playId, documentRevision: manifest.binding.documentRevision, scriptDigests: [...new Set(plan.programs.map(p => p.sourceDigest))], tick, frame,
    byteLength: Buffer.byteLength(canonicalJson(trace)), redacted: trace.events.some(row => row.event === 'observation-rejected' || row.kind === 'error') });
  const associated = associateBehaviorTrace(observation, trace, manifest, plan);
  if (associated.status !== 'current') throw new BehaviorContractError('behavior.runtime-binding');
  return freezeProjection({ artifact: associated.artifact, closed });
}

/** Captures are cumulative prefixes. Do not admit rewrites, tick reversal or a
 * shorter late response from the same realm after a more recent capture. */
export function assertBehaviorCaptureProgress(previous: BehaviorTraceV1 | null, next: BehaviorTraceV1): void {
  if (!previous) return;
  if (previous.playId !== next.playId || previous.generation !== next.generation || previous.manifestDigest !== next.manifestDigest
    || next.events.length < previous.events.length || next.truncation.omittedAtLeast < previous.truncation.omittedAtLeast
    || canonicalJson(next.events.slice(0, previous.events.length)) !== canonicalJson(previous.events)) throw new BehaviorContractError('behavior.runtime-capture-order');
}
