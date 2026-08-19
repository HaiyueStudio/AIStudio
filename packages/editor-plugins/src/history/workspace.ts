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
import { asStableId, type JsonValue, type StableId } from '@haiyue/ai-studio-contracts';
import { OperationLog, OperationLogError } from '@haiyue/ai-studio-operation-log';
import { ProjectDocument, type ProjectDocumentReadModel } from '../project/document.js';
import { ProjectRepository, RecentProjectStore } from '../project/repository.js';

export interface ProjectCommandInput {
  readonly id: StableId;
  readonly label: string;
  readonly baseRevision: number;
  readonly key: string;
  readonly value: JsonValue;
  readonly transactionId?: StableId;
}

export interface ProjectWorkspaceSnapshot {
  readonly projectRoot: string | null;
  readonly document: ProjectDocumentReadModel | null;
  readonly documents: EditorDocumentHostSnapshot;
  readonly history: EditorHistorySnapshot;
  readonly session: EditorProjectSessionSnapshot;
  readonly logging: ReturnType<OperationLog['status']>;
  readonly activeTasks: number;
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
  private disposed = false;

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

  async newProject(selectedRoot: string, name: string): Promise<ProjectWorkspaceSnapshot> {
    return this.serialize(async () => {
      this.assertActive();
      if (!name.trim() || name.length > 80) throw new TypeError('Project name must contain 1-80 characters.');
      const repository = await ProjectRepository.open(selectedRoot);
      const projectId = asStableId(`project:${randomUUID()}`);
      const documentId = asStableId(`document:${randomUUID()}`);
      await this.resources.operationLog.append({
        kind: 'project/create-requested', severity: 'info', source: asStableId('studio.project'),
        correlation: { projectId, documentId }, payload: { name: name.trim() },
      });
      const document = new ProjectDocument(projectId, name.trim(), documentId, {}, 1, 0);
      await this.replaceDocument(repository, document);
      await this.remember(repository.root);
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
      const value = await repository.read();
      await this.resources.operationLog.append({
        kind: 'project/open-requested', severity: 'info', source: asStableId('studio.project'),
        correlation: { projectId: value.projectId, documentId: value.document.id }, payload: {},
      });
      const document = new ProjectDocument(
        value.projectId, value.name, value.document.id, value.document.settings, value.document.revision, value.document.savedRevision,
      );
      await this.replaceDocument(repository, document);
      await this.remember(repository.root);
      await this.resources.operationLog.append({
        kind: 'project/opened', severity: 'info', source: asStableId('studio.project'),
        correlation: { projectId: value.projectId, documentId: value.document.id }, payload: { revision: value.document.revision },
      });
      return this.snapshot();
    });
  }

  async reopen(): Promise<ProjectWorkspaceSnapshot> {
    const root = this.repository?.root;
    if (!root) throw new Error('No project is open.');
    return this.openProject(root);
  }

  async execute(input: ProjectCommandInput, signal?: AbortSignal): Promise<ProjectWorkspaceSnapshot> {
    return this.serialize(async () => {
      this.assertActive();
      throwIfAborted(signal);
      const document = this.requireDocument();
      assertBaseRevision(document, input.baseRevision);
      validateCommand(input);
      await this.resources.operationLog.append({
        kind: 'document/command-requested', severity: 'info', source: asStableId('studio.document'),
        correlation: commandCorrelation(document, input),
        payload: { label: input.label, baseRevision: input.baseRevision, key: input.key },
      }, { signal });
      throwIfAborted(signal);
      let previous: Readonly<{ existed: boolean; value?: JsonValue }> | undefined;
      const command: EditorCommand = {
        label: input.label,
        estimatedBytes: JSON.stringify(input.value).length + input.key.length,
        execute: () => { previous = document.setSetting(input.key, input.value); return true; },
        undo: () => document.restoreSetting(input.key, previous!),
        redo: () => { document.setSetting(input.key, input.value); return true; },
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
        correlation: commandCorrelation(document, input), payload: { revision: document.revision, historyLabel: input.label },
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
    });
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
      this.emit();
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.resources.tasks.cancelAll();
    await this.mutationTail;
    await this.detachDocument();
    this.listeners.clear();
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

  private async replaceDocument(repository: ProjectRepository, document: ProjectDocument): Promise<void> {
    this.resources.tasks.cancelAll();
    await this.detachDocument();
    this.resources.history.clear();
    this.repository = repository;
    this.document = document;
    this.resources.documents.attach(document, true);
    this.resources.projectSession.open(document.projectId, document.name, document.revision);
    if (document.savedRevision === document.revision) this.resources.projectSession.markSaved(document.revision);
    this.emit();
  }

  private async detachDocument(): Promise<void> {
    if (!this.document) return;
    const id = this.document.documentId;
    this.resources.tasks.cancelAll();
    this.resources.history.clear();
    await this.resources.documents.close(id);
    this.document = null;
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
  private requireDocument(): ProjectDocument { this.assertActive(); if (!this.document) throw new Error('No project document is open.'); return this.document; }
  private requireRepository(): ProjectRepository { if (!this.repository) throw new Error('No project repository is open.'); return this.repository; }
  private assertActive(): void { if (this.disposed) throw new Error('Project workspace is disposed.'); }
}

function validateCommand(input: ProjectCommandInput): void {
  if (!input.label.trim() || input.label.length > 120) throw new TypeError('Command label must contain 1-120 characters.');
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) throw new TypeError('Command base revision is invalid.');
  JSON.stringify(input.value);
}

function assertBaseRevision(document: ProjectDocument, baseRevision: number): void {
  if (document.revision !== baseRevision) {
    throw new ProjectRevisionError(document.revision, baseRevision);
  }
}

function commandCorrelation(document: ProjectDocument, input: ProjectCommandInput) {
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
