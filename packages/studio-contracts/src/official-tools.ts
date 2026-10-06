import type { JsonObject, StableId } from './index.js';

export type StudioToolEffectV1 = 'observe' | 'reversible-edit' | 'trusted-code' | 'runtime-start' | 'external-side-effect';
export type StudioToolRiskV1 = 'low' | 'medium' | 'high';

export interface StudioToolDefinitionV1 {
  readonly schemaVersion: 1;
  readonly id: StableId;
  readonly version: '1.0.0';
  readonly title: string;
  readonly description: string;
  readonly effect: StudioToolEffectV1;
  readonly risk: StudioToolRiskV1;
  readonly requiredCapabilities: readonly StableId[];
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly redactedFields: readonly string[];
  readonly presentation: Readonly<{ intent: string; result: string }>;
  readonly timeoutMs: number;
  readonly maxResultBytes: number;
  readonly requiresApproval: boolean;
  /** Registry-owned concurrency declaration. Only explicitly safe observations may be scheduled in parallel. */
  readonly concurrencySafe: boolean;
}

/** Reviewed composition-time mapping; credentials and upstream types never cross this port. */
export interface OfficialToolBindingV1 {
  readonly schemaVersion: 1;
  readonly providerId: StableId;
  readonly nativeName: string;
  readonly definition: StudioToolDefinitionV1;
}
export interface OfficialToolExecutionV1 {
  readonly callId: StableId;
  readonly sessionId: StableId;
  readonly turnId: StableId;
  readonly toolId: StableId;
  readonly arguments: JsonObject;
}
/** Existing Host policy must finish before execute. No authorization token is model-visible. */
export interface OfficialToolProviderV1 {
  readonly definitions: readonly StudioToolDefinitionV1[];
  execute(call: OfficialToolExecutionV1, signal: AbortSignal): Promise<JsonObject>;
}

export function isOfficialToolBindingV1(value: unknown): value is OfficialToolBindingV1 {
  if (!object(value) || !keys(value, ['schemaVersion', 'providerId', 'nativeName', 'definition']) || value.schemaVersion !== 1
    || !id(value.providerId) || !text(value.nativeName, 128) || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value.nativeName) || value.nativeName.startsWith('studio_') || value.nativeName === 'run_code') return false;
  const d = value.definition;
  if (!object(d) || !keys(d, ['schemaVersion','id','version','title','description','effect','risk','requiredCapabilities','inputSchema','outputSchema','redactedFields','presentation','timeoutMs','maxResultBytes','requiresApproval','concurrencySafe'])
    || d.schemaVersion !== 1 || d.version !== '1.0.0' || !id(d.id) || !d.id.startsWith('official.')
    || !text(d.title, 128) || !text(d.description, 8192) || !['observe','external-side-effect','trusted-code','runtime-start'].includes(String(d.effect))
    || !['low','medium','high'].includes(String(d.risk)) || !Array.isArray(d.requiredCapabilities) || d.requiredCapabilities.length > 32 || !d.requiredCapabilities.every(id)
    || !object(d.inputSchema) || d.inputSchema.type !== 'object' || !object(d.outputSchema) || d.outputSchema.type !== 'object'
    || !Array.isArray(d.redactedFields) || d.redactedFields.length > 32 || !d.redactedFields.every(x => text(x, 128))
    || !object(d.presentation) || !keys(d.presentation, ['intent','result']) || !text(d.presentation.intent,128) || !text(d.presentation.result,128)
    || !integer(d.timeoutMs, 120000) || !integer(d.maxResultBytes, 262144) || typeof d.requiresApproval !== 'boolean' || typeof d.concurrencySafe !== 'boolean') return false;
  if (d.effect === 'observe' ? d.risk !== 'low' || d.requiresApproval : !d.requiresApproval || d.risk === 'low' || d.concurrencySafe) return false;
  try { return JSON.stringify(value).length <= 131072 && safeJson(value); } catch { return false; }
}
function keys(v: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(v).length === allowed.length && Object.keys(v).every(k => allowed.includes(k)); }
function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v: unknown, max: number): v is string { return typeof v === 'string' && v.length > 0 && v.length <= max; }
function id(v: unknown): v is StableId { return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(v); }
function integer(v: unknown, max: number): boolean { return Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= max; }
function safeJson(v: unknown, depth = 0): boolean {
  if (depth > 24) return false;
  if (typeof v === 'string') return !/Bearer\s+\S+|sk-[a-zA-Z0-9_-]{8,}/i.test(v);
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(x => safeJson(x,depth+1));
  return object(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Object.entries(v).every(([k,x]) => !/^(?:__proto__|constructor|prototype|apiKey|accessToken|authorization|credentials)$/i.test(k) && safeJson(x,depth+1));
}
