import type { KnowledgeHitV1, M13StableId } from '@haiyue/ai-studio-contracts';

export type KnowledgeSourceKind = KnowledgeHitV1['sourceKind'];

export interface KnowledgeSourceInput {
  readonly sourceId: M13StableId;
  /** Local package/project/session URI or project-relative path. Network URLs are rejected. */
  readonly source: string;
  readonly sourceKind: KnowledgeSourceKind;
  readonly text: string;
  readonly mediaType?: 'text/plain' | 'text/markdown' | 'application/json';
  readonly packageVersion: string | null;
  readonly projectRevision: number | null;
  readonly permissionScope: M13StableId;
  readonly capabilityIds?: readonly M13StableId[];
  readonly claimKeys?: readonly string[];
  readonly relatedSourceIds?: readonly M13StableId[];
  readonly authorized: boolean;
  readonly verified?: boolean;
}

export interface KnowledgeSearchInput {
  readonly query: string;
  readonly mode?: 'exact-only' | 'hybrid';
  readonly allowedPermissionScopes: readonly M13StableId[];
  readonly sourceKinds?: readonly KnowledgeSourceKind[];
  readonly packageVersions?: readonly string[];
  readonly projectRevision?: number | null;
  readonly capabilityIds?: readonly M13StableId[];
  readonly graphSeedSourceIds?: readonly M13StableId[];
  readonly includeStale?: boolean;
  readonly limit?: number;
  readonly tokenBudget?: number;
  readonly signal?: AbortSignal;
}

export interface KnowledgeCitation {
  readonly source: string;
  readonly sourceKind: KnowledgeSourceKind;
  readonly packageVersion: string | null;
  readonly projectRevision: number | null;
  readonly contentDigest: string;
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
}

export interface KnowledgeSearchHit {
  readonly hit: KnowledgeHitV1;
  readonly citation: KnowledgeCitation;
  readonly excerpt: string;
  readonly estimatedTokens: number;
  readonly capabilityIds: readonly M13StableId[];
  readonly artifactId: M13StableId;
}

export interface KnowledgeSearchDiagnostic {
  readonly code: 'permission-filtered' | 'stale-filtered' | 'version-filtered' | 'conflicting-sources' | 'token-budget' | 'no-results';
  readonly count: number;
  readonly message: string;
}

export interface KnowledgeSearchResult {
  readonly query: string;
  readonly hits: readonly KnowledgeSearchHit[];
  readonly artifactIds: readonly M13StableId[];
  readonly diagnostics: readonly KnowledgeSearchDiagnostic[];
  readonly estimatedTokens: number;
  readonly candidateCount: number;
  readonly retrieval: 'exact-only' | 'hybrid';
  readonly indexDigest: string;
}

export interface KnowledgeIndexSnapshot {
  readonly sourceCount: number;
  readonly chunkCount: number;
  readonly tombstoneCount: number;
  readonly indexDigest: string;
  readonly initialized: boolean;
}

export interface LocalEmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  embed(text: string): readonly number[];
}

export interface KnowledgeRetrievalOptions {
  readonly embedding?: LocalEmbeddingProvider;
  readonly chunkCharacters?: number;
  readonly chunkOverlapCharacters?: number;
  readonly clock?: () => Date;
}

export class KnowledgeRetrievalError extends Error {
  constructor(readonly code: string, message: string, readonly recoverable = false) {
    super(message);
    this.name = 'KnowledgeRetrievalError';
  }
}
