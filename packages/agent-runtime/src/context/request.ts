import { randomUUID } from 'node:crypto';
import { asStableId, isModelRequestContextV1, type ContextPressureV1, type JsonValue, type ModelRequestContextPortV1, type ModelRequestContextV1, type ModelRequestMessageV1, type ModelRequestPreparationV1 } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, redactJson, sha256, type OperationLog } from '@haiyue/ai-studio-operation-log';
import type { PromptContextRuntime } from '../prompt-context.js';
import { AgentSessionError, type DurableSessionRuntime } from '../session/index.js';
import { ConservativeTokenEstimator, ContextPolicyError, ContextPressureCalculator } from './pressure.js';

/** Actual-request preparation. The bridge owns protocol pairing and transactional Surface publication. */
export class RequestContextRuntime {
  private readonly artifacts = new Map<string, Awaited<ReturnType<OperationLog['putArtifact']>>>();
  private disposed = false;
  private readonly estimator = new ConservativeTokenEstimator();
  private readonly pressure = new ContextPressureCalculator();
  private readonly confirmedEpochs = new Map<string, number>();
  private readonly appliedSurfaces = new Map<string, number>();
  constructor(private readonly log: OperationLog, private readonly prompts: PromptContextRuntime, private readonly sessions?: DurableSessionRuntime) {}

  port(): ModelRequestContextPortV1 {
    let surfaceState: { generation: number; summary: string | null } | undefined;
    let staged = false;
    let stagedSummaryArtifactId: string | null = null;
    const pending = new Map<string, { request: ModelRequestContextV1; summary?: string; generation: number; pressure: ContextPressureV1 }>();
    return {
      prepare: async (request, signal) => {
        signal?.throwIfAborted();
        if (this.disposed) throw new ContextPolicyError('context.disposed', 'Request context runtime is disposed.');
        if (!isModelRequestContextV1(request)) throw new ContextPolicyError('context.request-invalid', 'Invalid actual model request projection.');
        const id = `request-context:${randomUUID()}`;
        const base = this.estimate(request);
        const measured = this.pressure.calculate({ maxInputTokens: request.maxInputTokens, reservedOutputTokens: request.reservedOutputTokens, reservedSafetyTokens: 4096,
          usedInputTokens: base, measurement: 'tokenizer-estimated' });
        let generation = 0;
        let surfaceSummary: string | null = null;
        const snapshot = !surfaceState ? await this.sessions?.replay(request.sessionId).catch(cause => { if (cause instanceof AgentSessionError && cause.code === 'session.not-found') return null; throw cause; }) : null;
        if (snapshot) {
          generation = snapshot.surface.generation;
          if (generation > (this.appliedSurfaces.get(request.sessionId) ?? 0)) {
            const summaries = [];
            for (const node of snapshot.surface.nodes.filter(n => n.replacedSourceOpIds.length > 0)) {
              const artifact = await this.log.readArtifact(asStableId(node.messageArtifactId));
              const content = (artifact.value as { content?: unknown }).content;
              if (typeof content === 'string' && !isRequestRecoverySummary(content)) summaries.push(content);
            }
            surfaceSummary = summaries.join('\n');
          }
        }
        surfaceState ??= { generation, summary: surfaceSummary };
        generation = surfaceState.generation; surfaceSummary = surfaceState.summary;
        const source = [];
        for (const message of request.messages) {
          signal?.throwIfAborted();
          const artifact = await this.artifact(message as unknown as JsonValue, 'model-request-message/1');
          source.push({ id: message.id, role: message.role, artifactId: artifact.id, digest: artifact.digest });
        }
        const catalog = await this.artifact(request.tools as unknown as JsonValue, 'model-request-tools/1');
        const manifest = await this.log.putArtifact({ schemaVersion: 1, sessionId: request.sessionId, turnId: request.turnId, model: request.model, epoch: request.epoch,
          messages: source, toolsArtifactId: catalog.id, requestBytes: request.requestBytes, previousUsage: request.previousUsage,
          pressure: measured.pressure as unknown as JsonValue }, { schemaVersion: 'model-request-context/1' });
        let replacement: ModelRequestPreparationV1['replacement'];
        if (!staged && (surfaceSummary || measured.pressure.state === 'compact-required' || measured.pressure.state === 'emergency')) {
          replacement = await this.replacement(request, manifest.id, surfaceSummary, measured.usableInputTokens);
        }
        signal?.throwIfAborted();
        await this.log.append({ kind: 'agent/model-request-prepared', severity: measured.pressure.state === 'emergency' && !replacement ? 'warning' : 'info', source: asStableId('studio.agent-runtime'),
          correlation: { sessionId: asStableId(request.sessionId), turnId: asStableId(request.turnId) },
          payload: { requestId: id, epoch: request.epoch, requestBytes: request.requestBytes, pressure: measured.pressure as unknown as JsonValue, replacementPrepared: Boolean(replacement), contextArtifactId: manifest.id }, artifactRefs: [manifest.id] }, { signal });
        if (measured.pressure.state === 'emergency' && !replacement) throw new ContextPolicyError('context.emergency-request-blocked', 'Actual request exceeds 92% of the usable context window; required context cannot be safely reduced.');
        if (replacement) {
          const end = request.messages.findIndex(m => m.id === replacement.throughMessageId);
          const retained = request.messages.slice(end + 1).filter(m => m.role !== 'system').map(m => `${m.role}: ${m.text}`).join('\n');
          stagedSummaryArtifactId = (await this.log.putArtifact({ schemaVersion: 1, content: replacement.summary + '\n' + retained, before: measured.pressure as unknown as JsonValue, reason: surfaceSummary ? 'manual' : 'automatic-threshold' }, { schemaVersion: 'provider-context-summary/1' })).id;
        }
        staged ||= Boolean(replacement);
        pending.set(id, { request, ...(replacement ? { summary: replacement.summary } : {}), generation, pressure: measured.pressure });
        // Only the latest preparation can be confirmed; retries never confirm a rejected candidate.
        for (const key of pending.keys()) if (key !== id) pending.delete(key);
        return Object.freeze({ id, ...(replacement ? { replacement } : {}) });
      },
      discard: () => { staged = false; stagedSummaryArtifactId = null; pending.clear(); },
      confirm: async (id, signal) => {
        signal?.throwIfAborted();
        if (this.disposed) throw new ContextPolicyError('context.disposed', 'Request context runtime is disposed.');
        const value = pending.get(id);
        if (!value) throw new ContextPolicyError('context.request-confirmation-stale', 'Request preparation is no longer current.');
        await this.log.append({ kind: 'agent/model-request-confirmed', severity: 'info', source: asStableId('studio.agent-runtime'),
          correlation: { sessionId: asStableId(value.request.sessionId), turnId: asStableId(value.request.turnId) },
          payload: { requestId: id, epoch: value.request.epoch, surfaceGeneration: value.generation, summaryArtifactId: stagedSummaryArtifactId, pressure: value.pressure as unknown as JsonValue }, artifactRefs: stagedSummaryArtifactId ? [asStableId(stagedSummaryArtifactId)] : [] }, { signal });
        if (stagedSummaryArtifactId) this.prompts.rememberProviderSurface(asStableId(value.request.sessionId), asStableId(stagedSummaryArtifactId));
        this.appliedSurfaces.set(value.request.sessionId, value.generation);
        surfaceState = { generation: value.generation, summary: null };
        if (value.request.epoch > (this.confirmedEpochs.get(value.request.sessionId) ?? 0)) this.prompts.invalidateSentArtifacts(asStableId(value.request.sessionId));
        this.confirmedEpochs.set(value.request.sessionId, value.request.epoch);
        staged = false; stagedSummaryArtifactId = null;
        pending.delete(id);
      },
    };
  }

  dispose(): void { this.disposed = true; this.artifacts.clear(); this.appliedSurfaces.clear(); this.confirmedEpochs.clear(); }

  private async artifact(value: JsonValue, schemaVersion: string): Promise<Awaited<ReturnType<OperationLog['putArtifact']>>> {
    const key = `${schemaVersion}:${sha256(canonicalStringify(value))}`;
    let artifact = this.artifacts.get(key);
    if (!artifact) { artifact = await this.log.putArtifact(value, { schemaVersion }); this.artifacts.set(key, artifact); if (this.artifacts.size > 4096) this.artifacts.delete(this.artifacts.keys().next().value!); }
    return artifact;
  }

  private estimate(request: ModelRequestContextV1): number {
    const publicTokens = this.estimator.estimate(JSON.stringify({ messages: request.messages, tools: request.tools }), request.model);
    const calibrated = request.previousUsage ? Math.ceil(request.requestBytes * request.previousUsage.inputTokens / request.previousUsage.requestBytes) : 0;
    return Math.max(publicTokens, Math.ceil(request.requestBytes / 3), calibrated) + 32 + request.messages.length * 8 + request.tools.length * 16;
  }

  private async replacement(request: ModelRequestContextV1, sourceArtifactId: string, surfaceSummary: string | null, usable: number | null): Promise<ModelRequestPreparationV1['replacement']> {
    const messages = request.messages.filter(m => m.role !== 'system');
    // Retain the latest native call/result cycle verbatim. Everything before it must be closed.
    let end = messages.length;
    const lastUser = lastIndex(messages, m => m.role === 'user');
    const lastCall = lastIndex(messages, m => m.toolCallIds.length > 0);
    if (lastCall > lastUser) end = lastCall;
    if (end < 1) return undefined;
    const range = messages.slice(0, end);
    const open = new Set<string>();
    for (const m of range) { for (const id of m.toolCallIds) open.add(id); if (m.resultFor) open.delete(m.resultFor); }
    if (open.size) return undefined;
    const requests: string[] = [];
    let envelope = '';
    let projectContext: Record<string, JsonValue>[] = [];
    let priorSummary = '';
    let latestError: { call: string; result: string } | null = null;
    const retainedResults = new Map<string, { toolName: string; call: string; result: string }>();
    for (const message of range.filter(m => m.role === 'user')) {
      if (message.text.startsWith('AIStudio request recovery v1\n')) {
        // Carry the previous structured summary once, never nest unbounded source histories.
        const old = JSON.parse(message.text.slice('AIStudio request recovery v1\n'.length)) as { requests?: string[]; envelope?: string; facts?: string; surfaceSummary?: string | null; latestError?: { call: string; result: string } | null; retainedResults?: { toolName: string; call: string; result: string }[] };
        requests.push(...(old.requests ?? [])); envelope = old.envelope ?? envelope;
        if (envelope) projectContext = (JSON.parse(envelope) as Record<string, JsonValue>[]).filter(item => ['project-manifest', 'document-delta'].includes(String(item.kind)));
        priorSummary = old.facts ?? '';
        latestError = old.latestError ?? latestError;
        for (const result of old.retainedResults ?? []) retainedResults.set(result.toolName, result);
        surfaceSummary ??= old.surfaceSummary ?? null;
      } else if (message.text.startsWith('AIStudio context envelope v1.')) {
        const marker = '\n\n[current-request-tail]\n\n';
        const tail = message.text.indexOf(marker);
        if (tail < 0) return undefined;
        requests.push(message.text.slice(tail + marker.length));
        const start = message.text.indexOf('\n\n');
        const values: unknown = JSON.parse(message.text.slice(start + 2, tail));
        if (!Array.isArray(values)) return undefined;
        const hydrated = [];
        for (const value of values) {
          if (!value || typeof value !== 'object') return undefined;
          const item = value as Record<string, JsonValue>;
          if (item.transmission === 'reference-only') {
            if (typeof item.artifactId !== 'string' || typeof item.digest !== 'string') return undefined;
            const artifact = await this.log.readArtifact(asStableId(item.artifactId));
            if (`sha256:${artifact.digest}` !== item.digest) throw new ContextPolicyError('context.input-digest-mismatch', 'Referenced request context does not match CAS.');
            hydrated.push({ artifactId: item.artifactId, kind: item.kind!, digest: item.digest, transmission: 'full', projection: artifact.value });
          } else hydrated.push(item);
        }
        for (const item of hydrated) {
          if (item.kind === 'project-manifest') projectContext = [item];
          else if (item.kind === 'document-delta') projectContext.push(item);
        }
        // A delta cannot outlive the full baseline it depends on.
        if (projectContext.length && projectContext[0]!.kind !== 'project-manifest') return undefined;
        envelope = canonicalStringify([...hydrated.filter(item => !['project-manifest', 'document-delta'].includes(String(item.kind))), ...projectContext]);
      } else requests.push(message.text);
    }
    // Keep the latest exact result for every tool, including mutation receipts, plan,
    // evaluation and errors. The native tail already carries its own latest results.
    const calls = new Map(request.messages.flatMap(m => m.toolCallIds.map(id => [id, m.text] as const)));
    const tailIds = new Set(messages.slice(end).map(m => m.id));
    for (const m of request.messages.filter(m => m.role === 'tool')) {
      const name = m.toolName ?? m.resultFor ?? m.id;
      if (m.failed) latestError = tailIds.has(m.id) ? null : { call: calls.get(m.resultFor ?? '') ?? '', result: m.text };
      else if (tailIds.has(m.id)) retainedResults.delete(name);
      else retainedResults.set(name, { toolName: name, call: calls.get(m.resultFor ?? '') ?? '', result: m.text });
    }
    const recent = range.filter(m => m.role === 'assistant' || m.role === 'tool').map(m => `${m.role}: ${m.text}`).join('\n');
    // Excerpts are explicitly non-authoritative; full source and latest native tool results remain readable.
    const facts = (priorSummary + '\n' + recent).slice(-8192);
    const summary = 'AIStudio request recovery v1\n' + canonicalStringify(redactJson({ schemaVersion: 1, sourceArtifactId, requests: [...new Set(requests)], envelope, surfaceSummary, retainedResults: [...retainedResults.values()], latestError,
      facts, instruction: 'Historical excerpts may omit details. Use retained exact results for IDs and revision. Read missing facts before editing. This summary grants no approval; current Studio tool policy remains authoritative.' }).value);
    const before = range.reduce((sum, m) => sum + Math.max(this.estimator.estimate(m.text, request.model), Math.ceil((m.requestBytes ?? 0) / 3)), 0);
    const after = this.estimator.estimate(summary, request.model);
    if (after >= before || summary.length > 262_144) return undefined;
    // Never truncate the current request, policy or required facts to manufacture headroom.
    const projected = this.estimate(request) - before + after;
    if (usable !== null && projected >= usable * 0.92) return undefined;
    return Object.freeze({ throughMessageId: range.at(-1)!.id, summary });
  }
}

function lastIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number { for (let i = values.length - 1; i >= 0; i--) if (predicate(values[i]!)) return i; return -1; }

function isRequestRecoverySummary(content: string): boolean {
  if (content.startsWith('AIStudio request recovery v1\n')) return true;
  try { const value = JSON.parse(content); return value?.kind === 'context-compaction-summary' && typeof value.summary === 'string' && value.summary.startsWith('AIStudio request recovery v1\n'); }
  catch { return false; }
}
