import type { JsonObject, JsonValue } from '@haiyue/ai-studio-contracts';
import { canonicalStringify } from '@haiyue/ai-studio-operation-log';
import { GameToolProtocolError } from './types.js';

const object = (v: JsonValue | undefined): JsonObject => v && typeof v === 'object' && !Array.isArray(v) ? v as JsonObject : {};
const rows = (v: JsonValue | undefined): JsonObject[] => Array.isArray(v) ? v.filter((x): x is JsonObject => !!x && typeof x === 'object' && !Array.isArray(x)) : [];

/** Bound each step independently: diagnostics must not multiply the full scene
 * or script journal by the number of gesture samples. */
export function gestureRouting(value: JsonObject, pointerId: number): JsonObject {
  const raw = object(value.routing);
  if (typeof raw.tick !== 'number') return { available: false };
  const hits = rows(raw.hits).filter(x => x.pointerId === pointerId);
  const reads = rows(raw.reads);
  const orbit = object(raw.orbit);
  const decisions = rows(orbit.decisions).filter(x => x.pointerId === pointerId);
  const result: JsonObject = { available: true, hits: hits.slice(0, 2), reads: reads.slice(0, 4),
    orbit: { scriptId: orbit.scriptId ?? null, mode: orbit.mode ?? null, decisions: decisions.slice(0, 2) },
    truncated: raw.truncated === true || orbit.truncated === true || hits.length > 2 || reads.length > 4 || decisions.length > 2 };
  // Preserve a truthful unknown instead of cutting JSON or falsely reporting no reader.
  return new TextEncoder().encode(JSON.stringify(result)).byteLength <= 2048 ? result : { available: true, truncated: true };
}

export function diagnoseGesture(steps: readonly JsonObject[], before: JsonObject, after: JsonObject, effects: JsonObject, expect?: JsonObject): JsonObject {
  const routing = steps.map(s => object(s.routing));
  const complete = routing.length > 0 && routing.every(r => r.available === true && r.truncated !== true);
  const hits = routing.flatMap(r => rows(r.hits));
  const reads = routing.flatMap(r => rows(r.reads));
  const down = hits.find(h => h.phase === 'down');
  const emitted = hits.flatMap(h => rows(h.emitted));
  const suppressed = hits.flatMap(h => rows(h.suppressed));
  const stateEntities = (v: JsonObject) => new Map(rows(object(v.state).entities).map(e => [e.id, e]));
  const oldEntities = stateEntities(before), newEntities = stateEntities(after);
  const mismatches: string[] = [];
  if (expect) {
    if (typeof expect.cameraChanged === 'boolean' && effects.cameraChanged !== expect.cameraChanged) mismatches.push(`cameraChanged: expected ${expect.cameraChanged}, observed ${effects.cameraChanged}`);
    if (typeof expect.minChangedEntities === 'number' && Number(effects.changedEntityCount) < expect.minChangedEntities) mismatches.push(`changedEntityCount: expected >= ${expect.minChangedEntities}, observed ${effects.changedEntityCount}`);
    for (const key of ['changedEntityIds', 'unchangedEntityIds', 'changedTransformEntityIds'] as const) for (const id of Array.isArray(expect[key]) ? expect[key] as string[] : []) {
      if (!oldEntities.has(id) || !newEntities.has(id)) { mismatches.push(`${id}: entity absent from baseline/final engine state`); continue; }
      const comparison = (e: JsonObject): JsonObject => key === 'changedTransformEntityIds' ? { position: e.position ?? null, rotation: e.rotation ?? null, scale: e.scale ?? null } : e;
      const changed = canonicalStringify(comparison(oldEntities.get(id)!)) !== canonicalStringify(comparison(newEntities.get(id)!));
      if (changed !== (key !== 'unchangedEntityIds')) mismatches.push(`${id}: expected ${key !== 'unchangedEntityIds' ? 'change' : 'unchanged'}, observed ${changed ? 'change' : 'unchanged'}`);
    }
  }
  let stage = 'effects-observed';
  let nextAction = 'Compare actual changed members and nonmembers against the intended behavior. Event reads and script-reported counters do not prove the behavior succeeded.';
  if (!down) { stage = 'routing-incomplete'; nextAction = 'Routing evidence is absent or truncated; do not infer a miss or missing script reader. Inspect the target and its script directly.'; }
  else if (hits.some(h => h.raycastFailed === true)) { stage = 'raycast-error'; nextAction = 'Inspect runtime errors and active camera before changing gameplay.'; }
  else if (!down?.hitEntityId) { stage = 'background-hit'; nextAction = 'The down event hit no opaque mesh. If an object was intended, inspect the active camera and target placement; choose a visible surface and test it.'; }
  else if (!down.pointer || object(down.pointer).enabled !== true) { stage = 'pointer-unavailable'; nextAction = 'Inspect the actual hit entity and its ancestors with scene.get-many. Add pointer events to the visible hit surface, not an occluded inner face. Child events do not bubble to parents.'; }
  else if (suppressed.some(s => s.reason === 'event-limit')) { stage = 'event-limit'; nextAction = 'Inspect maxEventsPerTick and subscribed events on the hit surface.'; }
  else if (!complete) { stage = 'routing-incomplete'; nextAction = 'Routing was truncated. Keep the recorded positive hits/reads, but inspect target scripts before inferring missing events or readers.'; }
  else if (!emitted.length) { stage = 'events-filtered'; nextAction = 'The mesh was hit but no subscribed event was emitted. Check pointer.events, draggable and capturePointer against the script branches.'; }
  else if (!reads.some(r => Number(r.eventCount) > 0)) { stage = 'events-unread'; nextAction = 'Events were emitted but no recorded script read them. Check enabled script bindings and selfInteractions owner ids; global interactions needs explicit entity routing.'; }
  else if (Number(effects.changedEntityCount) === 0) { stage = 'read-without-entity-effect'; nextAction = 'A script read events, but no engine entity changed. Inspect event type/id filters, down/up state, movement threshold and effect target. A read does not prove a handler branch executed.'; }
  if (expect?.cameraChanged === false && effects.cameraChanged === true) nextAction += ' Camera changed unexpectedly: inspect routing.orbit mode/claim decisions and other camera-writing scripts.';
  return { stage, expectationMatched: expect ? mismatches.length === 0 : null, mismatches: mismatches.slice(0, 16), mismatchesTruncated: mismatches.length > 16,
    hitEntityId: down?.hitEntityId ?? null, receiverEntityId: down?.receiverEntityId ?? null, emittedTypes: [...new Set(emitted.map(e => e.type ?? null))],
    readerScriptIds: [...new Set(reads.filter(r => Number(r.eventCount) > 0).map(r => r.scriptId ?? null))].slice(0, 8), nextAction };
}

/** Session-local, bounded guard. New artifact ids/ticks/Play instances are not
 * progress. Only an explicit failed expectation is eligible, never an inferred
 * background click or missing legacy diagnostic. */
export class GestureProgressGuard {
  private entries = new Map<string, { fingerprint: string; count: number; probe: string; nextAction: string }>();
  before(key: string, args: JsonObject): void {
    const previous = this.entries.get(key);
    if (previous && previous.count >= 2 && !(typeof args.hypothesis === 'string' && this.probe(args) !== previous.probe)) {
      throw new GameToolProtocolError('interaction.diagnostic-required', `Repeated same-revision gesture failure. ${previous.nextAction} Inspect the cited target/script before another test; repair it, or supply a hypothesis explaining a different points/expect probe. Recreating Play or evidence does not count as a repair.`, true);
    }
  }
  after(key: string, args: JsonObject, diagnostic: JsonObject): number {
    if (diagnostic.expectationMatched !== false) { this.entries.delete(key); return 0; }
    const fingerprint = canonicalStringify({ stage: diagnostic.stage!, hit: diagnostic.hitEntityId!, mismatches: diagnostic.mismatches! });
    const previous = this.entries.get(key);
    const count = previous?.fingerprint === fingerprint ? previous.count + 1 : 1;
    this.entries.delete(key);
    this.entries.set(key, { fingerprint, count, probe: this.probe(args), nextAction: String(diagnostic.nextAction) });
    if (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value!);
    return count;
  }
  clear(): void { this.entries.clear(); }
  private probe(args: JsonObject): string { return canonicalStringify({ points: args.points!, expect: args.expect ?? null, settleTicks: args.settleTicks ?? 1 }); }
}
