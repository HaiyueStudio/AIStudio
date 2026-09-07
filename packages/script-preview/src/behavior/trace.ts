import type { BehaviorManifestV1, BehaviorTraceArtifactV1, BehaviorTraceV1 } from '@haiyue/ai-studio-contracts';
import { BehaviorContractError, behaviorDigest, canonicalJson, checkedJson, freezeProjection, withDigest } from './canonical.js';
import { parseBehaviorContract } from './validation.js';

export function createBehaviorTrace(manifestInput: unknown, input: unknown): BehaviorTraceV1 {
  const manifest = parseBehaviorContract('behavior-manifest', manifestInput);
  const value = checkedJson(input, 8 * 1024 * 1024) as Record<string, unknown>;
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !['schemaVersion', 'playId', 'generation', 'events'].includes(key)) || !Array.isArray(value.events)) throw new BehaviorContractError('behavior.trace-input');
  const events: unknown[] = [];
  let bytes = 0;
  let previousSequence = -1;
  const reasons: ('events' | 'bytes')[] = [];
  for (const event of value.events) {
    // Even dropped rows must be valid and secret-free, so truncation cannot hide malformed evidence.
    const row = parseBehaviorContract('behavior-trace', withDigest({ schemaVersion: value.schemaVersion, sourceBindingDigest: manifest.binding.digest, manifestDigest: manifest.digest, playId: value.playId, generation: value.generation,
      events: [event], truncation: { truncated: false, reasons: [], omittedAtLeast: 0 } }));
    validateTraceNodes(row, manifest);
    if (row.events[0].sequence <= previousSequence) throw new BehaviorContractError('behavior.trace-event-order');
    previousSequence = row.events[0].sequence;
    const size = Buffer.byteLength(canonicalJson(event));
    if (events.length === 10000) { if (!reasons.includes('events')) reasons.push('events'); continue; }
    if (bytes + size > 4 * 1024 * 1024 - 4096) { if (!reasons.includes('bytes')) reasons.push('bytes'); continue; }
    bytes += size; events.push(event);
  }
  const trace = parseBehaviorContract('behavior-trace', withDigest({ schemaVersion: value.schemaVersion, sourceBindingDigest: manifest.binding.digest, manifestDigest: manifest.digest, playId: value.playId, generation: value.generation,
    events, truncation: { truncated: reasons.length > 0, reasons, omittedAtLeast: value.events.length - events.length } }));
  validateTraceNodes(trace, manifest);
  return trace;
}
/** Verify the existing evidence envelope before deciding whether its trace may overlay current structure. */
export function associateBehaviorTrace(observationInput: unknown, traceInput: unknown, currentManifestInput: unknown, currentPlay: Readonly<{ playId: string; generation: number }>): Readonly<{ status: 'current' | 'historical'; artifact: BehaviorTraceArtifactV1 }> {
  const observation = parseBehaviorContract('observation-artifact', observationInput);
  const trace = parseBehaviorContract('behavior-trace', traceInput);
  const manifest = parseBehaviorContract('behavior-manifest', currentManifestInput);
  if (observation.type !== 'event-trace' || observation.playId !== trace.playId || observation.digest !== behaviorDigest(trace) || observation.byteLength !== Buffer.byteLength(canonicalJson(trace))) throw new BehaviorContractError('behavior.observation-association');
  let status: 'current' | 'historical' = 'historical';
  if (trace.sourceBindingDigest === manifest.binding.digest && trace.manifestDigest === manifest.digest) {
    validateTraceNodes(trace, manifest);
    // Existing Play supports explicit subsets, including a declarative run without scripts.
    // Require every selected digest to be current/enabled and every observed script to be selected.
    const enabled = new Map(manifest.binding.scripts.filter(script => script.enabled).map(script => [script.id, script.digest]));
    const selected = new Set(observation.scriptDigests);
    if (observation.documentRevision !== manifest.binding.documentRevision || observation.scriptDigests.some(digest => ![...enabled.values()].includes(digest)) || trace.events.some(event => (event.scriptId !== null && (!enabled.has(event.scriptId) || !selected.has(enabled.get(event.scriptId)!))) || event.tick > observation.tick || event.frame > observation.frame)) throw new BehaviorContractError('behavior.observation-binding');
    if (trace.playId === currentPlay.playId && trace.generation === currentPlay.generation) status = 'current';
  }
  return freezeProjection({ status, artifact: { observation, trace } });
}
function validateTraceNodes(trace: BehaviorTraceV1, manifest: BehaviorManifestV1): void {
  const nodes = new Map(manifest.nodes.map(node => [node.id, node]));
  for (const event of trace.events) {
    if (!event.nodeId) continue;
    const node = nodes.get(event.nodeId);
    if (!node || node.source.entityId !== event.entityId || (node.source.kind === 'script' ? node.source.scriptId !== event.scriptId || event.componentId !== null : node.source.componentId !== event.componentId || event.scriptId !== null)) throw new BehaviorContractError('behavior.trace-source');
  }
}
