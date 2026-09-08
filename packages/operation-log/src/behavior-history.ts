import { asStableId, type BehaviorExplanationV1, type BehaviorManifestV1, type BehaviorTraceArtifactV1, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, sha256 } from './canonical.js';
import type { ConversationOperationLog } from './project-agent-history.js';

export interface BehaviorArtifactValues {
  readonly manifest: BehaviorManifestV1;
  readonly explanation: BehaviorExplanationV1;
  readonly trace: BehaviorTraceArtifactV1;
}
export type BehaviorArtifactKind = keyof BehaviorArtifactValues;
export interface BehaviorArtifactBinding {
  readonly projectId: string;
  readonly documentId: string;
  readonly documentRevision: number;
  readonly sourceBindingDigest: string;
  readonly manifestDigest: string;
}
export interface BehaviorArtifactReference extends BehaviorArtifactBinding {
  readonly kind: BehaviorArtifactKind;
  readonly artifactId: StableId;
  readonly digest: string;
  readonly createdAt: string;
}
export interface BehaviorHistoryOptions {
  readonly log: ConversationOperationLog;
  /** Domain validation is injected to avoid an operation-log -> analyzer dependency cycle. */
  validate<K extends BehaviorArtifactKind>(kind: K, value: unknown): BehaviorArtifactValues[K];
}
const MAX_BYTES = 8 * 1024 * 1024, CHUNK_BYTES = 192 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/u, ARTIFACT = /^artifact:sha256:[a-f0-9]{64}$/u;
const kinds = ['manifest', 'explanation', 'trace'] as const;

/** Stores derived data in the existing artifact store. ProjectAgentHistory replicates
 * each journal fact and ALL of its artifactRefs into the existing project directory. */
export class ProjectBehaviorHistory {
  constructor(private readonly options: BehaviorHistoryOptions) {}

  /** Existing durable facts only. Matching ownership does not claim that a
   * transaction caused a particular branch or that an artifact passed review. */
  async related(projectId: string, documentId: string, source: Readonly<{ entityId: string; scriptId?: string }>, cursor?: string) {
    for (const id of [projectId, documentId, source.entityId, ...(source.scriptId ? [source.scriptId] : [])]) asStableId(id);
    return this.options.log.query({ projectId: asStableId(projectId), documentId: asStableId(documentId),
      ...(source.scriptId ? { scriptId: asStableId(source.scriptId) } : { entityId: asStableId(source.entityId) }),
      limit: 20, traverseCorrelation: false, ...(cursor ? { cursor } : {}) });
  }

  async put<K extends BehaviorArtifactKind>(binding: BehaviorArtifactBinding, kind: K, input: unknown, signal?: AbortSignal): Promise<BehaviorArtifactReference> {
    checkBinding(binding); checkKind(kind); checkSignal(signal);
    const value = this.options.validate(kind, input); checkValueBinding(binding, kind, value);
    const bytes = Buffer.from(canonicalStringify(value as unknown as JsonObject), 'utf8');
    if (bytes.byteLength > MAX_BYTES) throw new Error('behavior.history-budget');
    const digest = `sha256:${sha256(bytes)}`;
    const chunks: StableId[] = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      checkSignal(signal);
      const artifact = await this.options.log.putArtifact({ encoding: 'base64', bytes: bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64') }, { schemaVersion: 'behavior-artifact-chunk/1' });
      chunks.push(artifact.id);
    }
    checkSignal(signal);
    const index = await this.options.log.putArtifact({ ...binding, kind, digest, byteLength: bytes.length, chunks }, { schemaVersion: 'behavior-artifact-index/1' });
    checkSignal(signal);
    const event = await this.options.log.append({
      kind: `behavior/${kind}`, severity: 'info', source: asStableId('studio.behavior-history'),
      correlation: { projectId: asStableId(binding.projectId), documentId: asStableId(binding.documentId) },
      payload: { ...binding, kind, digest, artifactId: index.id }, artifactRefs: [index.id, ...chunks],
    }, { signal });
    return Object.freeze({ ...binding, kind, digest, artifactId: index.id, createdAt: event.timestamp });
  }

  async read<K extends BehaviorArtifactKind>(projectId: string, artifactId: string, kind: K, signal?: AbortSignal): Promise<Readonly<{ reference: BehaviorArtifactReference; value: BehaviorArtifactValues[K] }>> {
    asStableId(projectId); checkKind(kind); checkSignal(signal);
    if (!ARTIFACT.test(artifactId)) throw new Error('behavior.history-reference');
    const indexArtifact = await this.options.log.readArtifact(asStableId(artifactId));
    const index = indexArtifact.value as Record<string, unknown>;
    if (!index || indexArtifact.provenance.schemaVersion !== 'behavior-artifact-index/1' || index.projectId !== projectId || index.kind !== kind) throw new Error('behavior.history-project');
    checkBinding(index as unknown as BehaviorArtifactBinding);
    if (Object.keys(index).some(key => !['projectId','documentId','documentRevision','sourceBindingDigest','manifestDigest','kind','digest','byteLength','chunks'].includes(key)) || !DIGEST.test(String(index.digest)) || !Number.isSafeInteger(index.byteLength) || Number(index.byteLength) < 1 || Number(index.byteLength) > MAX_BYTES || !Array.isArray(index.chunks) || index.chunks.length !== Math.ceil(Number(index.byteLength) / CHUNK_BYTES) || index.chunks.some(id => typeof id !== 'string' || !ARTIFACT.test(id))) throw new Error('behavior.history-index');
    const chunks: Buffer[] = [];
    for (const id of index.chunks) {
      checkSignal(signal);
      const chunk = await this.options.log.readArtifact(asStableId(id));
      const content = chunk.value;
      if (chunk.provenance.schemaVersion !== 'behavior-artifact-chunk/1' || !content || typeof content !== 'object' || Array.isArray(content) || !('encoding' in content) || content.encoding !== 'base64' || !('bytes' in content) || typeof content.bytes !== 'string' || content.bytes.length > CHUNK_BYTES * 4 / 3 || Object.keys(content).some(key => !['encoding','bytes'].includes(key))) throw new Error('behavior.history-chunk');
      const data = Buffer.from(content.bytes, 'base64');
      if (data.toString('base64') !== content.bytes) throw new Error('behavior.history-chunk');
      chunks.push(data);
    }
    checkSignal(signal);
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== index.byteLength || `sha256:${sha256(bytes)}` !== index.digest) throw new Error('behavior.history-integrity');
    const value = this.options.validate(kind, JSON.parse(bytes.toString('utf8')));
    const binding: BehaviorArtifactBinding = { projectId, documentId: String(index.documentId), documentRevision: Number(index.documentRevision), sourceBindingDigest: String(index.sourceBindingDigest), manifestDigest: String(index.manifestDigest) };
    checkValueBinding(binding, kind, value);
    return Object.freeze({ reference: Object.freeze({ ...binding, kind, artifactId: asStableId(artifactId), digest: String(index.digest), createdAt: indexArtifact.createdAt }), value });
  }

  async list(projectId: string, input: Readonly<{ kind?: BehaviorArtifactKind; limit?: number; cursor?: string }> = {}): Promise<Readonly<{ records: readonly BehaviorArtifactReference[]; nextCursor: string | null }>> {
    asStableId(projectId); if (input.kind) checkKind(input.kind);
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('behavior.history-query');
    const page = await this.options.log.query({ projectId: asStableId(projectId), kinds: (input.kind ? [input.kind] : kinds).map(kind => `behavior/${kind}`), limit, traverseCorrelation: false, ...(input.cursor ? { cursor: input.cursor } : {}) });
    const records = page.events.map(event => {
      const payload = event.payload; checkBinding(payload as unknown as BehaviorArtifactBinding); checkKind(payload.kind);
      if (payload.projectId !== projectId || typeof payload.artifactId !== 'string' || !ARTIFACT.test(payload.artifactId) || payload.artifactId !== event.artifactRefs[0] || !DIGEST.test(String(payload.digest))) throw new Error('behavior.history-record');
      return Object.freeze({ projectId, documentId: String(payload.documentId), documentRevision: Number(payload.documentRevision), sourceBindingDigest: String(payload.sourceBindingDigest), manifestDigest: String(payload.manifestDigest), kind: payload.kind, artifactId: asStableId(payload.artifactId), digest: String(payload.digest), createdAt: event.timestamp });
    });
    return Object.freeze({ records: Object.freeze(records), nextCursor: page.nextCursor ?? null });
  }
}
function checkKind(kind: unknown): asserts kind is BehaviorArtifactKind { if (!(kinds as readonly unknown[]).includes(kind)) throw new Error('behavior.history-kind'); }
function checkBinding(binding: BehaviorArtifactBinding): void {
  asStableId(binding.projectId); asStableId(binding.documentId);
  if (!Number.isSafeInteger(binding.documentRevision) || binding.documentRevision < 0 || !DIGEST.test(binding.sourceBindingDigest) || !DIGEST.test(binding.manifestDigest)) throw new Error('behavior.history-binding');
}
function checkValueBinding(binding: BehaviorArtifactBinding, kind: BehaviorArtifactKind, value: BehaviorArtifactValues[BehaviorArtifactKind]): void {
  if (kind === 'manifest') {
    const manifest = value as BehaviorManifestV1;
    if (manifest.binding.projectId !== binding.projectId || manifest.binding.documentId !== binding.documentId || manifest.binding.documentRevision !== binding.documentRevision || manifest.binding.digest !== binding.sourceBindingDigest || manifest.digest !== binding.manifestDigest) throw new Error('behavior.history-binding');
  } else if (kind === 'explanation') { if ((value as BehaviorExplanationV1).manifestDigest !== binding.manifestDigest) throw new Error('behavior.history-binding'); }
  else {
    const artifact = value as BehaviorTraceArtifactV1;
    if (artifact.trace.manifestDigest !== binding.manifestDigest || artifact.trace.sourceBindingDigest !== binding.sourceBindingDigest || artifact.observation.documentRevision !== binding.documentRevision) throw new Error('behavior.history-binding');
  }
}
function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new Error('behavior.cancelled'); }
