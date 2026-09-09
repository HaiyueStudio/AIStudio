import { asStableId, type JsonObject, type JsonValue, type ObservationArtifactV2 } from '@haiyue/ai-studio-contracts';
import type { GameAuthoringToolService, GameToolApproval, GameToolPreparation } from '@haiyue/ai-studio-game-authoring-tools';
import { parseAdvancedStudioIntent, type AdvancedStudioSource } from '@haiyue/ai-studio-shell/advanced/model';
import { EMPTY_RESOURCE_PANEL, type ResourcePanelData } from '@haiyue/ai-studio-shell/resources/model';

export interface EditorProjectIdentity { readonly projectId: string; readonly documentId: string; readonly revision: number; readonly selectionRevision: number; readonly storageKey: string | null; }
export interface EditorResourcePort {
  query(input: JsonObject, signal: AbortSignal): Promise<Readonly<{ binding: JsonObject | null; data: ResourcePanelData }>>;
  execute(input: JsonObject, signal: AbortSignal): Promise<JsonObject>;
  importAsset(input: JsonObject, signal: AbortSignal): Promise<JsonObject>;
  locateUsage(input: JsonObject): JsonObject;
  cancel(): void;
  dispose(): void;
}
export interface ProjectEditorPorts {
  current(): EditorProjectIdentity | null;
  nextId(): string;
  advancedSource(epoch: string): AdvancedStudioSource;
  select(entityId: string | null): Promise<unknown>;
  history(direction: 'undo' | 'redo', baseRevision: number): Promise<unknown>;
  resources(request: (toolId: string, args: JsonObject, signal?: AbortSignal) => Promise<JsonValue>, signal: AbortSignal): Promise<EditorResourcePort>;
  readonly tools: GameAuthoringToolService;
  approve(preparation: GameToolPreparation, approval: GameToolApproval, signal: AbortSignal): Promise<'allow-once' | 'reject'>;
}
interface Guard { readonly epoch: string; readonly identity: EditorProjectIdentity; }

/** Project lifecycle, exact approvals and opaque resource views. All domain writes
 * still execute through the existing tools and shared Document History. */
export class ProjectEditorController {
  private identity: EditorProjectIdentity | null = null;
  private epoch: string;
  private resource: EditorResourcePort | null = null;
  private resourcePending: Promise<EditorResourcePort> | null = null;
  private view: Readonly<{ token: string; guard: Guard; binding: JsonObject }> | null = null;
  private readonly tasks = new Set<AbortController>();
  private closed = false;
  private queryGeneration = 0;
  private observation: Readonly<{ artifact: ObservationArtifactV2; value: JsonObject; epoch: string; documentId: string }> | null = null;
  constructor(private readonly ports: ProjectEditorPorts) { this.epoch = ports.nextId(); this.syncProject(); }

  syncProject(): void {
    this.assertOpen();
    const next = this.ports.current();
    if (!sameOwner(this.identity, next)) this.replaceProject();
    else if (next?.revision !== this.identity?.revision) this.view = null;
    this.identity = next;
  }
  /** Explicitly called before every open/reopen, even for an identical copied document. */
  replaceProject(): void {
    this.cancel(); this.epoch = this.ports.nextId(); this.view = null;
    this.observation = null;
    this.resource?.dispose(); this.resource = null; this.resourcePending = null;
  }
  snapshotAdvanced(): AdvancedStudioSource {
    this.syncProject(); const source = this.ports.advancedSource(this.epoch), observation = this.observation;
    return observation ? { ...source, observation: observation.artifact, observationValue: observation.value, observationEpoch: observation.epoch, observationDocumentId: observation.documentId } : source;
  }
  async dispatchAdvanced(input: unknown, signal?: AbortSignal): Promise<JsonObject> {
    const intent = parseAdvancedStudioIntent(input, this.snapshotAdvanced());
    if (intent.type === 'cancel') { this.cancel(); return { cancelled: true }; }
    const guard = this.capture(), task = this.task(signal);
    try {
      this.guard(guard, task.signal, true);
      if (intent.type === 'author') return await this.requestTool(intent.toolId, intent.arguments, task.signal, guard, true) as JsonObject;
      if (intent.type === 'select') await this.ports.select(intent.reference?.id ?? null);
      else if (intent.type === 'undo' || intent.type === 'redo') await this.ports.history(intent.type, intent.stamp.baseRevision);
      else if (intent.type === 'runtime.inspect') {
        const result = await this.requestTool('play.inspect', {}, task.signal, guard) as JsonObject;
        // The tool runtime persists the existing ObservationArtifactV2 envelope.
        this.observation = { artifact: object(result.observation) as unknown as ObservationArtifactV2,
          value: object(result.projection), epoch: guard.epoch, documentId: guard.identity.documentId };
        return result;
      }
      else return { focusEntityId: this.snapshotAdvanced().selection.active?.id ?? null };
      this.guardOwner(guard, task.signal); return { completed: true };
    } finally { task.detach(); }
  }
  async queryResources(query: JsonObject = {}, signal?: AbortSignal): Promise<ResourcePanelData> {
    this.syncProject();
    if (!this.identity) return EMPTY_RESOURCE_PANEL;
    const guard = this.capture(), task = this.task(signal), generation = ++this.queryGeneration;
    try {
      const resources = await this.openResources(task.signal); this.guard(guard, task.signal);
      const page = await resources.query(query, task.signal); this.guard(guard, task.signal);
      if (generation !== this.queryGeneration) throw Error('resource.query-superseded');
      if (!page.binding) { this.view = null; return EMPTY_RESOURCE_PANEL; }
      const token = this.ports.nextId(); this.view = { token, guard, binding: page.binding };
      return Object.freeze({ ...page.data, viewToken: token, projectKey: this.epoch });
    } finally { task.detach(); }
  }
  async dispatchResource(input: unknown, signal?: AbortSignal): Promise<JsonObject> {
    const value = object(input);
    if (value.type === 'cancel') { exact(value, ['type']); this.cancel(); return { cancelled: true }; }
    if (value.type === 'query' || value.type === 'refresh') {
      exact(value, ['type', 'query']);
      if (value.type === 'refresh') this.resource?.cancel();
      return await this.queryResources(object(value.query), signal) as unknown as JsonObject;
    }
    if (value.type === 'select-target') { exact(value, ['type']); return await this.queryResources({}, signal) as unknown as JsonObject; }
    if (value.type !== 'action' && value.type !== 'locate-use') throw Error('resource.intent-invalid');
    exact(value, value.type === 'action' ? ['type', 'viewToken', 'entry', 'action'] : ['type', 'viewToken', 'entry', 'ref', 'field'], value.type === 'action' ? ['targetEntityId', 'usage'] : []);
    const { type, viewToken, ...args } = value, view = this.requireView(viewToken), task = this.task(signal);
    try {
      this.guard(view.guard, task.signal);
      const resources = await this.openResources(task.signal); this.guard(view.guard, task.signal);
      const result = type === 'action' ? await resources.execute({ ...args, binding: view.binding }, task.signal)
        : { kind: 'location', location: resources.locateUsage({ ...args, binding: view.binding }) };
      this.guardOwner(view.guard, task.signal); return result;
    } finally { task.detach(); }
  }
  async importResource(viewToken: unknown, input: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
    const view = this.requireView(viewToken), task = this.task(signal);
    try {
      this.guard(view.guard, task.signal);
      const resources = await this.openResources(task.signal); this.guard(view.guard, task.signal);
      const result = await resources.importAsset({ ...input, binding: view.binding }, task.signal);
      this.guardOwner(view.guard, task.signal); return result;
    } finally { task.detach(); }
  }
  cancel(): void { this.queryGeneration++; for (const task of this.tasks) task.abort(); this.resource?.cancel(); }
  dispose(): void { if (this.closed) return; this.replaceProject(); this.closed = true; }

  private async requestTool(toolId: string, args: JsonObject, signal?: AbortSignal, expected?: Guard, selection = false): Promise<JsonValue> {
    const guard = expected ?? this.capture(), task = this.task(signal), callId = asStableId(`manual:${this.ports.nextId()}`);
    const cancel = () => { void this.ports.tools.cancel(callId).catch(() => undefined); };
    task.signal.addEventListener('abort', cancel, { once: true });
    let completed = false;
    try {
      this.guard(guard, task.signal, selection);
      const preparation = await this.ports.tools.prepare({ schemaVersion: 1, id: callId, sessionId: asStableId(`manual:${guard.epoch}`), turnId: callId, toolId: asStableId(toolId), toolVersion: '1.0.0', arguments: args }, task.signal);
      this.guard(guard, task.signal, selection);
      if (preparation.documentId !== guard.identity.documentId || preparation.baseRevision !== guard.identity.revision) throw Error('editor.preparation-stale');
      if (preparation.approvalId) {
        const approval = this.ports.tools.approval(preparation.approvalId);
        if (!approval) throw Error('editor.approval-unavailable');
        const decision = await this.ports.approve(preparation, approval, task.signal);
        this.guard(guard, task.signal, selection);
        await this.ports.tools.decide(preparation.approvalId, decision);
        if (decision !== 'allow-once') throw Error('editor.approval-rejected');
      }
      this.guard(guard, task.signal, selection);
      const result = await this.ports.tools.execute(preparation.id, task.signal);
      this.guardOwner(guard, task.signal);
      if (result.status !== 'completed') throw Error(`editor.tool-${result.status}`);
      completed = true; return result.value;
    } finally { task.signal.removeEventListener('abort', cancel); if (!completed) await this.ports.tools.cancel(callId).catch(() => undefined); task.detach(); }
  }
  private async openResources(signal: AbortSignal): Promise<EditorResourcePort> {
    if (this.resource) return this.resource;
    if (this.resourcePending) {
      try { return await this.resourcePending; }
      catch (error) { signal.throwIfAborted(); if (this.closed) throw error; return this.openResources(signal); }
    }
    const guard = this.capture();
    const pending = this.ports.resources((id, args, signal) => this.requestTool(id, args, signal), signal).then(resource => {
      try { this.guardOwner(guard, signal); } catch (error) { resource.dispose(); throw error; }
      this.resource = resource; return resource;
    }).finally(() => { if (this.resourcePending === pending) this.resourcePending = null; });
    this.resourcePending = pending; return pending;
  }
  private requireView(token: unknown) { this.syncProject(); const view = this.view; if (!view || token !== view.token) throw Error('resource.view-stale'); this.guard(view.guard, new AbortController().signal); return view; }
  private capture(): Guard { this.syncProject(); if (!this.identity) throw Error('editor.project-unavailable'); return { epoch: this.epoch, identity: { ...this.identity } }; }
  private guardOwner(guard: Guard, signal: AbortSignal): void {
    this.assertOpen(); signal.throwIfAborted();
    if (guard.epoch !== this.epoch || !sameOwner(guard.identity, this.ports.current())) throw Error('editor.project-stale');
  }
  private guard(guard: Guard, signal: AbortSignal, selection = false): void {
    this.guardOwner(guard, signal); const current = this.ports.current();
    if (current?.revision !== guard.identity.revision || selection && current.selectionRevision !== guard.identity.selectionRevision) throw Error('editor.revision-stale');
  }
  private task(signal?: AbortSignal) {
    this.assertOpen(); const controller = new AbortController();
    const abort = () => controller.abort(); if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true }); this.tasks.add(controller);
    return { signal: controller.signal, detach: () => { signal?.removeEventListener('abort', abort); this.tasks.delete(controller); } };
  }
  private assertOpen(): void { if (this.closed) throw Error('editor.disposed'); }
}
function sameOwner(a: EditorProjectIdentity | null, b: EditorProjectIdentity | null): boolean { return a?.projectId === b?.projectId && a?.documentId === b?.documentId && a?.storageKey === b?.storageKey; }
function object(value: unknown): JsonObject { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('editor.input-invalid'); return value as JsonObject; }
function exact(value: JsonObject, keys: readonly string[], optional: readonly string[] = []): void { if (keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key) && !optional.includes(key))) throw Error('editor.input-invalid'); }
