import { randomUUID } from 'node:crypto';
import {
  asStableId,
  type BackendSessionBindingV1,
  type CompactionRecordV1,
  type ContextPressureV1,
  type JsonObject,
  type JsonValue,
  type M13DiagnosticCode,
  type M13Digest,
  type M13StableId,
  type SessionOpV1,
  type StableId,
  type SurfaceOpV1,
} from '@haiyue/ai-studio-contracts';
import { canonicalStringify, redactObject, sha256, type OperationLog } from '@haiyue/ai-studio-operation-log';
import { ConservativeTokenEstimator, ContextPolicyError, ContextPressureCalculator } from '../context/pressure.js';
import { DurableSessionRuntime } from '../session/index.js';
import type { SessionReplaySnapshotV1 } from '../session/index.js';
import type {
  CompactionHistoryEntryV1,
  CompactionPreviewDecision,
  CompactionPreviewV1,
  CompactionRangePreviewV1,
  CompactionRunResultV1,
  CompactionRuntimeOptions,
  CompactionSourceMessageV1,
  CompactionSummarizer,
  PinnedContextFactInput,
  PinnedContextFactV1,
  PreviewCompactionInput,
  RunCompactionInput,
} from './types.js';

const COMPACTION_PHASES = Object.freeze({
  'compaction.requested': 'requested',
  'compaction.started': 'started',
  'compaction.summary-created': 'summary-created',
  'compaction.completed': 'completed',
  'compaction.failed': 'failed',
} as const);

export class ContextCompactionError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) { super(message, options); this.name = 'ContextCompactionError'; }
}

export class ContextCompactionRuntime {
  private readonly estimator;
  private readonly pressure = new ContextPressureCalculator();
  private readonly clock: () => Date;
  private readonly idFactory: NonNullable<CompactionRuntimeOptions['idFactory']>;
  private readonly targetRatio: number;
  private readonly minimumRatio: number;
  private readonly maximumRatio: number;
  private readonly maximumSummaryBytes: number;
  private readonly active = new Set<M13StableId>();
  private readonly controllers = new Map<M13StableId, AbortController>();
  private readonly pending = new Set<Promise<unknown>>();
  private idIndex = 0;
  private state: 'active' | 'disposing' | 'disposed' = 'active';

  constructor(
    private readonly log: OperationLog,
    private readonly sessions: DurableSessionRuntime,
    private readonly summarizer: CompactionSummarizer,
    options: CompactionRuntimeOptions = {},
  ) {
    this.estimator = options.estimator ?? new ConservativeTokenEstimator();
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? ((kind) => `${kind}:${randomUUID()}`);
    this.targetRatio = ratio(options.targetRatio ?? 0.6, 'target ratio');
    this.minimumRatio = ratio(options.targetMinimumRatio ?? 0.55, 'minimum target ratio');
    this.maximumRatio = ratio(options.targetMaximumRatio ?? 0.65, 'maximum target ratio');
    if (!(this.minimumRatio <= this.targetRatio && this.targetRatio <= this.maximumRatio && this.maximumRatio < this.pressure.thresholds.compact)) throw new ContextCompactionError('context.compaction-policy-invalid', 'Compaction targets must be ordered and remain below the automatic threshold.');
    this.maximumSummaryBytes = integer(options.maximumSummaryBytes ?? 256 * 1024, 1, 512 * 1024, 'maximum summary bytes');
  }

  async preview(sessionId: M13StableId, input: PreviewCompactionInput): Promise<CompactionPreviewV1> {
    this.assertActive();
    const snapshot = await this.sessions.replay(stable(sessionId, 'session id'));
    const binding = bindingFor(snapshot, input.backendBindingId);
    const messages = await this.readSurfaceMessages(snapshot, binding.model);
    const pinnedFacts = this.collectPinnedFacts(snapshot, input.pinnedFacts ?? []);
    const protectedNodeIds = protectedNodes(snapshot, input.protectedNodeIds ?? []);
    const surfaceTokens = messages.reduce((sum, item) => sum + item.estimatedTokens, 0);
    const additionalInputTokens = optionalInteger(input.additionalInputTokens ?? 0, 'additional input tokens');
    const providerUsed = optionalNullableInteger(input.providerUsedInputTokens, 'provider used input tokens');
    const usedInputTokens = providerUsed ?? surfaceTokens + additionalInputTokens;
    const measured = this.pressure.calculate({
      maxInputTokens: binding.capabilities.maxInputTokens,
      reservedOutputTokens: input.reservedOutputTokens,
      reservedSafetyTokens: input.reservedSafetyTokens,
      usedInputTokens: binding.capabilities.maxInputTokens === null ? null : usedInputTokens,
      measurement: providerUsed === null ? 'tokenizer-estimated' : 'provider-reported',
    });
    let decision: CompactionPreviewDecision = 'ready';
    if (measured.pressure.state === 'unknown') decision = 'capacity-unavailable';
    else if (input.reason === 'automatic-threshold' && measured.pressure.state !== 'compact-required' && measured.pressure.state !== 'emergency') decision = 'not-required';
    else if (hasOpenBoundary(snapshot)) decision = 'deferred-open-boundary';
    const range = decision === 'ready'
      ? selectRange(snapshot, messages, protectedNodeIds, measured.pressure, measured.usableInputTokens!, this.minimumRatio, this.targetRatio, this.maximumRatio, (candidate) => this.estimator.estimate(summaryEnvelope('', candidate, pinnedFacts), binding.model))
      : null;
    if (decision === 'ready' && range === null) decision = messages.length < 2 || compressibleEnd(messages, protectedNodeIds) < 1 ? 'no-stable-range' : 'target-unreachable';
    return freeze({
      reason: input.reason,
      decision,
      pressure: measured.pressure,
      sourceSurfaceGeneration: snapshot.surface.generation,
      sourceSurfaceDigest: snapshot.surface.digest as M13Digest,
      protectedNodeIds: Object.freeze(protectedNodeIds),
      pinnedFacts: Object.freeze(pinnedFacts),
      range,
    });
  }

  async compact(sessionId: M13StableId, input: RunCompactionInput): Promise<CompactionRunResultV1> {
    this.assertActive();
    const id = stable(sessionId, 'session id');
    if (this.active.has(id)) throw new ContextCompactionError('context.compaction-overlap', `Session ${id} already has an active compaction.`);
    this.active.add(id);
    const controller = new AbortController();
    const unlink = forwardAbort(input.signal, controller);
    this.controllers.set(id, controller);
    const execution = (async () => {
      const effective = { ...input, signal: controller.signal };
      const preview = await this.preview(id, effective);
      if (preview.decision !== 'ready' || !preview.range) return freeze({
        status: preview.decision === 'not-required' ? 'not-required' : 'deferred',
        compactionId: null,
        preview,
        record: null,
      }) as CompactionRunResultV1;
      return this.run(id, effective, preview);
    })();
    this.pending.add(execution);
    try { return await execution; }
    finally { unlink(); this.pending.delete(execution); this.controllers.delete(id); this.active.delete(id); }
  }

  async recover(sessionId: M13StableId): Promise<readonly CompactionHistoryEntryV1[]> {
    this.assertActive();
    const id = stable(sessionId, 'session id');
    const snapshot = await this.sessions.replay(id);
    const history = parseHistory(snapshot.ops);
    await validateHistoryArtifacts(this.log, history);
    const byId = groupHistory(history);
    for (const [compactionId, entries] of byId) {
      const terminal = entries.some((entry) => entry.phase === 'completed' || entry.phase === 'failed');
      if (terminal) continue;
      const summary = [...entries].reverse().find((entry) => entry.phase === 'summary-created');
      if (summary) {
        await this.sessions.append(id, {
          kind: 'compaction.completed', nodeId: compactionId, parentOpId: summary.opId, dependsOn: [summary.opId],
          payload: { phase: 'completed', compaction: summary.record as unknown as JsonValue, recoveredAfterRestart: true },
        });
      } else {
        const latest = entries.at(-1)!;
        const failed = failedRecord(latest.record, 'context.compaction-unsafe');
        await this.sessions.append(id, {
          kind: 'compaction.failed', nodeId: compactionId, parentOpId: latest.opId, dependsOn: [latest.opId],
          payload: { phase: 'failed', compaction: failed as unknown as JsonValue, recoveredAfterRestart: true },
        });
      }
    }
    const recovered = parseHistory((await this.sessions.replay(id)).ops);
    await validateHistoryArtifacts(this.log, recovered);
    return recovered;
  }

  async history(sessionId: M13StableId): Promise<readonly CompactionHistoryEntryV1[]> {
    this.assertActive();
    const history = parseHistory((await this.sessions.replay(stable(sessionId, 'session id'))).ops);
    await validateHistoryArtifacts(this.log, history);
    return history;
  }

  latestCompleted(ops: readonly SessionOpV1[]): CompactionRecordV1 | null {
    return latestCompletedCompaction(ops);
  }

  async dispose(): Promise<void> {
    if (this.state !== 'active') return;
    this.state = 'disposing';
    for (const controller of this.controllers.values()) controller.abort(new ContextCompactionError('context.compaction-disposed', 'Context compaction runtime is disposing.'));
    try { await Promise.allSettled([...this.pending]); }
    finally { this.controllers.clear(); this.active.clear(); this.pending.clear(); this.state = 'disposed'; }
  }

  private async run(sessionId: M13StableId, input: RunCompactionInput, preview: CompactionPreviewV1): Promise<CompactionRunResultV1> {
    const beforeRun = await this.sessions.replay(sessionId);
    if (beforeRun.surface.generation !== preview.sourceSurfaceGeneration || beforeRun.surface.digest !== preview.sourceSurfaceDigest) throw new ContextCompactionError('context.compaction-preview-stale', 'Surface changed after compaction preview; a new preview is required.');
    const compactionId = this.nextUniqueId('compaction', new Set(beforeRun.ops.filter((op) => op.kind.startsWith('compaction.')).map((op) => op.nodeId).filter((id): id is M13StableId => id !== null)));
    const range = preview.range!;
    let record: CompactionRecordV1 = freeze({
      id: compactionId,
      reason: preview.reason,
      coveredStartSequence: range.coveredStartSequence,
      coveredEndSequence: range.coveredEndSequence,
      before: preview.pressure,
      after: null,
      sourceSurfaceGeneration: preview.sourceSurfaceGeneration,
      targetSurfaceGeneration: null,
      summaryArtifactId: null,
      pinnedFactDigests: Object.freeze(preview.pinnedFacts.map((fact) => fact.digest)),
      validation: 'pending',
      diagnostic: null,
    });
    let latestOpId: M13StableId | null = null;
    let surfacePublished = false;
    try {
      let snapshot = await this.sessions.append(sessionId, {
        kind: 'compaction.requested', nodeId: compactionId,
        payload: { phase: 'requested', compaction: record as unknown as JsonValue, preview: previewPayload(preview) },
      });
      latestOpId = snapshot.ops.at(-1)!.id;
      throwIfAborted(input.signal);
      snapshot = await this.sessions.append(sessionId, {
        kind: 'compaction.started', nodeId: compactionId, parentOpId: latestOpId, dependsOn: [latestOpId],
        payload: { phase: 'started', compaction: record as unknown as JsonValue },
      });
      latestOpId = snapshot.ops.at(-1)!.id;
      const binding = bindingFor(snapshot, input.backendBindingId);
      const allMessages = await this.readSurfaceMessages(snapshot, binding.model);
      const selected = range.nodeIds.map((nodeId) => allMessages.find((message) => message.nodeId === nodeId)!).filter(Boolean);
      const envelopeOverheadTokens = this.estimator.estimate(summaryEnvelope('', range, preview.pinnedFacts), binding.model);
      const targetBodyTokens = Math.max(1, range.targetSummaryTokens - envelopeOverheadTokens);
      const maximumBodyTokens = Math.max(1, range.maximumSummaryTokens - envelopeOverheadTokens);
      throwIfAborted(input.signal);
      const result = await this.summarizer(freeze({
        schemaVersion: 1,
        compactionId,
        sessionId,
        model: binding.model,
        messages: Object.freeze(selected),
        pinnedFacts: preview.pinnedFacts,
        targetEnvelopeTokens: range.targetSummaryTokens,
        estimatedEnvelopeOverheadTokens: envelopeOverheadTokens,
        targetSummaryTokens: targetBodyTokens,
        maximumSummaryTokens: maximumBodyTokens,
      }), input.signal);
      throwIfAborted(input.signal);
      const summaryContent = structuredSummary(result?.summary, range, preview.pinnedFacts);
      if (Buffer.byteLength(summaryContent) > this.maximumSummaryBytes) throw new ContextCompactionError('context.compaction-summary-invalid', 'Compaction summary exceeds the bounded artifact size.');
      const summaryTokens = this.estimator.estimate(summaryContent, binding.model);
      if (summaryTokens < range.minimumSummaryTokens || summaryTokens > range.maximumSummaryTokens || summaryTokens >= range.coveredTokens) throw new ContextCompactionError('context.compaction-summary-invalid', 'Compaction summary does not meet the validated token target.');
      const artifactValue = redactObject({ schemaVersion: 1, kind: 'surface-summary', role: 'assistant', content: summaryContent }).value;
      const artifact = await this.log.putArtifact(artifactValue, { schemaVersion: 'agent-surface-summary/1' });
      const surfaceOperation: SurfaceOpV1 = freeze({
        op: 'replace',
        id: this.nextUniqueId('surface-node', new Set(snapshot.surface.nodes.map((node) => node.id))),
        sourceOpIds: range.sourceOpIds,
        startNodeId: range.startNodeId,
        endNodeId: range.endNodeId,
        replacementArtifactId: artifact.id,
        reason: 'compaction',
      });
      const usedAfter = Math.max(0, preview.pressure.usedInputTokens! - range.coveredTokens + summaryTokens);
      const after = this.pressure.calculate({
        maxInputTokens: preview.pressure.maxInputTokens,
        reservedOutputTokens: preview.pressure.reservedOutputTokens,
        reservedSafetyTokens: preview.pressure.reservedSafetyTokens,
        usedInputTokens: usedAfter,
        measurement: 'tokenizer-estimated',
      }).pressure;
      if (preview.pressure.ratio! >= this.pressure.thresholds.compact && (after.ratio === null || after.ratio < this.minimumRatio || after.ratio > this.maximumRatio)) throw new ContextCompactionError('context.compaction-summary-invalid', 'Compaction did not land inside the 55%-65% target pressure band.');
      record = freeze({ ...record, after, targetSurfaceGeneration: preview.sourceSurfaceGeneration + 1, summaryArtifactId: artifact.id, validation: 'passed' });
      snapshot = await this.sessions.append(sessionId, {
        kind: 'compaction.summary-created', nodeId: compactionId, parentOpId: latestOpId, dependsOn: [latestOpId],
        projectRevision: latestProjectRevision(snapshot), artifactRefs: [artifact.id],
        payload: { phase: 'summary-created', compaction: record as unknown as JsonValue, surfaceOperation: surfaceOperation as unknown as JsonValue },
      });
      surfacePublished = true;
      latestOpId = snapshot.ops.at(-1)!.id;
      snapshot = await this.sessions.append(sessionId, {
        kind: 'compaction.completed', nodeId: compactionId, parentOpId: latestOpId, dependsOn: [latestOpId],
        projectRevision: latestProjectRevision(snapshot), payload: { phase: 'completed', compaction: record as unknown as JsonValue },
      });
      const completedRecord = parseCompactionRecord(snapshot.ops.at(-1)!.payload.compaction);
      return freeze({ status: 'completed', compactionId, preview, record: completedRecord });
    } catch (cause) {
      if (surfacePublished) throw cause;
      const diagnostic: M13DiagnosticCode = cause instanceof ContextCompactionError && cause.code === 'context.compaction-summary-invalid' ? 'context.compaction-summary-invalid' : 'context.compaction-unsafe';
      const failed = failedRecord(record, diagnostic);
      if (latestOpId !== null) await this.sessions.append(sessionId, {
        kind: 'compaction.failed', nodeId: compactionId, parentOpId: latestOpId, dependsOn: [latestOpId],
        payload: { phase: 'failed', compaction: failed as unknown as JsonValue, cancelled: input.signal?.aborted === true },
      });
      return freeze({ status: 'failed', compactionId, preview, record: failed });
    }
  }

  private async readSurfaceMessages(snapshot: SessionReplaySnapshotV1, model: string): Promise<readonly CompactionSourceMessageV1[]> {
    const result: CompactionSourceMessageV1[] = [];
    for (const node of snapshot.surface.nodes) {
      const artifact = await this.log.readArtifact(node.messageArtifactId as StableId);
      const value = artifact.value;
      if (!isRecord(value) || value.schemaVersion !== 1 || !['session-message', 'surface-summary'].includes(String(value.kind)) || typeof value.content !== 'string') throw new ContextCompactionError('context.compaction-summary-invalid', `Surface artifact ${node.messageArtifactId} is not a valid model message.`);
      result.push(freeze({
        nodeId: node.id,
        role: node.role,
        content: value.content,
        sourceOpIds: Object.freeze(node.replacedSourceOpIds.length > 0 ? [...node.replacedSourceOpIds] : [node.originOpId]),
        estimatedTokens: this.estimator.estimate(value.content, model),
      }));
    }
    return Object.freeze(result);
  }

  private collectPinnedFacts(snapshot: SessionReplaySnapshotV1, supplied: readonly PinnedContextFactInput[]): readonly PinnedContextFactV1[] {
    const candidates: PinnedContextFactInput[] = [...supplied];
    if (snapshot.session.activeGoal) candidates.push({ kind: 'active-goal', content: snapshot.session.activeGoal });
    const revision = latestProjectRevision(snapshot);
    if (revision !== null) candidates.push({ kind: 'project-revision', content: `Current project revision is ${revision}.`, projectRevision: revision });
    for (const id of snapshot.recovery.unresolvedBarrierIds) candidates.push({ kind: 'unresolved-barrier', content: `Unresolved interaction barrier ${id}.` });
    for (const kind of ['document.committed', 'evidence.captured', 'evaluation.completed'] as const) {
      const op = [...snapshot.ops].reverse().find((entry) => entry.kind === kind && entry.artifactRefs.length > 0);
      if (op) candidates.push({ kind: kind === 'document.committed' ? 'scene-diff' : 'artifact-reference', content: `${kind} artifacts: ${op.artifactRefs.join(', ')}`, artifactRefs: op.artifactRefs, projectRevision: op.projectRevision });
    }
    for (const op of [...snapshot.ops].reverse()) {
      const blocker = op.payload.blocker;
      if (typeof blocker === 'string') candidates.push({ kind: 'blocker', content: blocker, artifactRefs: op.artifactRefs, projectRevision: op.projectRevision });
      const blockers = op.payload.blockers;
      if (Array.isArray(blockers)) for (const value of blockers) if (typeof value === 'string') candidates.push({ kind: 'blocker', content: value, artifactRefs: op.artifactRefs, projectRevision: op.projectRevision });
      if (candidates.filter((fact) => fact.kind === 'blocker').length >= 32) break;
    }
    const result = new Map<M13Digest, PinnedContextFactV1>();
    for (const candidate of candidates) {
      const normalized = normalizeFact(candidate);
      result.set(normalized.digest, normalized);
    }
    if (result.size > 1024) throw new ContextCompactionError('context.pinned-fact-invalid', 'Compaction exceeds the pinned fact contract limit.');
    return Object.freeze([...result.values()].sort((a, b) => a.digest.localeCompare(b.digest)));
  }

  private nextUniqueId(kind: 'compaction' | 'surface-node', used: ReadonlySet<M13StableId>): M13StableId {
    for (let attempt = 0; attempt < 1024; attempt += 1) {
      const candidate = stable(this.idFactory(kind, this.idIndex++), `${kind} id`);
      if (!used.has(candidate)) return candidate;
    }
    throw new ContextCompactionError('context.id-exhausted', `Could not allocate a unique ${kind} id.`);
  }

  private assertActive(): void { if (this.state !== 'active') throw new ContextCompactionError('context.compaction-disposed', `Context compaction runtime is ${this.state}.`); }
}

export function latestCompletedCompaction(ops: readonly SessionOpV1[]): CompactionRecordV1 | null {
  const value = [...parseHistory(ops)].reverse().find((entry) => entry.phase === 'completed');
  return value?.record ?? null;
}

export async function assertCompactionRecordArtifact(log: OperationLog, record: CompactionRecordV1): Promise<void> {
  if (record.validation !== 'passed' || record.summaryArtifactId === null) return;
  const artifact = await log.readArtifact(record.summaryArtifactId as StableId);
  const value = artifact.value;
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'surface-summary' || value.role !== 'assistant' || typeof value.content !== 'string') throw new ContextCompactionError('context.compaction-summary-invalid', `Compaction ${record.id} summary artifact is invalid.`);
  let summary: unknown;
  try { summary = JSON.parse(value.content); } catch (cause) { throw new ContextCompactionError('context.compaction-summary-invalid', `Compaction ${record.id} structured summary is invalid JSON.`, { cause }); }
  if (!isRecord(summary) || summary.schemaVersion !== 1 || summary.kind !== 'context-compaction-summary' || !Array.isArray(summary.pinnedFacts)) throw new ContextCompactionError('context.compaction-summary-invalid', `Compaction ${record.id} structured summary is invalid.`);
  const digests = summary.pinnedFacts.map((fact) => isRecord(fact) ? fact.digest : null);
  if (digests.length !== record.pinnedFactDigests.length || digests.some((digest, index) => digest !== record.pinnedFactDigests[index])) throw new ContextCompactionError('context.compaction-summary-invalid', `Compaction ${record.id} lost or reordered pinned facts.`);
}

function selectRange(
  snapshot: SessionReplaySnapshotV1,
  messages: readonly CompactionSourceMessageV1[],
  protectedNodeIds: readonly M13StableId[],
  pressure: ContextPressureV1,
  usableInputTokens: number,
  minimumRatio: number,
  targetRatio: number,
  maximumRatio: number,
  estimateEnvelopeOverhead: (range: CompactionRangePreviewV1) => number,
): CompactionRangePreviewV1 | null {
  const end = compressibleEnd(messages, protectedNodeIds);
  if (end < 1 || pressure.usedInputTokens === null) return null;
  let coveredTokens = 0;
  for (let index = 0; index <= end; index += 1) {
    coveredTokens += messages[index]!.estimatedTokens;
    if (index < 1) continue;
    const accountedCovered = Math.min(coveredTokens, pressure.usedInputTokens);
    const remaining = pressure.usedInputTokens - accountedCovered;
    const maximumSummaryTokens = Math.min(coveredTokens - 1, Math.floor(maximumRatio * usableInputTokens - remaining));
    const minimumSummaryTokens = Math.max(1, Math.ceil(minimumRatio * usableInputTokens - remaining));
    const selected = messages.slice(0, index + 1);
    const sourceOpIds = unique(selected.flatMap((message) => [...message.sourceOpIds])).sort();
    const sequences = sourceOpIds.map((id) => snapshot.ops.find((op) => op.id === id)?.sequence).filter((value): value is number => value !== undefined);
    const draft = freeze({
      startNodeId: selected[0]!.nodeId,
      endNodeId: selected.at(-1)!.nodeId,
      nodeIds: Object.freeze(selected.map((message) => message.nodeId)),
      sourceOpIds: Object.freeze(sourceOpIds),
      coveredStartSequence: sequences.length > 0 ? Math.min(...sequences) : 0,
      coveredEndSequence: sequences.length > 0 ? Math.max(...sequences) : snapshot.surface.throughSequence,
      coveredTokens: accountedCovered,
      targetSummaryTokens: 0,
      minimumSummaryTokens,
      maximumSummaryTokens,
    });
    const fixedMinimum = estimateEnvelopeOverhead(draft) + 1;
    const effectiveMinimum = Math.max(minimumSummaryTokens, fixedMinimum);
    if (maximumSummaryTokens < effectiveMinimum) continue;
    const targetSummaryTokens = clamp(Math.round(targetRatio * usableInputTokens - remaining), effectiveMinimum, maximumSummaryTokens);
    return freeze({ ...draft, targetSummaryTokens, minimumSummaryTokens: effectiveMinimum });
  }
  return null;
}

function protectedNodes(snapshot: SessionReplaySnapshotV1, supplied: readonly M13StableId[]): M13StableId[] {
  const ids = new Set<M13StableId>(supplied.map((id) => stable(id, 'protected node id')));
  const latestUser = [...snapshot.surface.nodes].map((node) => node.role).lastIndexOf('user');
  if (latestUser >= 0) for (const node of snapshot.surface.nodes.slice(latestUser)) ids.add(node.id);
  const openTurns = new Set(snapshot.recovery.openTurnIds);
  const openBatches = new Set(snapshot.recovery.openBatchIds);
  for (const node of snapshot.surface.nodes) {
    const sources = node.replacedSourceOpIds.length > 0 ? node.replacedSourceOpIds : [node.originOpId];
    if (sources.some((id) => { const op = snapshot.ops.find((entry) => entry.id === id); return Boolean(op && ((op.turnId && openTurns.has(op.turnId)) || (op.batchId && openBatches.has(op.batchId)))); })) ids.add(node.id);
  }
  return [...ids].sort();
}

function compressibleEnd(messages: readonly CompactionSourceMessageV1[], protectedNodeIds: readonly M13StableId[]): number {
  const protectedSet = new Set(protectedNodeIds);
  const firstProtected = messages.findIndex((message) => protectedSet.has(message.nodeId));
  return (firstProtected < 0 ? messages.length : firstProtected) - 1;
}

function hasOpenBoundary(snapshot: SessionReplaySnapshotV1): boolean {
  return snapshot.recovery.openTurnIds.length > 0 || snapshot.recovery.openToolNodeIds.length > 0 || snapshot.recovery.openBatchIds.length > 0 || snapshot.recovery.unresolvedBarrierIds.length > 0;
}

function bindingFor(snapshot: SessionReplaySnapshotV1, bindingId: M13StableId): BackendSessionBindingV1 {
  const id = stable(bindingId, 'backend binding id');
  const binding = snapshot.session.backendBindings.find((entry) => entry.bindingId === id && entry.status === 'active');
  if (!binding) throw new ContextCompactionError('context.binding-unavailable', `Active backend binding ${id} is unavailable.`);
  return binding;
}

function normalizeFact(input: PinnedContextFactInput): PinnedContextFactV1 {
  if (!['active-goal', 'acceptance', 'artifact-reference', 'blocker', 'latest-error', 'project-revision', 'scene-diff', 'unresolved-barrier'].includes(input.kind)) throw new ContextCompactionError('context.pinned-fact-invalid', 'Pinned fact kind is invalid.');
  if (typeof input.content !== 'string' || input.content.trim().length === 0 || Buffer.byteLength(input.content) > 32_768) throw new ContextCompactionError('context.pinned-fact-invalid', 'Pinned fact content is invalid.');
  const artifactRefs = unique((input.artifactRefs ?? []).map((id) => stable(id, 'pinned artifact id'))).sort();
  if (artifactRefs.length > 64) throw new ContextCompactionError('context.pinned-fact-invalid', 'Pinned fact has too many artifact references.');
  const projectRevision = input.projectRevision ?? null;
  if (projectRevision !== null && (!Number.isSafeInteger(projectRevision) || projectRevision < 0)) throw new ContextCompactionError('context.pinned-fact-invalid', 'Pinned fact project revision is invalid.');
  const safe = redactObject({ kind: input.kind, content: input.content.trim(), artifactRefs, projectRevision }).value;
  const base = { kind: safe.kind as PinnedContextFactV1['kind'], content: safe.content as string, artifactRefs: safe.artifactRefs as readonly M13StableId[], projectRevision: safe.projectRevision as number | null };
  return freeze({ ...base, digest: digest(base as unknown as JsonValue) });
}

function structuredSummary(summary: unknown, range: CompactionRangePreviewV1, pinnedFacts: readonly PinnedContextFactV1[]): string {
  if (typeof summary !== 'string' || summary.trim().length === 0) throw new ContextCompactionError('context.compaction-summary-invalid', 'Compaction summarizer returned no summary.');
  const safe = redactObject({ summary: summary.trim() }).value.summary;
  if (typeof safe !== 'string' || safe.length === 0) throw new ContextCompactionError('context.compaction-summary-invalid', 'Compaction summary is invalid after redaction.');
  return summaryEnvelope(safe, range, pinnedFacts);
}

function summaryEnvelope(summary: string, range: CompactionRangePreviewV1, pinnedFacts: readonly PinnedContextFactV1[]): string {
  return canonicalStringify({
    schemaVersion: 1,
    kind: 'context-compaction-summary',
    coveredNodeIds: range.nodeIds,
    coveredSourceOpIds: range.sourceOpIds,
    summary,
    pinnedFacts,
  });
}

function parseHistory(ops: readonly SessionOpV1[]): readonly CompactionHistoryEntryV1[] {
  const result: CompactionHistoryEntryV1[] = [];
  for (const op of ops) {
    const phase = COMPACTION_PHASES[op.kind as keyof typeof COMPACTION_PHASES];
    if (!phase) continue;
    if (op.payload.phase !== phase) throw new ContextCompactionError('context.compaction-record-invalid', `Compaction operation ${op.id} has a mismatched phase.`);
    const record = parseCompactionRecord(op.payload.compaction);
    if (op.nodeId !== record.id) throw new ContextCompactionError('context.compaction-record-invalid', `Compaction operation ${op.id} has a mismatched compaction id.`);
    result.push(freeze({ record, phase, opId: op.id }));
  }
  for (const entries of groupHistory(result).values()) validateHistoryTransitions(entries);
  return Object.freeze(result);
}

function parseCompactionRecord(value: unknown): CompactionRecordV1 {
  const keys = ['id', 'reason', 'coveredStartSequence', 'coveredEndSequence', 'before', 'after', 'sourceSurfaceGeneration', 'targetSurfaceGeneration', 'summaryArtifactId', 'pinnedFactDigests', 'validation', 'diagnostic'];
  if (!isRecord(value) || !keys.every((key) => key in value) || Object.keys(value).some((key) => !keys.includes(key)) || !isStable(value.id)
    || !['automatic-threshold', 'manual', 'provider-required'].includes(String(value.reason))
    || !isNonNegative(value.coveredStartSequence) || !isNonNegative(value.coveredEndSequence) || value.coveredEndSequence < value.coveredStartSequence
    || !validPressure(value.before) || (value.after !== null && !validPressure(value.after))
    || !isNonNegative(value.sourceSurfaceGeneration) || (value.targetSurfaceGeneration !== null && !isNonNegative(value.targetSurfaceGeneration))
    || (value.summaryArtifactId !== null && !isStable(value.summaryArtifactId)) || !Array.isArray(value.pinnedFactDigests) || value.pinnedFactDigests.some((item) => !isDigest(item))
    || !['pending', 'passed', 'failed'].includes(String(value.validation)) || (value.diagnostic !== null && !['context.compaction-unsafe', 'context.compaction-summary-invalid'].includes(String(value.diagnostic)))) {
    throw new ContextCompactionError('context.compaction-record-invalid', 'Compaction record is invalid.');
  }
  return freeze(value) as unknown as CompactionRecordV1;
}

function validPressure(value: unknown): value is ContextPressureV1 {
  if (!isRecord(value)) return false;
  return (value.maxInputTokens === null || (isNonNegative(value.maxInputTokens) && value.maxInputTokens >= 1024 && value.maxInputTokens <= 100_000_000)) && isNonNegative(value.reservedOutputTokens) && isNonNegative(value.reservedSafetyTokens)
    && (value.usedInputTokens === null || isNonNegative(value.usedInputTokens)) && (value.ratio === null || (typeof value.ratio === 'number' && Number.isFinite(value.ratio) && value.ratio >= 0 && value.ratio <= 1))
    && ['provider-reported', 'tokenizer-estimated', 'unavailable'].includes(String(value.measurement)) && ['normal', 'warning', 'preparing', 'compact-required', 'emergency', 'unknown'].includes(String(value.state));
}

function groupHistory(entries: readonly CompactionHistoryEntryV1[]): Map<M13StableId, CompactionHistoryEntryV1[]> {
  const result = new Map<M13StableId, CompactionHistoryEntryV1[]>();
  for (const entry of entries) { const values = result.get(entry.record.id) ?? []; values.push(entry); result.set(entry.record.id, values); }
  return result;
}

async function validateHistoryArtifacts(log: OperationLog, entries: readonly CompactionHistoryEntryV1[]): Promise<void> {
  for (const entry of entries) if (entry.phase === 'summary-created') await assertCompactionRecordArtifact(log, entry.record);
}

function validateHistoryTransitions(entries: readonly CompactionHistoryEntryV1[]): void {
  const phases = entries.map((entry) => entry.phase).join(',');
  if (!['requested', 'requested,started', 'requested,started,summary-created', 'requested,started,summary-created,completed', 'requested,started,failed'].includes(phases)) throw new ContextCompactionError('context.compaction-record-invalid', `Invalid compaction phase sequence ${phases}.`);
  const base = entries[0]!.record;
  for (const entry of entries) if (entry.record.reason !== base.reason || entry.record.sourceSurfaceGeneration !== base.sourceSurfaceGeneration || entry.record.coveredStartSequence !== base.coveredStartSequence || entry.record.coveredEndSequence !== base.coveredEndSequence) throw new ContextCompactionError('context.compaction-record-invalid', `Compaction ${base.id} changed immutable coordinates.`);
  for (const entry of entries) {
    const pending = entry.phase === 'requested' || entry.phase === 'started';
    if (pending && (entry.record.validation !== 'pending' || entry.record.after !== null || entry.record.targetSurfaceGeneration !== null || entry.record.summaryArtifactId !== null || entry.record.diagnostic !== null)) throw new ContextCompactionError('context.compaction-record-invalid', `Compaction ${base.id} has an invalid pending record.`);
    if ((entry.phase === 'summary-created' || entry.phase === 'completed') && (entry.record.validation !== 'passed' || entry.record.after === null || entry.record.targetSurfaceGeneration !== entry.record.sourceSurfaceGeneration + 1 || entry.record.summaryArtifactId === null || entry.record.diagnostic !== null)) throw new ContextCompactionError('context.compaction-record-invalid', `Compaction ${base.id} has an invalid published record.`);
    if (entry.phase === 'failed' && (entry.record.validation !== 'failed' || entry.record.after !== null || entry.record.targetSurfaceGeneration !== null || entry.record.summaryArtifactId !== null || entry.record.diagnostic === null)) throw new ContextCompactionError('context.compaction-record-invalid', `Compaction ${base.id} has an invalid failure record.`);
  }
  const published = entries.find((entry) => entry.phase === 'summary-created')?.record;
  const completed = entries.find((entry) => entry.phase === 'completed')?.record;
  if (published && completed && canonicalStringify(published as unknown as JsonValue) !== canonicalStringify(completed as unknown as JsonValue)) throw new ContextCompactionError('context.compaction-record-invalid', `Compaction ${base.id} completion drifted from its published record.`);
}

function failedRecord(record: CompactionRecordV1, diagnostic: Extract<M13DiagnosticCode, 'context.compaction-unsafe' | 'context.compaction-summary-invalid'>): CompactionRecordV1 {
  return freeze({ ...record, after: null, targetSurfaceGeneration: null, summaryArtifactId: null, validation: 'failed', diagnostic });
}

function previewPayload(preview: CompactionPreviewV1): JsonObject {
  return freeze({ decision: preview.decision, sourceSurfaceDigest: preview.sourceSurfaceDigest, protectedNodeIds: preview.protectedNodeIds, range: preview.range as unknown as JsonValue });
}

function latestProjectRevision(snapshot: SessionReplaySnapshotV1): number | null { return [...snapshot.ops].reverse().find((op) => op.projectRevision !== null)?.projectRevision ?? null; }
function optionalNullableInteger(value: number | null | undefined, label: string): number | null { return value === null || value === undefined ? null : optionalInteger(value, label); }
function optionalInteger(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new ContextPolicyError('context.measurement-invalid', `Invalid ${label}.`); return value; }
function integer(value: number, minimum: number, maximum: number, label: string): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ContextCompactionError('context.compaction-policy-invalid', `Invalid ${label}.`); return value; }
function ratio(value: number, label: string): number { if (!Number.isFinite(value) || value <= 0 || value >= 1) throw new ContextCompactionError('context.compaction-policy-invalid', `Invalid ${label}.`); return value; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }
function stable(value: M13StableId, label: string): M13StableId { try { return asStableId(value, label); } catch (cause) { throw new ContextCompactionError('context.id-invalid', `Invalid ${label}.`, { cause }); } }
function isStable(value: unknown): value is M13StableId { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value); }
function isDigest(value: unknown): value is M13Digest { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value); }
function isNonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function digest(value: JsonValue): M13Digest { return `sha256:${sha256(canonicalStringify(value))}` as M13Digest; }
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
function freeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new ContextCompactionError('context.compaction-cancelled', 'Context compaction was cancelled.'); }
function forwardAbort(parent: AbortSignal | undefined, controller: AbortController): () => void { const abort = (): void => controller.abort(parent?.reason); if (!parent) return () => {}; if (parent.aborted) abort(); else parent.addEventListener('abort', abort, { once: true }); return () => parent.removeEventListener('abort', abort); }
