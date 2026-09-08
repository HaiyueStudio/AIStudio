import type { BehaviorArtifactKind, BehaviorArtifactValues } from '@haiyue/ai-studio-operation-log';
import { BehaviorContractError, behaviorDigest, canonicalJson, checkedJson, freezeProjection } from './canonical.js';
import { parseBehaviorContract } from './validation.js';

/** Validation adapter for the existing operation-log artifact owner. */
export function validateBehaviorArtifact<K extends BehaviorArtifactKind>(kind: K, input: unknown): BehaviorArtifactValues[K] {
  if (kind === 'manifest') return parseBehaviorContract('behavior-manifest', input) as BehaviorArtifactValues[K];
  if (kind === 'explanation') return parseBehaviorContract('behavior-explanation', input) as BehaviorArtifactValues[K];
  if (kind !== 'trace') throw new BehaviorContractError('behavior.artifact-kind');
  const pair = checkedJson(input, 8 * 1024 * 1024) as Record<string, unknown>;
  if (!pair || Array.isArray(pair) || typeof pair !== 'object' || Object.keys(pair).length !== 2 || !Object.hasOwn(pair, 'observation') || !Object.hasOwn(pair, 'trace')) throw new BehaviorContractError('behavior.observation-association');
  const observation = parseBehaviorContract('observation-artifact', pair.observation), trace = parseBehaviorContract('behavior-trace', pair.trace);
  if (observation.type !== 'event-trace' || observation.playId !== trace.playId || observation.digest !== behaviorDigest(trace) || observation.byteLength !== Buffer.byteLength(canonicalJson(trace)) || trace.events.some(event => event.tick > observation.tick || event.frame > observation.frame)) throw new BehaviorContractError('behavior.observation-association');
  return freezeProjection({ observation, trace }) as BehaviorArtifactValues[K];
}
