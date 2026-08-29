import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import {
  DEFAULT_SCRIPT_CAPABILITIES,
  generateScriptRuntimeDeclarations,
  SCRIPT_CAPABILITIES,
  ScriptComponent,
  ScriptResource,
  type ScriptCapabilityName,
  type ScriptRuntimeApi,
  type ScriptRuntimeContext,
  type ScriptRuntimeErrorEvent,
} from '@haiyue/engine/components';
import { CartesianTransform3D, Entity, World } from '@haiyue/engine';
import {
  asStableId,
  createStudioServiceToken,
  defineStudioPlugin,
  type JsonObject,
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

export const MAX_PLAY_SCRIPTS = 128;
export const DEFAULT_PLAY_RUNTIME_CONFIG: PlayRuntimeConfig = Object.freeze({ schemaVersion: 1, mode: 'fixed-step', tickRateHz: 60, maxSubSteps: 1_000, seed: 'haiyue-play' });

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
  readonly enabled: boolean;
  readonly order: number;
  readonly capabilities: readonly ScriptCapabilityName[];
  readonly digest: `sha256:${string}`;
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

export interface PlayRuntimeConfig {
  readonly schemaVersion: 1;
  readonly mode: 'fixed-step';
  readonly tickRateHz: number;
  readonly maxSubSteps: number;
  readonly seed: string;
}

export interface PreviewPrepareInput { readonly scriptIds?: readonly StableId[]; }

export interface PreviewScriptPlan {
  readonly scriptId: StableId;
  readonly entityId: StableId;
  readonly order: number;
  readonly textRevision: number;
  readonly digest: string;
  readonly capabilities: readonly ScriptCapabilityName[];
  readonly diagnostics: readonly ScriptDiagnostic[];
  readonly emittedText: string;
}

interface WorkerResult {
  readonly id: string;
  readonly diagnostics: readonly ScriptDiagnostic[];
  readonly emittedText: string;
}

function isWorkerResult(value: unknown): value is WorkerResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return typeof result.id === 'string'
    && typeof result.emittedText === 'string'
    && Array.isArray(result.diagnostics)
    && result.diagnostics.every((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const diagnostic = item as Record<string, unknown>;
      return typeof diagnostic.code === 'string'
        && (diagnostic.severity === 'error' || diagnostic.severity === 'warning')
        && typeof diagnostic.path === 'string'
        && Number.isSafeInteger(diagnostic.line) && Number(diagnostic.line) >= 1
        && Number.isSafeInteger(diagnostic.column) && Number(diagnostic.column) >= 1
        && typeof diagnostic.message === 'string';
    });
}

export class ScriptValidationWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<string, Readonly<{ resolve(value: WorkerResult): void; reject(cause: unknown): void }>>();
  private readonly generations = new Map<string, number>();
  private failure: Error | null = null;
  private disposed = false;

  constructor() {
    this.worker = new Worker(new URL('./validation-worker.js', import.meta.url));
    this.worker.on('message', (message: unknown) => {
      if (!isWorkerResult(message)) {
        this.fail(new Error('Script validation worker returned an invalid result.'));
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message);
    });
    this.worker.on('error', (cause) => this.fail(cause));
    this.worker.on('exit', (code) => {
      if (!this.disposed) this.fail(new Error(`Script validation worker exited unexpectedly with code ${code}.`));
    });
  }

  async validate(input: Readonly<{
    scriptId: StableId; textRevision: number; sourcePath: string; text: string; capabilities?: readonly ScriptCapabilityName[];
  }>): Promise<ScriptValidationResult> {
    this.assertActive();
    const capabilities = normalizeCapabilities(input.capabilities, input.text);
    const generation = (this.generations.get(input.scriptId) ?? 0) + 1;
    this.generations.set(input.scriptId, generation);
    const requestId = asStableId(`script-validation:${randomUUID()}`);
    const result = await new Promise<WorkerResult>((resolve, reject) => {
      this.pending.set(requestId, Object.freeze({ resolve, reject }));
      try {
        this.worker.postMessage({
          id: requestId,
          sourcePath: input.sourcePath,
          text: input.text,
          declarations: studioScriptRuntimeDeclarations(capabilities),
        });
      } catch (cause) {
        this.pending.delete(requestId);
        reject(cause);
      }
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
  private fail(cause: unknown): void {
    const failure = cause instanceof Error ? cause : new Error(String(cause));
    this.failure ??= failure;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }
  private assertActive(): void {
    if (this.disposed) throw new Error('Script validation worker is disposed.');
    if (this.failure) throw this.failure;
  }
}

export function studioScriptRuntimeDeclarations(capabilities: readonly ScriptCapabilityName[]): string {
  return `${generateScriptRuntimeDeclarations(capabilities)}
interface HaiyueStudioPointerEvent {
  readonly type: 'move' | 'down' | 'up' | 'cancel' | 'wheel';
  readonly pointerId: number;
  /** Viewport-normalized horizontal coordinate from 0 to 1. */
  readonly x: number;
  /** Viewport-normalized vertical coordinate from 0 to 1. */
  readonly y: number;
  readonly button?: number;
  readonly wheelX?: number;
  readonly wheelY?: number;
}
interface HaiyueScriptInputApi {
  /** Convenience alias for isPressed(action); true on every tick while held. */
  isDown(action: string): boolean;
  /** Pointer-only events with phase exposed as type and normalized x/y coordinates. */
  pointerEvents(): readonly HaiyueStudioPointerEvent[];
}
interface HaiyueStudioInstanceVector { readonly x: number; readonly y: number; readonly z: number; }
interface HaiyueStudioInstanceTransform {
  readonly position: HaiyueStudioInstanceVector;
  readonly rotationDegrees?: HaiyueStudioInstanceVector;
  readonly scale?: HaiyueStudioInstanceVector;
  readonly color?: readonly [number, number, number, number?];
}
interface HaiyueStudioInstanceSet {
  readonly capacity: number;
  setCount(count: number): void;
  set(index: number, transform: HaiyueStudioInstanceTransform): void;
}
interface HaiyueStudioHudTextOptions {
  readonly position?: 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  readonly offsetX?: number;
  readonly offsetY?: number;
  readonly color?: string;
  readonly backgroundColor?: string;
  readonly fontSize?: number;
}
interface HaiyueScriptSceneApi {
  instances(entity: Entity | number | string, capacity: number): HaiyueStudioInstanceSet;
  /** Create or update responsive text in the Play HUD. Reusing id updates in place. */
  hudText(id: string, text: string, options?: HaiyueStudioHudTextOptions): void;
  removeHudText(id: string): void;
}
`;
}

export class ProjectScriptService {
  private readonly listeners = new Set<(snapshot: ScriptCatalogSnapshot) => void>();
  private readonly proposals = new Map<StableId, ScriptEditProposal>();
  private readonly subscription: Readonly<{ dispose(): void }>;
  private current: ScriptCatalogSnapshot;
  private disposed = false;

  constructor(private readonly workspace: ProjectWorkspace, private readonly validator: ScriptValidationWorker, private readonly log: OperationLog) {
    this.current = scriptsFromWorkspace(workspace, workspace.snapshot());
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
    if (this.workspace.queryGameDocument({ entityId: input.entityId, limit: 1 }).entities.length !== 1) throw new Error(`Script entity ${input.entityId} does not exist.`);
    const previous = this.current.resources.find((resource) => resource.entityId === input.entityId);
    const scriptId = previous?.id ?? asStableId(`script:${randomUUID()}`);
    const sourcePath = previous?.sourcePath ?? `scripts/${scriptId.slice('script:'.length)}.ts`;
    const nextTextRevision = (previous?.textRevision ?? 0) + 1;
    const validation = await this.validator.validate({ scriptId, textRevision: nextTextRevision, sourcePath, text: input.text, capabilities: input.capabilities ?? previous?.capabilities });
    if (validation.stale) throw new Error('Script validation result is stale.');
    const id = asStableId(`script-proposal:${randomUUID()}`);
    const diff = lineDiff(previous?.text ?? '', input.text);
    const proposal: ScriptEditProposal = Object.freeze({
      id, entityId: input.entityId, scriptId, baseRevision: input.baseRevision,
      previousTextRevision: previous?.textRevision ?? 0, nextTextRevision, text: input.text,
      digest: digestScript(input.text, validation.capabilities), addedLines: diff.addedLines, removedLines: diff.removedLines,
      capabilities: validation.capabilities, diagnostics: validation.diagnostics, emittedText: validation.emittedText,
    });
    await this.log.append({
      kind: 'script/proposal-ready', severity: hasErrors(proposal.diagnostics) ? 'warning' : 'info', source: asStableId('studio.script'),
      correlation: { documentId: this.current.documentId, entityId: input.entityId, scriptId, revisionId: asStableId(`script-revision:${nextTextRevision}`) },
      payload: { proposalId: id, digest: proposal.digest, addedLines: diff.addedLines, removedLines: diff.removedLines, capabilities: proposal.capabilities, diagnosticCount: proposal.diagnostics.length },
    });
    this.proposals.set(id, proposal);
    return proposal;
  }

  async commitProposal(proposalId: StableId, commandId: StableId, signal?: AbortSignal): Promise<ScriptResourceSnapshot> {
    this.assertActive();
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`Script proposal ${proposalId} is missing or already consumed.`);
    if (hasErrors(proposal.diagnostics)) throw new Error('Script proposal has validation errors.');
    const previous = this.current.resources.find((resource) => resource.id === proposal.scriptId);
    await this.workspace.executeBatch({
      id: commandId, label: 'Edit Entity Script', baseRevision: proposal.baseRevision,
      operations: [{ op: 'script.upsert', script: {
        id: proposal.scriptId, entityId: proposal.entityId, name: previous?.name ?? 'Entity Script',
        sourcePath: previous?.sourcePath ?? `scripts/${proposal.scriptId.slice('script:'.length)}.ts`, source: proposal.text,
        textRevision: proposal.nextTextRevision, enabled: previous?.enabled ?? true, order: previous?.order ?? this.current.resources.length,
        capabilities: proposal.capabilities, digest: sourceDigest(proposal.text),
      } }],
    }, signal);
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
    const next = scriptsFromWorkspace(this.workspace, workspace);
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
  readonly documentId: StableId;
  readonly documentRevision: number;
  readonly selection: 'all-enabled' | 'explicit';
  readonly scriptSetDigest: `sha256:${string}`;
  readonly scripts: readonly PreviewScriptPlan[];
  readonly capabilities: readonly ScriptCapabilityName[];
  readonly runtimeConfig: PlayRuntimeConfig;
  readonly risk: 'trusted-project';
  readonly diagnostics: readonly Readonly<ScriptDiagnostic & { scriptId: StableId; entityId: StableId }>[];
}

export interface PreviewGrant { readonly id: StableId; readonly planId: StableId; readonly expiresAt: number; }

export interface ScriptPreviewStudioService {
  snapshot(): ScriptCatalogSnapshot;
  proposeEdit(input: Readonly<{ entityId: StableId; text: string; baseRevision: number; capabilities?: readonly ScriptCapabilityName[] }>): Promise<ScriptEditProposal>;
  commitProposal(proposalId: StableId, commandId: StableId, signal?: AbortSignal): Promise<ScriptResourceSnapshot>;
  prepare(input?: PreviewPrepareInput): Promise<PreviewPlan>;
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
      const authorization = new PreviewAuthorizationService(scripts, validator, log, Date.now, () => playRuntimeConfigFromScene(scene.snapshot()));
      const service: ScriptPreviewStudioService = Object.freeze({
        snapshot: () => scripts.snapshot(),
        proposeEdit: (input: Parameters<ScriptPreviewStudioService['proposeEdit']>[0]) => {
          if (!scene.snapshot().entities.some((entity) => entity.id === input.entityId)) throw new Error(`Script entity ${input.entityId} does not exist.`);
          return scripts.proposeEdit(input);
        },
        commitProposal: scripts.commitProposal.bind(scripts),
        prepare: async (input?: PreviewPrepareInput) => {
          const plan = await authorization.prepare(input);
          const snapshot = scene.snapshot();
          if (snapshot.documentId !== plan.documentId || snapshot.revision !== plan.documentRevision) throw new Error('Preview scene changed during multi-script validation.');
          const entityIds = new Set(snapshot.entities.map((entity) => entity.id));
          for (const script of plan.scripts) if (!entityIds.has(script.entityId)) throw new Error(`Preview entity ${script.entityId} does not exist.`);
          return plan;
        },
        decide: authorization.decide.bind(authorization),
        consume: authorization.consume.bind(authorization),
      });
      context.services.provide(scriptPreviewServiceToken, service);
      context.effects.own('script-preview.dispose', async () => { authorization.dispose(); scripts.dispose(); await validator.dispose(); });
    },
  });
}

export class PreviewAuthorizationService {
  private readonly plans = new Map<StableId, PreviewPlan>();
  private readonly grants = new Map<StableId, Readonly<{ grant: PreviewGrant; plan: PreviewPlan }>>();
  private readonly subscription: Readonly<{ dispose(): void }>;
  private disposed = false;
  constructor(
    private readonly scripts: ProjectScriptService,
    private readonly validator: ScriptValidationWorker,
    private readonly log: OperationLog,
    private readonly clock: () => number = Date.now,
    private readonly runtimeConfig: () => PlayRuntimeConfig = () => DEFAULT_PLAY_RUNTIME_CONFIG,
  ) {
    let initial = true;
    this.subscription = scripts.subscribe(() => {
      if (initial) { initial = false; return; }
      this.plans.clear(); this.grants.clear();
    });
  }

  async prepare(input: PreviewPrepareInput = {}): Promise<PreviewPlan> {
    this.assertActive();
    const catalog = this.scripts.snapshot();
    const selected = selectPreviewScripts(catalog, input.scriptIds);
    const runtimeConfig = normalizePlayRuntimeConfig(this.runtimeConfig());
    const validations = await Promise.all(selected.map((script) => this.validator.validate({
      scriptId: script.id, textRevision: script.textRevision, sourcePath: script.sourcePath, text: script.text, capabilities: script.capabilities,
    })));
    if (validations.some((validation) => validation.stale)) throw new Error('Multi-script preview validation result is stale.');
    const scripts = Object.freeze(selected.map((script, index): PreviewScriptPlan => {
      const validation = validations[index]!;
      return Object.freeze({
        scriptId: script.id, entityId: script.entityId, order: script.order, textRevision: script.textRevision,
        digest: digestScript(script.text, validation.capabilities), capabilities: validation.capabilities,
        diagnostics: validation.diagnostics, emittedText: validation.emittedText,
      });
    }));
    const capabilities = Object.freeze(SCRIPT_CAPABILITIES.filter((capability) => scripts.some((script) => script.capabilities.includes(capability))));
    const scriptSetDigest = digestScriptSet(catalog.documentId, catalog.documentRevision, runtimeConfig, scripts);
    const diagnostics = Object.freeze(scripts.flatMap((script) => script.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic, scriptId: script.scriptId, entityId: script.entityId }))));
    const plan: PreviewPlan = Object.freeze({
      id: asStableId(`preview-plan:${randomUUID()}`), documentId: catalog.documentId, documentRevision: catalog.documentRevision,
      selection: input.scriptIds === undefined ? 'all-enabled' : 'explicit', scriptSetDigest, scripts, capabilities, runtimeConfig,
      risk: 'trusted-project', diagnostics,
    });
    await this.log.append({
      kind: 'preview/approval-ready', severity: hasErrors(plan.diagnostics) ? 'warning' : 'info', source: asStableId('studio.preview'),
      correlation: { documentId: catalog.documentId },
      payload: { planId: plan.id, scriptSetDigest, scriptCount: scripts.length, scriptIds: scripts.map((script) => script.scriptId), capabilities: plan.capabilities, runtimeConfig: runtimeConfig as unknown as JsonObject, risk: plan.risk, diagnosticCount: plan.diagnostics.length },
    });
    this.plans.set(plan.id, plan);
    return plan;
  }

  async decide(planId: StableId, approved: boolean, ttlMs = 60_000): Promise<PreviewGrant | null> {
    this.assertActive();
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Preview plan ${planId} is missing.`);
    this.plans.delete(planId);
    if (!approved) {
      await this.log.append({ kind: 'preview/authorization-denied', severity: 'warning', source: asStableId('studio.preview'), correlation: { documentId: plan.documentId }, payload: { planId, scriptSetDigest: plan.scriptSetDigest } });
      return null;
    }
    if (hasErrors(plan.diagnostics)) throw new Error('A preview with validation errors cannot be authorized.');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) throw new RangeError('Preview grant TTL must be an integer from 1 to 300000 milliseconds.');
    const grant: PreviewGrant = Object.freeze({ id: asStableId(`preview-grant:${randomUUID()}`), planId, expiresAt: this.clock() + ttlMs });
    await this.log.append({ kind: 'preview/authorized', severity: 'info', source: asStableId('studio.preview'), correlation: { documentId: plan.documentId }, payload: { planId, grantId: grant.id, scriptSetDigest: plan.scriptSetDigest, scriptCount: plan.scripts.length, runtimeConfig: plan.runtimeConfig as unknown as JsonObject, expiresAt: grant.expiresAt } });
    this.grants.set(grant.id, Object.freeze({ grant, plan }));
    return grant;
  }

  consume(grantId: StableId): PreviewPlan {
    this.assertActive();
    const entry = this.grants.get(grantId);
    if (!entry) throw new Error(`Preview grant ${grantId} is missing or already consumed.`);
    this.grants.delete(grantId);
    if (this.clock() > entry.grant.expiresAt) throw new Error('Preview grant expired.');
    const catalog = this.scripts.snapshot();
    if (catalog.documentId !== entry.plan.documentId || catalog.documentRevision !== entry.plan.documentRevision) throw new Error('Preview grant is stale.');
    const selected = selectPreviewScripts(catalog, entry.plan.selection === 'all-enabled' ? undefined : entry.plan.scripts.map((script) => script.scriptId));
    if (selected.length !== entry.plan.scripts.length) throw new Error('Preview grant script set is stale.');
    for (let index = 0; index < selected.length; index += 1) {
      const current = selected[index]!; const planned = entry.plan.scripts[index]!;
      if (current.id !== planned.scriptId || current.entityId !== planned.entityId || current.order !== planned.order || current.textRevision !== planned.textRevision
        || digestScript(current.text, planned.capabilities) !== planned.digest) throw new Error('Preview grant script set is stale.');
    }
    const runtimeConfig = normalizePlayRuntimeConfig(this.runtimeConfig());
    if (JSON.stringify(runtimeConfig) !== JSON.stringify(entry.plan.runtimeConfig)
      || digestScriptSet(catalog.documentId, catalog.documentRevision, runtimeConfig, entry.plan.scripts) !== entry.plan.scriptSetDigest) throw new Error('Preview grant runtime configuration is stale.');
    return entry.plan;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.subscription.dispose(); this.plans.clear(); this.grants.clear();
  }
  private assertActive(): void { if (this.disposed) throw new Error('Preview authorization service is disposed.'); }
}

export interface PreviewRuntimeSnapshot {
  readonly instanceId: StableId | null;
  readonly state: 'stopped' | 'playing' | 'faulted';
  readonly scriptSetDigest: `sha256:${string}` | null;
  readonly scriptCount: number;
  readonly scripts: readonly Readonly<{
    scriptId: StableId; entityId: StableId; order: number; state: 'playing' | 'faulted';
    position: Readonly<{ x: number; y: number; z: number }> | null; disposableCount: number; errorCount: number;
  }>[];
  readonly entityId: StableId | null;
  readonly position: Readonly<{ x: number; y: number; z: number }> | null;
  readonly disposableCount: number;
  readonly errors: readonly Readonly<{ scriptId: StableId; entityId: StableId; code: string; path: string; line: number | null; column: number | null; message: string }>[];
}

interface PreviewScriptOwner { readonly plan: PreviewScriptPlan; readonly resource: ScriptResource; readonly component: ScriptComponent; readonly entity: Entity; }

export class IsolatedTrustedPreviewRuntime {
  private world: World | null = null;
  private readonly owners: PreviewScriptOwner[] = [];
  private readonly planByComponent = new Map<ScriptComponent, PreviewScriptPlan>();
  private scriptSetDigest: `sha256:${string}` | null = null;
  private instanceId: StableId | null = null;
  private errors: PreviewRuntimeSnapshot['errors'] = Object.freeze([]);
  private lifecycleTail: Promise<void> = Promise.resolve();

  constructor(private readonly log: OperationLog) {}

  async start(scene: SceneSnapshot, plan: PreviewPlan): Promise<PreviewRuntimeSnapshot> {
    return this.enqueueLifecycle(() => this.startNow(scene, plan));
  }

  private async startNow(scene: SceneSnapshot, plan: PreviewPlan): Promise<PreviewRuntimeSnapshot> {
    await this.stopNow('restart');
    if (scene.documentId !== plan.documentId || scene.revision !== plan.documentRevision) throw new Error('Preview plan does not match the Scene document revision.');
    if (plan.scripts.length < 1 || plan.scripts.length > MAX_PLAY_SCRIPTS) throw new Error(`Preview plan must contain 1-${MAX_PLAY_SCRIPTS} scripts.`);
    const world = new World('AIStudio Isolated Preview');
    try {
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
      this.errors = Object.freeze([]);
      ScriptComponent.setRuntimeApiFactory((base, context) => filterRuntimeApi(base, context, this.planByComponent));
      ScriptComponent.enableTrustedProject({
        capabilities: plan.capabilities,
        errorPolicy: 'disable-script',
        onError: (event) => this.captureError(event),
      });
      for (const script of plan.scripts) {
        const entity = entities.get(script.entityId);
        if (!entity) throw new Error(`Preview entity ${script.entityId} does not exist.`);
        const resource = new ScriptResource({ name: script.scriptId, sourcePath: `scripts/${script.scriptId}.ts`, scripts: { onUpdate: script.emittedText } });
        const component = new ScriptComponent({}, resource);
        this.planByComponent.set(component, script);
        entity.addComponent(component);
        this.owners.push(Object.freeze({ plan: script, resource, component, entity }));
      }
      this.world = world; this.scriptSetDigest = plan.scriptSetDigest;
      this.instanceId = asStableId(`preview-instance:${randomUUID()}`);
      await this.log.append({ kind: 'preview/started', severity: 'info', source: asStableId('studio.preview'), correlation: { documentId: plan.documentId, previewId: this.instanceId }, payload: { scriptSetDigest: plan.scriptSetDigest, scriptCount: plan.scripts.length, scriptIds: plan.scripts.map((script) => script.scriptId), capabilities: plan.capabilities, runtimeConfig: plan.runtimeConfig as unknown as JsonObject, risk: plan.risk } });
      return this.snapshot();
    } catch (cause) {
      this.releaseScriptOwners();
      world.destroy();
      ScriptComponent.resetRuntimeApiFactory();
      ScriptComponent.resetExecutionOptions();
      this.world = null; this.scriptSetDigest = null; this.instanceId = null;
      await this.log.append({ kind: 'preview/start-failed', severity: 'error', source: asStableId('studio.preview'), correlation: { documentId: plan.documentId }, payload: { scriptSetDigest: plan.scriptSetDigest, message: cause instanceof Error ? cause.message : String(cause) } }).catch(() => {});
      throw cause;
    }
  }

  tick(time: number, delta: number): PreviewRuntimeSnapshot {
    if (!this.world) throw new Error('Preview is not playing.');
    this.world.update(time, delta);
    return this.snapshot();
  }

  hotReload(scriptId: StableId, emittedText: string): PreviewRuntimeSnapshot {
    const owner = this.owners.find((candidate) => candidate.plan.scriptId === scriptId);
    if (!owner) throw new Error(`Preview script ${scriptId} is not playing.`);
    owner.resource.setScript('onUpdate', emittedText);
    this.errors = Object.freeze(this.errors.filter((error) => error.scriptId !== scriptId));
    return this.snapshot();
  }

  snapshot(): PreviewRuntimeSnapshot {
    const scripts = Object.freeze(this.owners.map((owner) => {
      const transform = owner.entity.getComponent(CartesianTransform3D);
      const position = transform ? Object.freeze({ x: transform.position[0]!, y: transform.position[1]!, z: transform.position[2]! }) : null;
      const errorCount = this.errors.filter((error) => error.scriptId === owner.plan.scriptId).length;
      return Object.freeze({ scriptId: owner.plan.scriptId, entityId: owner.plan.entityId, order: owner.plan.order, state: errorCount > 0 ? 'faulted' as const : 'playing' as const, position, disposableCount: owner.component.disposableCount, errorCount });
    }));
    const primary = scripts[0] ?? null;
    return Object.freeze({
      instanceId: this.instanceId,
      state: !this.world ? 'stopped' : this.errors.length > 0 ? 'faulted' : 'playing',
      scriptSetDigest: this.scriptSetDigest,
      scriptCount: scripts.length,
      scripts,
      entityId: primary?.entityId ?? null,
      position: primary?.position ?? null,
      disposableCount: scripts.reduce((sum, script) => sum + script.disposableCount, 0),
      errors: this.errors,
    });
  }

  async stop(reason = 'user'): Promise<PreviewRuntimeSnapshot> {
    return this.enqueueLifecycle(() => this.stopNow(reason));
  }

  private async stopNow(reason: string): Promise<PreviewRuntimeSnapshot> {
    if (!this.world) return this.snapshot();
    const instanceId = this.instanceId;
    const disposableCount = this.owners.reduce((sum, owner) => sum + owner.component.disposableCount, 0);
    const scriptCount = this.owners.length;
    this.releaseScriptOwners();
    this.world.destroy();
    ScriptComponent.resetRuntimeApiFactory();
    ScriptComponent.resetExecutionOptions();
    this.world = null; this.scriptSetDigest = null; this.instanceId = null;
    await this.log.append({ kind: 'preview/stopped', severity: 'info', source: asStableId('studio.preview'), correlation: { previewId: instanceId ?? undefined }, payload: { reason, scriptCount, disposedSideEffects: disposableCount } });
    return this.snapshot();
  }

  private async enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTail;
    let release!: () => void;
    this.lifecycleTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  private captureError(event: ScriptRuntimeErrorEvent): void {
    const plan = this.planByComponent.get(event.component);
    if (!plan) return;
    const error = Object.freeze({
      scriptId: plan.scriptId,
      entityId: plan.entityId,
      code: event.error.code,
      path: event.error.path ?? '',
      line: event.sourceLocation.line,
      column: event.sourceLocation.column,
      message: event.error.message,
    });
    this.errors = Object.freeze([...this.errors, error]);
    void this.log.append({ kind: 'preview/runtime-error', severity: 'error', source: asStableId('studio.preview'), correlation: { entityId: plan.entityId, scriptId: plan.scriptId, previewId: this.instanceId ?? undefined }, payload: error }).catch(() => {});
  }

  private releaseScriptOwners(): void {
    for (const owner of this.owners.splice(0).reverse()) {
      owner.entity.removeComponent(owner.component);
      owner.component.destroy();
      this.planByComponent.delete(owner.component);
    }
    this.planByComponent.clear();
  }
}

function scriptsFromWorkspace(owner: ProjectWorkspace, workspace: ProjectWorkspaceSnapshot): ScriptCatalogSnapshot {
  const document = workspace.document;
  if (!document) return freezeCatalog({ schemaVersion: 1, documentId: asStableId('document:none'), documentRevision: 0, resources: [] });
  const resources = owner.scriptsSnapshot().map((script) => Object.freeze({
    id: asStableId(script.id, 'script id'), entityId: asStableId(script.entityId, 'script entity id'), name: script.name,
    sourcePath: script.sourcePath, text: script.source, textRevision: script.textRevision, enabled: script.enabled, order: script.order,
    capabilities: Object.freeze(normalizeStoredCapabilities(script.capabilities)), digest: script.digest, dirty: document.dirty,
  }));
  return freezeCatalog({ schemaVersion: 1, documentId: document.documentId, documentRevision: document.revision, resources });
}

export function playRuntimeConfigFromScene(scene: SceneSnapshot): PlayRuntimeConfig {
  const component = scene.entities.flatMap((entity) => entity.components ?? []).find((value) => value.enabled && value.type === 'haiyue.simulation.settings');
  if (!component) return DEFAULT_PLAY_RUNTIME_CONFIG;
  return normalizePlayRuntimeConfig({ schemaVersion: 1, mode: 'fixed-step', tickRateHz: component.value.tickRateHz, maxSubSteps: component.value.maxSubSteps, seed: component.value.seed });
}

function normalizePlayRuntimeConfig(value: unknown): PlayRuntimeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Play runtime config must be an object.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['schemaVersion', 'mode', 'tickRateHz', 'maxSubSteps', 'seed'].includes(key))
    || input.schemaVersion !== 1 || input.mode !== 'fixed-step'
    || typeof input.tickRateHz !== 'number' || !Number.isFinite(input.tickRateHz) || input.tickRateHz < 1 || input.tickRateHz > 240
    || !Number.isSafeInteger(input.maxSubSteps) || Number(input.maxSubSteps) < 1 || Number(input.maxSubSteps) > 10_000
    || typeof input.seed !== 'string' || input.seed.length < 1 || input.seed.length > 256) throw new TypeError('Play runtime config is invalid.');
  return Object.freeze({ schemaVersion: 1, mode: 'fixed-step', tickRateHz: input.tickRateHz, maxSubSteps: Number(input.maxSubSteps), seed: input.seed });
}

function selectPreviewScripts(catalog: ScriptCatalogSnapshot, requestedIds: readonly StableId[] | undefined): readonly ScriptResourceSnapshot[] {
  if (requestedIds !== undefined && (!Array.isArray(requestedIds) || requestedIds.length < 1 || requestedIds.length > MAX_PLAY_SCRIPTS)) throw new RangeError(`Preview scriptIds must contain 1-${MAX_PLAY_SCRIPTS} ids.`);
  if (requestedIds && new Set(requestedIds).size !== requestedIds.length) throw new TypeError('Preview scriptIds must be unique.');
  const requested = requestedIds ? new Set(requestedIds) : null;
  const selected = catalog.resources
    .filter((script) => requested ? requested.has(script.id) : script.enabled)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  if (requested && selected.length !== requested.size) throw new Error('One or more requested preview scripts do not exist.');
  if (selected.some((script) => !script.enabled)) throw new Error('Disabled scripts cannot enter a preview plan.');
  if (selected.length < 1) throw new Error('Preview requires at least one enabled committed script.');
  if (selected.length > MAX_PLAY_SCRIPTS) throw new Error(`Preview exceeds the ${MAX_PLAY_SCRIPTS}-script budget.`);
  if (new Set(selected.map((script) => script.entityId)).size !== selected.length) throw new Error('Only one enabled preview script may bind to each entity.');
  return Object.freeze(selected);
}

function digestScriptSet(documentId: StableId, documentRevision: number, runtimeConfig: PlayRuntimeConfig, scripts: readonly PreviewScriptPlan[]): `sha256:${string}` {
  const value = JSON.stringify({
    schemaVersion: 1, documentId, documentRevision, runtimeConfig,
    scripts: scripts.map((script) => ({ scriptId: script.scriptId, entityId: script.entityId, order: script.order, textRevision: script.textRevision, digest: script.digest, capabilities: script.capabilities })),
  });
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function filterRuntimeApi(base: ScriptRuntimeApi, context: ScriptRuntimeContext, plans: ReadonlyMap<ScriptComponent, PreviewScriptPlan>): ScriptRuntimeApi {
  const plan = plans.get(context.component);
  if (!plan) return Object.freeze({});
  const source = base as unknown as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const capability of plan.capabilities) if (source[capability] !== undefined) output[capability] = source[capability];
  return Object.freeze(output) as unknown as ScriptRuntimeApi;
}

function freezeCatalog(value: ScriptCatalogSnapshot): ScriptCatalogSnapshot { return Object.freeze({ ...value, resources: Object.freeze(value.resources.map((item) => Object.freeze(item))) }); }
function normalizeStoredCapabilities(value: readonly string[]): ScriptCapabilityName[] { const output: ScriptCapabilityName[] = []; for (const item of value) { if (!SCRIPT_CAPABILITIES.includes(item as ScriptCapabilityName)) throw new TypeError(`Unknown stored script capability ${item}.`); output.push(item as ScriptCapabilityName); } return output; }
function normalizeCapabilities(value: readonly ScriptCapabilityName[] | undefined, text = ''): readonly ScriptCapabilityName[] {
  const requested = value ?? DEFAULT_SCRIPT_CAPABILITIES;
  const inferred = usesSceneApi(text) ? ['scene' as const] : [];
  const physics = usesPhysicsApi(text) ? ['physics' as const] : [];
  const unique = [...new Set([...requested, ...inferred, ...physics])];
  for (const capability of unique) if (!SCRIPT_CAPABILITIES.includes(capability)) throw new TypeError(`Unknown script capability ${capability}.`);
  return Object.freeze(unique);
}
function usesPhysicsApi(text: string): boolean {
  return /\bapi\s*(?:\.|\?\.)\s*physics\b/u.test(text)
    || /\bapi\s*(?:\?\.)?\[\s*(['"])physics\1\s*\]/u.test(text);
}
function usesSceneApi(text: string): boolean {
  return /\bapi\s*(?:\.|\?\.)\s*scene\b/u.test(text)
    || /\bapi\s*(?:\?\.)?\[\s*(['"])scene\1\s*\]/u.test(text);
}
function assertScriptText(text: unknown): asserts text is string { if (typeof text !== 'string' || text.length > 100_000 || text.includes('\0')) throw new TypeError('Script text must be a bounded string without NUL bytes.'); }
function digestScript(text: string, capabilities: readonly ScriptCapabilityName[]): string { return createHash('sha256').update(text).update('\0').update(capabilities.join(',')).digest('hex'); }
function sourceDigest(text: string): `sha256:${string}` { return `sha256:${createHash('sha256').update(text).digest('hex')}`; }
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
export * from './effects/index.js';
