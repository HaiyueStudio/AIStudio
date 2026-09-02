import { createHash } from 'node:crypto';
import type { BackendSessionBindingV1, M13StableId } from '@haiyue/ai-studio-contracts';
import type { CompactionSummarizer } from '../compaction/index.js';
import { DurableSessionRuntime, type SessionReplaySnapshotV1 } from '../session/index.js';
import { BackendSessionError } from './error.js';
import type {
  BackendSessionAdapter,
  EnsureBackendSessionInputV1,
  EnsureBackendSessionResultV1,
} from './types.js';

export class BackendSessionRuntime {
  private readonly adapters = new Map<M13StableId, BackendSessionAdapter>();
  private readonly tails = new Map<M13StableId, Promise<void>>();
  private state: 'active' | 'disposing' | 'disposed' = 'active';

  constructor(private readonly sessions: DurableSessionRuntime, adapters: readonly BackendSessionAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: BackendSessionAdapter): Readonly<{ dispose(): void }> {
    this.assertActive();
    if (this.adapters.has(adapter.backendId)) throw new BackendSessionError('backend.session-adapter-duplicate', `Backend Session adapter ${adapter.backendId} is already registered.`);
    this.adapters.set(adapter.backendId, adapter);
    let active = true;
    return Object.freeze({ dispose: () => { if (!active) return; active = false; if (this.adapters.get(adapter.backendId) === adapter) this.adapters.delete(adapter.backendId); } });
  }

  async ensure(sessionId: M13StableId, input: EnsureBackendSessionInputV1): Promise<EnsureBackendSessionResultV1> {
    this.assertActive();
    return this.enqueue(sessionId, () => this.ensureNow(sessionId, input));
  }

  private async ensureNow(sessionId: M13StableId, input: EnsureBackendSessionInputV1): Promise<EnsureBackendSessionResultV1> {
    const adapter = this.adapter(input.backendId);
    const snapshot = await this.sessions.replay(sessionId);
    const previous = bindingForBackend(snapshot, input.backendId);
    const capabilities = await adapter.capabilities(input.model, input.signal);
    if (previous && previous.status !== 'detached' && previous.remoteSessionId && previous.model === input.model) {
      const inspection = await adapter.inspect(previous.remoteSessionId, input.signal);
      if (inspection.state === 'available') {
        const modelMatches = inspection.model === null || inspection.model === previous.model;
        const boundaryMatches = inspection.lastConfirmedOpId !== null && inspection.lastConfirmedOpId === previous.lastConfirmedOpId;
        if (modelMatches && boundaryMatches) {
          const nextCapabilities = bindingCapabilities(capabilities);
          const binding = sameBindingCapabilities(previous.capabilities, nextCapabilities)
            ? previous
            : await this.bind(sessionId, { ...previous, generation: previous.generation + 1, status: 'active', capabilities: nextCapabilities });
          return Object.freeze({ binding, action: 'reused', recovery: 'not-required', diagnostic: null });
        }
        await this.detachBinding(snapshot, previous, adapter, input.signal);
        return this.openReplacement(sessionId, input, adapter, capabilities, previous, 'backend.remote-boundary-mismatch', 'The provider Session boundary or model no longer matches Studio.', true);
      }
      if (inspection.state === 'unavailable') {
        if (previous.status === 'stale') return Object.freeze({ binding: previous, action: 'stale', recovery: 'provider-unavailable', diagnostic: inspection.diagnostic });
        const stale = await this.bind(sessionId, {
          ...previous,
          generation: previous.generation + 1,
          status: 'stale',
          capabilities: bindingCapabilities(capabilities),
        });
        return Object.freeze({ binding: stale, action: 'stale', recovery: 'provider-unavailable', diagnostic: inspection.diagnostic });
      }
      await this.detachBinding(snapshot, previous, adapter, input.signal);
      return this.openReplacement(sessionId, input, adapter, capabilities, previous, inspection.diagnostic.code, inspection.diagnostic.message, true);
    }
    if (previous && previous.status !== 'detached') await this.detachBinding(snapshot, previous, adapter, input.signal);
    return this.openReplacement(sessionId, input, adapter, capabilities, previous, null, null, Boolean(previous));
  }

  async confirmBoundary(sessionId: M13StableId, bindingId: M13StableId, opId: M13StableId, signal?: AbortSignal): Promise<BackendSessionBindingV1> {
    this.assertActive();
    return this.enqueue(sessionId, () => this.confirmBoundaryNow(sessionId, bindingId, opId, signal));
  }

  private async confirmBoundaryNow(sessionId: M13StableId, bindingId: M13StableId, opId: M13StableId, signal?: AbortSignal): Promise<BackendSessionBindingV1> {
    const snapshot = await this.sessions.replay(sessionId);
    const binding = snapshot.session.backendBindings.find((entry) => entry.bindingId === bindingId);
    if (!binding || binding.status === 'detached' || !binding.remoteSessionId) throw new BackendSessionError('backend.session-binding-unavailable', `Backend binding ${bindingId} is not active.`);
    if (!snapshot.ops.some((op) => op.id === opId)) throw new BackendSessionError('backend.session-boundary-invalid', `Session operation ${opId} is not part of ${sessionId}.`);
    await this.adapter(binding.backendId).confirmBoundary(binding.remoteSessionId, opId, signal);
    return this.bind(sessionId, { ...binding, generation: binding.generation + 1, status: 'active', lastConfirmedOpId: opId });
  }

  async detach(sessionId: M13StableId, bindingId: M13StableId, signal?: AbortSignal): Promise<BackendSessionBindingV1> {
    this.assertActive();
    return this.enqueue(sessionId, () => this.detachNow(sessionId, bindingId, signal));
  }

  private async detachNow(sessionId: M13StableId, bindingId: M13StableId, signal?: AbortSignal): Promise<BackendSessionBindingV1> {
    const snapshot = await this.sessions.replay(sessionId);
    const binding = snapshot.session.backendBindings.find((entry) => entry.bindingId === bindingId);
    if (!binding) throw new BackendSessionError('backend.session-binding-unavailable', `Backend binding ${bindingId} does not exist.`);
    if (binding.status === 'detached') return binding;
    await this.detachBinding(snapshot, binding, this.adapter(binding.backendId), signal);
    return (await this.sessions.replay(sessionId)).session.backendBindings.find((entry) => entry.bindingId === bindingId)!;
  }

  compactionSummarizer(sessionId: M13StableId, bindingId: M13StableId, fallback: CompactionSummarizer): CompactionSummarizer {
    return async (request, signal) => {
      this.assertActive();
      if (request.sessionId !== sessionId) throw new BackendSessionError('backend.compaction-session-mismatch', 'Compaction request Session does not match its Backend binding.');
      const snapshot = await this.sessions.replay(sessionId);
      const binding = snapshot.session.backendBindings.find((entry) => entry.bindingId === bindingId);
      if (!binding || binding.status !== 'active' || !binding.remoteSessionId) return fallback(request, signal);
      const adapter = this.adapter(binding.backendId);
      if (!binding.capabilities.nativeCompaction) return fallback(request, signal);
      const result = await adapter.compact(binding.remoteSessionId, request, signal);
      if (result.status === 'completed') return Object.freeze({ summary: result.summary });
      return fallback(request, signal);
    };
  }

  async dispose(): Promise<void> {
    if (this.state !== 'active') return;
    this.state = 'disposing';
    try { await Promise.all(this.tails.values()); }
    finally { this.adapters.clear(); this.tails.clear(); this.state = 'disposed'; }
  }

  private async openReplacement(
    sessionId: M13StableId,
    input: EnsureBackendSessionInputV1,
    adapter: BackendSessionAdapter,
    capabilities: Awaited<ReturnType<BackendSessionAdapter['capabilities']>>,
    previous: BackendSessionBindingV1 | undefined,
    diagnosticCode: string | null,
    diagnosticMessage: string | null,
    rebuilding: boolean,
  ): Promise<EnsureBackendSessionResultV1> {
    const snapshot = await this.sessions.replay(sessionId);
    const lastConfirmedOpId = snapshot.ops.at(-1)!.id;
    const opened = await adapter.open({
      studioSessionId: sessionId,
      model: input.model,
      tools: input.tools,
      surfaceGeneration: snapshot.surface.generation,
      surfaceDigest: snapshot.surface.digest as `sha256:${string}`,
      lastConfirmedOpId,
    }, input.signal);
    if (!sameCapabilities(capabilities, opened.capabilities)) throw new BackendSessionError('backend.capability-drift', `Backend ${input.backendId} capabilities changed while opening a Session.`);
    await adapter.confirmBoundary(opened.remoteSessionId, lastConfirmedOpId, input.signal);
    const binding = await this.bind(sessionId, {
      bindingId: previous?.bindingId ?? bindingId(sessionId, input.backendId),
      backendId: input.backendId,
      provider: adapter.provider,
      model: input.model,
      remoteSessionId: opened.remoteSessionId,
      generation: (previous?.generation ?? 0) + 1,
      status: 'active',
      capabilities: bindingCapabilities(capabilities),
      lastConfirmedOpId,
    });
    return Object.freeze({
      binding,
      action: previous ? 'rebound' : 'created',
      recovery: rebuilding ? 'checkpoint-replay-required' : 'not-required',
      diagnostic: diagnosticCode && diagnosticMessage ? Object.freeze({ code: diagnosticCode, message: diagnosticMessage }) : null,
    });
  }

  private async detachBinding(snapshot: SessionReplaySnapshotV1, binding: BackendSessionBindingV1, adapter: BackendSessionAdapter, signal?: AbortSignal): Promise<void> {
    if (binding.remoteSessionId) await adapter.detach(binding.remoteSessionId, signal);
    await this.sessions.append(snapshot.session.id, { kind: 'backend.detached', payload: { bindingId: binding.bindingId, remoteSessionId: binding.remoteSessionId, generation: binding.generation } });
  }

  private async bind(sessionId: M13StableId, input: BackendSessionBindingV1): Promise<BackendSessionBindingV1> {
    const snapshot = await this.sessions.bindBackend(sessionId, Object.freeze(input));
    const binding = snapshot.session.backendBindings.find((entry) => entry.bindingId === input.bindingId);
    if (!binding) throw new BackendSessionError('backend.session-binding-missing', 'Persisted Backend binding was not projected.');
    return binding;
  }

  private adapter(backendId: M13StableId): BackendSessionAdapter {
    const adapter = this.adapters.get(backendId);
    if (!adapter) throw new BackendSessionError('backend.session-adapter-missing', `Backend Session adapter ${backendId} is not registered.`);
    return adapter;
  }

  private enqueue<T>(sessionId: M13StableId, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const result = previous.then(action);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(sessionId, tail);
    void tail.finally(() => { if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId); });
    return result;
  }

  private assertActive(): void { if (this.state !== 'active') throw new BackendSessionError('backend.session-runtime-disposed', 'Backend Session runtime is disposed.'); }
}

function bindingForBackend(snapshot: SessionReplaySnapshotV1, backendId: M13StableId): BackendSessionBindingV1 | undefined {
  return snapshot.session.backendBindings.find((entry) => entry.backendId === backendId);
}

function bindingId(sessionId: M13StableId, backendId: M13StableId): M13StableId {
  const digest = createHash('sha256').update(`${sessionId}\0${backendId}`).digest('hex').slice(0, 32);
  return `binding:${digest}`;
}

function bindingCapabilities(value: Awaited<ReturnType<BackendSessionAdapter['capabilities']>>): BackendSessionBindingV1['capabilities'] {
  return Object.freeze({
    maxInputTokens: value.maxInputTokens,
    nativeCompaction: value.nativeCompaction && value.nativeCompactionMirror === 'atomic-summary',
    parallelToolCalls: value.parallelToolCalls,
    codeMode: value.codeMode,
    providerUsage: value.providerUsage,
    providerCache: value.providerCache,
  });
}

function sameCapabilities(left: Awaited<ReturnType<BackendSessionAdapter['capabilities']>>, right: Awaited<ReturnType<BackendSessionAdapter['capabilities']>>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function sameBindingCapabilities(left: BackendSessionBindingV1['capabilities'], right: BackendSessionBindingV1['capabilities']): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
