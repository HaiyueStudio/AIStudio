import { createHash, randomUUID } from 'node:crypto';
import { ControlledAssetCatalog, CONTROLLED_ASSET_CATALOG_SETTING_KEY, type ControlledAssetManifestEntry } from '../assets/catalog.js';
import type {
  EditorDocumentHostSnapshot,
  EditorHistoryService,
  EditorProjectSessionSnapshot,
  EditorProjectSessionState,
  EditorTaskCoordinator,
} from '@haiyue/editor-platform';
import type { EditorDocumentHost } from '@haiyue/editor-platform';
import type { EditorCommand, EditorHistorySnapshot } from '@haiyue/editor-plugin-sdk';
import { asStableId, type GameDocumentDeltaV2, type GameDocumentOperationV2, type GameDocumentQueryResultV2, type GameDocumentQueryV2, type GameDocumentV2, type JsonValue, type StableId } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, OperationLog, OperationLogError, sha256, type DurableOperationEvent } from '@haiyue/ai-studio-operation-log';
import { ProjectDocument, type ProjectDocumentReadModel, type ProjectMigrationReport } from '../project/document.js';
import { ProjectPathError, ProjectRepository, RecentProjectStore } from '../project/repository.js';
import { ComponentRegistry } from '../components/registry.js';
import { SceneContextRuntime, type SceneDiffInput, type SceneDiffResult, type SceneQueryInput, type SceneQueryResult } from '../project/scene-context.js';

export interface ProjectCommandInput {
  readonly id: StableId;
  readonly label: string;
  readonly baseRevision: number;
  readonly key: string;
  readonly value: JsonValue;
  readonly transactionId?: StableId;
}
export interface ProjectBatchCommandInput {
  readonly id: StableId;
  readonly label: string;
  readonly baseRevision: number;
  readonly operations: readonly GameDocumentOperationV2[];
  readonly transactionId?: StableId;
}
export interface ProjectTransactionInput extends Omit<ProjectBatchCommandInput, 'transactionId'> {
  readonly transactionId: StableId;
  readonly idempotencyKey: StableId;
  readonly memberNodeIds?: readonly StableId[];
}
export interface ProjectTransactionReceipt {
  readonly schemaVersion: 1;
  readonly transactionId: StableId;
  readonly idempotencyKey: StableId;
  readonly projectId: StableId;
  readonly documentId: StableId;
  readonly commandId: StableId;
  readonly baseRevision: number;
  readonly beforeRevision: number;
  readonly afterRevision: number;
  readonly operationDigest: `sha256:${string}`;
  readonly memberDigest: `sha256:${string}`;
  readonly memberNodeIds: readonly StableId[];
  readonly historyEntryId: number;
  readonly historyLabel: string;
  readonly committedAt: string;
  readonly sceneDiffTransactionId: StableId | null;
  readonly sceneDiffArtifactId: StableId | null;
  readonly resultArtifactIds: readonly StableId[];
  readonly receiptDigest: `sha256:${string}`;
  readonly artifactId: StableId;
}
export interface ProjectTransactionCommit {
  readonly snapshot: ProjectWorkspaceSnapshot;
  readonly receipt: ProjectTransactionReceipt;
  readonly replayed: boolean;
}
export type ProjectTransactionReconciliation =
  | Readonly<{ status: 'committed'; receipt: ProjectTransactionReceipt }>
  | Readonly<{ status: 'not-committed'; documentId: StableId; revision: number }>
  | Readonly<{ status: 'ambiguous'; documentId: StableId; revision: number; reason: string }>;
export interface ProjectTransactionIdentity {
  readonly transactionId: StableId;
  readonly idempotencyKey: StableId;
  readonly baseRevision: number;
  readonly operationDigest: `sha256:${string}`;
  readonly memberDigest?: `sha256:${string}`;
}
export type ProjectTransactionFaultPoint = 'before-history-write' | 'after-history-write' | 'after-receipt-write' | 'after-commit-event';
export type ProjectDocumentMutation = Readonly<{ kind: 'replace'; documentId: StableId | null; revision: number }> | Readonly<{ kind: 'delta'; delta: GameDocumentDeltaV2 }>;

export interface ProjectWorkspaceSnapshot {
  readonly projectRoot: string | null;
  readonly document: ProjectDocumentReadModel | null;
  readonly documents: EditorDocumentHostSnapshot;
  readonly history: EditorHistorySnapshot;
  readonly session: EditorProjectSessionSnapshot;
  readonly logging: ReturnType<OperationLog['status']>;
  readonly activeTasks: number;
  readonly migration: ProjectMigrationReport | null;
  readonly disposed: boolean;
}

export interface ProjectWorkspaceResources {
  readonly documents: EditorDocumentHost;
  readonly history: EditorHistoryService;
  readonly tasks: EditorTaskCoordinator;
  readonly projectSession: EditorProjectSessionState;
  readonly operationLog: OperationLog;
  readonly recentProjects: RecentProjectStore;
  readonly transactionFaultInjector?: (point: ProjectTransactionFaultPoint, transactionId: StableId) => void | Promise<void>;
}

export class ProjectWorkspace {
  private repository: ProjectRepository | null = null;
  // Document-owned immutable PNG bytes; retained across Undo for Redo until first save.
  private readonly draftTextures = new Map<string, Uint8Array>();
  private draftTextureBytes = 0;
  private document: ProjectDocument | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private listeners = new Set<(snapshot: ProjectWorkspaceSnapshot) => void>();
  private mutationListeners = new Set<(mutation: ProjectDocumentMutation) => void>();
  private disposed = false;
  private migration: ProjectMigrationReport | null = null;
  private readonly sceneContext = new SceneContextRuntime();
  private mutationProvenanceOpIds: readonly StableId[] = Object.freeze([]);
  readonly componentRegistry = new ComponentRegistry();

  constructor(private readonly resources: ProjectWorkspaceResources) {}

  snapshot(): ProjectWorkspaceSnapshot {
    return Object.freeze({
      projectRoot: this.repository?.root ?? null,
      document: this.document?.snapshot() ?? null,
      documents: this.resources.documents.snapshot(),
      history: this.resources.history.snapshot(),
      session: this.resources.projectSession.snapshot(),
      logging: this.resources.operationLog.projectStatus(this.document?.projectId ?? null),
      activeTasks: this.resources.tasks.activeCount,
      migration: this.migration,
      disposed: this.disposed,
    });
  }

  subscribe(listener: (snapshot: ProjectWorkspaceSnapshot) => void): Readonly<{ dispose(): void }> {
    this.assertActive();
    this.listeners.add(listener);
    listener(this.snapshot());
    let active = true;
    return Object.freeze({ dispose: () => { if (active) { active = false; this.listeners.delete(listener); } } });
  }

  subscribeDocumentMutations(listener: (mutation: ProjectDocumentMutation) => void): Readonly<{ dispose(): void }> {
    this.assertActive(); this.mutationListeners.add(listener); let active = true;
    return Object.freeze({ dispose: () => { if (active) { active = false; this.mutationListeners.delete(listener); } } });
  }

  gameSnapshot(): GameDocumentV2 { return this.requireDocument().gameSnapshot(); }
  primarySceneId(): StableId { return this.requireDocument().primarySceneId(); }
  scriptsSnapshot(): GameDocumentV2['scripts'] { return this.requireDocument().scriptsSnapshot(); }
  queryGameDocument(input: GameDocumentQueryV2): GameDocumentQueryResultV2 { return this.requireDocument().query(input); }
  queryScene(input: SceneQueryInput = {}): SceneQueryResult { this.assertActive(); return this.sceneContext.query(input); }
  diffScene(input: SceneDiffInput): SceneDiffResult { this.assertActive(); return this.sceneContext.diff(input); }
  componentOwner(componentId: StableId): StableId | null { return this.requireDocument().componentOwner(componentId); }
  validateTransactionOperations(operations: readonly GameDocumentOperationV2[]): void { this.requireDocument().validateOperations(operations); }
  async readControlledAsset(relativePath: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertActive();
    throwIfAborted(signal);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 * 1024) throw new ProjectPathError('project-asset-budget-invalid', 'Controlled asset read budget is invalid.');
    const draft = this.draftTextures.get(relativePath);
    if (draft) {
      if (draft.byteLength > maxBytes) throw new ProjectPathError('project-asset-source-budget', 'Generated texture exceeds the requested read budget.');
      return new Uint8Array(draft);
    }
    const bytes = await this.requireRepository().readControlledAsset(relativePath, maxBytes);
    throwIfAborted(signal);
    return bytes;
  }

  async newProject(selectedRoot: string | null, name: string): Promise<ProjectWorkspaceSnapshot> {
    return this.serialize(async () => {
      this.assertActive();
      if (!name.trim() || name.length > 80) throw new TypeError('Project name must contain 1-80 characters.');
      const repository = selectedRoot ? await ProjectRepository.open(selectedRoot) : null;
      this.migration = null;
      const projectId = asStableId(`project:${randomUUID()}`);
      const documentId = asStableId(`document:${randomUUID()}`);
      await this.resources.operationLog.append({
        kind: 'project/create-requested', severity: 'info', source: asStableId('studio.project'),
        correlation: { projectId, documentId }, payload: { name: name.trim() },
      });
      const document = new ProjectDocument(projectId, name.trim(), documentId, {}, 1, 0, this.componentRegistry);
      await this.replaceDocument(repository, document);
      if (repository) await this.remember(repository.root);
      await this.resources.operationLog.append({
        kind: 'project/created', severity: 'info', source: asStableId('studio.project'),
        correlation: { projectId, documentId }, payload: { revision: 1 },
      });
      return this.snapshot();
    });
  }

  async openProject(selectedRoot: string): Promise<ProjectWorkspaceSnapshot> {
    return this.serialize(async () => {
      this.assertActive();
      const repository = await ProjectRepository.open(selectedRoot);
      const loaded = await repository.readWithMigration(this.componentRegistry); const value = loaded.file; this.migration = loaded.migration;
      await this.resources.operationLog.append({
        kind: 'project/open-requested', severity: 'info', source: asStableId('studio.project'),
        correlation: { projectId: value.projectId, documentId: asStableId(value.document.id, 'document id') }, payload: {},
      });
      const document = ProjectDocument.fromFile(value, this.componentRegistry);
      await this.replaceDocument(repository, document);
      await this.remember(repository.root);
      await this.resources.operationLog.append({
        kind: 'project/opened', severity: 'info', source: asStableId('studio.project'),
        correlation: { projectId: value.projectId, documentId: asStableId(value.document.id, 'document id') }, payload: { revision: value.document.revision },
      });
      if (loaded.migration) await this.resources.operationLog.append({ kind: 'project/migrated', severity: 'info', source: asStableId('studio.project'), correlation: { projectId: value.projectId, documentId: asStableId(value.document.id, 'document id') }, payload: { reportId: loaded.migration.id, fromVersion: 1, toVersion: 2, sourceDigest: loaded.migration.sourceDigest, resultDigest: loaded.migration.resultDigest, entities: loaded.migration.entities, components: loaded.migration.components, scripts: loaded.migration.scripts } });
      return this.snapshot();
    });
  }

  async reopen(): Promise<ProjectWorkspaceSnapshot> {
    const root = this.repository?.root;
    if (!root) throw new Error('No project is open.');
    return this.openProject(root);
  }

  async execute(input: ProjectCommandInput, signal?: AbortSignal): Promise<ProjectWorkspaceSnapshot> {
    const operations = input.key === 'script.resources' ? legacyScriptOperations(this.requireDocument().scriptsSnapshot(), input.value) : [{ op: 'setting.set', key: input.key, value: input.value } as const];
    return this.executeBatch({ id: input.id, label: input.label, baseRevision: input.baseRevision, operations, ...(input.transactionId ? { transactionId: input.transactionId } : {}) }, signal);
  }

  async executeBatch(input: ProjectBatchCommandInput, signal?: AbortSignal): Promise<ProjectWorkspaceSnapshot> {
    return this.serialize(() => this.executeBatchNow(input, signal));
  }

  async importGeneratedTexture(input: Readonly<{ id: StableId; documentId: StableId; baseRevision: number; bytes: Uint8Array; width: number; height: number; recipeDigest: string }>, signal?: AbortSignal): Promise<Readonly<{ revision: number; asset: ControlledAssetManifestEntry }>> {
    return this.serialize(async () => {
      this.assertActive(); throwIfAborted(signal);
      const document = this.requireDocument();
      if (document.documentId !== input.documentId) throw new Error('Generated texture belongs to a different project document.');
      assertBaseRevision(document, input.baseRevision);
      if (!/^sha256:[a-f0-9]{64}$/u.test(input.recipeDigest)) throw new TypeError('Texture recipe digest is invalid.');
      if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.height < 1 || input.width > 2048 || input.height > 2048) throw new TypeError('Texture dimensions must be 1..2048.');
      const bytes = new Uint8Array(input.bytes);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const catalog = ControlledAssetCatalog.fromManifest(document.gameSnapshot().settings[CONTROLLED_ASSET_CATALOG_SETTING_KEY]);
      const asset = catalog.import({ projectPath: `assets/generated/${digest}.png`, bytes, kind: 'texture', mimeType: 'image/png', license: 'project-owned', provenance: `Canvas 2D recipe v1 ${input.recipeDigest}`, width: input.width, height: input.height, decodedBytes: Math.max(bytes.byteLength, input.width * input.height * 4) });
      const staged = this.repository ? await this.repository.stageGeneratedTexture(bytes, signal) : this.stageDraftTexture(asset.projectPath, bytes);
      try {
        this.assertActive(); throwIfAborted(signal);
        const result = await this.executeBatchNow({ id: input.id, label: 'Draw PNG Texture', baseRevision: input.baseRevision, operations: [
          { op: 'asset.upsert', asset: { id: asset.id, kind: asset.kind, digest: asset.digest, source: 'project' } },
          { op: 'setting.set', key: CONTROLLED_ASSET_CATALOG_SETTING_KEY, value: catalog.settingValue() },
        ] }, signal);
        return Object.freeze({ revision: result.document!.revision, asset });
      } catch (cause) {
        // A post-commit audit error must not remove bytes referenced by the committed document.
        if (document.revision === input.baseRevision) await staged.rollback();
        throw cause;
      }
    });
  }

  private stageDraftTexture(projectPath: string, bytes: Uint8Array): Readonly<{ rollback(): Promise<void> }> {
    if (bytes.byteLength < 1 || bytes.byteLength > 20 * 1024 * 1024) throw new ProjectPathError('texture.source-budget', 'Generated PNG exceeds the texture byte budget.');
    const existing = this.draftTextures.has(projectPath);
    if (!existing) {
      if (this.draftTextureBytes + bytes.byteLength > 64 * 1024 * 1024) throw new ProjectPathError('texture.draft-budget', 'Save the project to persist generated textures before creating more.');
      this.draftTextures.set(projectPath, bytes);
      this.draftTextureBytes += bytes.byteLength;
    }
    return { rollback: async () => {
      if (!existing && this.draftTextures.delete(projectPath)) this.draftTextureBytes -= bytes.byteLength;
    } };
  }

  private async executeBatchNow(input: ProjectBatchCommandInput, signal?: AbortSignal): Promise<ProjectWorkspaceSnapshot> {
    this.assertActive();
    throwIfAborted(signal);
    const document = this.requireDocument();
    assertBaseRevision(document, input.baseRevision);
    validateCommand(input);
    const requested = await this.resources.operationLog.append({
      kind: 'document/command-requested', severity: 'info', source: asStableId('studio.document'),
      correlation: commandCorrelation(document, input),
      payload: { label: input.label, baseRevision: input.baseRevision, operationCount: input.operations.length, operationKinds: [...new Set(input.operations.map((operation) => operation.op))] },
    }, { signal });
    throwIfAborted(signal);
    let latest: GameDocumentDeltaV2 | undefined;
    const command: EditorCommand = {
      label: input.label,
      estimatedBytes: JSON.stringify(input.operations).length,
      execute: () => { latest = document.apply(input.transactionId ?? input.id, input.operations); this.emitMutation(Object.freeze({ kind: 'delta', delta: latest })); return true; },
      undo: () => { if (!latest) throw new Error('Document command has no inverse.'); latest = document.apply(asStableId(`transaction:undo:${randomUUID()}`), latest.inverse); this.emitMutation(Object.freeze({ kind: 'delta', delta: latest })); },
      redo: () => { latest = document.apply(asStableId(`transaction:redo:${randomUUID()}`), input.operations); this.emitMutation(Object.freeze({ kind: 'delta', delta: latest })); return true; },
    };
    this.mutationProvenanceOpIds = Object.freeze([requested.eventId]);
    try {
      if (!this.resources.history.execute(command)) throw new Error('Command reported no change.');
    } catch (cause) {
      await this.resources.operationLog.append({
        kind: 'document/command-failed', severity: 'error', source: asStableId('studio.document'),
        correlation: commandCorrelation(document, input), payload: { message: errorMessage(cause) },
      }).catch(() => {});
      throw cause;
    } finally {
      this.mutationProvenanceOpIds = Object.freeze([]);
    }
    this.resources.projectSession.updateDocumentRevision(document.revision);
    await this.resources.operationLog.append({
      kind: 'document/command-committed', severity: 'info', source: asStableId('studio.document'),
      correlation: commandCorrelation(document, input), payload: { revision: document.revision, historyLabel: input.label, operationCount: input.operations.length, metrics: latest?.metrics ?? null },
    });
    this.emit();
    return this.snapshot();
  }

  async executeTransaction(input: ProjectTransactionInput, signal?: AbortSignal): Promise<ProjectTransactionCommit> {
    return this.serialize(async () => {
      this.assertActive();
      throwIfAborted(signal);
      validateCommand(input);
      validateTransaction(input);
      const document = this.requireDocument();
      const operationDigest = digestOperations(input.operations);
      const memberNodeIds = Object.freeze([...(input.memberNodeIds ?? [])]);
      const memberDigest = digestMembers(memberNodeIds);
      const existing = await this.readTransactionReceipt(input.transactionId);
      if (existing) {
        assertReceiptMatches(existing, input, document.documentId, operationDigest, memberDigest);
        return Object.freeze({ snapshot: this.snapshot(), receipt: existing, replayed: true });
      }
      const existingIdempotency = await this.findTransactionReceiptByIdempotencyKey(input.idempotencyKey);
      if (existingIdempotency) throw new OperationLogError('transaction-idempotency-conflict', `Idempotency key ${input.idempotencyKey} is already committed by transaction ${existingIdempotency.transactionId}.`);
      assertBaseRevision(document, input.baseRevision);
      const requested = await this.resources.operationLog.append({
        kind: 'document/transaction-requested', severity: 'info', source: asStableId('studio.document'),
        correlation: commandCorrelation(document, input),
        payload: { label: input.label, baseRevision: input.baseRevision, operationCount: input.operations.length, operationKinds: [...new Set(input.operations.map((operation) => operation.op))], idempotencyKey: input.idempotencyKey, operationDigest, memberDigest, memberNodeIds },
      }, { signal });
      throwIfAborted(signal);
      await this.resources.transactionFaultInjector?.('before-history-write', input.transactionId);
      let latest: GameDocumentDeltaV2 | undefined;
      const command: EditorCommand = {
        label: input.label,
        estimatedBytes: JSON.stringify(input.operations).length,
        execute: () => { latest = document.apply(input.transactionId, input.operations); this.emitMutation(Object.freeze({ kind: 'delta', delta: latest })); return true; },
        undo: () => { if (!latest) throw new Error('Document transaction has no inverse.'); latest = document.apply(asStableId(`transaction:undo:${randomUUID()}`), latest.inverse); this.emitMutation(Object.freeze({ kind: 'delta', delta: latest })); },
        redo: () => { latest = document.apply(asStableId(`transaction:redo:${randomUUID()}`), input.operations); this.emitMutation(Object.freeze({ kind: 'delta', delta: latest })); return true; },
      };
      this.mutationProvenanceOpIds = Object.freeze([requested.eventId]);
      try {
        if (!this.resources.history.execute(command)) throw new Error('Transaction command reported no change.');
      } catch (cause) {
        await this.resources.operationLog.append({
          kind: 'document/transaction-failed', severity: 'error', source: asStableId('studio.document'),
          correlation: commandCorrelation(document, input), payload: { message: errorMessage(cause), idempotencyKey: input.idempotencyKey, operationDigest, phase: 'history-write' },
        }).catch(() => {});
        throw cause;
      } finally {
        this.mutationProvenanceOpIds = Object.freeze([]);
      }
      this.resources.projectSession.updateDocumentRevision(document.revision);
      await this.resources.transactionFaultInjector?.('after-history-write', input.transactionId);
      const historyEntry = this.resources.history.snapshot().entries.at(-1);
      if (!historyEntry) throw new Error('Committed transaction is missing its History entry.');
      if (!latest) throw new Error('Committed transaction is missing its Scene diff.');
      const sceneDiffArtifact = await this.resources.operationLog.putArtifact(latest as unknown as JsonValue, { schemaVersion: 'project-scene-diff/2' });
      const committedAt = new Date().toISOString();
      const receiptBase = Object.freeze({
        schemaVersion: 1 as const, transactionId: input.transactionId, idempotencyKey: input.idempotencyKey,
        projectId: document.projectId, documentId: document.documentId, commandId: input.id,
        baseRevision: input.baseRevision, beforeRevision: latest?.beforeRevision ?? input.baseRevision, afterRevision: document.revision,
        operationDigest, memberDigest, memberNodeIds, historyEntryId: historyEntry.id, historyLabel: input.label, committedAt,
        sceneDiffTransactionId: asStableId(latest.transactionId), sceneDiffArtifactId: sceneDiffArtifact.id, resultArtifactIds: Object.freeze([sceneDiffArtifact.id]),
      });
      const receiptDigest = prefixedDigest(sha256(canonicalStringify(receiptBase as unknown as JsonValue)));
      const artifact = await this.resources.operationLog.putArtifact(Object.freeze({ ...receiptBase, receiptDigest }) as unknown as JsonValue, { schemaVersion: 'project-transaction-receipt/1' });
      await this.resources.operationLog.append({
        kind: 'document/transaction-receipt-written', severity: 'info', source: asStableId('studio.document'),
        correlation: commandCorrelation(document, input), artifactRefs: [artifact.id, sceneDiffArtifact.id],
        payload: { revision: document.revision, beforeRevision: latest.beforeRevision, historyEntryId: historyEntry.id, idempotencyKey: input.idempotencyKey, operationDigest, memberDigest, receiptDigest, receiptArtifactId: artifact.id, sceneDiffTransactionId: latest.transactionId, sceneDiffArtifactId: sceneDiffArtifact.id, resultArtifactIds: [sceneDiffArtifact.id] },
      });
      await this.resources.transactionFaultInjector?.('after-receipt-write', input.transactionId);
      const receipt: ProjectTransactionReceipt = Object.freeze({ ...receiptBase, receiptDigest, artifactId: artifact.id });
      await this.resources.operationLog.append({
        kind: 'document/transaction-committed', severity: 'info', source: asStableId('studio.document'),
        correlation: commandCorrelation(document, input), artifactRefs: [artifact.id, sceneDiffArtifact.id],
        payload: { revision: document.revision, beforeRevision: latest.beforeRevision, historyLabel: input.label, historyEntryId: historyEntry.id, operationCount: input.operations.length, idempotencyKey: input.idempotencyKey, operationDigest, memberDigest, receiptDigest, receiptArtifactId: artifact.id, sceneDiffTransactionId: latest.transactionId, sceneDiffArtifactId: sceneDiffArtifact.id, resultArtifactIds: [sceneDiffArtifact.id], metrics: latest.metrics ?? null },
      });
      await this.resources.transactionFaultInjector?.('after-commit-event', input.transactionId);
      this.emit();
      return Object.freeze({ snapshot: this.snapshot(), receipt, replayed: false });
    });
  }

  async reconcileTransaction(input: Pick<ProjectTransactionInput, 'transactionId' | 'idempotencyKey' | 'baseRevision' | 'operations' | 'memberNodeIds'>): Promise<ProjectTransactionReconciliation> {
    this.assertActive();
    const document = this.requireDocument();
    const operationDigest = digestOperations(input.operations);
    const memberDigest = digestMembers(input.memberNodeIds ?? []);
    const receipt = await this.readTransactionReceipt(input.transactionId);
    if (receipt) {
      assertReceiptMatches(receipt, input, document.documentId, operationDigest, memberDigest);
      return Object.freeze({ status: 'committed', receipt });
    }
    const existingIdempotency = await this.findTransactionReceiptByIdempotencyKey(input.idempotencyKey);
    if (existingIdempotency) throw new OperationLogError('transaction-idempotency-conflict', `Idempotency key ${input.idempotencyKey} is already committed by transaction ${existingIdempotency.transactionId}.`);
    if (document.revision === input.baseRevision) return Object.freeze({ status: 'not-committed', documentId: document.documentId, revision: document.revision });
    return Object.freeze({ status: 'ambiguous', documentId: document.documentId, revision: document.revision, reason: `Document advanced from base revision ${input.baseRevision} without a matching durable transaction receipt.` });
  }

  async reconcileTransactionIdentity(input: ProjectTransactionIdentity): Promise<ProjectTransactionReconciliation> {
    this.assertActive();
    const document = this.requireDocument();
    const receipt = await this.readTransactionReceipt(input.transactionId);
    if (receipt) {
      if (receipt.idempotencyKey !== input.idempotencyKey || receipt.documentId !== document.documentId || receipt.baseRevision !== input.baseRevision || receipt.operationDigest !== input.operationDigest || (input.memberDigest !== undefined && receipt.memberDigest !== input.memberDigest)) throw new OperationLogError('transaction-idempotency-conflict', `Transaction ${input.transactionId} was already used with different recovery coordinates.`);
      return Object.freeze({ status: 'committed', receipt });
    }
    const existingIdempotency = await this.findTransactionReceiptByIdempotencyKey(input.idempotencyKey);
    if (existingIdempotency) throw new OperationLogError('transaction-idempotency-conflict', `Idempotency key ${input.idempotencyKey} is already committed by transaction ${existingIdempotency.transactionId}.`);
    if (document.revision === input.baseRevision) return Object.freeze({ status: 'not-committed', documentId: document.documentId, revision: document.revision });
    return Object.freeze({ status: 'ambiguous', documentId: document.documentId, revision: document.revision, reason: `Document advanced from base revision ${input.baseRevision} without a matching durable transaction receipt.` });
  }

  async reconcileTransactionMember(memberNodeId: StableId, baseRevision: number): Promise<ProjectTransactionReconciliation> {
    this.assertActive();
    const document = this.requireDocument();
    const matches: ProjectTransactionReceipt[] = [];
    for await (const event of this.transactionReceiptEvents()) {
      const artifactId = event.artifactRefs[0]; if (!artifactId) continue;
      const receipt = parseTransactionReceipt((await this.resources.operationLog.readArtifact(artifactId)).value, artifactId);
      if (receipt.sceneDiffArtifactId) assertSceneDiffMatchesReceipt((await this.resources.operationLog.readArtifact(receipt.sceneDiffArtifactId)).value, receipt);
      if (receipt.memberNodeIds.includes(memberNodeId) && !matches.some((candidate) => candidate.artifactId === receipt.artifactId)) matches.push(receipt);
      if (matches.length > 1) break;
    }
    if (matches.length === 1) {
      const receipt = matches[0]!;
      if (receipt.documentId !== document.documentId || receipt.baseRevision !== baseRevision) return Object.freeze({ status: 'ambiguous', documentId: document.documentId, revision: document.revision, reason: `Member ${memberNodeId} matched a receipt with different document or base revision coordinates.` });
      return Object.freeze({ status: 'committed', receipt });
    }
    if (matches.length > 1) return Object.freeze({ status: 'ambiguous', documentId: document.documentId, revision: document.revision, reason: `Member ${memberNodeId} matched multiple durable transaction receipts.` });
    if (document.revision === baseRevision) return Object.freeze({ status: 'not-committed', documentId: document.documentId, revision: document.revision });
    return Object.freeze({ status: 'ambiguous', documentId: document.documentId, revision: document.revision, reason: `Document advanced from base revision ${baseRevision} without a receipt containing member ${memberNodeId}.` });
  }

  async beginGroup(label: string, transactionId: StableId): Promise<void> {
    return this.serialize(async () => {
      const document = this.requireDocument();
      await this.resources.operationLog.append({
        kind: 'history/group-started', severity: 'info', source: asStableId('studio.history'),
        correlation: { projectId: document.projectId, documentId: document.documentId, transactionId }, payload: { label },
      });
      this.resources.history.beginGroup(label);
    });
  }

  async endGroup(transactionId: StableId): Promise<void> {
    return this.serialize(async () => {
      const document = this.requireDocument();
      this.resources.history.endGroup();
      await this.resources.operationLog.append({
        kind: 'history/group-committed', severity: 'info', source: asStableId('studio.history'),
        correlation: { projectId: document.projectId, documentId: document.documentId, transactionId }, payload: { revision: document.revision },
      });
      this.emit();
    });
  }

  async cancelGroup(transactionId: StableId): Promise<void> {
    return this.serialize(async () => {
      const document = this.requireDocument();
      this.resources.history.cancelGroup();
      this.resources.projectSession.updateDocumentRevision(document.revision);
      await this.resources.operationLog.append({
        kind: 'history/group-cancelled', severity: 'warning', source: asStableId('studio.history'),
        correlation: { projectId: document.projectId, documentId: document.documentId, transactionId }, payload: { revision: document.revision },
      });
      this.emit();
    });
  }

  async undo(baseRevision: number, id = asStableId(`command:undo:${randomUUID()}`)): Promise<ProjectWorkspaceSnapshot> {
    return this.historyMove('undo', baseRevision, id);
  }

  async redo(baseRevision: number, id = asStableId(`command:redo:${randomUUID()}`)): Promise<ProjectWorkspaceSnapshot> {
    return this.historyMove('redo', baseRevision, id);
  }

  async save(): Promise<ProjectWorkspaceSnapshot> {
    return this.serialize(async () => {
      this.assertActive();
      const document = this.requireDocument();
      const repository = this.requireRepository();
      return this.persist(repository, document);
    });
  }

  async saveAs(selectedRoot: string): Promise<ProjectWorkspaceSnapshot> {
    return this.serialize(async () => {
      this.assertActive();
      const document = this.requireDocument();
      const repository = await ProjectRepository.open(selectedRoot);
      const result = await this.persist(repository, document);
      await this.remember(repository.root);
      return result;
    });
  }

  private async persist(repository: ProjectRepository, document: ProjectDocument): Promise<ProjectWorkspaceSnapshot> {
    await this.resources.operationLog.append({
      kind: 'project/save-requested', severity: 'info', source: asStableId('studio.project'),
      correlation: { projectId: document.projectId, documentId: document.documentId }, payload: { revision: document.revision },
    });
    const staged: Readonly<{ rollback(): Promise<void> }>[] = [];
    try {
      // Include undone assets: their History entries can still be redone after saving.
      for (const bytes of this.draftTextures.values()) staged.push(await repository.stageGeneratedTexture(bytes));
      await repository.save(document.serializeForSave());
    } catch (cause) {
      for (const entry of staged.reverse()) await entry.rollback();
      throw cause;
    }
    this.repository = repository;
    this.draftTextures.clear();
    this.draftTextureBytes = 0;
    document.markSaved();
    this.resources.projectSession.markSaved(document.revision);
    await this.resources.operationLog.append({
      kind: 'project/saved', severity: 'info', source: asStableId('studio.project'),
      correlation: { projectId: document.projectId, documentId: document.documentId }, payload: { revision: document.revision },
    });
    this.emit();
    return this.snapshot();
  }

  cancelAll(): void {
    this.resources.tasks.cancelAll();
  }

  async closeProject(): Promise<void> {
    return this.serialize(async () => {
      if (!this.document) return;
      const document = this.document;
      await this.resources.operationLog.append({
        kind: 'project/closed', severity: 'info', source: asStableId('studio.project'),
        correlation: { projectId: document.projectId, documentId: document.documentId }, payload: { dirty: document.revision !== document.savedRevision },
      });
      await this.detachDocument();
      this.repository = null;
      this.migration = null;
      this.emit();
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.resources.tasks.cancelAll();
    await this.mutationTail;
    await this.detachDocument();
    this.listeners.clear();
    this.mutationListeners.clear();
    this.disposed = true;
  }

  private async historyMove(kind: 'undo' | 'redo', baseRevision: number, id: StableId): Promise<ProjectWorkspaceSnapshot> {
    return this.serialize(async () => {
      const document = this.requireDocument();
      assertBaseRevision(document, baseRevision);
      const requested = await this.resources.operationLog.append({
        kind: `history/${kind}-requested`, severity: 'info', source: asStableId('studio.history'),
        correlation: { projectId: document.projectId, documentId: document.documentId, commandId: id }, payload: { baseRevision },
      });
      this.mutationProvenanceOpIds = Object.freeze([requested.eventId]);
      let changed = false;
      try { changed = kind === 'undo' ? this.resources.history.undo() : this.resources.history.redo(); }
      finally { this.mutationProvenanceOpIds = Object.freeze([]); }
      if (!changed) throw new Error(`Nothing to ${kind}.`);
      this.resources.projectSession.updateDocumentRevision(document.revision);
      await this.resources.operationLog.append({
        kind: `history/${kind}-committed`, severity: 'info', source: asStableId('studio.history'),
        correlation: { projectId: document.projectId, documentId: document.documentId, commandId: id }, payload: { revision: document.revision },
      });
      this.emit();
      return this.snapshot();
    });
  }

  private async replaceDocument(repository: ProjectRepository | null, document: ProjectDocument): Promise<void> {
    this.resources.tasks.cancelAll();
    await this.detachDocument();
    this.resources.history.clear();
    this.repository = repository;
    this.document = document;
    this.resources.documents.attach(document, true);
    this.resources.projectSession.open(document.projectId, document.name, document.revision);
    if (document.savedRevision === document.revision) this.resources.projectSession.markSaved(document.revision);
    this.sceneContext.reset(document.gameSnapshot());
    this.emitMutation(Object.freeze({ kind: 'replace', documentId: document.documentId, revision: document.revision }));
    this.emit();
  }

  private async detachDocument(): Promise<void> {
    if (!this.document) return;
    const id = this.document.documentId;
    this.resources.tasks.cancelAll();
    this.resources.history.clear();
    await this.resources.documents.close(id);
    this.document = null;
    this.draftTextures.clear();
    this.draftTextureBytes = 0;
    this.sceneContext.reset(null);
    this.emitMutation(Object.freeze({ kind: 'replace', documentId: null, revision: 0 }));
  }

  private async remember(root: string): Promise<void> {
    const recent = await this.resources.recentProjects.load();
    await this.resources.recentProjects.save([root, ...recent.filter((entry) => entry !== root)]);
  }

  private async readTransactionReceipt(transactionId: StableId): Promise<ProjectTransactionReceipt | null> {
    const ids = new Set<StableId>(); let found = false;
    for await (const event of this.transactionReceiptEvents(transactionId)) {
      found = true;
      if (!event.artifactRefs[0]) throw new OperationLogError('transaction-receipt-duplicate', `Transaction ${transactionId} is missing a receipt artifact.`);
      ids.add(event.artifactRefs[0]);
      if (ids.size > 1) break;
    }
    if (!found) return null;
    const artifactIds = [...ids];
    if (artifactIds.length !== 1) throw new OperationLogError('transaction-receipt-duplicate', `Transaction ${transactionId} has missing or conflicting receipt artifacts.`);
    const artifactId = artifactIds[0]!;
    const artifact = await this.resources.operationLog.readArtifact(artifactId);
    const receipt = parseTransactionReceipt(artifact.value, artifactId);
    if (receipt.sceneDiffArtifactId) {
      const sceneDiff = await this.resources.operationLog.readArtifact(receipt.sceneDiffArtifactId);
      assertSceneDiffMatchesReceipt(sceneDiff.value, receipt);
    }
    return receipt;
  }

  private async findTransactionReceiptByIdempotencyKey(idempotencyKey: StableId): Promise<ProjectTransactionReceipt | null> {
    const seen = new Set<StableId>();
    for await (const event of this.transactionReceiptEvents()) {
      const artifactId = event.artifactRefs[0]; if (!artifactId || seen.has(artifactId)) continue;
      seen.add(artifactId);
      const receipt = parseTransactionReceipt((await this.resources.operationLog.readArtifact(artifactId)).value, artifactId);
      if (receipt.sceneDiffArtifactId) assertSceneDiffMatchesReceipt((await this.resources.operationLog.readArtifact(receipt.sceneDiffArtifactId)).value, receipt);
      if (receipt.idempotencyKey === idempotencyKey) return receipt;
    }
    return null;
  }

  /** A result limit does not bound the journal scan. Walk a fixed retained prefix
   * in sequence windows, including empty windows, without dropping old receipts. */
  private async *transactionReceiptEvents(transactionId?: StableId): AsyncGenerator<DurableOperationEvent> {
    const log = this.resources.operationLog;
    const status = log.status();
    const { projectId, documentId } = this.requireDocument();
    let start = status.retainedFromSequence; let windowSize = 5_000;
    while (start < status.nextSequence) {
      const end = Math.min(status.nextSequence, start + windowSize);
      let cursor: string | undefined;
      try {
        do {
          const page = await log.query({ projectId, documentId, kinds: ['document/transaction-receipt-written', 'document/transaction-committed'],
            ...(transactionId ? { transactionId } : {}), ...(start > 0 ? { afterSequence: start - 1 } : {}), beforeSequence: end,
            limit: 200, traverseCorrelation: false, ...(cursor ? { cursor } : {}) });
          for (const event of page.events) yield event;
          cursor = page.nextCursor;
        } while (cursor);
      } catch (cause) {
        if (!(cause instanceof OperationLogError) || cause.code !== 'query-scan-budget-exceeded' || windowSize === 1) throw cause;
        windowSize = Math.max(1, Math.floor(windowSize / 2)); continue;
      }
      start = end;
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (cause: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    this.mutationTail = this.mutationTail.then(async () => {
      try { resolveResult(await operation()); }
      catch (cause) { rejectResult(cause); }
    });
    return result;
  }

  private emit(): void { const snapshot = this.snapshot(); for (const listener of [...this.listeners]) listener(snapshot); }
  private emitMutation(value: ProjectDocumentMutation): void {
    if (value.kind === 'delta' && this.document) this.sceneContext.record({ delta: value.delta, target: this.document.gameSnapshot(), provenanceOpIds: this.mutationProvenanceOpIds });
    for (const listener of [...this.mutationListeners]) listener(value);
  }
  private requireDocument(): ProjectDocument { this.assertActive(); if (!this.document) throw new Error('No project document is open.'); return this.document; }
  private requireRepository(): ProjectRepository { if (!this.repository) throw new Error('No project repository is open.'); return this.repository; }
  private assertActive(): void { if (this.disposed) throw new Error('Project workspace is disposed.'); }
}

function validateCommand(input: ProjectBatchCommandInput): void {
  if (!input.label.trim() || input.label.length > 120) throw new TypeError('Command label must contain 1-120 characters.');
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) throw new TypeError('Command base revision is invalid.');
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 1_000) throw new TypeError('Command operations must contain 1-1000 entries.');
  JSON.stringify(input.operations);
}

function validateTransaction(input: ProjectTransactionInput): void {
  if (!input.transactionId || !input.idempotencyKey) throw new TypeError('Transaction and idempotency identities are required.');
  if (input.memberNodeIds && (input.memberNodeIds.length > 1_000 || new Set(input.memberNodeIds).size !== input.memberNodeIds.length)) throw new TypeError('Transaction member node ids must be unique and bounded.');
}

function digestOperations(operations: readonly GameDocumentOperationV2[]): `sha256:${string}` {
  return prefixedDigest(sha256(canonicalStringify(operations as unknown as JsonValue)));
}

function digestMembers(memberNodeIds: readonly StableId[]): `sha256:${string}` {
  return prefixedDigest(sha256(canonicalStringify([...memberNodeIds] as unknown as JsonValue)));
}

function assertReceiptMatches(receipt: ProjectTransactionReceipt, input: Pick<ProjectTransactionInput, 'transactionId' | 'idempotencyKey' | 'baseRevision'>, documentId: StableId, operationDigest: `sha256:${string}`, memberDigest: `sha256:${string}`): void {
  if (receipt.transactionId !== input.transactionId || receipt.idempotencyKey !== input.idempotencyKey || receipt.documentId !== documentId || receipt.baseRevision !== input.baseRevision || receipt.operationDigest !== operationDigest || receipt.memberDigest !== memberDigest) {
    throw new OperationLogError('transaction-idempotency-conflict', `Transaction ${input.transactionId} was already used with different coordinates or operations.`);
  }
}

function parseTransactionReceipt(value: JsonValue, artifactId: StableId): ProjectTransactionReceipt {
  if (!isRecord(value) || value.schemaVersion !== 1
    || typeof value.transactionId !== 'string' || typeof value.idempotencyKey !== 'string'
    || typeof value.projectId !== 'string' || typeof value.documentId !== 'string' || typeof value.commandId !== 'string'
    || !Number.isSafeInteger(value.baseRevision) || !Number.isSafeInteger(value.beforeRevision) || !Number.isSafeInteger(value.afterRevision)
    || typeof value.operationDigest !== 'string' || typeof value.memberDigest !== 'string' || typeof value.receiptDigest !== 'string'
    || !Array.isArray(value.memberNodeIds) || !value.memberNodeIds.every((entry) => typeof entry === 'string')
    || !Number.isSafeInteger(value.historyEntryId) || typeof value.historyLabel !== 'string' || typeof value.committedAt !== 'string') {
    throw new OperationLogError('transaction-receipt-invalid', 'Transaction receipt artifact is invalid.');
  }
  const transactionId = asStableId(value.transactionId, 'transaction id');
  const idempotencyKey = asStableId(value.idempotencyKey, 'idempotency key');
  const projectId = asStableId(value.projectId, 'project id');
  const documentId = asStableId(value.documentId, 'document id');
  const commandId = asStableId(value.commandId, 'command id');
  const memberNodeIds = Object.freeze(value.memberNodeIds.map((entry) => asStableId(entry as string, 'member node id')));
  const operationDigest = digestValue(value.operationDigest, 'operation digest');
  const memberDigest = digestValue(value.memberDigest, 'member digest');
  const receiptDigest = digestValue(value.receiptDigest, 'receipt digest');
  const legacyReceiptBase = Object.freeze({
    schemaVersion: 1 as const, transactionId, idempotencyKey, projectId, documentId, commandId,
    baseRevision: value.baseRevision as number, beforeRevision: value.beforeRevision as number, afterRevision: value.afterRevision as number,
    operationDigest, memberDigest, memberNodeIds, historyEntryId: value.historyEntryId as number,
    historyLabel: value.historyLabel, committedAt: value.committedAt,
  });
  const hasSceneDiff = value.sceneDiffTransactionId !== undefined || value.sceneDiffArtifactId !== undefined || value.resultArtifactIds !== undefined;
  if (hasSceneDiff && (typeof value.sceneDiffTransactionId !== 'string' || typeof value.sceneDiffArtifactId !== 'string' || !Array.isArray(value.resultArtifactIds) || !value.resultArtifactIds.every((entry) => typeof entry === 'string'))) throw new OperationLogError('transaction-receipt-invalid', `Transaction ${transactionId} Scene diff references are invalid.`);
  const sceneDiffTransactionId = hasSceneDiff ? asStableId(value.sceneDiffTransactionId as string, 'Scene diff transaction id') : null;
  const sceneDiffArtifactId = hasSceneDiff ? asStableId(value.sceneDiffArtifactId as string, 'Scene diff artifact id') : null;
  const resultArtifactIds = Object.freeze(hasSceneDiff ? (value.resultArtifactIds as string[]).map((entry) => asStableId(entry, 'result artifact id')) : []);
  if (sceneDiffTransactionId && sceneDiffTransactionId !== transactionId) throw new OperationLogError('transaction-receipt-invalid', `Transaction ${transactionId} Scene diff identity does not match.`);
  if (sceneDiffArtifactId && !resultArtifactIds.includes(sceneDiffArtifactId)) throw new OperationLogError('transaction-receipt-invalid', `Transaction ${transactionId} Scene diff artifact is not retained as a result.`);
  const receiptBase = hasSceneDiff ? Object.freeze({ ...legacyReceiptBase, sceneDiffTransactionId, sceneDiffArtifactId, resultArtifactIds }) : legacyReceiptBase;
  const expected = prefixedDigest(sha256(canonicalStringify(receiptBase as unknown as JsonValue)));
  if (receiptDigest !== expected) throw new OperationLogError('transaction-receipt-invalid', `Transaction ${transactionId} receipt digest is invalid.`);
  return Object.freeze({ ...legacyReceiptBase, sceneDiffTransactionId, sceneDiffArtifactId, resultArtifactIds, receiptDigest, artifactId });
}

function assertSceneDiffMatchesReceipt(value: JsonValue, receipt: ProjectTransactionReceipt): void {
  if (!isRecord(value) || value.schemaVersion !== 2 || value.transactionId !== receipt.transactionId || value.documentId !== receipt.documentId || value.beforeRevision !== receipt.beforeRevision || value.afterRevision !== receipt.afterRevision) {
    throw new OperationLogError('transaction-receipt-invalid', `Transaction ${receipt.transactionId} Scene diff artifact does not match its receipt.`);
  }
}

function digestValue(value: string, label: string): `sha256:${string}` {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new OperationLogError('transaction-receipt-invalid', `${label} is invalid.`);
  return value as `sha256:${string}`;
}

function prefixedDigest(value: string): `sha256:${string}` { return (value.startsWith('sha256:') ? value : `sha256:${value}`) as `sha256:${string}`; }

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

function assertBaseRevision(document: ProjectDocument, baseRevision: number): void {
  if (document.revision !== baseRevision) {
    throw new ProjectRevisionError(document.revision, baseRevision);
  }
}

function commandCorrelation(document: ProjectDocument, input: Pick<ProjectBatchCommandInput, 'id' | 'transactionId'>) {
  return Object.freeze({
    projectId: document.projectId,
    documentId: document.documentId,
    commandId: input.id,
    transactionId: input.transactionId,
  });
}

export class ProjectRevisionError extends Error {
  readonly code = 'stale-project-revision';
  constructor(readonly actualRevision: number, readonly baseRevision: number) {
    super(`Project revision is ${actualRevision}; command expected ${baseRevision}.`);
    this.name = 'ProjectRevisionError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OperationLogError('command-cancelled', 'Project command was cancelled.', { cause: signal.reason });
}
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function legacyScriptOperations(scripts: GameDocumentV2['scripts'], value: JsonValue): readonly GameDocumentOperationV2[] {
  if (!Array.isArray(value)) throw new TypeError('Script resources must be an array.');
  const nextIds = new Set<string>(); const operations: GameDocumentOperationV2[] = [];
  for (const [order, item] of value.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Script resource must be an object.'); const raw = item as Record<string, JsonValue>;
    if (typeof raw.id !== 'string' || typeof raw.entityId !== 'string' || typeof raw.name !== 'string' || typeof raw.sourcePath !== 'string' || typeof raw.text !== 'string' || !Number.isSafeInteger(raw.textRevision) || !Array.isArray(raw.capabilities) || !raw.capabilities.every((entry) => typeof entry === 'string')) throw new TypeError('Script resource is invalid.');
    const id = asStableId(raw.id, 'script id'); nextIds.add(id); operations.push({ op: 'script.upsert', script: { id, entityId: asStableId(raw.entityId, 'script entity id'), name: raw.name, sourcePath: raw.sourcePath, source: raw.text, textRevision: raw.textRevision as number, enabled: true, order, capabilities: raw.capabilities as string[], digest: `sha256:${sha256(raw.text)}` } });
  }
  for (const script of scripts) if (!nextIds.has(script.id)) operations.push({ op: 'script.remove', scriptId: script.id });
  if (operations.length === 0) throw new TypeError('Script resource command has no changes.'); return Object.freeze(operations);
}
