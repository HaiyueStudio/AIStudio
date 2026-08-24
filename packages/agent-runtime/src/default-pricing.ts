import type { PricingCatalogV1 } from '@haiyue/ai-studio-contracts';

/** Packaged copy of config/pricing/m12-pricing-catalog-v1.json; a test prevents drift. */
export const M12_DEFAULT_PRICING_CATALOG: PricingCatalogV1 = Object.freeze({
  schemaVersion: 1, id: 'pricing:haiyue-m12-usd', version: '1.0.0', effectiveAt: '2026-08-24T00:00:00.000Z', currency: 'USD',
  sources: Object.freeze([
    Object.freeze({ provider: 'deepseek', url: 'https://api-docs.deepseek.com/quick_start/pricing/', retrievedAt: '2026-08-24T00:00:00.000Z' }),
    Object.freeze({ provider: 'openai', url: 'https://platform.openai.com/pricing', retrievedAt: '2026-08-24T00:00:00.000Z' }),
  ]),
  entries: Object.freeze([
    entry('deepseek', 'deepseek-v4-flash', 140_000, 2_800, 140_000, 280_000),
    entry('deepseek', 'deepseek-v4-pro', 435_000, 3_625, 435_000, 870_000),
    entry('openai', 'gpt-5.6-sol', 2_500_000, 250_000, 3_125_000, 15_000_000),
    entry('openai', 'gpt-5.6-terra', 1_250_000, 125_000, 1_562_500, 7_500_000),
    entry('openai', 'gpt-5.6-luna', 500_000, 50_000, 625_000, 3_000_000),
    entry('openai', 'gpt-5.5', 2_500_000, 250_000, null, 15_000_000),
    entry('openai', 'gpt-5.4', 1_250_000, 130_000, null, 7_500_000),
    entry('openai', 'gpt-5.3-codex', 1_750_000, 175_000, null, 14_000_000),
  ]),
});

function entry(provider: string, model: string, inputMicrosPerMillion: number, cachedInputMicrosPerMillion: number | null, cacheWriteMicrosPerMillion: number | null, outputMicrosPerMillion: number): PricingCatalogV1['entries'][number] {
  return Object.freeze({ provider, model, inputMicrosPerMillion, cachedInputMicrosPerMillion, cacheWriteMicrosPerMillion, outputMicrosPerMillion, reasoningBilling: 'included-in-output' });
}
