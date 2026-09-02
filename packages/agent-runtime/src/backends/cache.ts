import type { BackendSessionBindingV1, UsageRecordV2 } from '@haiyue/ai-studio-contracts';
import type { ContextCacheMetrics } from '../prompt-context.js';
import { BackendSessionError } from './error.js';
import type { BackendCacheEvidenceV1 } from './types.js';

export function projectBackendCacheEvidence(
  binding: BackendSessionBindingV1,
  context: ContextCacheMetrics,
  usage?: Pick<UsageRecordV2, 'cachedInputTokens' | 'cacheWriteTokens'> | null,
): BackendCacheEvidenceV1 {
  for (const [label, value] of Object.entries({
    localArtifactHits: context.localArtifactHits,
    localArtifactMisses: context.localArtifactMisses,
    deltaReuseBytes: context.deltaReuseBytes,
    providerCacheEligibleBytes: context.providerCacheEligibleBytes,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new BackendSessionError('backend.cache-evidence-invalid', `${label} is invalid.`);
  }
  const hitTokens = tokenCount(usage?.cachedInputTokens ?? context.providerReportedHitTokens);
  const writeTokens = tokenCount(usage?.cacheWriteTokens);
  const providerReported = hitTokens !== null || writeTokens !== null;
  return Object.freeze({
    localCas: Object.freeze({
      artifactHits: context.localArtifactHits,
      artifactMisses: context.localArtifactMisses,
      deltaReuseBytes: context.deltaReuseBytes,
      source: 'studio-cas' as const,
    }),
    provider: Object.freeze({
      status: providerReported ? 'reported' as const : binding.capabilities.providerCache === 'unavailable' ? 'unavailable' as const : 'unknown' as const,
      hitTokens,
      writeTokens,
      eligiblePrefixBytes: context.providerCacheEligibleBytes,
      source: providerReported ? 'provider-usage' as const : 'provider-capability' as const,
    }),
  });
}

function tokenCount(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new BackendSessionError('backend.cache-evidence-invalid', 'Provider cache token evidence is invalid.');
  return value;
}
