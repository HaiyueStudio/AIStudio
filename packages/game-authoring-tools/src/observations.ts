import { randomUUID } from 'node:crypto';
import {
  asStableId,
  type EvaluationResultV2,
  type JsonObject,
  type JsonValue,
  type ObservationArtifactV2,
  type StableId,
  type TaskSpecV2,
} from '@haiyue/ai-studio-contracts';
import { canonicalStringify, type OperationLog } from '@haiyue/ai-studio-operation-log';
import type { GamePlayCapture, GamePlayObservation, GameToolCall } from './types.js';
import { GameToolProtocolError } from './types.js';

const PRODUCER_VERSION = 'haiyue-play-observation/2.0.0';
// Base64 plus the provenance envelope must remain below Operation Log's 512 KiB JSON artifact ceiling.
const MAX_SCREENSHOT_BYTES = 376 * 1024;
const DEFAULT_TASK_OBSERVATION_BYTES = 5_000_000;

interface StoredObservationEnvelope extends JsonObject {
  readonly kind: 'haiyue.play-observation.v2';
  readonly type: ObservationArtifactV2['type'];
  readonly taskId: StableId;
  readonly turnId: StableId;
  readonly playId: StableId;
  readonly documentRevision: number;
  readonly scriptDigests: readonly string[];
  readonly tick: number;
  readonly frame: number;
  readonly viewport: Readonly<{ width: number; height: number }> | null;
  readonly device: string | null;
  readonly capturedAt: string;
  readonly redacted: boolean;
  readonly producerVersion: string;
  readonly payload: JsonValue;
}

export interface PersistedObservation {
  readonly artifact: ObservationArtifactV2;
  readonly projection: JsonObject | null;
  readonly projectionTruncated: boolean;
}

export class PlayObservationRepository {
  private readonly taskBytes = new Map<StableId, number>();

  constructor(
    private readonly operationLog: OperationLog,
    private readonly taskByteLimit = DEFAULT_TASK_OBSERVATION_BYTES,
  ) {
    if (!Number.isSafeInteger(taskByteLimit) || taskByteLimit < 1) throw new TypeError('Observation task byte limit must be positive.');
  }

  async persistState(call: GameToolCall, observation: GamePlayObservation, type: ObservationArtifactV2['type'] = 'state'): Promise<PersistedObservation> {
    const taskId = taskIdFor(call);
    const envelope = observationEnvelope(call, taskId, type, observation, observation.value, false);
    return this.persist(taskId, envelope, observation.value);
  }

  async persistInspection(call: GameToolCall, observation: GamePlayObservation): Promise<readonly PersistedObservation[]> {
    const value = observation.value;
    // Keep each derived record bound to exactly the same runtime snapshot.
    return [
      await this.persistState(call, observation),
      await this.persistState(call, { ...observation, value: Object.freeze({ trace: value.trace ?? [], physicsEvents: value.physicsEvents ?? [], interactions: isRecord(value.gesture) ? value.gesture.interactions as JsonValue ?? [] : value.interactions ?? [] }) }, 'event-trace'),
      await this.persistState(call, { ...observation, value: Object.freeze({ count: typeof value.runtimeErrorCount === 'number' ? value.runtimeErrorCount : 0 }) }, 'runtime-errors'),
      await this.persistState(call, { ...observation, value: Object.freeze({ finite: Number.isFinite(observation.tick) && Number.isFinite(observation.frame), tick: observation.tick, frame: observation.frame, timeMs: typeof value.timeMs === 'number' ? value.timeMs : null }) }, 'performance'),
    ];
  }

  async persistCapture(call: GameToolCall, capture: GamePlayCapture): Promise<PersistedObservation> {
    if (capture.mediaType !== 'image/png' || capture.byteLength < 8 || capture.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new GameToolProtocolError('observation.screenshot-too-large', `Screenshot must be a PNG between 8 and ${MAX_SCREENSHOT_BYTES} bytes.`);
    }
    const bytes = decodeBase64(capture.base64);
    if (bytes.byteLength !== capture.byteLength || !isPng(bytes)) throw new GameToolProtocolError('observation.screenshot-invalid', 'Screenshot transport payload is not the declared PNG.');
    const taskId = taskIdFor(call);
    const payload = Object.freeze({ mediaType: capture.mediaType, byteLength: capture.byteLength, base64: capture.base64 });
    const envelope = observationEnvelope(call, taskId, 'screenshot', capture, payload, false);
    return this.persist(taskId, envelope, Object.freeze({ mediaType: capture.mediaType, byteLength: capture.byteLength }));
  }

  async persistAnalysis(call: GameToolCall, observation: GamePlayObservation, value: JsonObject): Promise<PersistedObservation> {
    const taskId = taskIdFor(call);
    return this.persist(taskId, observationEnvelope(call, taskId, 'visual-analysis', observation, value, false), value);
  }

  async read(id: StableId): Promise<Readonly<{ artifact: ObservationArtifactV2; payload: JsonValue }>> {
    const record = await this.operationLog.readArtifact(id).catch((cause) => {
      const code = isRecord(cause) && cause.code === 'artifact-checksum-mismatch' ? 'observation.integrity-failed' : 'observation.missing';
      throw new GameToolProtocolError(code, errorMessage(cause));
    });
    const envelope = validateStoredEnvelope(record.value);
    return Object.freeze({ artifact: artifactFrom(envelope, record.id, record.digest, record.bytes), payload: envelope.payload });
  }

  usage(taskId: StableId): number { return this.taskBytes.get(taskId) ?? 0; }

  private async persist(taskId: StableId, envelope: StoredObservationEnvelope, projection: JsonObject | null): Promise<PersistedObservation> {
    const estimatedBytes = new TextEncoder().encode(canonicalStringify(envelope)).byteLength;
    const used = this.taskBytes.get(taskId) ?? 0;
    if (used + estimatedBytes > this.taskByteLimit) throw new GameToolProtocolError('observation.quota-exceeded', `Task observation quota would exceed ${this.taskByteLimit} bytes.`);
    const stored = await this.operationLog.putArtifactDetailed(envelope);
    if (!stored.localHit) this.taskBytes.set(taskId, used + stored.reference.bytes);
    const artifact = artifactFrom(envelope, stored.reference.id, stored.reference.digest, stored.reference.bytes);
    await this.operationLog.append({
      kind: 'observation/persisted', severity: 'info', source: asStableId('studio.play-observation'),
      correlation: { turnId: envelope.turnId, previewId: envelope.playId },
      payload: { artifactId: artifact.id, type: artifact.type, digest: artifact.digest, documentRevision: artifact.documentRevision, tick: artifact.tick, frame: artifact.frame, byteLength: artifact.byteLength, localHit: stored.localHit },
    });
    const bounded = observationProjection(projection);
    return Object.freeze({ artifact, ...bounded });
  }
}

export class DeterministicTaskEvaluator {
  constructor(private readonly observations: PlayObservationRepository, private readonly currentRevision: () => number) {}

  async evaluate(value: unknown, expectedTaskId?: StableId): Promise<EvaluationResultV2> {
    const input = validateEvaluationInput(value);
    const task = validateTaskSpec(input.taskSpec);
    if (expectedTaskId !== undefined && task.id !== expectedTaskId) throw new GameToolProtocolError('evaluation.task-mismatch', 'TaskSpec does not belong to the active Agent task.');
    const observations = await Promise.all(input.observationIds.map((id) => this.observations.read(id)));
    const provenanceDiagnostic = incompatibleProvenance(task.id, observations);
    if (provenanceDiagnostic) {
      return Object.freeze({
        schemaVersion: 2, id: asStableId(`evaluation:${randomUUID()}`), taskId: task.id,
        evaluatorVersion: 'haiyue-fixed-evaluator/2.0.0', status: 'blocked',
        acceptanceResults: Object.freeze(task.acceptance.map((acceptance) => Object.freeze({ acceptanceId: acceptance.id, status: 'blocked' as const, evidenceIds: Object.freeze(provenanceDiagnostic === 'evaluation.screenshot-state-tick-mismatch' ? observations.map((item) => item.artifact.id) : []), diagnostic: provenanceDiagnostic }))),
        budgetStatus: input.budgetStatus, usageRecordIds: input.usageRecordIds, costRecordIds: input.costRecordIds,
        turns: Object.freeze([]), tools: Object.freeze([]), completedAt: new Date().toISOString(),
      });
    }
    for (const [id, ids] of Object.entries(input.acceptanceEvidence)) {
      if (!task.acceptance.some(item => item.id === id) || ids.some(id => !input.observationIds.includes(id))) throw new GameToolProtocolError('evaluation.evidence-selection-invalid', `Criterion evidence must name an approved criterion and included observations. Invalid selection: ${JSON.stringify({ criterionId: id, criterionKnown: task.acceptance.some(item => item.id === id), observationsNotIncluded: ids.filter(id => !input.observationIds.includes(id)).slice(0, 4), approvedCriterionIds: task.acceptance.slice(0, 8).map(item => item.id) })}. Correct this mapping and resubmit using retained evidence; restarting Play does not fix selection ids.`);
    }
    const results: EvaluationResultV2['acceptanceResults'][number][] = [];
    for (const acceptance of task.acceptance) {
      const evaluated = evaluateAcceptance(task.id, acceptance, input.acceptanceEvidence[acceptance.id] ? observations.filter(item => input.acceptanceEvidence[acceptance.id]!.includes(item.artifact.id as StableId)) : observations, this.currentRevision());
      results.push(evaluated);
    }
    const required = task.acceptance.filter((item) => item.required);
    const requiredResults = required.map((item) => results.find((result) => result.acceptanceId === item.id)!);
    const status: EvaluationResultV2['status'] = requiredResults.some((item) => item.status === 'fail') ? 'fail'
      : requiredResults.some((item) => item.status === 'blocked') ? 'blocked' : 'pass';
    const now = new Date().toISOString();
    const result: EvaluationResultV2 = Object.freeze({
      schemaVersion: 2, id: asStableId(`evaluation:${randomUUID()}`), taskId: task.id,
      evaluatorVersion: 'haiyue-fixed-evaluator/2.0.0', status,
      acceptanceResults: Object.freeze(results),
      budgetStatus: input.budgetStatus,
      usageRecordIds: input.usageRecordIds, costRecordIds: input.costRecordIds,
      turns: Object.freeze([]), tools: Object.freeze([]), completedAt: now,
    });
    return result;
  }
}

function incompatibleProvenance(taskId: string, observations: readonly Readonly<{ artifact: ObservationArtifactV2; payload: JsonValue }>[]): string | null {
  if (observations.some((item) => item.artifact.taskId !== taskId)) return 'evaluation.evidence-task-mismatch';
  const playIds = new Set(observations.map((item) => item.artifact.playId));
  const revisions = new Set(observations.map((item) => item.artifact.documentRevision));
  const scriptSets = new Set(observations.map((item) => canonicalStringify([...item.artifact.scriptDigests].sort())));
  const viewports = new Set(observations.map((item) => canonicalStringify(item.artifact.viewport)));
  const devices = new Set(observations.map((item) => item.artifact.device));
  if (playIds.size !== 1 || revisions.size !== 1 || scriptSets.size !== 1 || viewports.size !== 1 || devices.size !== 1) return 'evaluation.evidence-provenance-mismatch';
  const stateTicks = new Set(observations.filter((item) => item.artifact.type === 'state').map((item) => item.artifact.tick));
  if (stateTicks.size && observations.some((item) => item.artifact.type === 'screenshot' && !stateTicks.has(item.artifact.tick))) return 'evaluation.screenshot-state-tick-mismatch';
  return null;
}

function evaluateAcceptance(
  taskId: string,
  acceptance: TaskSpecV2['acceptance'][number],
  observations: readonly Readonly<{ artifact: ObservationArtifactV2; payload: JsonValue }>[],
  currentRevision: number,
): EvaluationResultV2['acceptanceResults'][number] {
  const parsed = parseAssertion(acceptance.assertion);
  if (!parsed) return Object.freeze({ acceptanceId: acceptance.id, status: 'blocked', evidenceIds: Object.freeze([]), diagnostic: 'evaluation.assertion-unsupported' });
  const candidates = observations.filter((item) => item.artifact.taskId === taskId && item.artifact.type === parsed.type);
  if (!candidates.length) return Object.freeze({ acceptanceId: acceptance.id, status: 'fail', evidenceIds: Object.freeze([]), diagnostic: `evaluation.evidence-missing:${parsed.type}` });
  const latest = [...candidates].sort((left, right) => right.artifact.tick - left.artifact.tick || right.artifact.capturedAt.localeCompare(left.artifact.capturedAt))[0]!;
  if (latest.artifact.documentRevision !== currentRevision) return Object.freeze({ acceptanceId: acceptance.id, status: 'blocked', evidenceIds: Object.freeze([latest.artifact.id]), diagnostic: 'evaluation.evidence-stale-revision' });
  if (!parsed.signal) return Object.freeze({ acceptanceId: acceptance.id, status: 'pass', evidenceIds: Object.freeze([latest.artifact.id]), diagnostic: null });
  if ((parsed.type === 'screenshot' || acceptance.category === 'visual') && parsed.type !== 'visual-analysis') {
    return Object.freeze({ acceptanceId: acceptance.id, status: 'blocked', evidenceIds: Object.freeze([latest.artifact.id]), diagnostic: 'evaluation.visual-verifier-required' });
  }
  const actual = readPath(latest.payload, parsed.signal);
  if (actual === MISSING) {
    const unavailable = unavailablePlayEvidenceSignal(acceptance.assertion) !== null;
    return Object.freeze({ acceptanceId: acceptance.id, status: unavailable ? 'blocked' : 'fail', evidenceIds: Object.freeze([latest.artifact.id]), diagnostic: `${unavailable ? 'evaluation.signal-unavailable' : 'evaluation.signal-missing'}:${parsed.signal}` });
  }
  const passed = compare(actual, parsed.operator!, parsed.expected);
  return Object.freeze({ acceptanceId: acceptance.id, status: passed ? 'pass' : 'fail', evidenceIds: Object.freeze([latest.artifact.id]), diagnostic: passed ? null : `evaluation.condition-failed:${parsed.signal}:${parsed.operator}` });
}

type ParsedAssertion = Readonly<{ type: ObservationArtifactV2['type']; signal?: string; operator?: 'equals' | 'gte' | 'lte'; expected?: JsonValue }>;
export const EVIDENCE_ASSERTION_PATTERN = '^evidence\\s+(state|event-trace|runtime-errors|performance|screenshot|visual-analysis|lifecycle)(?:\\s+signal\\s+([A-Za-z0-9_.-]{1,160})\\s+(equals|gte|lte)\\s+(.+))?$';
const evidenceAssertionPattern = new RegExp(EVIDENCE_ASSERTION_PATTERN, 'u');
/** Use the evaluator's parser when validating a proposed plan, before asking the user to approve it. */
export function isSupportedEvidenceAssertion(value: string): boolean { return parseAssertion(value) !== null; }
/** Normalize only a known projection wrapper, before the plan is approved.
 * persistInspection projects state.gesture.interactions into event-trace.interactions.
 * Keep the evidence type, index, predicate and expected value unchanged. */
export function normalizePlayEvidenceAssertion(value: string): string {
  const parsed = parseAssertion(value);
  if (parsed?.type === 'state' && /^gesture\.final\.effects\./u.test(parsed.signal ?? '')) return value.replace(/^(evidence\s+state\s+signal\s+)gesture\.final\.(effects\.)/u, '$1$2');
  if (parsed?.type !== 'event-trace' || !/^gesture\.interactions(?:\.|$)/u.test(parsed.signal ?? '')) return value;
  return value.replace(/^(evidence\s+event-trace\s+signal\s+)gesture\.(interactions)(?=\.|\s)/u, '$1$2');
}
/** Reserved engine-owned fields only; gameplay/physics extension payloads remain open. */
export function unavailablePlayEvidenceSignal(assertion: string): string | null {
  const parsed = parseAssertion(assertion);
  if (!parsed?.signal) return null;
  const path = parsed.signal;
  if (parsed.type === 'state' && /^gesture\.(?:final\.)?effects(?:\.|$)/u.test(path)) return `${path} is a result wrapper, not an observation signal. Gesture effects are at effects.* on its final state artifact. Correct the plan before approval; an approved assertion must be reapproved, not silently rewritten or repaired through gameplay.`;
  const entity = /^state\.entities\.(?:0|[1-9][0-9]*)\.([^.]+)/u.exec(path);
  if (parsed.type === 'state' && entity && !['id', 'parentId', 'worldMatrix', 'position', 'rotation', 'scale', 'materialColor'].includes(entity[1]!)) {
    return `${path} is not a runtime entity field. Use scene.get-many for authored geometry/material/pointer configuration; Play entities expose id, position, rotation, scale and materialColor. Preserve the requirement and choose a supported verification method before approval.`;
  }
  if (parsed.type === 'event-trace' && !/^(?:trace|physicsEvents|interactions)(?:\.|$)/u.test(path)) {
    return `${path} is not an event-trace field. Pointer events are under interactions.<index>.type/entityId; trace and physicsEvents are separate arrays. Inspect the returned event payload; do not invent events.`;
  }
  if (parsed.type === 'state' && path.startsWith('effects.') && !/^effects\.(?:rotationMatched|intermediateMotion|rotationMismatches|rotationMismatchesTruncated|cameraChanged|materialColorChanged|changedEntityCount|changedEntityIds|changedEntityIdsTruncated|changedMaterialEntityCount|changedMaterialEntityIds|changedMaterialEntityIdsTruncated|changedTransformEntityCount|changedTransformEntityIds|changedTransformEntityIdsTruncated)(?:\.|$)/u.test(path)) {
    return `${path} is not a gesture effect. Use play.pointer-gesture state evidence: effects.cameraChanged, materialColorChanged, changedEntityCount/Ids or changedMaterialEntityCount/Ids, changedTransformEntityCount/Ids. These fields exist only on the gesture's final state artifact, not plain play.inspect.`;
  }
  return null;
}
function parseAssertion(value: string): ParsedAssertion | null {
  const match = evidenceAssertionPattern.exec(value.trim());
  if (!match) return null;
  if (!match[2]) return Object.freeze({ type: match[1] as ObservationArtifactV2['type'] });
  let expected: JsonValue;
  try { expected = JSON.parse(match[4]!) as JsonValue; } catch { return null; }
  if (!isJsonValue(expected)) return null;
  return Object.freeze({ type: match[1] as ObservationArtifactV2['type'], signal: match[2], operator: match[3] as 'equals' | 'gte' | 'lte', expected });
}

function compare(actual: JsonValue, operator: 'equals' | 'gte' | 'lte', expected: JsonValue | undefined): boolean {
  if (operator === 'equals') return canonicalStringify(actual) === canonicalStringify(expected ?? null);
  return typeof actual === 'number' && typeof expected === 'number' && (operator === 'gte' ? actual >= expected : actual <= expected);
}

// Full evidence stays in the artifact. Model-facing projections have an independent
// budget so a baseline/final pair cannot overflow the gesture tool result limit.
function observationProjection(value: JsonObject | null): Readonly<{ projection: JsonObject | null; projectionTruncated: boolean }> {
  const bytes = (item: JsonValue): number => new TextEncoder().encode(canonicalStringify(item)).byteLength;
  if (value === null || bytes(value) <= 8_192) return { projection: value, projectionTruncated: false };
  const priority = ['diagnostics', 'effects', 'gameplay', 'state', 'camera', 'entities', 'input', 'interactions', 'runtimeErrorCount', 'tick', 'frame'];
  const compact = (item: JsonValue, width: number, depth = 0): JsonValue => {
    if (typeof item === 'string') return item.slice(0, 256);
    if (item === null || typeof item !== 'object') return item;
    if (depth >= 10) return null;
    if (Array.isArray(item)) return item.slice(0, width).map(child => compact(child, width, depth + 1));
    const keys = Object.keys(item).sort((a, b) => (priority.indexOf(a) < 0 ? 99 : priority.indexOf(a)) - (priority.indexOf(b) < 0 ? 99 : priority.indexOf(b)));
    return Object.fromEntries(keys.slice(0, 24).map(key => [key, compact((item as JsonObject)[key]!, width, depth + 1)]));
  };
  for (const width of [8, 4, 2, 1]) {
    const projection = compact(value, width) as JsonObject;
    if (bytes(projection) <= 8_192) return { projection, projectionTruncated: true };
  }
  return { projection: null, projectionTruncated: true };
}

const MISSING = Symbol('missing');
function readPath(value: JsonValue, path: string): JsonValue | typeof MISSING {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(segment) || !Number.isSafeInteger(Number(segment)) || !Object.hasOwn(current, segment)) return MISSING;
      current = current[Number(segment)];
    } else {
      if (!isRecord(current) || !Object.hasOwn(current, segment)) return MISSING;
      current = current[segment];
    }
  }
  return isJsonValue(current) ? current : MISSING;
}

function observationEnvelope(call: GameToolCall, taskId: StableId, type: ObservationArtifactV2['type'], observation: Omit<GamePlayObservation, 'value'>, payload: JsonValue, redacted: boolean): StoredObservationEnvelope {
  return Object.freeze({
    kind: 'haiyue.play-observation.v2', type, taskId, turnId: call.turnId, playId: observation.playId,
    documentRevision: observation.documentRevision, scriptDigests: Object.freeze([...observation.scriptDigests]),
    tick: observation.tick, frame: observation.frame, viewport: observation.viewport, device: observation.device,
    capturedAt: observation.capturedAt, redacted, producerVersion: PRODUCER_VERSION, payload,
  }) as StoredObservationEnvelope;
}

function artifactFrom(envelope: StoredObservationEnvelope, id: StableId, digest: string, bytes: number): ObservationArtifactV2 {
  return Object.freeze({
    schemaVersion: 2, id, type: envelope.type, digest: digest as `sha256:${string}`,
    taskId: envelope.taskId, turnId: envelope.turnId, playId: envelope.playId,
    documentRevision: envelope.documentRevision, scriptDigests: envelope.scriptDigests as readonly `sha256:${string}`[],
    tick: envelope.tick, frame: envelope.frame, viewport: envelope.viewport, device: envelope.device,
    capturedAt: envelope.capturedAt, byteLength: bytes, redacted: envelope.redacted, producerVersion: envelope.producerVersion,
  });
}

function validateStoredEnvelope(value: JsonValue): StoredObservationEnvelope {
  if (!isRecord(value) || value.kind !== 'haiyue.play-observation.v2' || !['state', 'event-trace', 'runtime-errors', 'performance', 'screenshot', 'visual-analysis', 'lifecycle'].includes(String(value.type))
    || typeof value.taskId !== 'string' || typeof value.turnId !== 'string' || typeof value.playId !== 'string'
    || !Number.isSafeInteger(value.documentRevision) || !Array.isArray(value.scriptDigests) || !value.scriptDigests.every(isDigest)
    || !Number.isSafeInteger(value.tick) || !Number.isSafeInteger(value.frame) || typeof value.capturedAt !== 'string'
    || typeof value.redacted !== 'boolean' || value.producerVersion !== PRODUCER_VERSION || !isJsonValue(value.payload)) {
    throw new GameToolProtocolError('observation.invalid', 'Persisted observation envelope is invalid.');
  }
  if (value.viewport !== null && (!isRecord(value.viewport) || !Number.isSafeInteger(value.viewport.width) || !Number.isSafeInteger(value.viewport.height))) throw new GameToolProtocolError('observation.invalid', 'Persisted observation viewport is invalid.');
  if (value.device !== null && typeof value.device !== 'string') throw new GameToolProtocolError('observation.invalid', 'Persisted observation device is invalid.');
  return value as unknown as StoredObservationEnvelope;
}

interface EvaluationInput { readonly taskSpec: unknown; readonly acceptanceEvidence: Readonly<Record<string, readonly StableId[]>>; readonly observationIds: readonly StableId[]; readonly budgetStatus: EvaluationResultV2['budgetStatus']; readonly usageRecordIds: readonly StableId[]; readonly costRecordIds: readonly StableId[]; }
function validateEvaluationInput(value: unknown): EvaluationInput {
  if (!isRecord(value) || !Array.isArray(value.observationIds) || value.observationIds.length < 1 || value.observationIds.length > 256) throw new GameToolProtocolError('evaluation.input-invalid', 'Evaluation input is invalid.');
  const ids = value.observationIds.map((id) => stable(id, 'observation id'));
  const acceptanceEvidence: Record<string, readonly StableId[]> = Object.create(null);
  if (value.acceptanceEvidence !== undefined) {
    if (!isRecord(value.acceptanceEvidence) || Object.keys(value.acceptanceEvidence).length > 64) throw new GameToolProtocolError('evaluation.evidence-selection-invalid', 'Criterion evidence selection is invalid.');
    for (const [id, selected] of Object.entries(value.acceptanceEvidence)) {
      if (!Array.isArray(selected) || selected.length < 1 || selected.length > 256) throw new GameToolProtocolError('evaluation.evidence-selection-invalid', 'Select 1-256 observations per criterion.');
      acceptanceEvidence[stable(id, 'acceptance id')] = Object.freeze(selected.map(id => stable(id, 'observation id')));
    }
  }
  return Object.freeze({ taskSpec: value.taskSpec, acceptanceEvidence: Object.freeze(acceptanceEvidence), observationIds: Object.freeze(ids), budgetStatus: ['within', 'soft-exceeded', 'hard-exceeded'].includes(String(value.budgetStatus)) ? value.budgetStatus as EvaluationResultV2['budgetStatus'] : 'within', usageRecordIds: stableArray(value.usageRecordIds), costRecordIds: stableArray(value.costRecordIds) });
}

function validateTaskSpec(value: unknown): TaskSpecV2 {
  if (!isRecord(value) || value.schemaVersion !== 2 || typeof value.id !== 'string' || typeof value.request !== 'string' || value.request.length > 20_000
    || !Array.isArray(value.visibleConstraints) || !value.visibleConstraints.every((item) => typeof item === 'string') || typeof value.budgetId !== 'string'
    || !Array.isArray(value.requiredCapabilities) || !Array.isArray(value.acceptance) || value.acceptance.length < 1 || value.acceptance.length > 256) throw new GameToolProtocolError('evaluation.task-spec-invalid', 'TaskSpecV2 is invalid.');
  const acceptance = value.acceptance.map((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.required !== 'boolean' || !['agent', 'runner-only'].includes(String(item.visibility)) || !['functional', 'visual', 'performance', 'lifecycle', 'budget', 'security'].includes(String(item.category)) || typeof item.assertion !== 'string' || item.assertion.length > 2_000) throw new GameToolProtocolError('evaluation.task-spec-invalid', 'Task acceptance entry is invalid.');
    return Object.freeze({ id: stable(item.id, 'acceptance id'), required: item.required, visibility: item.visibility as 'agent' | 'runner-only', category: item.category as TaskSpecV2['acceptance'][number]['category'], assertion: item.assertion });
  });
  return Object.freeze({ schemaVersion: 2, id: stable(value.id, 'task id'), request: value.request, visibleConstraints: Object.freeze([...value.visibleConstraints] as string[]), budgetId: stable(value.budgetId, 'budget id'), requiredCapabilities: Object.freeze((value.requiredCapabilities as unknown[]).map((item) => stable(item, 'capability id'))) as TaskSpecV2['requiredCapabilities'], acceptance: Object.freeze(acceptance) });
}

function taskIdFor(call: GameToolCall): StableId { return call.taskId ?? asStableId(`task:${call.sessionId}`); }
function stableArray(value: unknown): readonly StableId[] { return value === undefined ? Object.freeze([]) : !Array.isArray(value) || value.length > 256 ? (() => { throw new GameToolProtocolError('evaluation.input-invalid', 'Record id list is invalid.'); })() : Object.freeze(value.map((item) => stable(item, 'record id'))); }
function stable(value: unknown, label: string): StableId { if (typeof value !== 'string') throw new GameToolProtocolError('evaluation.input-invalid', `${label} is invalid.`); return asStableId(value, label); }
function decodeBase64(value: string): Uint8Array { if (typeof value !== 'string' || value.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + 8 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) throw new GameToolProtocolError('observation.screenshot-invalid', 'Screenshot base64 is invalid.'); return Buffer.from(value, 'base64'); }
function isPng(bytes: Uint8Array): boolean { return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value); }
function isDigest(value: unknown): boolean { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function isJsonValue(value: unknown): value is JsonValue { if (value === null || typeof value === 'string' || typeof value === 'boolean') return true; if (typeof value === 'number') return Number.isFinite(value); if (Array.isArray(value)) return value.every(isJsonValue); return isRecord(value) && Object.values(value).every(isJsonValue); }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
