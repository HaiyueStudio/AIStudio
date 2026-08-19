import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import {
  DEFAULT_SCRIPT_CAPABILITIES,
  generateScriptRuntimeDeclarations,
  SCRIPT_CAPABILITIES,
  ScriptComponent,
  ScriptResource,
  type ScriptCapabilityName,
  type ScriptRuntimeErrorEvent,
} from '@haiyue/engine/components';
import { CartesianTransform3D, Entity, World } from '@haiyue/engine';
import {
  asStableId,
  createStudioServiceToken,
  defineStudioPlugin,
  type JsonObject,
  type JsonValue,
  type StableId,
  type StudioPluginDefinition,
} from '@haiyue/ai-studio-contracts';
import {
  ProjectRevisionError,
  projectWorkspaceServiceToken,
  sceneAuthoringToken,
  type ProjectWorkspace,
  type ProjectWorkspaceSnapshot,
  type SceneSnapshot,
} from '@haiyue/ai-studio-editor-plugins';
import { operationLogServiceToken, type OperationLog } from '@haiyue/ai-studio-operation-log';

export type { ScriptCapabilityName } from '@haiyue/engine/components';

export interface ScriptDiagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface ScriptResourceSnapshot {
  readonly id: StableId;
  readonly entityId: StableId;
  readonly name: string;
  readonly sourcePath: string;
  readonly text: string;
  readonly textRevision: number;
  readonly dirty: boolean;
}

export interface ScriptCatalogSnapshot {
  readonly schemaVersion: 1;
  readonly documentId: StableId;
  readonly documentRevision: number;
  readonly resources: readonly ScriptResourceSnapshot[];
}

export interface ScriptValidationResult {
  readonly requestId: StableId;
  readonly scriptId: StableId;
  readonly textRevision: number;
  readonly capabilities: readonly ScriptCapabilityName[];
  readonly diagnostics: readonly ScriptDiagnostic[];
  readonly emittedText: string;
  readonly stale: boolean;
}

export interface ScriptEditProposal {
  readonly id: StableId;
  readonly entityId: StableId;
  readonly scriptId: StableId;
  readonly baseRevision: number;
  readonly previousTextRevision: number;
  readonly nextTextRevision: number;
  readonly text: string;
  readonly digest: string;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly capabilities: readonly ScriptCapabilityName[];
  readonly diagnostics: readonly ScriptDiagnostic[];
  readonly emittedText: string;
}

interface WorkerResult {
  readonly id: string;
  readonly diagnostics: readonly ScriptDiagnostic[];
  readonly emittedText: string;
}

export class ScriptValidationWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<string, Readonly<{ resolve(value: WorkerResult): void; reject(cause: unknown): void }>>();
  private readonly generations = new Map<string, number>();
  private disposed = false;

  constructor() {
    this.worker = new Worker(new URL('./validation-worker.js', import.meta.url));
    this.worker.on('message', (message: WorkerResult) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message);
    });
    this.worker.on('error', (cause) => {
      for (const pending of this.pending.values()) pending.reject(cause);
      this.pending.clear();
    });
  }

  async validate(input: Readonly<{
    scriptId: StableId; textRevision: number; sourcePath: string; text: string; capabilities?: readonly ScriptCapabilityName[];
  }>): Promise<ScriptValidationResult> {
    this.assertActive();
    const capabilities = normalizeCapabilities(input.capabilities);
    const generation = (this.generations.get(input.scriptId) ?? 0) + 1;
    this.generations.set(input.scriptId, generation);
    const requestId = asStableId(`script-validation:${randomUUID()}`);
    const result = await new Promise<WorkerResult>((resolve, reject) => {
      this.pending.set(requestId, Object.freeze({ resolve, reject }));
      this.worker.postMessage({
        id: requestId,
        sourcePath: input.sourcePath,
        text: input.text,
        declarations: generateScriptRuntimeDeclarations(capabilities),
      });
    });
    return Object.freeze({
      requestId,
      scriptId: input.scriptId,
      textRevision: input.textRevision,
      capabilities,
      diagnostics: Object.freeze(result.diagnostics.map((item) => Object.freeze(item))),
      emittedText: result.emittedText,
      stale: generation !== this.generations.get(input.scriptId),
    });
  }

  invalidate(scriptId: StableId): void { this.generations.set(scriptId, (this.generations.get(scriptId) ?? 0) + 1); }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pending.values()) pending.reject(new Error('Script validation worker disposed.'));
    this.pending.clear();
    this.generations.clear();
    await this.worker.terminate();
  }
  private assertActive(): void { if (this.disposed) throw new Error('Script validation worker is disposed.'); }
}

const SCRIPT_SETTING_KEY = 'script.resources';

export class ProjectScriptService {
  private readonly listeners = new Set<(snapshot: ScriptCatalogSnapshot) => void>();
  private readonly proposals = new Map<StableId, ScriptEditProposal>();
  private readonly subscription: Readonly<{ dispose(): void }>;
  private current: ScriptCatalogSnapshot;
  private disposed = false;

  constructor(private readonly workspace: ProjectWorkspace, private readonly validator: ScriptValidationWorker, private readonly log: OperationLog) {
    this.current = scriptsFromWorkspace(workspace.snapshot());
    this.subscription = workspace.subscribe((snapshot) => this.sync(snapshot));
  }

  snapshot(): ScriptCatalogSnapshot { this.assertActive(); return this.current; }
  subscribe(listener: (snapshot: ScriptCatalogSnapshot) => void): Readonly<{ dispose(): void }> {
    this.assertActive(); this.listeners.add(listener); listener(this.current);
    let active = true;
    return Object.freeze({ dispose: () => { if (active) { active = false; this.listeners.delete(listener); } } });
  }

  async proposeEdit(input: Readonly<{
    entityId: StableId; text: string; baseRevision: number; capabilities?: readonly ScriptCapabilityName[];
  }>): Promise<ScriptEditProposal> {
    this.assertActive();
    assertScriptText(input.text);
    if (input.baseRevision !== this.current.documentRevision) throw new ProjectRevisionError(this.current.documentRevision, input.baseRevision);
    const previous = this.current.resources.find((resource) => resource.entityId === input.entityId);
    const scriptId = previous?.id ?? asStableId(`script:${randomUUID()}`);
    const sourcePath = previous?.sourcePath ?? `scripts/${scriptId.slice('script:'.length)}.ts`;
    const nextTextRevision = (previous?.textRevision ?? 0) + 1;
    const validation = await this.validator.validate({ scriptId, textRevision: nextTextRevision, sourcePath, text: input.text, capabilities: input.capabilities });
    if (validation.stale) throw new Error('Script validation result is stale.');
    const id = asStableId(`script-proposal:${randomUUID()}`);
    const diff = lineDiff(previous?.text ?? '', input.text);
    const proposal: ScriptEditProposal = Object.freeze({
      id, entityId: input.entityId, scriptId, baseRevision: input.baseRevision,
      previousTextRevision: previous?.textRevision ?? 0, nextTextRevision, text: input.text,
      digest: digestScript(input.text, validation.capabilities), addedLines: diff.addedLines, removedLines: diff.removedLines,
      capabilities: validation.capabilities, diagnostics: validation.diagnostics, emittedText: validation.emittedText,
    });
    this.proposals.set(id, proposal);
    await this.log.append({
      kind: 'script/proposal-ready', severity: hasErrors(proposal.diagnostics) ? 'warning' : 'info', source: asStableId('studio.script'),
      correlation: { documentId: this.current.documentId, entityId: input.entityId, scriptId, revisionId: asStableId(`script-revision:${nextTextRevision}`) },
      payload: { proposalId: id, digest: proposal.digest, addedLines: diff.addedLines, removedLines: diff.removedLines, capabilities: proposal.capabilities, diagnosticCount: proposal.diagnostics.length },
    });
    return proposal;
  }

  async commitProposal(proposalId: StableId, commandId: StableId, signal?: AbortSignal): Promise<ScriptResourceSnapshot> {
    this.assertActive();
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`Script proposal ${proposalId} is missing or already consumed.`);
    if (hasErrors(proposal.diagnostics)) throw new Error('Script proposal has validation errors.');
    const resources = this.current.resources.filter((resource) => resource.entityId !== proposal.entityId).map(stripDirty);
    resources.push(Object.freeze({
      id: proposal.scriptId, entityId: proposal.entityId, name: 'Entity Script', sourcePath: `scripts/${proposal.scriptId.slice('script:'.length)}.ts`,
      text: proposal.text, textRevision: proposal.nextTextRevision,
    }));
    const stored = Object.freeze({ schemaVersion: 1, resources: Object.freeze(resources) });
    await this.workspace.execute({ id: commandId, label: 'Edit Entity Script', baseRevision: proposal.baseRevision, key: SCRIPT_SETTING_KEY, value: stored as unknown as JsonValue }, signal);
    this.proposals.delete(proposalId);
    const committed = this.current.resources.find((resource) => resource.id === proposal.scriptId);
    if (!committed) throw new Error('Committed script did not project back into the document.');
    await this.log.append({
      kind: 'script/edit-committed', severity: 'info', source: asStableId('studio.script'),
      correlation: { commandId, documentId: this.current.documentId, entityId: committed.entityId, scriptId: committed.id, revisionId: asStableId(`script-revision:${committed.textRevision}`) },
      payload: { digest: proposal.digest, documentRevision: this.current.documentRevision },
    });
    return committed;
  }

  getProposal(id: StableId): ScriptEditProposal | undefined { return this.proposals.get(id); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.subscription.dispose(); this.listeners.clear(); this.proposals.clear();
  }
  private sync(workspace: ProjectWorkspaceSnapshot): void {
    if (this.disposed) return;
    const next = scriptsFromWorkspace(workspace);
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    for (const resource of this.current.resources) {
      const updated = next.resources.find((candidate) => candidate.id === resource.id);
      if (!updated || updated.textRevision !== resource.textRevision) this.validator.invalidate(resource.id);
    }
    this.current = next;
    for (const listener of [...this.listeners]) listener(next);
  }
  private assertActive(): void { if (this.disposed) throw new Error('Project script service is disposed.'); }
}

export interface PreviewPlan {
  readonly id: StableId;
  readonly scriptId: StableId;
  readonly entityId: StableId;
  readonly documentRevision: number;
  readonly textRevision: number;
  readonly digest: string;
  readonly capabilities: readonly ScriptCapabilityName[];
  readonly risk: 'trusted-project';
  readonly diagnostics: readonly ScriptDiagnostic[];
  readonly emittedText: string;
}

export interface PreviewGrant { readonly id: StableId; readonly planId: StableId; readonly expiresAt: number; }

export interface ScriptPreviewStudioService {
  snapshot(): ScriptCatalogSnapshot;
  proposeEdit(input: Readonly<{ entityId: StableId; text: string; baseRevision: number; capabilities?: readonly ScriptCapabilityName[] }>): Promise<ScriptEditProposal>;
  commitProposal(proposalId: StableId, commandId: StableId, signal?: AbortSignal): Promise<ScriptResourceSnapshot>;
  prepare(scriptId: StableId, capabilities?: readonly ScriptCapabilityName[]): Promise<PreviewPlan>;
  decide(planId: StableId, approved: boolean, ttlMs?: number): Promise<PreviewGrant | null>;
  consume(grantId: StableId): PreviewPlan;
}

export const scriptPreviewServiceToken = createStudioServiceToken<ScriptPreviewStudioService>('studio.script-preview');

export function createScriptPreviewPlugin(): StudioPluginDefinition<JsonObject> {
  return defineStudioPlugin({
    manifest: {
      schemaVersion: 1,
      id: asStableId('studio.script-preview.plugin'),
      version: '0.0.0',
      apiVersion: '1.0',
      required: [
        { id: asStableId('studio.project-workspace'), version: '1.0.0' },
        { id: asStableId('studio.scene-authoring'), version: '1.0.0' },
        { id: asStableId('studio.operation-log'), version: '1.0.0' },
      ],
      optional: [],
      provides: [{ id: asStableId('studio.script-preview'), version: '1.0.0' }],
      contributions: [],
      activationPolicy: 'required',
    },
    validateConfig(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0) throw new TypeError('Script preview config must be empty.');
      return Object.freeze({});
    },
    activate(context) {
      const workspace = context.services.get(projectWorkspaceServiceToken);
      const scene = context.services.get(sceneAuthoringToken);
      const log = context.services.get(operationLogServiceToken).log;
      const validator = new ScriptValidationWorker();
      const scripts = new ProjectScriptService(workspace, validator, log);
      const authorization = new PreviewAuthorizationService(scripts, validator, log);
      const service: ScriptPreviewStudioService = Object.freeze({
        snapshot: () => scripts.snapshot(),
        proposeEdit: (input: Parameters<ScriptPreviewStudioService['proposeEdit']>[0]) => {
          if (!scene.snapshot().entities.some((entity) => entity.id === input.entityId)) throw new Error(`Script entity ${input.entityId} does not exist.`);
          return scripts.proposeEdit(input);
        },
        commitProposal: scripts.commitProposal.bind(scripts),
        prepare: authorization.prepare.bind(authorization),
        decide: authorization.decide.bind(authorization),
        consume: authorization.consume.bind(authorization),
      });
      context.services.provide(scriptPreviewServiceToken, service);
      context.effects.own('script-preview.dispose', async () => { scripts.dispose(); await validator.dispose(); });
    },
  });
}

export class PreviewAuthorizationService {
  private readonly plans = new Map<StableId, PreviewPlan>();
  private readonly grants = new Map<StableId, Readonly<{ grant: PreviewGrant; plan: PreviewPlan }>>();
  constructor(private readonly scripts: ProjectScriptService, private readonly validator: ScriptValidationWorker, private readonly log: OperationLog, private readonly clock: () => number = Date.now) {}

  async prepare(scriptId: StableId, capabilities?: readonly ScriptCapabilityName[]): Promise<PreviewPlan> {
    const catalog = this.scripts.snapshot();
    const script = catalog.resources.find((resource) => resource.id === scriptId);
    if (!script) throw new Error(`Script ${scriptId} does not exist.`);
    const validation = await this.validator.validate({ scriptId, textRevision: script.textRevision, sourcePath: script.sourcePath, text: script.text, capabilities });
    if (validation.stale) throw new Error('Preview validation result is stale.');
    const plan: PreviewPlan = Object.freeze({
      id: asStableId(`preview-plan:${randomUUID()}`), scriptId, entityId: script.entityId,
      documentRevision: catalog.documentRevision, textRevision: script.textRevision,
      digest: digestScript(script.text, validation.capabilities), capabilities: validation.capabilities,
      risk: 'trusted-project', diagnostics: validation.diagnostics, emittedText: validation.emittedText,
    });
    this.plans.set(plan.id, plan);
    await this.log.append({
      kind: 'preview/approval-ready', severity: hasErrors(plan.diagnostics) ? 'warning' : 'info', source: asStableId('studio.preview'),
      correlation: { documentId: catalog.documentId, entityId: plan.entityId, scriptId, revisionId: asStableId(`script-revision:${plan.textRevision}`) },
      payload: { planId: plan.id, digest: plan.digest, capabilities: plan.capabilities, risk: plan.risk, diagnosticCount: plan.diagnostics.length },
    });
    return plan;
  }

  async decide(planId: StableId, approved: boolean, ttlMs = 60_000): Promise<PreviewGrant | null> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Preview plan ${planId} is missing.`);
    this.plans.delete(planId);
    if (!approved) {
      await this.log.append({ kind: 'preview/authorization-denied', severity: 'warning', source: asStableId('studio.preview'), correlation: { entityId: plan.entityId, scriptId: plan.scriptId }, payload: { planId } });
      return null;
    }
    if (hasErrors(plan.diagnostics)) throw new Error('A preview with validation errors cannot be authorized.');
    const grant: PreviewGrant = Object.freeze({ id: asStableId(`preview-grant:${randomUUID()}`), planId, expiresAt: this.clock() + ttlMs });
    this.grants.set(grant.id, Object.freeze({ grant, plan }));
    await this.log.append({ kind: 'preview/authorized', severity: 'info', source: asStableId('studio.preview'), correlation: { entityId: plan.entityId, scriptId: plan.scriptId }, payload: { planId, grantId: grant.id, digest: plan.digest, expiresAt: grant.expiresAt } });
    return grant;
  }

  consume(grantId: StableId): PreviewPlan {
    const entry = this.grants.get(grantId);
    if (!entry) throw new Error(`Preview grant ${grantId} is missing or already consumed.`);
    this.grants.delete(grantId);
    if (this.clock() > entry.grant.expiresAt) throw new Error('Preview grant expired.');
    const catalog = this.scripts.snapshot();
    const script = catalog.resources.find((resource) => resource.id === entry.plan.scriptId);
    if (!script || catalog.documentRevision !== entry.plan.documentRevision || script.textRevision !== entry.plan.textRevision
      || digestScript(script.text, entry.plan.capabilities) !== entry.plan.digest) throw new Error('Preview grant is stale.');
    return entry.plan;
  }
}

export interface PreviewRuntimeSnapshot {
  readonly instanceId: StableId | null;
  readonly state: 'stopped' | 'playing' | 'faulted';
  readonly entityId: StableId | null;
  readonly position: Readonly<{ x: number; y: number; z: number }> | null;
  readonly disposableCount: number;
  readonly errors: readonly Readonly<{ code: string; path: string; line: number | null; column: number | null; message: string }>[];
}

export class IsolatedTrustedPreviewRuntime {
  private world: World | null = null;
  private resource: ScriptResource | null = null;
  private component: ScriptComponent | null = null;
  private entity: Entity | null = null;
  private entityId: StableId | null = null;
  private instanceId: StableId | null = null;
  private errors: PreviewRuntimeSnapshot['errors'] = Object.freeze([]);

  constructor(private readonly log: OperationLog) {}

  async start(scene: SceneSnapshot, plan: PreviewPlan): Promise<PreviewRuntimeSnapshot> {
    await this.stop('restart');
    const world = new World('AIStudio Isolated Preview');
    const entities = new Map<StableId, Entity>();
    for (const item of scene.entities) {
      const entity = new Entity(item.name);
      entity.addComponent(new CartesianTransform3D({ position: tuple(item.transform.position), rotation: tupleRadians(item.transform.rotationDegrees), scale: tuple(item.transform.scale) }));
      entities.set(item.id, entity);
    }
    for (const item of scene.entities) {
      const entity = entities.get(item.id)!;
      if (item.parentId) entities.get(item.parentId)?.addChild(entity); else world.addEntity(entity);
    }
    const entity = entities.get(plan.entityId);
    if (!entity) { world.destroy(); throw new Error(`Preview entity ${plan.entityId} does not exist.`); }
    const resource = new ScriptResource({ name: plan.scriptId, sourcePath: `scripts/${plan.scriptId}.ts`, scripts: { onUpdate: plan.emittedText } });
    const component = new ScriptComponent({}, resource);
    entity.addComponent(component);
    this.errors = Object.freeze([]);
    ScriptComponent.enableTrustedProject({
      capabilities: plan.capabilities,
      errorPolicy: 'disable-script',
      onError: (event) => this.captureError(event),
    });
    this.world = world; this.resource = resource; this.component = component; this.entity = entity; this.entityId = plan.entityId;
    this.instanceId = asStableId(`preview-instance:${randomUUID()}`);
    await this.log.append({ kind: 'preview/started', severity: 'info', source: asStableId('studio.preview'), correlation: { entityId: plan.entityId, scriptId: plan.scriptId, previewId: this.instanceId }, payload: { digest: plan.digest, capabilities: plan.capabilities, risk: plan.risk } });
    return this.snapshot();
  }

  tick(time: number, delta: number): PreviewRuntimeSnapshot {
    if (!this.world) throw new Error('Preview is not playing.');
    this.world.update(time, delta);
    return this.snapshot();
  }

  hotReload(emittedText: string): PreviewRuntimeSnapshot {
    if (!this.resource) throw new Error('Preview is not playing.');
    this.resource.setScript('onUpdate', emittedText);
    return this.snapshot();
  }

  snapshot(): PreviewRuntimeSnapshot {
    const transform = this.entity?.getComponent(CartesianTransform3D);
    const position = transform ? Object.freeze({ x: transform.position[0]!, y: transform.position[1]!, z: transform.position[2]! }) : null;
    return Object.freeze({
      instanceId: this.instanceId,
      state: !this.world ? 'stopped' : this.errors.length > 0 ? 'faulted' : 'playing',
      entityId: this.entityId,
      position,
      disposableCount: this.component?.disposableCount ?? 0,
      errors: this.errors,
    });
  }

  async stop(reason = 'user'): Promise<PreviewRuntimeSnapshot> {
    if (!this.world) return this.snapshot();
    const instanceId = this.instanceId;
    const disposableCount = this.component?.disposableCount ?? 0;
    this.world.destroy();
    ScriptComponent.resetExecutionOptions();
    this.world = null; this.resource = null; this.component = null; this.entity = null; this.entityId = null; this.instanceId = null;
    await this.log.append({ kind: 'preview/stopped', severity: 'info', source: asStableId('studio.preview'), correlation: { previewId: instanceId ?? undefined }, payload: { reason, disposedSideEffects: disposableCount } });
    return this.snapshot();
  }

  private captureError(event: ScriptRuntimeErrorEvent): void {
    const error = Object.freeze({
      code: event.error.code,
      path: event.error.path ?? '',
      line: event.sourceLocation.line,
      column: event.sourceLocation.column,
      message: event.error.message,
    });
    this.errors = Object.freeze([...this.errors, error]);
    void this.log.append({ kind: 'preview/runtime-error', severity: 'error', source: asStableId('studio.preview'), correlation: { entityId: this.entityId ?? undefined, previewId: this.instanceId ?? undefined }, payload: error }).catch(() => {});
  }
}

function scriptsFromWorkspace(workspace: ProjectWorkspaceSnapshot): ScriptCatalogSnapshot {
  const document = workspace.document;
  if (!document) return freezeCatalog({ schemaVersion: 1, documentId: asStableId('document:none'), documentRevision: 0, resources: [] });
  const raw = document.settings[SCRIPT_SETTING_KEY];
  const resources = raw === undefined ? [] : parseStoredScripts(raw, document.dirty);
  return freezeCatalog({ schemaVersion: 1, documentId: document.documentId, documentRevision: document.revision, resources });
}

function parseStoredScripts(value: JsonValue, dirty: boolean): ScriptResourceSnapshot[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Script catalog must be an object.');
  const raw = value as Record<string, JsonValue>;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.resources)) throw new TypeError('Script catalog envelope is invalid.');
  const ids = new Set<string>(); const entities = new Set<string>();
  return raw.resources.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`Script resource ${index} is invalid.`);
    const source = item as Record<string, JsonValue>;
    if (typeof source.id !== 'string' || typeof source.entityId !== 'string') throw new TypeError(`Script resource ${index} identity is invalid.`);
    const id = asStableId(source.id, 'script id'); const entityId = asStableId(source.entityId, 'script entity id');
    if (ids.has(id) || entities.has(entityId) || typeof source.name !== 'string' || typeof source.sourcePath !== 'string'
      || typeof source.text !== 'string' || !Number.isSafeInteger(source.textRevision) || (source.textRevision as number) < 1) throw new TypeError(`Script resource ${index} metadata is invalid.`);
    const name = source.name as string; const sourcePath = source.sourcePath as string; const text = source.text as string;
    ids.add(id); entities.add(entityId); assertScriptText(text);
    return Object.freeze({ id, entityId, name, sourcePath, text, textRevision: source.textRevision as number, dirty });
  });
}

function freezeCatalog(value: ScriptCatalogSnapshot): ScriptCatalogSnapshot { return Object.freeze({ ...value, resources: Object.freeze(value.resources.map((item) => Object.freeze(item))) }); }
function stripDirty(value: ScriptResourceSnapshot): Omit<ScriptResourceSnapshot, 'dirty'> { const { dirty: _dirty, ...stored } = value; return Object.freeze(stored); }
function normalizeCapabilities(value: readonly ScriptCapabilityName[] | undefined): readonly ScriptCapabilityName[] {
  const requested = value ?? DEFAULT_SCRIPT_CAPABILITIES;
  const unique = [...new Set(requested)];
  for (const capability of unique) if (!SCRIPT_CAPABILITIES.includes(capability)) throw new TypeError(`Unknown script capability ${capability}.`);
  return Object.freeze(unique);
}
function assertScriptText(text: unknown): asserts text is string { if (typeof text !== 'string' || text.length > 100_000 || text.includes('\0')) throw new TypeError('Script text must be a bounded string without NUL bytes.'); }
function digestScript(text: string, capabilities: readonly ScriptCapabilityName[]): string { return createHash('sha256').update(text).update('\0').update(capabilities.join(',')).digest('hex'); }
function lineDiff(before: string, after: string): Readonly<{ addedLines: number; removedLines: number }> {
  const left = before ? before.split(/\r?\n/u) : []; const right = after ? after.split(/\r?\n/u) : [];
  let shared = 0; const remaining = new Map<string, number>();
  for (const line of left) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  for (const line of right) { const count = remaining.get(line) ?? 0; if (count > 0) { shared += 1; remaining.set(line, count - 1); } }
  return Object.freeze({ addedLines: right.length - shared, removedLines: left.length - shared });
}
function hasErrors(diagnostics: readonly ScriptDiagnostic[]): boolean { return diagnostics.some((item) => item.severity === 'error'); }
function tuple(value: Readonly<{ x: number; y: number; z: number }>): [number, number, number] { return [value.x, value.y, value.z]; }
function tupleRadians(value: Readonly<{ x: number; y: number; z: number }>): [number, number, number] { const factor = Math.PI / 180; return [value.x * factor, value.y * factor, value.z * factor]; }
