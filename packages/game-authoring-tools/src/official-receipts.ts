import { asStableId, isOfficialToolReceiptV1, type JsonObject } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, redactObject, scanRetainedEvents, sha256, type ConversationOperationLog } from '@haiyue/ai-studio-operation-log';
import { GameToolProtocolError, type GameToolCall, type GameToolDefinition } from './types.js';

/** Durable outcome guard, scoped to the existing task; never authorizes an execution. */
export class OfficialReceiptJournal {
  private readonly unresolved = new Map<string, JsonObject>();
  private loaded: Promise<void> = Promise.resolve();
  private nextSequence = 0;
  constructor(private readonly log?: ConversationOperationLog) {}
  key(definition: GameToolDefinition, call: GameToolCall, args: JsonObject): string {
    return sha256(canonicalStringify({ owner: call.taskId ?? call.sessionId, toolId: definition.id, version: definition.version, args }));
  }
  async begin(key: string, definition: GameToolDefinition, call: GameToolCall): Promise<void> {
    // Project history can import facts after this runtime has already executed tools.
    const refreshed = this.loaded.then(() => this.restore());
    this.loaded = refreshed.catch(() => undefined);
    await refreshed;
    if (definition.effect !== 'observe' && this.unresolved.has(key)) throw this.failure(this.unresolved.get(key)!);
    const pending: JsonObject = { schemaVersion: 1, execution: 'unknown', delivery: 'unavailable', reason: 'provider-error', callId: call.id, retryable: false };
    // Reserve before the first I/O so concurrent callers cannot dispatch the same uncertain effect.
    this.unresolved.set(key, pending);
    await this.log?.append({ kind: 'official/execution-dispatched', severity: 'info', source: asStableId('studio.game-tools'),
      correlation: { sessionId: call.sessionId, turnId: call.turnId, toolCallId: call.id }, payload: { scopeKey: key, toolId: definition.id, receipt: pending } });
  }
  async record(key: string, definition: GameToolDefinition, call: GameToolCall, value: unknown): Promise<JsonObject> {
    const clean = redactObject(value as JsonObject, { fields: definition.redactedFields }).value;
    if (!isOfficialToolReceiptV1(clean)) throw new GameToolProtocolError('official.receipt-invalid', 'official.receipt-invalid');
    const receipt: JsonObject = { ...clean, callId: call.id, retryable: clean.execution === 'not-started' };
    const artifact = await this.log?.putArtifact(receipt, { schemaVersion: 'official-execution-receipt/1' });
    const details: JsonObject = { ...receipt, ...(artifact ? { artifactRef: { id: artifact.id, digest: artifact.digest } } : {}) };
    await this.log?.append({ kind: 'official/execution-receipt', severity: clean.delivery === 'available' ? 'info' : 'warning', source: asStableId('studio.game-tools'),
      correlation: { sessionId: call.sessionId, turnId: call.turnId, toolCallId: call.id }, artifactRefs: artifact ? [artifact.id] : [],
      payload: { scopeKey: key, toolId: definition.id, receipt: details } });
    if (clean.delivery === 'available' || clean.execution === 'not-started') this.unresolved.delete(key);
    else this.unresolved.set(key, details);
    return details;
  }
  failure(receipt: JsonObject, code = 'official.execution-outcome-unresolved'): GameToolProtocolError {
    return new GameToolProtocolError(code, 'The operation may already have taken effect. Inspect the recorded receipt and current state before any further action.', false,
      { executionReceipt: receipt, instruction: 'Do not repeat this operation automatically; inspect its receipt and current state.' });
  }
  private async restore(): Promise<void> {
    if (!this.log) return;
    const end = this.log.status().nextSequence;
    for await (const event of scanRetainedEvents(this.log, ['official/execution-dispatched', 'official/execution-receipt'], this.nextSequence)) {
      const { scopeKey, receipt } = event.payload;
      if (typeof scopeKey !== 'string' || !/^[a-f0-9]{64}$/.test(scopeKey)) continue;
      const fact = receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt as JsonObject : {};
      const base = { schemaVersion: fact.schemaVersion, execution: fact.execution, delivery: fact.delivery, reason: fact.reason, ...(fact.preview === undefined ? {} : { preview: fact.preview }) };
      if (!isOfficialToolReceiptV1(base) || fact.callId !== event.correlation.toolCallId || Buffer.byteLength(JSON.stringify(fact)) > 40_000) {
        this.unresolved.set(scopeKey, { schemaVersion: 1, execution: 'unknown', delivery: 'unavailable', reason: 'provider-error', retryable: false });
      } else if (event.kind === 'official/execution-receipt' && (fact.delivery === 'available' || fact.execution === 'not-started')) this.unresolved.delete(scopeKey);
      else this.unresolved.set(scopeKey, fact);
    }
    this.nextSequence = end;
  }
}
export function resultPreview(value: unknown, definition: Pick<GameToolDefinition, 'redactedFields'>): string | undefined {
  // Only plain JSON values reach here; bounding prevents a second large provider result copy.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: string[] = []; let remaining = 8192;
  for (const [key, item] of Object.entries(value)) {
    if (remaining <= 0) break;
    if (typeof item !== 'string' || key.length > 256) continue;
    // Redact at the original field path before flattening or truncating it.
    const safe = redactObject({ [key]: item }, { fields: definition.redactedFields }).value[key];
    const part = `${key}: ${String(safe).slice(0, remaining)}`.slice(0, remaining); result.push(part); remaining -= part.length + 1;
  }
  return result.join('\n');
}
