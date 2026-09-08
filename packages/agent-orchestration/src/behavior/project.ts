import { asStableId, type BehaviorAnalysisInputV1, type BehaviorExplanationV1, type BehaviorManifestV1, type BehaviorTraceArtifactV1, type EditorLocationV1, type JsonObject } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, sha256, type BehaviorArtifactBinding, type BehaviorArtifactKind, type BehaviorArtifactReference } from '@haiyue/ai-studio-operation-log';
import type { BehaviorApprovedPlay, BehaviorProjectIdentity, ProjectBehaviorPorts } from './ports.js';

/** Unversioned service projection; domain data retains the existing G02 envelopes. */
export interface BehaviorProjectSnapshot {
  readonly project: BehaviorProjectIdentity | null;
  readonly state: 'empty' | 'pending' | 'analyzing' | 'ready' | 'failed';
  readonly manifest: BehaviorManifestV1 | null;
  readonly explanation: BehaviorExplanationV1 | null;
  readonly artifacts: readonly BehaviorArtifactReference[];
  readonly diagnostic: string | null;
  readonly trace: BehaviorTraceArtifactV1 | null;
  readonly traceStatus: 'current' | 'historical' | null;
}
interface OwnedBehaviorPlay {
  readonly planId: string; readonly playId: string; readonly generation: number; readonly manifest: BehaviorManifestV1; readonly runtimePlan: unknown;
  readonly correlation: Readonly<{ taskId: string; turnId: string }>;
  artifact: BehaviorTraceArtifactV1 | null; closed: boolean;
}

/** Owns project-bound derived work, never editor mutation, sessions or a second scheduler. */
export class ProjectBehaviorController {
  private identity: BehaviorProjectIdentity | null = null;
  private state: BehaviorProjectSnapshot['state'] = 'empty';
  private manifest: BehaviorManifestV1 | null = null;
  private explanation: BehaviorExplanationV1 | null = null;
  private artifacts: readonly BehaviorArtifactReference[] = [];
  private diagnostic: string | null = null;
  private generation = 0;
  private analysis: AbortController | null = null;
  private explanationTask: AbortController | null = null;
  private readonly explanations = new Map<string, BehaviorExplanationV1>();
  private sourceKey: string | null = null;
  private readonly tasks = new Set<AbortController>();
  private readonly listeners = new Set<() => void>();
  private closed = false;
  private disposal: Promise<void> | null = null;
  private playGeneration = 0;
  private playRequestGeneration = 0;
  private activePlay: string | null = null;
  private readonly plays = new Map<string, OwnedBehaviorPlay>();
  private trace: BehaviorTraceArtifactV1 | null = null;
  private traceStatus: BehaviorProjectSnapshot['traceStatus'] = null;
  private playPreparation: Readonly<{ id: string; promise: Promise<unknown> }> | null = null;
  private captureQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly ports: ProjectBehaviorPorts) { this.syncProject(); }
  snapshot(): BehaviorProjectSnapshot { return Object.freeze({ project: this.identity, state: this.state, manifest: this.manifest, explanation: this.explanation, artifacts: this.artifacts, diagnostic: this.diagnostic, trace: this.trace, traceStatus: this.traceStatus }); }
  subscribe(listener: () => void): Readonly<{ dispose(): void }> { this.assertOpen(); this.listeners.add(listener); return Object.freeze({ dispose: () => { this.listeners.delete(listener); } }); }

  /** Called by the existing workspace subscription. Selection-only changes keep analysis. */
  syncProject(): void {
    this.assertOpen();
    const current = this.ports.current();
    if (sameIdentity(current, this.identity)) return;
    this.cancel(); this.identity = current ? Object.freeze({ ...current }) : null;
    this.manifest = null; this.explanation = null; this.artifacts = []; this.explanations.clear(); this.diagnostic = null;
    this.state = current ? 'pending' : 'empty'; this.changed();
  }

  /** The same authoritative input boundary is injected into G04's behaviorSource. */
  async source(signal: AbortSignal): Promise<BehaviorAnalysisInputV1> {
    this.assertOpen(); this.syncProject();
    const project = this.requireProject(), generation = this.generation;
    try {
      const input = this.ports.validateSource(await abortable(() => this.ports.readSource(signal), signal));
      this.guard(generation, signal);
      if (input.projectId !== project.projectId || input.document.id !== project.documentId || input.document.revision !== project.revision) throw new Error('behavior.stale');
      return input;
    } catch (error) { throw safeError(error, signal); }
  }

  async refresh(signal?: AbortSignal): Promise<BehaviorProjectSnapshot> {
    this.assertOpen(); this.syncProject(); this.requireProject(); this.cancel();
    const { task, detach } = this.task(signal); this.analysis = task;
    const generation = this.generation; this.state = 'analyzing'; this.diagnostic = null;
    this.manifest = null; this.explanation = null; this.explanations.clear(); this.changed();
    try {
      const input = await this.source(task.signal), inputKey = this.sourceFingerprint(input);
      const manifest = await this.ports.reader.analyze(input, task.signal); this.guard(generation, task.signal);
      const after = await this.source(task.signal); this.guard(generation, task.signal);
      if (this.sourceFingerprint(after) !== inputKey || manifest.binding.digest !== this.ports.bindSource(after).digest) throw new Error('behavior.stale');
      const reference = await this.ports.history.put(artifactBinding(manifest), 'manifest', manifest, task.signal);
      this.guard(generation, task.signal);
      this.manifest = manifest; this.sourceKey = inputKey; this.artifacts = Object.freeze([reference]); this.state = 'ready'; this.changed();
      return this.snapshot();
    } catch (error) {
      if (!this.closed && generation === this.generation) { this.manifest = null; this.state = task.signal.aborted ? 'pending' : 'failed'; this.diagnostic = task.signal.aborted ? 'behavior.cancelled' : 'behavior.analysis-failed'; this.changed(); }
      throw safeError(error, task.signal);
    } finally { detach(); if (this.analysis === task) this.analysis = null; }
  }

  async explain(input: Readonly<{ manifestDigest: string; nodeIds: readonly string[]; language: 'en' | 'zh-CN' }>, signal?: AbortSignal): Promise<BehaviorExplanationV1> {
    this.assertOpen(); this.syncProject();
    const manifest = this.requireManifest(input.manifestDigest), generation = this.generation;
    this.explanationTask?.abort(); const { task, detach } = this.task(signal); this.explanationTask = task;
    try {
      const source = await this.source(task.signal); this.guard(generation, task.signal);
      if (this.ports.bindSource(source).digest !== manifest.binding.digest || this.sourceFingerprint(source) !== this.sourceKey) throw new Error('behavior.stale');
      const key = fingerprint(input), cached = this.explanations.get(key);
      const result = cached ?? this.ports.reader.explain({ schemaVersion: 1, ...input, sourceBindingDigest: manifest.binding.digest });
      this.guard(generation, task.signal);
      if (!cached) {
        const reference = await this.ports.history.put(artifactBinding(manifest), 'explanation', result, task.signal); this.guard(generation, task.signal);
        this.artifacts = Object.freeze([...this.artifacts, reference].slice(-100));
        this.explanations.set(key, result); if (this.explanations.size > 16) this.explanations.delete(this.explanations.keys().next().value!);
      }
      this.explanation = result; this.changed(); return result;
    } catch (error) { throw safeError(error, task.signal); }
    finally { detach(); if (this.explanationTask === task) this.explanationTask = null; }
  }

  async locateNode(manifestDigest: string, nodeId: string, signal?: AbortSignal): Promise<EditorLocationV1> {
    this.assertOpen(); this.syncProject(); const manifest = this.requireManifest(manifestDigest);
    return this.resolveLocation(this.ports.reader.locate({ schemaVersion: 1, manifestDigest, sourceBindingDigest: manifest.binding.digest, nodeId }), signal);
  }
  async resolveLocation(input: unknown, signal?: AbortSignal): Promise<EditorLocationV1> {
    this.assertOpen(); this.syncProject(); const manifest = this.requireManifest(), generation = this.generation;
    const { task, detach } = this.task(signal);
    try {
      const location = this.ports.validateLocation(input), source = await this.source(task.signal); this.guard(generation, task.signal);
      if (this.ports.bindSource(source).digest !== manifest.binding.digest || this.sourceFingerprint(source) !== this.sourceKey || this.ports.reader.resolveLocation(location).status !== 'current') throw new Error('behavior.location-historical');
      return location;
    } catch (error) { throw safeError(error, task.signal); }
    finally { detach(); }
  }
  async history(input: Readonly<{ kind?: BehaviorArtifactKind; limit?: number; cursor?: string }> = {}) {
    this.assertOpen(); this.syncProject(); const project = this.requireProject(), generation = this.generation;
    const result = await this.ports.history.list(project.projectId, input); this.guard(generation); return result;
  }
  async related(manifestDigest: string, nodeId: string, cursor?: string, signal?: AbortSignal) {
    const generation = this.generation;
    const location = await this.locateNode(manifestDigest, nodeId, signal); this.guard(generation, signal);
    if (location.target.kind !== 'behavior-node') throw new Error('behavior.location-historical');
    const source = location.target.source, project = this.requireProject();
    const page = await this.ports.history.related(project.projectId, project.documentId, { entityId: source.entityId, ...(source.kind === 'script' ? { scriptId: source.scriptId } : {}) }, cursor);
    this.guard(generation, signal); return page;
  }
  /** Called only after the existing preview authorization has produced its real
   * executable plan. This adds derived observation data, never execution authority. */
  preparePlay(plan: BehaviorApprovedPlay, correlation: Readonly<{ taskId: string; turnId: string }>, signal?: AbortSignal): Promise<unknown> {
    this.assertOpen(); this.syncProject();
    if (this.playPreparation?.id === plan.id) return this.playPreparation.promise;
    const promise = this.preparePlayNow(plan, correlation, signal);
    const pending = { id: plan.id, promise }; this.playPreparation = pending;
    void promise.finally(() => { if (this.playPreparation === pending) this.playPreparation = null; }).catch(() => undefined);
    return promise;
  }
  private async preparePlayNow(plan: BehaviorApprovedPlay, correlation: Readonly<{ taskId: string; turnId: string }>, signal?: AbortSignal): Promise<unknown> {
    const preparation = ++this.playRequestGeneration;
    const runtime = this.ports.runtime; if (!runtime) throw new Error('behavior.runtime-unavailable');
    const project = this.requireProject();
    if (plan.documentId !== project.documentId || plan.documentRevision !== project.revision) throw new Error('behavior.stale');
    asStableId(plan.id); asStableId(correlation.taskId); asStableId(correlation.turnId);
    if (!this.manifest) await this.refresh(signal);
    const manifest = this.requireManifest(), generation = this.generation, { task, detach } = this.task(signal);
    try {
      const source = await this.source(task.signal); this.guard(generation, task.signal);
      if (preparation !== this.playRequestGeneration || this.sourceFingerprint(source) !== this.sourceKey || this.ports.bindSource(source).digest !== manifest.binding.digest) throw new Error('behavior.stale');
      const existing = [...this.plays.values()].find(play => play.planId === plan.id);
      if (existing) { if (existing.closed) throw new Error('behavior.play-closed'); return existing.runtimePlan; }
      const playId = `behavior-play:${globalThis.crypto.randomUUID()}`, playGeneration = ++this.playGeneration;
      const runtimePlan = runtime.prepare(source, manifest, { playId, generation: playGeneration, scripts: plan.scripts });
      this.guard(generation, task.signal);
      const play: OwnedBehaviorPlay = { planId: plan.id, playId, generation: playGeneration, manifest, runtimePlan, correlation: Object.freeze({ ...correlation }), artifact: null, closed: false };
      this.plays.set(playId, play); this.activePlay = playId; this.trace = null; this.traceStatus = null;
      // Keep bounded prior owners so the old realm's final Stop capture can still
      // be archived during a restart; it can never replace the new Play overlay.
      while (this.plays.size > 4) this.plays.delete(this.plays.keys().next().value!);
      this.changed(); return runtimePlan;
    } catch (error) { throw safeError(error, task.signal); }
    finally { detach(); }
  }
  capturePlay(input: unknown, signal?: AbortSignal): Promise<BehaviorProjectSnapshot> {
    this.assertOpen(); this.syncProject(); const generation = this.generation;
    // Cumulative captures are serialized in this existing project workflow. No
    // timer or scheduler is introduced; a late shorter prefix is rejected.
    const result = this.captureQueue.catch(() => undefined).then(() => this.capturePlayNow(input, generation, signal));
    this.captureQueue = result; return result;
  }
  private async capturePlayNow(input: unknown, generation: number, signal?: AbortSignal): Promise<BehaviorProjectSnapshot> {
    const { task, detach } = this.task(signal);
    try {
      this.guard(generation, task.signal);
      const runtime = this.ports.runtime; if (!runtime) throw new Error('behavior.runtime-unavailable');
      const descriptor = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'playId') : undefined;
      const playId = descriptor && 'value' in descriptor && typeof descriptor.value === 'string' ? descriptor.value : '';
      const play = this.plays.get(playId); if (!play || play.closed) throw new Error('behavior.play-stale');
      const source = await this.source(task.signal); this.guard(generation, task.signal);
      if (this.sourceFingerprint(source) !== this.sourceKey || this.ports.bindSource(source).digest !== play.manifest.binding.digest) throw new Error('behavior.stale');
      const captured = runtime.capture(play.runtimePlan, play.manifest, input, { id: asStableId(`observation:${globalThis.crypto.randomUUID()}`), taskId: asStableId(play.correlation.taskId), turnId: asStableId(play.correlation.turnId), capturedAt: new Date().toISOString(), viewport: null, device: null, producerVersion: this.ports.producerVersion ?? '0.0.0' });
      runtime.assertProgress(play.artifact?.trace ?? null, captured.artifact.trace);
      if (play.artifact && (captured.artifact.observation.tick < play.artifact.observation.tick || captured.artifact.observation.frame < play.artifact.observation.frame)) throw new Error('behavior.runtime-capture-order');
      if (play.artifact?.trace.digest !== captured.artifact.trace.digest) {
        const reference = await this.ports.history.put(artifactBinding(play.manifest), 'trace', captured.artifact, task.signal); this.guard(generation, task.signal);
        this.artifacts = Object.freeze([...this.artifacts, reference].slice(-100));
      }
      play.artifact = captured.artifact; play.closed = captured.closed;
      if (this.activePlay === play.playId) { this.trace = captured.artifact; this.traceStatus = play.closed ? 'historical' : 'current'; this.changed(); }
      return this.snapshot();
    } catch (error) { throw safeError(error, task.signal); }
    finally { detach(); }
  }
  async readArtifact<K extends BehaviorArtifactKind>(kind: K, artifactId: string, signal?: AbortSignal) {
    this.assertOpen(); this.syncProject(); const project = this.requireProject(), generation = this.generation;
    const { task, detach } = this.task(signal);
    try {
    const result = await this.ports.history.read(project.projectId, artifactId, kind, task.signal); this.guard(generation, task.signal);
    const source = this.manifest ? await this.source(task.signal) : null; this.guard(generation, task.signal);
    const bindingCurrent = source !== null && this.sourceFingerprint(source) === this.sourceKey && this.manifest?.digest === result.reference.manifestDigest && this.manifest?.binding.digest === result.reference.sourceBindingDigest;
    let current = kind !== 'trace' && bindingCurrent;
    if (kind === 'trace' && bindingCurrent && this.ports.runtime && this.manifest) {
      const value = result.value as BehaviorTraceArtifactV1, play = this.activePlay ? this.plays.get(this.activePlay) : null;
      const associated = this.ports.runtime.associate(value.observation, value.trace, this.manifest, play && !play.closed ? play : { playId: 'play:none', generation: 1 });
      current = associated.status === 'current';
    }
    return Object.freeze({ ...result, status: current ? 'current' as const : 'historical' as const });
    } catch (error) { throw safeError(error, task.signal); }
    finally { detach(); }
  }
  cancel(): void {
    ++this.generation; for (const task of this.tasks) task.abort(); this.ports.reader.invalidate();
    this.manifest = null; this.explanation = null; this.sourceKey = null; this.explanations.clear();
    this.plays.clear(); this.activePlay = null; this.trace = null; this.traceStatus = null; this.playPreparation = null;
    this.state = this.identity ? 'pending' : 'empty'; this.changed();
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    const pending = this.playPreparation?.promise;
    this.closed = true; this.cancel(); this.listeners.clear(); this.manifest = null; this.explanation = null; this.explanations.clear();
    return this.disposal = Promise.all([this.ports.reader.dispose(), this.captureQueue.catch(() => undefined), pending?.catch(() => undefined)]).then(() => undefined);
  }
  private sourceFingerprint(input: BehaviorAnalysisInputV1): string { return fingerprint({ binding: this.ports.bindSource(input).digest, config: input.config }); }
  private requireProject(): BehaviorProjectIdentity { if (!this.identity) throw new Error('behavior.project-unavailable'); return this.identity; }
  private requireManifest(digest?: string): BehaviorManifestV1 { this.requireProject(); if (!this.manifest || (digest !== undefined && digest !== this.manifest.digest)) throw new Error('behavior.stale'); return this.manifest; }
  private guard(generation: number, signal?: AbortSignal): void { this.assertOpen(); if (signal?.aborted || generation !== this.generation || !sameIdentity(this.identity, this.ports.current())) throw new Error('behavior.stale'); }
  private assertOpen(): void { if (this.closed) throw new Error('behavior.disposed'); }
  private task(signal?: AbortSignal) { const task = new AbortController(), detach = forwardAbort(signal, task); this.tasks.add(task); return { task, detach: () => { detach(); this.tasks.delete(task); } }; }
  private changed(): void { if (!this.closed) for (const listener of this.listeners) listener(); }
}
function artifactBinding(manifest: BehaviorManifestV1): BehaviorArtifactBinding { return Object.freeze({ projectId: manifest.binding.projectId, documentId: manifest.binding.documentId, documentRevision: manifest.binding.documentRevision, sourceBindingDigest: manifest.binding.digest, manifestDigest: manifest.digest }); }
function fingerprint(value: unknown): string { return sha256(canonicalStringify(value as JsonObject)); }
function sameIdentity(a: BehaviorProjectIdentity | null, b: BehaviorProjectIdentity | null): boolean { return a?.projectId === b?.projectId && a?.documentId === b?.documentId && a?.revision === b?.revision; }
function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void { const abort = () => controller.abort(); if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true }); return () => signal?.removeEventListener('abort', abort); }
function safeError(error: unknown, signal: AbortSignal): Error { return new Error(signal.aborted ? 'behavior.cancelled' : error instanceof Error && /^behavior\.[a-z-]{1,80}$/u.test(error.message) ? error.message : 'behavior.request-failed'); }
async function abortable(read: () => unknown | Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('behavior.cancelled')); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(() => { if (signal.aborted) throw new Error('behavior.cancelled'); return read(); }), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
