import { canonicalStringify, contentDigest, deepFreeze } from './canonical.mjs';

const EVIDENCE_TYPES = new Set(['state', 'event-trace', 'input-replay', 'screenshot', 'performance', 'lifecycle', 'log']);
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export class EvidenceCollector {
  #artifacts = [];
  #bytes = 0;

  constructor({ runId, caseId, projectDigest, seed, viewport, maxObservationBytes }) {
    this.provenance = deepFreeze({ runId, caseId, projectDigest, seed, viewport: { ...viewport }, producerVersion: 'game-eval-runner-1.0.0' });
    this.maxObservationBytes = maxObservationBytes;
  }

  collect(rawObservation) {
    validateRawObservation(rawObservation);
    const payload = {
      schemaVersion: 1,
      type: rawObservation.type,
      tick: rawObservation.tick,
      signals: { ...rawObservation.signals },
      ...(rawObservation.media ? { media: { ...rawObservation.media } } : {}),
      provenance: this.provenance,
    };
    const byteLength = Buffer.byteLength(canonicalStringify(payload));
    if (this.#bytes + byteLength > this.maxObservationBytes) {
      throw new EvidenceCollectionError('eval.observation-budget-exceeded', `Observation bytes exceed ${this.maxObservationBytes}.`);
    }
    const digest = contentDigest(payload);
    const artifact = deepFreeze({ ...payload, id: `evidence:${digest.slice(7, 31)}`, digest, byteLength });
    this.#bytes += byteLength;
    this.#artifacts.push(artifact);
    return artifact;
  }

  collectAll(observations) { return observations.map((observation) => this.collect(observation)); }
  manifest() {
    const artifacts = [...this.#artifacts].sort((left, right) => left.id.localeCompare(right.id));
    const body = { schemaVersion: 1, provenance: this.provenance, totalBytes: this.#bytes, artifacts };
    return deepFreeze({ ...body, digest: contentDigest(body) });
  }
}

function validateRawObservation(value) {
  if (!value || typeof value !== 'object' || !EVIDENCE_TYPES.has(value.type)) throw new EvidenceCollectionError('eval.evidence-type-invalid', 'Evidence type is invalid.');
  if (!Number.isSafeInteger(value.tick) || value.tick < 0) throw new EvidenceCollectionError('eval.evidence-tick-invalid', 'Evidence tick is invalid.');
  if (!value.signals || typeof value.signals !== 'object' || Array.isArray(value.signals)) throw new EvidenceCollectionError('eval.evidence-signals-invalid', 'Evidence signals are invalid.');
  for (const [name, signal] of Object.entries(value.signals)) {
    if (!/^[a-z][a-zA-Z0-9.-]{2,127}$/.test(name)) throw new EvidenceCollectionError('eval.evidence-signal-name-invalid', `Signal ${name} is invalid.`);
    if (!(signal === null || typeof signal === 'boolean' || typeof signal === 'string' || (typeof signal === 'number' && Number.isFinite(signal)))) {
      throw new EvidenceCollectionError('eval.evidence-signal-value-invalid', `Signal ${name} must be a bounded scalar.`);
    }
  }
  if (value.type === 'screenshot') {
    const media = value.media;
    if (!media || media.mediaType !== 'image/png' || !DIGEST.test(media.digest)
      || !Number.isSafeInteger(media.width) || media.width < 1 || media.width > 16384
      || !Number.isSafeInteger(media.height) || media.height < 1 || media.height > 16384
      || typeof media.semanticAnalyzerVersion !== 'string') {
      throw new EvidenceCollectionError('eval.screenshot-provenance-invalid', 'Screenshot evidence requires PNG digest, viewport and semantic analyzer provenance.');
    }
  } else if (value.media !== undefined) throw new EvidenceCollectionError('eval.evidence-media-invalid', 'Only screenshot evidence can carry media metadata.');
}

export class EvidenceCollectionError extends Error {
  constructor(code, message) { super(message); this.name = 'EvidenceCollectionError'; this.code = code; }
}
