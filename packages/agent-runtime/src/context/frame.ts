import { randomUUID } from 'node:crypto';
import {
  asStableId,
  type ContextFrameV1,
  type ContextPressureV1,
  type JsonValue,
  type M13Digest,
  type M13StableId,
  type StableId,
} from '@haiyue/ai-studio-contracts';
import { canonicalStringify, sha256, type OperationLog } from '@haiyue/ai-studio-operation-log';
import { assertCompactionRecordArtifact, latestCompletedCompaction, type ContextCompactionRuntime } from '../compaction/index.js';
import { DurableSessionRuntime } from '../session/index.js';
import { ConservativeTokenEstimator, ContextPolicyError, ContextPressureCalculator } from './pressure.js';
import type { CaptureContextFrameInput, CapturedContextFrameV1, ContextFrameInputDraft, ContextFrameRuntimeOptions, TokenEstimator } from './types.js';

export class ContextFrameRuntime {
  private readonly clock: () => Date;
  private readonly idFactory: NonNullable<ContextFrameRuntimeOptions['idFactory']>;
  private readonly estimator: TokenEstimator;
  private readonly pressure = new ContextPressureCalculator();
  private idIndex = 0;
  private disposed = false;

  constructor(
    private readonly log: OperationLog,
    private readonly sessions: DurableSessionRuntime,
    private readonly compactions?: ContextCompactionRuntime,
    options: ContextFrameRuntimeOptions & Readonly<{ estimator?: TokenEstimator }> = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => `context-frame:${randomUUID()}`);
    this.estimator = options.estimator ?? new ConservativeTokenEstimator();
  }

  async capture(input: CaptureContextFrameInput): Promise<CapturedContextFrameV1> {
    this.assertActive();
    const sessionId = stable(input.sessionId, 'session id');
    const turnId = stable(input.turnId, 'turn id');
    const external = await this.validateInputs(input.inputs ?? []);
    const additional = validInteger(input.additionalInputTokens ?? 0, 'additional input tokens') + external.reduce((sum, entry) => sum + entry.estimatedTokens, 0);
    const automatic = this.compactions ? await this.compactions.compact(sessionId, {
      reason: 'automatic-threshold',
      backendBindingId: input.backendBindingId,
      reservedOutputTokens: input.reservedOutputTokens,
      reservedSafetyTokens: input.reservedSafetyTokens,
      additionalInputTokens: additional,
      providerUsedInputTokens: input.providerUsedInputTokens,
      signal: input.signal,
    }) : null;
    const snapshot = await this.sessions.replay(sessionId);
    const bindingId = stable(input.backendBindingId, 'backend binding id');
    const binding = snapshot.session.backendBindings.find((entry) => entry.bindingId === bindingId && entry.status === 'active');
    if (!binding) throw new ContextPolicyError('context.binding-unavailable', `Active backend binding ${bindingId} is unavailable.`);
    if (input.projectRevision !== null && (!Number.isSafeInteger(input.projectRevision) || input.projectRevision < 0)) throw new ContextPolicyError('context.frame-invalid', 'Context Frame project revision is invalid.');
    const surfaceEntries: Array<Readonly<{ nodeId: M13StableId; messageArtifactId: M13StableId; digest: M13Digest; role: string; estimatedTokens: number }>> = [];
    let surfaceTokens = 0;
    for (const node of snapshot.surface.nodes) {
      const artifact = await this.log.readArtifact(node.messageArtifactId as StableId);
      const value = artifact.value;
      if (!isRecord(value) || typeof value.content !== 'string') throw new ContextPolicyError('context.surface-invalid', `Surface artifact ${node.messageArtifactId} is invalid.`);
      const estimatedTokens = this.estimator.estimate(value.content, binding.model);
      surfaceTokens += estimatedTokens;
      surfaceEntries.push(Object.freeze({ nodeId: node.id, messageArtifactId: node.messageArtifactId, digest: `sha256:${artifact.digest}` as M13Digest, role: node.role, estimatedTokens }));
    }
    const surfaceManifest = Object.freeze({
      schemaVersion: 1,
      kind: 'model-surface-context-input',
      sessionId,
      generation: snapshot.surface.generation,
      throughSequence: snapshot.surface.throughSequence,
      surfaceDigest: snapshot.surface.digest,
      nodes: Object.freeze(surfaceEntries),
    });
    const surfaceArtifact = await this.log.putArtifact(surfaceManifest, { schemaVersion: 'model-surface-context-input/1' });
    const estimatedUsed = surfaceTokens + additional;
    const providerUsed = input.providerUsedInputTokens === undefined || input.providerUsedInputTokens === null ? null : validInteger(input.providerUsedInputTokens, 'provider used input tokens');
    const measured = automatic?.status === 'completed' && automatic.record?.after ? Object.freeze({ pressure: automatic.record.after, usableInputTokens: automatic.record.after.maxInputTokens === null ? null : automatic.record.after.maxInputTokens - automatic.record.after.reservedOutputTokens - automatic.record.after.reservedSafetyTokens }) : this.pressure.calculate({
      maxInputTokens: binding.capabilities.maxInputTokens,
      reservedOutputTokens: input.reservedOutputTokens,
      reservedSafetyTokens: input.reservedSafetyTokens,
      usedInputTokens: binding.capabilities.maxInputTokens === null ? null : providerUsed ?? estimatedUsed,
      measurement: providerUsed === null ? 'tokenizer-estimated' : 'provider-reported',
    });
    if (measured.pressure.state === 'emergency') throw new ContextPolicyError('context.emergency-request-blocked', 'Context pressure is at or above 92%; a new model request is blocked until context is compacted.');
    const surfaceInput = Object.freeze({
      kind: 'surface' as const,
      artifactId: surfaceArtifact.id,
      digest: `sha256:${surfaceArtifact.digest}` as M13Digest,
      sourceRevision: null,
      estimatedTokens: surfaceTokens,
      required: true,
    });
    const inputs = Object.freeze([surfaceInput, ...external]);
    const latestCompaction = this.compactions?.latestCompleted(snapshot.ops) ?? latestCompletedCompaction(snapshot.ops);
    if (latestCompaction) {
      await assertCompactionRecordArtifact(this.log, latestCompaction);
    }
    const id = stable(input.id ?? this.idFactory('context-frame', this.idIndex++), 'context frame id');
    const frame: ContextFrameV1 = deepFreeze({
      schemaVersion: 1,
      id,
      sessionId,
      turnId,
      backendBindingId: bindingId,
      model: binding.model,
      surfaceGeneration: snapshot.surface.generation,
      projectRevision: input.projectRevision,
      inputs,
      pressure: measured.pressure,
      cachePrefixDigest: digest(inputs.map((entry) => ({ kind: entry.kind, digest: entry.digest, sourceRevision: entry.sourceRevision })) as unknown as JsonValue),
      compaction: latestCompaction,
      createdAt: this.clock().toISOString(),
    });
    const frameArtifact = await this.log.putArtifact(frame as unknown as JsonValue, { schemaVersion: 'context-frame/1' });
    await this.sessions.append(sessionId, {
      kind: 'evidence.captured',
      turnId,
      projectRevision: input.projectRevision,
      artifactRefs: [frameArtifact.id],
      payload: {
        evidenceKind: 'context-frame',
        contextFrameId: frame.id,
        contextFrameArtifactId: frameArtifact.id,
        surfaceGeneration: frame.surfaceGeneration,
        surfaceDigest: snapshot.surface.digest,
        pressure: frame.pressure as unknown as JsonValue,
      },
    });
    return deepFreeze({ frame, artifactId: frameArtifact.id, surfaceArtifactId: surfaceArtifact.id });
  }

  async assertReadable(artifactId: M13StableId): Promise<ContextFrameV1> {
    this.assertActive();
    const artifact = await this.log.readArtifact(stable(artifactId, 'context frame artifact id') as StableId);
    const value = artifact.value;
    if (!validFrame(value)) throw new ContextPolicyError('context.frame-invalid', 'Context Frame artifact is invalid.');
    return deepFreeze(value) as unknown as ContextFrameV1;
  }

  dispose(): void { this.disposed = true; }

  private async validateInputs(inputs: readonly ContextFrameInputDraft[]): Promise<readonly ContextFrameInputDraft[]> {
    if (!Array.isArray(inputs) || inputs.length > 1023) throw new ContextPolicyError('context.inputs-invalid', 'Context Frame external inputs exceed the bounded limit.');
    const result: ContextFrameInputDraft[] = [];
    const ids = new Set<M13StableId>();
    for (const input of inputs) {
      const id = stable(input.artifactId, 'context input artifact id');
      if (ids.has(id)) throw new ContextPolicyError('context.inputs-invalid', `Duplicate Context Frame input ${id}.`);
      ids.add(id);
      if (!['policy', 'tool-catalog', 'scene-snapshot', 'scene-diff', 'diagnostics-delta', 'evidence-delta', 'durable-memory', 'knowledge-hit'].includes(input.kind)) throw new ContextPolicyError('context.inputs-invalid', `Unsupported Context Frame input kind ${input.kind}.`);
      if (!isDigest(input.digest) || (input.sourceRevision !== null && (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 0)) || !Number.isSafeInteger(input.estimatedTokens) || input.estimatedTokens < 0 || typeof input.required !== 'boolean') throw new ContextPolicyError('context.inputs-invalid', `Context Frame input ${id} is invalid.`);
      const artifact = await this.log.readArtifact(id as StableId);
      if (`sha256:${artifact.digest}` !== input.digest) throw new ContextPolicyError('context.input-digest-mismatch', `Context Frame input ${id} digest does not match CAS.`);
      result.push(Object.freeze({ ...input, artifactId: id }));
    }
    return Object.freeze(result);
  }

  private assertActive(): void { if (this.disposed) throw new ContextPolicyError('context.frame-runtime-disposed', 'Context Frame runtime is disposed.'); }
}

function stable(value: M13StableId, label: string): M13StableId { try { return asStableId(value, label); } catch (cause) { throw new ContextPolicyError('context.id-invalid', `Invalid ${label}.`, { cause }); } }
function validInteger(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new ContextPolicyError('context.measurement-invalid', `Invalid ${label}.`); return value; }
function isDigest(value: unknown): value is M13Digest { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function validFrame(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isStable(value.id) || !isStable(value.sessionId) || !isStable(value.turnId) || !isStable(value.backendBindingId) || typeof value.model !== 'string' || value.model.length === 0
    || !isNonNegativeInteger(value.surfaceGeneration) || (value.projectRevision !== null && !isNonNegativeInteger(value.projectRevision))
    || !Array.isArray(value.inputs) || value.inputs.length === 0 || !isRecord(value.pressure) || !isDigest(value.cachePrefixDigest) || typeof value.createdAt !== 'string') return false;
  if (value.inputs.some((entry) => !isRecord(entry) || typeof entry.kind !== 'string' || !isStable(entry.artifactId) || !isDigest(entry.digest) || (entry.sourceRevision !== null && !isNonNegativeInteger(entry.sourceRevision)) || !isNonNegativeInteger(entry.estimatedTokens) || typeof entry.required !== 'boolean')) return false;
  const pressure = value.pressure;
  return (pressure.maxInputTokens === null || (isNonNegativeInteger(pressure.maxInputTokens) && pressure.maxInputTokens >= 1024 && pressure.maxInputTokens <= 100_000_000)) && isNonNegativeInteger(pressure.reservedOutputTokens) && isNonNegativeInteger(pressure.reservedSafetyTokens)
    && (pressure.usedInputTokens === null || isNonNegativeInteger(pressure.usedInputTokens)) && (pressure.ratio === null || (typeof pressure.ratio === 'number' && Number.isFinite(pressure.ratio) && pressure.ratio >= 0 && pressure.ratio <= 1))
    && typeof pressure.measurement === 'string' && typeof pressure.state === 'string';
}
function isStable(value: unknown): value is M13StableId { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value); }
function isNonNegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function digest(value: JsonValue): M13Digest { return `sha256:${sha256(canonicalStringify(value))}` as M13Digest; }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
