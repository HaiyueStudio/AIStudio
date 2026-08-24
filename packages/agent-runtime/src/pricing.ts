import { asStableId, type CostRecordV2, type PricingCatalogV1, type StableId, type UsageRecordV2 } from '@haiyue/ai-studio-contracts';
export interface CostEstimate {
  readonly record: CostRecordV2;
  readonly explanation: string;
  readonly cacheSavingMicros: number | null;
}

export class PricingEngine {
  constructor(readonly catalog: PricingCatalogV1) { validatePricingCatalog(catalog); }

  estimate(options: {
    readonly provider: string;
    readonly model: string;
    readonly usage: UsageRecordV2;
    readonly billingMode: 'api' | 'subscription' | 'unknown';
    readonly actualAmountMicros?: number;
  }): CostEstimate {
    const id = asStableId(`cost:${stableSuffix(options.usage.id)}`);
    if (options.actualAmountMicros !== undefined) {
      assertNonNegativeSafeInteger(options.actualAmountMicros, 'actual amount');
      return freezeEstimate({
        record: { schemaVersion: 2, id, usageRecordId: options.usage.id, pricingCatalogId: this.catalog.id, pricingCatalogVersion: this.catalog.version, effectiveAt: this.catalog.effectiveAt, currency: this.catalog.currency, amountMicros: options.actualAmountMicros, status: 'actual', formula: 'provider-actual-amount' },
        explanation: 'Provider supplied an actual billed amount.', cacheSavingMicros: null,
      });
    }
    if (options.billingMode !== 'api') return unknown(id, options.usage.id, options.billingMode === 'subscription' ? 'Subscription limits are not API billing amounts.' : 'Billing mode is unknown.');
    const entry = this.catalog.entries.find((candidate) => candidate.provider === options.provider && candidate.model === options.model);
    if (!entry) return unknown(id, options.usage.id, `No pricing entry exists for ${options.provider}/${options.model}.`);
    const usage = options.usage;
    if ([usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.reasoningTokens].some((value) => value === null)) return unknown(id, usage.id, 'Provider usage is incomplete, so cost cannot be estimated.');
    const cached = usage.cachedInputTokens!;
    const cacheWrite = usage.cacheWriteTokens ?? 0;
    if (cached + cacheWrite > usage.inputTokens!) return unknown(id, usage.id, 'Cached and cache-write input tokens exceed total input tokens.');
    if (cached > 0 && entry.cachedInputMicrosPerMillion === null) return unknown(id, usage.id, 'The catalog has no cached-input price for this model.');
    if (cacheWrite > 0 && entry.cacheWriteMicrosPerMillion === null) return unknown(id, usage.id, 'The catalog has no cache-write price for this model.');

    const uncachedInput = usage.inputTokens! - cached - cacheWrite;
    const reasoning = entry.reasoningBilling === 'separate-as-output' ? usage.reasoningTokens! : 0;
    const amountMicros = sumRounded([
      [uncachedInput, entry.inputMicrosPerMillion],
      [cached, entry.cachedInputMicrosPerMillion ?? 0],
      [cacheWrite, entry.cacheWriteMicrosPerMillion ?? 0],
      [usage.outputTokens! + reasoning, entry.outputMicrosPerMillion],
    ]);
    const cacheSavingMicros = cached === 0 ? 0 : roundRate(cached, entry.inputMicrosPerMillion) - roundRate(cached, entry.cachedInputMicrosPerMillion ?? entry.inputMicrosPerMillion);
    const formula = 'round((uncachedInput*input + cachedInput*cached + cacheWrite*write + billableOutput*output)/1M)';
    return freezeEstimate({
      record: { schemaVersion: 2, id, usageRecordId: usage.id, pricingCatalogId: this.catalog.id, pricingCatalogVersion: this.catalog.version, effectiveAt: this.catalog.effectiveAt, currency: this.catalog.currency, amountMicros, status: 'estimated', formula },
      explanation: `Estimated from pricing catalog ${this.catalog.id}@${this.catalog.version}.`, cacheSavingMicros,
    });
  }
}

export function validatePricingCatalog(value: unknown): PricingCatalogV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isStableId(value.id) || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value.version)
    || typeof value.effectiveAt !== 'string' || !timestamp.test(value.effectiveAt) || typeof value.currency !== 'string' || !/^[A-Z]{3}$/u.test(value.currency)
    || !Array.isArray(value.sources) || !Array.isArray(value.entries) || value.entries.length === 0) throw new PricingError('pricing.catalog-invalid', 'Pricing catalog envelope is invalid.');
  const keys = new Set<string>();
  for (const source of value.sources) if (!isRecord(source) || typeof source.provider !== 'string' || typeof source.url !== 'string' || !/^https:\/\//u.test(source.url) || typeof source.retrievedAt !== 'string' || !timestamp.test(source.retrievedAt)) throw new PricingError('pricing.source-invalid', 'Pricing source is invalid.');
  for (const entry of value.entries) {
    if (!isRecord(entry) || typeof entry.provider !== 'string' || typeof entry.model !== 'string' || !['included-in-output', 'separate-as-output'].includes(String(entry.reasoningBilling))) throw new PricingError('pricing.entry-invalid', 'Pricing entry is invalid.');
    for (const key of ['inputMicrosPerMillion', 'outputMicrosPerMillion']) assertNonNegativeSafeInteger(entry[key], key);
    for (const key of ['cachedInputMicrosPerMillion', 'cacheWriteMicrosPerMillion']) if (entry[key] !== null) assertNonNegativeSafeInteger(entry[key], key);
    const compound = `${entry.provider}\0${entry.model}`; if (keys.has(compound)) throw new PricingError('pricing.entry-duplicate', `Duplicate pricing entry ${entry.provider}/${entry.model}.`); keys.add(compound);
  }
  return deepFreeze(value) as unknown as PricingCatalogV1;
}

export class PricingError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'PricingError'; } }

function unknown(id: StableId, usageRecordId: string, explanation: string): CostEstimate {
  return freezeEstimate({ record: { schemaVersion: 2, id, usageRecordId, pricingCatalogId: null, pricingCatalogVersion: null, effectiveAt: null, currency: null, amountMicros: null, status: 'unknown', formula: null }, explanation, cacheSavingMicros: null });
}
function roundRate(tokens: number, rate: number): number { return Number((BigInt(tokens) * BigInt(rate) + 500_000n) / 1_000_000n); }
function sumRounded(items: readonly (readonly [number, number])[]): number { return items.reduce((sum, [tokens, rate]) => sum + roundRate(tokens, rate), 0); }
function stableSuffix(value: string): string { return value.replace(/[^A-Za-z0-9._:-]/gu, '_').slice(0, 100); }
function freezeEstimate(value: CostEstimate): CostEstimate { return Object.freeze({ ...value, record: Object.freeze(value.record) }); }
function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new PricingError('pricing.value-invalid', `${label} must be a non-negative safe integer.`); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function isStableId(value: unknown): value is StableId { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value); }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
