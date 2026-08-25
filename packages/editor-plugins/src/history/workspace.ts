import { randomUUID } from 'node:crypto';
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
import { OperationLog, OperationLogError, sha256 } from '@haiyue/ai-studio-operation-log';
import { ProjectDocument, type ProjectDocumentReadModel, type ProjectMigrationReport } from '../project/document.js';
import { ProjectRepository, RecentProjectStore } from '../project/repository.js';
import { ComponentRegistry } from '../components/registry.js';

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
}

export class ProjectWorkspace {
  private repository: ProjectRepository | null = null;
  private document: ProjectDocument | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private listeners = new Set<(snapshot: ProjectWorkspaceSnapshot) => void>();
  private mutationListeners = new Set<(mutation: ProjectDocumentMutation) => void>();
  private disposed = false;
  private migration: ProjectMigrationReport | null = null;
  readonly componentRegistry = new ComponentRegistry();

  constructor(private readonly resources: ProjectWorkspaceResources) {}

  snapshot(): ProjectWorkspaceSnapshot {
    return Object.freeze({
      projectRoot: this.repository?.root ?? null,
      document: this.document?.snapshot() ?? null,
      documents: this.resources.documents.snapshot(),
      history: this.resources.history.snapshot(),
      session: this.resources.projectSession.snapshot(),
      logging: this.resources.operationLog.status(),
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
  componentOwner(componentId: StableId): StableId | null { return this.requireDocument().componentOwner(componentId); }

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
    return this.serialize(async () => {
      this.assertActive();
      throwIfAborted(signal);
      const document = this.requireDocument();
      assertBaseRevision(document, input.baseRevision);
      validateCommand(input);
      await this.resources.operationLog.append({
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
      try {
        if (!this.resources.history.execute(command)) throw new Error('Command reported no change.');
      } catch (cause) {
        await this.resources.operationLog.append({
          kind: 'document/command-failed', severity: 'error', source: asStableId('studio.document'),
          correlation: commandCorrelation(document, input), payload: { message: errorMessage(cause) },
        }).catch(() => {});
        throw cause;
      }
      this.resources.projectSession.updateDocumentRevision(document.revision);
      await this.resources.operationLog.append({
        kind: 'document/command-committed', severity: 'info', source: asStableId('studio.document'),
        correlation: commandCorrelation(document, input), payload: { revision: document.revision, historyLabel: input.label, operationCount: input.operations.length, metrics: latest?.metrics ?? null },
      });
      this.emit();
      return this.snapshot();
    });
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
      this.repository = repository;
      await this.remember(repository.root);
      return this.persist(repository, document);
    });
  }

  private async persist(repository: ProjectRepository, document: ProjectDocument): Promise<ProjectWorkspaceSnapshot> {
    await this.resources.operationLog.append({
      kind: 'project/save-requested', severity: 'info', source: asStableId('studio.project'),
      correlation: { projectId: document.projectId, documentId: document.documentId }, payload: { revision: document.revision },
    });
    await repository.save(document.serializeForSave());
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
      await this.resources.operationLog.append({
        kind: `history/${kind}-requested`, severity: 'info', source: asStableId('studio.history'),
        correlation: { projectId: document.projectId, documentId: document.documentId, commandId: id }, payload: { baseRevision },
      });
      const changed = kind === 'undo' ? this.resources.history.undo() : this.resources.history.redo();
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
    this.emitMutation(Object.freeze({ kind: 'replace', documentId: null, revision: 0 }));
  }

  private async remember(root: string): Promise<void> {
    const recent = await this.resources.recentProjects.load();
    await this.resources.recentProjects.save([root, ...recent.filter((entry) => entry !== root)]);
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
  private emitMutation(value: ProjectDocumentMutation): void { for (const listener of [...this.mutationListeners]) listener(value); }
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
