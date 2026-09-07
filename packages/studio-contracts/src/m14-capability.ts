import type { M12CapabilityId, M12Digest } from './m12.js';

/** Offline census metadata only; never register tools or runtime adapters from this data. */
export type CapabilitySurfaceLayerV1 = 'upstream' | 'document' | 'runtime' | 'tool' | 'ui' | 'verification';
export type CapabilityEvidenceStateV1 = 'current' | 'stale' | 'missing';
export type CapabilityIntegrationStageV1 = 'implementation-present' | 'adapter-ready' | 'product-integrated';

export interface CapabilityEvidenceReferenceV1 {
  readonly path: string;
  readonly sha256: M12Digest;
  readonly kind: 'source' | 'public-export' | 'local-check' | 'adapter-acceptance' | 'product-acceptance' | 'historical';
  /** Export subpath, registry id, or check id; not an executable expression. */
  readonly locator: string;
}

export interface CapabilityLayerEvidenceV1 {
  readonly owner: string;
  readonly state: CapabilityEvidenceStateV1;
  readonly references: readonly CapabilityEvidenceReferenceV1[];
  readonly explanation: string;
}

export interface CapabilitySurfaceRecordV1 {
  readonly schemaVersion: 1;
  /** Reuses the M12 union; census adds no executable capability ids. */
  readonly capabilityId: M12CapabilityId;
  readonly stage: CapabilityIntegrationStageV1;
  readonly componentTypes: readonly string[];
  readonly toolIds: readonly string[];
  readonly layers: Readonly<Record<CapabilitySurfaceLayerV1, CapabilityLayerEvidenceV1>>;
  readonly acceptance: Readonly<{
    adapterCheckIds: readonly string[];
    productCheckIds: readonly string[];
  }>;
  readonly limitations: readonly string[];
}
