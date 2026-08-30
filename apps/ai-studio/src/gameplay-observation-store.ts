export type GameplayObservationValue = null | boolean | number | string | readonly GameplayObservationValue[] | Readonly<{ [key: string]: GameplayObservationValue }>;

export interface GameplayObservationOwner {
  readonly scriptId: string;
  readonly entityId: string;
}

export interface GameplayObservationRecord extends GameplayObservationOwner {
  readonly id: string;
  readonly value: GameplayObservationValue;
}

const ID = /^[A-Za-z0-9._:-]{1,64}$/u;
const MAX_RECORDS = 64;
const MAX_RECORD_BYTES = 8 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024;
const MAX_DEPTH = 8;
const MAX_NODES = 2_048;
const MAX_STRING_LENGTH = 2_048;
const MAX_KEY_LENGTH = 128;

/** Bounded semantic-state channel owned by the isolated Play iframe. */
export class GameplayObservationStore {
  private readonly records = new Map<string, Readonly<{ record: GameplayObservationRecord; bytes: number }>>();
  private totalBytes = 0;

  set(owner: GameplayObservationOwner, id: string, value: unknown): void {
    assertOwner(owner);
    if (!ID.test(id)) throw new TypeError('Gameplay observation id must contain 1-64 letters, digits, dots, colons, underscores or hyphens.');
    const normalized = normalizeValue(value);
    const bytes = new TextEncoder().encode(JSON.stringify(normalized)).byteLength;
    if (bytes > MAX_RECORD_BYTES) throw new RangeError(`Gameplay observation ${id} exceeds ${MAX_RECORD_BYTES} bytes.`);
    const key = `${owner.scriptId}\u0000${id}`;
    const previous = this.records.get(key);
    if (!previous && this.records.size >= MAX_RECORDS) throw new RangeError(`Gameplay observations exceed ${MAX_RECORDS} records.`);
    const nextTotal = this.totalBytes - (previous?.bytes ?? 0) + bytes;
    if (nextTotal > MAX_TOTAL_BYTES) throw new RangeError(`Gameplay observations exceed ${MAX_TOTAL_BYTES} bytes.`);
    const record = Object.freeze({ scriptId: owner.scriptId, entityId: owner.entityId, id, value: normalized });
    this.records.set(key, Object.freeze({ record, bytes }));
    this.totalBytes = nextTotal;
  }

  remove(owner: GameplayObservationOwner, id: string): void {
    assertOwner(owner);
    if (!ID.test(id)) throw new TypeError('Gameplay observation id is invalid.');
    const key = `${owner.scriptId}\u0000${id}`;
    const previous = this.records.get(key);
    if (!previous) return;
    this.records.delete(key);
    this.totalBytes -= previous.bytes;
  }

  clear(): void { this.records.clear(); this.totalBytes = 0; }

  snapshot(): readonly GameplayObservationRecord[] {
    return Object.freeze([...this.records.values()].map((entry) => entry.record).sort((left, right) => left.scriptId.localeCompare(right.scriptId) || left.id.localeCompare(right.id)));
  }
}

function assertOwner(value: GameplayObservationOwner): void {
  if (!value || typeof value.scriptId !== 'string' || !value.scriptId || typeof value.entityId !== 'string' || !value.entityId) throw new TypeError('Gameplay observation owner is invalid.');
}

function normalizeValue(value: unknown): GameplayObservationValue {
  return visit(value, 0, { nodes: 0 });
}

function visit(value: unknown, depth: number, counter: { nodes: number }): GameplayObservationValue {
  counter.nodes += 1;
  if (counter.nodes > MAX_NODES) throw new RangeError(`Gameplay observation exceeds ${MAX_NODES} values.`);
  if (depth > MAX_DEPTH) throw new RangeError(`Gameplay observation exceeds depth ${MAX_DEPTH}.`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Gameplay observation numbers must be finite.');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) throw new RangeError(`Gameplay observation strings must contain at most ${MAX_STRING_LENGTH} characters.`);
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => visit(entry, depth + 1, counter)));
  if (typeof value !== 'object') throw new TypeError('Gameplay observations must contain JSON values only.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Gameplay observation objects must be plain objects.');
  const result: Record<string, GameplayObservationValue> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (!key || key.length > MAX_KEY_LENGTH || key === '__proto__' || key === 'prototype' || key === 'constructor') throw new TypeError('Gameplay observation object key is invalid.');
    result[key] = visit((value as Record<string, unknown>)[key], depth + 1, counter);
  }
  return Object.freeze(result);
}
