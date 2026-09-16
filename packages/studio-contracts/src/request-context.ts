import type { JsonObject } from './index.js';

/** Provider-neutral, public message projection. Hidden reasoning and replay state stay in the bridge. */
export interface ModelRequestMessageV1 {
  readonly id: string;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly text: string;
  readonly toolCallIds: readonly string[];
  readonly resultFor: string | null;
  readonly toolName?: string | null;
  readonly requestBytes?: number;
  readonly failed?: boolean;
}
export interface ModelRequestContextV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly turnId: string;
  readonly model: string;
  readonly epoch: number;
  readonly maxInputTokens: number | null;
  readonly reservedOutputTokens: number;
  readonly messages: readonly ModelRequestMessageV1[];
  readonly tools: readonly JsonObject[];
  /** Conservative serialized request size, including private replay data; never the data itself. */
  readonly requestBytes: number;
  /** Last successful request only, never cumulative billed input. */
  readonly previousUsage: Readonly<{ inputTokens: number; requestBytes: number }> | null;
}
export interface ModelRequestPreparationV1 {
  readonly id: string;
  readonly replacement?: Readonly<{ throughMessageId: string; summary: string }>;
}
/** Same-process authority port; never accepted from model arguments or persisted as data. */
export interface ModelRequestContextPortV1 {
  prepare(input: ModelRequestContextV1, signal?: AbortSignal): Promise<ModelRequestPreparationV1>;
  confirm(id: string, signal?: AbortSignal): Promise<void>;
  discard?(): void;
}

export function isModelRequestContextV1(value: unknown): value is ModelRequestContextV1 {
  if (!record(value) || !keys(value, ['schemaVersion', 'sessionId', 'turnId', 'model', 'epoch', 'maxInputTokens', 'reservedOutputTokens', 'messages', 'tools', 'requestBytes', 'previousUsage']) || value.schemaVersion !== 1
    || !text(value.sessionId) || !text(value.turnId) || !text(value.model) || !integer(value.epoch) || !integer(value.reservedOutputTokens) || !integer(value.requestBytes)
    || (value.maxInputTokens !== null && (!integer(value.maxInputTokens) || value.maxInputTokens < 1024 || value.maxInputTokens > 100_000_000))
    || !Array.isArray(value.messages) || value.messages.length > 100_000 || !Array.isArray(value.tools) || value.tools.length > 1024) return false;
  const ids = new Set<string>();
  for (const m of value.messages) {
    if (!record(m) || !keys(m, ['id', 'role', 'text', 'toolCallIds', 'resultFor', 'toolName', 'requestBytes', 'failed']) || !text(m.id) || ids.has(m.id) || !['system', 'user', 'assistant', 'tool'].includes(String(m.role))
      || (m.failed !== undefined && typeof m.failed !== 'boolean') || (m.requestBytes !== undefined && !integer(m.requestBytes)) || (m.toolName !== undefined && m.toolName !== null && !text(m.toolName)) || typeof m.text !== 'string' || !Array.isArray(m.toolCallIds) || !m.toolCallIds.every(text) || (m.resultFor !== null && !text(m.resultFor))) return false;
    ids.add(m.id);
  }
  if (value.tools.some(t => !record(t))) return false;
  const usage = value.previousUsage;
  return usage === null || record(usage) && keys(usage, ['inputTokens', 'requestBytes']) && integer(usage.inputTokens) && integer(usage.requestBytes) && usage.requestBytes > 0;
}
export function isModelRequestPreparationV1(value: unknown): value is ModelRequestPreparationV1 {
  if (!record(value) || !keys(value, ['id', 'replacement']) || !text(value.id)) return false;
  const r = value.replacement;
  return r === undefined || record(r) && keys(r, ['throughMessageId', 'summary']) && text(r.throughMessageId) && typeof r.summary === 'string' && r.summary.length > 0 && r.summary.length <= 262_144;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every(k => allowed.includes(k)); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n]/u.test(value); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
