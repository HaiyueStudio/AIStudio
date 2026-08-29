import { randomUUID } from 'node:crypto';
import { asStableId, type ComponentDefinitionV2, type GameComponentInstanceV2, type JsonObject, type JsonValue, type StableId } from '@haiyue/ai-studio-contracts';
import { isSceneGeometryKind, isSceneMaterialKind, normalizeProjectCamera, projectCameraFromSettings, PROJECT_CAMERA_SETTING_KEY, type ProjectWorkspace, type SceneAuthoringService, type SceneEntityKind, type SceneMaterialColor, type TransformSnapshot } from '@haiyue/ai-studio-editor-plugins';
import { CONTROLLED_ASSET_CATALOG_SETTING_KEY, ControlledAssetCatalog, ControlledAssetError, type ControlledAssetKind, type ControlledAssetLicense } from '@haiyue/ai-studio-editor-plugins/assets';
import { canonicalStringify, sha256, type DiagnosticsQueryService, type OperationEventInput, type OperationLog, type OperationLogQuery } from '@haiyue/ai-studio-operation-log';
import type { PreviewPlan, ScriptCapabilityName, ScriptEditProposal, ScriptPreviewStudioService } from '@haiyue/ai-studio-script-preview';
import { GAME_AUTHORING_TOOL_BY_ID, GAME_AUTHORING_TOOL_DEFINITIONS } from './definitions.js';
import {
  GameToolProtocolError,
  type GamePreviewControl,
  type GameToolApproval,
  type GameToolApprovalResolution,
  type GameToolCall,
  type GameToolDefinition,
  type GameToolPreparation,
  type GameToolPreview,
  type GameToolResult,
  type GameToolRuntimeSnapshot,
} from './types.js';

export interface GameAuthoringToolRuntimeOptions {
  readonly workspace: ProjectWorkspace;
  readonly scene: SceneAuthoringService;
  readonly scripts: ScriptPreviewStudioService;
  readonly diagnostics: DiagnosticsQueryService;
  readonly operationLog: OperationLog;
  readonly preview: GamePreviewControl;
  readonly timeoutCeilingMs?: number;
}

interface StoredPreparation {
  readonly call: GameToolCall;
  readonly definition: GameToolDefinition;
  readonly arguments: JsonObject;
  readonly preview: GameToolPreview;
  view: GameToolPreparation;
  approval?: GameToolApproval;
  approvalScopeDigest?: string;
}

export class GameAuthoringToolRuntime {
  private readonly preparations = new Map<StableId, StoredPreparation>();
  private readonly proposals = new Map<StableId, ScriptEditProposal>();
  private readonly previewPlans = new Map<StableId, PreviewPlan>();
  private readonly active = new Map<StableId, AbortController>();
  private readonly approvalGrants = new Set<string>();
  private mutationTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: GameAuthoringToolRuntimeOptions) {
    if (options.timeoutCeilingMs !== undefined && (!Number.isSafeInteger(options.timeoutCeilingMs) || options.timeoutCeilingMs < 1 || options.timeoutCeilingMs > 20_000)) throw new TypeError('Tool timeout ceiling must be between one millisecond and twenty seconds.');
  }

  definitions(): readonly GameToolDefinition[] { this.assertActive(); return GAME_AUTHORING_TOOL_DEFINITIONS; }
  snapshot(): GameToolRuntimeSnapshot { return Object.freeze({ definitions: GAME_AUTHORING_TOOL_DEFINITIONS, pendingPreparations: this.preparations.size, pendingApprovals: [...this.preparations.values()].filter((item) => item.approval?.decision === 'pending').length, activeCalls: this.active.size, activeApprovalGrants: this.approvalGrants.size, disposed: this.disposed }); }

  async prepare(value: unknown, signal?: AbortSignal): Promise<GameToolPreparation> {
    this.assertActive();
    const call = validateToolCall(value);
    let definition = GAME_AUTHORING_TOOL_BY_ID.get(call.toolId);
    if (!definition || call.toolVersion !== definition.version) {
      await this.options.operationLog.append({
        kind: 'tool/call-rejected', severity: 'warning', source: asStableId('studio.game-tools'), correlation: correlation(call),
        payload: { toolId: call.toolId, toolVersion: call.toolVersion, argumentsDigest: sha256(canonicalStringify(call.arguments)), code: 'tool.not-found' },
      }, { signal }).catch(() => undefined);
      throw new GameToolProtocolError('tool.not-found', `Tool ${call.toolId}@${call.toolVersion} is not registered.`);
    }
    const receivedArgumentsDigest = sha256(canonicalStringify(call.arguments));
    await this.appendFact(definition, {
      kind: 'tool/call-received', severity: 'info', source: asStableId('studio.game-tools'), correlation: correlation(call),
      payload: { toolId: definition.id, toolVersion: definition.version, effect: definition.effect, risk: definition.risk, argumentsDigest: receivedArgumentsDigest },
    }, signal);
    try {
      const document = requireDocument(this.options.workspace);
      const args = normalizeArguments(definition.id, call.arguments, document.revision);
      definition = resolveComponentToolPolicy(definition, args, this.options.workspace);
      enforceLogHealth(definition.id, definition.effect, this.options.operationLog.status());
      await this.appendFact(definition, {
        kind: 'tool/pre-policy-passed', severity: 'info', source: asStableId('studio.game-tools'), correlation: correlation(call),
        payload: { toolId: definition.id, effect: definition.effect, documentId: document.documentId, currentRevision: document.revision },
      }, signal);
      const requestedRevision = readBaseRevision(args);
      if (requestedRevision !== undefined && requestedRevision !== document.revision) throw new GameToolProtocolError('tool.stale-revision', `Tool expected document revision ${requestedRevision}; current revision is ${document.revision}.`, true);
      const preview = buildPreview(definition.id, args, this.options.scene, this.proposals, this.previewPlans);
      const argumentsDigest = sha256(canonicalStringify(args));
      const previewDigest = sha256(canonicalStringify(preview as unknown as JsonObject));
      const preparationId = asStableId(`tool-preparation:${randomUUID()}`);
      const approvalScopeDigest = definition.requiresApproval && definition.effect === 'reversible-edit'
        ? approvalGrantDigest(document.documentId, call.sessionId, definition, preview.target) : undefined;
      const autoAllowed = approvalScopeDigest !== undefined && this.approvalGrants.has(approvalScopeDigest);
      const approvalId = definition.requiresApproval && !autoAllowed ? asStableId(`approval:${randomUUID()}`) : undefined;
      const status = approvalId ? 'approval-required' : 'ready';
      const view: GameToolPreparation = Object.freeze({
        schemaVersion: 1, id: preparationId, callId: call.id, sessionId: call.sessionId, turnId: call.turnId,
        toolId: definition.id, toolVersion: definition.version, effect: definition.effect, risk: definition.risk,
        documentId: document.documentId, baseRevision: document.revision, argumentsDigest, previewDigest, preview, status,
        ...(approvalId ? { approvalId } : {}),
      });
      const stored: StoredPreparation = { call, definition, arguments: args, preview, view, ...(approvalScopeDigest ? { approvalScopeDigest } : {}) };
      if (approvalId) stored.approval = Object.freeze({
        schemaVersion: 1, approvalId, preparationId, sessionId: call.sessionId, turnId: call.turnId, toolCallId: call.id,
        toolId: definition.id, toolVersion: definition.version,
        effect: definition.effect as Exclude<GameToolDefinition['effect'], 'observe'>,
        risk: definition.risk as Exclude<GameToolDefinition['risk'], 'low'>,
        argumentsDigest, previewDigest, documentId: document.documentId, baseRevision: document.revision, target: preview.target, decision: 'pending',
      });
      await this.appendFact(definition, {
        kind: 'tool/preview-prepared', severity: 'info', source: asStableId('studio.game-tools'), correlation: correlation(call, approvalId),
        payload: { preparationId, toolId: definition.id, argumentsDigest, previewDigest, documentId: document.documentId, baseRevision: document.revision, status },
      }, signal);
      if (stored.approval) await this.appendFact(definition, {
        kind: 'approval/requested', severity: 'warning', source: asStableId('studio.game-tools'), correlation: correlation(call, stored.approval.approvalId),
        payload: { preparationId, toolId: definition.id, effect: definition.effect, risk: definition.risk, target: preview.target, argumentsDigest, previewDigest, documentId: document.documentId, baseRevision: document.revision },
      }, signal);
      else if (autoAllowed && approvalScopeDigest) await this.appendFact(definition, {
        kind: 'approval/auto-allowed', severity: 'info', source: asStableId('studio.game-tools'), correlation: correlation(call),
        payload: { preparationId, toolId: definition.id, toolVersion: definition.version, effect: definition.effect, risk: definition.risk, target: preview.target, documentId: document.documentId, scope: 'project-session', scopeDigest: approvalScopeDigest, argumentsDigest, previewDigest },
      }, signal);
      this.preparations.set(preparationId, stored);
      return view;
    } catch (cause) {
      await this.options.operationLog.append({
        kind: 'tool/preparation-failed', severity: 'error', source: asStableId('studio.game-tools'), correlation: correlation(call),
        payload: { toolId: definition.id, toolVersion: definition.version, argumentsDigest: receivedArgumentsDigest, code: errorCode(cause), message: errorMessage(cause) },
      }).catch(() => undefined);
      throw cause;
    }
  }

  approval(id: StableId): GameToolApproval | undefined { this.assertActive(); return [...this.preparations.values()].find((item) => item.approval?.approvalId === id)?.approval; }

  async decide(approvalId: StableId, decision: GameToolApprovalResolution): Promise<GameToolApproval> {
    this.assertActive();
    const stored = [...this.preparations.values()].find((item) => item.approval?.approvalId === approvalId);
    if (!stored?.approval || stored.approval.decision !== 'pending') throw new GameToolProtocolError('approval.unavailable', `Approval ${approvalId} is not pending.`);
    const invalidation = await this.invalidatePendingApproval(stored);
    if (invalidation) throw new GameToolProtocolError(`approval.${invalidation}`, `Approval ${approvalId} is ${invalidation}; prepare the operation again.`, invalidation === 'stale');
    if (decision === 'allow-always' && stored.definition.effect !== 'reversible-edit') {
      await this.options.operationLog.append({
        kind: 'approval/decision-rejected', severity: 'warning', source: asStableId('studio.game-tools'), correlation: correlation(stored.call, approvalId),
        payload: { preparationId: stored.view.id, toolId: stored.definition.id, requestedDecision: decision, code: 'approval.scope-forbidden', effect: stored.definition.effect },
      });
      throw new GameToolProtocolError('approval.scope-forbidden', 'Allow always is available only for reversible editor operations; trusted code and runtime start require exact one-shot approval.');
    }
    const nextDecision = decision;
    await this.options.operationLog.append({
      kind: `approval/${nextDecision}`, severity: isAllowDecision(nextDecision) ? 'info' : 'warning', source: asStableId('studio.game-tools'),
      correlation: correlation(stored.call, approvalId), payload: { preparationId: stored.view.id, toolId: stored.definition.id, toolVersion: stored.definition.version, decision: nextDecision, scope: nextDecision === 'allow-always' ? 'project-session' : 'operation', scopeDigest: stored.approvalScopeDigest ?? null, target: stored.preview.target, documentId: stored.view.documentId, argumentsDigest: stored.view.argumentsDigest, previewDigest: stored.view.previewDigest },
    });
    if (nextDecision === 'allow-always' && stored.approvalScopeDigest) this.approvalGrants.add(stored.approvalScopeDigest);
    stored.approval = Object.freeze({ ...stored.approval, decision: nextDecision });
    stored.view = Object.freeze({ ...stored.view, status: isAllowDecision(nextDecision) ? 'ready' : 'rejected' });
    return stored.approval;
  }

  async execute(preparationId: StableId, signal?: AbortSignal): Promise<GameToolResult> {
    this.assertActive();
    const stored = this.preparations.get(preparationId);
    if (!stored) throw new GameToolProtocolError('tool.preparation-missing', `Preparation ${preparationId} is missing or consumed.`);
    if (stored.view.status === 'rejected' && !stored.approval) return this.finishWithoutExecution(stored, 'cancelled');
    if (stored.approval?.decision === 'pending') {
      const invalidation = await this.invalidatePendingApproval(stored);
      if (invalidation) return this.finishWithoutExecution(stored, 'rejected');
    }
    if (stored.approval?.decision === 'pending') throw new GameToolProtocolError('approval.required', 'The exact tool operation still requires approval.');
    if (stored.approval && !isAllowDecision(stored.approval.decision)) return this.finishWithoutExecution(stored, stored.approval.decision === 'cancel' ? 'cancelled' : 'rejected');
    const operation = () => this.executeStored(stored, signal);
    return stored.definition.effect === 'observe' || stored.definition.id === 'script.propose' || stored.definition.id === 'preview.validate' || stored.definition.id === 'preview.stop'
      ? operation() : this.serializeMutation(operation);
  }

  async cancel(callId: StableId): Promise<void> {
    this.active.get(callId)?.abort(new GameToolProtocolError('tool.cancelled', 'Tool call was cancelled.'));
    const facts: Promise<unknown>[] = [];
    for (const stored of this.preparations.values()) if (stored.call.id === callId && stored.view.status !== 'consumed') {
      stored.view = Object.freeze({ ...stored.view, status: 'rejected' });
      if (stored.approval?.decision === 'pending') stored.approval = Object.freeze({ ...stored.approval, decision: 'cancel' });
      facts.push(this.options.operationLog.append({ kind: 'tool/cancelled', severity: 'warning', source: asStableId('studio.game-tools'), correlation: correlation(stored.call, stored.approval?.approvalId), payload: { preparationId: stored.view.id, toolId: stored.definition.id } }).catch(() => {}));
    }
    await Promise.all(facts);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.active.values()) controller.abort(new GameToolProtocolError('tool.runtime-disposed', 'Game tool runtime disposed.'));
    this.active.clear(); this.preparations.clear(); this.proposals.clear(); this.previewPlans.clear(); this.approvalGrants.clear();
  }

  private async executeStored(stored: StoredPreparation, signal?: AbortSignal): Promise<GameToolResult> {
    enforceLogHealth(stored.definition.id, stored.definition.effect, this.options.operationLog.status());
    const document = requireDocument(this.options.workspace);
    if (document.documentId !== stored.view.documentId || document.revision !== stored.view.baseRevision) {
      stored.view = Object.freeze({ ...stored.view, status: 'stale' });
      if (stored.approval) stored.approval = Object.freeze({ ...stored.approval, decision: 'stale' });
      this.preparations.delete(stored.view.id);
      throw new GameToolProtocolError('tool.stale-revision', 'Document changed after preparation; prepare the tool again.', true);
    }
    if (sha256(canonicalStringify(stored.arguments)) !== stored.view.argumentsDigest || sha256(canonicalStringify(stored.preview as unknown as JsonObject)) !== stored.view.previewDigest) { this.preparations.delete(stored.view.id); throw new GameToolProtocolError('approval.digest-mismatch', 'Prepared arguments or preview changed.'); }
    this.preparations.delete(stored.view.id);
    stored.view = Object.freeze({ ...stored.view, status: 'consumed' });
    const controller = new AbortController();
    const unlink = fuseAbort(signal, controller);
    this.active.set(stored.call.id, controller);
    const timeoutMs = Math.min(stored.definition.timeoutMs, this.options.timeoutCeilingMs ?? stored.definition.timeoutMs);
    const timer = setTimeout(() => controller.abort(new GameToolProtocolError('tool.timeout', `Tool ${stored.definition.id} exceeded ${timeoutMs} ms.`, true)), timeoutMs);
    try {
      await this.appendFact(stored.definition, { kind: 'tool/execution-started', severity: 'info', source: asStableId('studio.game-tools'), correlation: correlation(stored.call, stored.approval?.approvalId), payload: { preparationId: stored.view.id, toolId: stored.definition.id, argumentsDigest: stored.view.argumentsDigest, previewDigest: stored.view.previewDigest } }, controller.signal);
      const value = await executeHandler(stored, this.options, this.proposals, this.previewPlans, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason ?? new GameToolProtocolError('tool.cancelled', 'Tool call was cancelled.');
      assertResultBudget(value, stored.definition.maxResultBytes);
      const after = requireDocument(this.options.workspace);
      const result: GameToolResult = Object.freeze({
        schemaVersion: 1, callId: stored.call.id, toolId: stored.definition.id, status: 'completed', value,
        documentId: after.documentId, beforeRevision: stored.view.baseRevision, afterRevision: after.revision,
        ...(historyLabel(stored.definition.id) ? { historyLabel: historyLabel(stored.definition.id) } : {}),
      });
      await this.appendFact(stored.definition, { kind: 'tool/execution-completed', severity: 'info', source: asStableId('studio.game-tools'), correlation: correlation(stored.call, stored.approval?.approvalId), payload: { toolId: stored.definition.id, beforeRevision: result.beforeRevision, afterRevision: result.afterRevision, resultDigest: sha256(canonicalStringify(value)), historyLabel: result.historyLabel ?? null } });
      return result;
    } catch (cause) {
      await this.appendFact(stored.definition, { kind: 'tool/execution-failed', severity: 'error', source: asStableId('studio.game-tools'), correlation: correlation(stored.call, stored.approval?.approvalId), payload: { toolId: stored.definition.id, code: cause instanceof GameToolProtocolError ? cause.code : 'tool.execution-failed', message: errorMessage(cause) } }).catch(() => {});
      throw cause;
    } finally {
      clearTimeout(timer); unlink(); this.active.delete(stored.call.id);
    }
  }

  private async finishWithoutExecution(stored: StoredPreparation, status: 'rejected' | 'cancelled'): Promise<GameToolResult> {
    this.preparations.delete(stored.view.id); stored.view = Object.freeze({ ...stored.view, status: 'consumed' });
    const result: GameToolResult = Object.freeze({ schemaVersion: 1, callId: stored.call.id, toolId: stored.definition.id, status, value: Object.freeze({ decision: stored.approval?.decision ?? status }), documentId: stored.view.documentId, beforeRevision: stored.view.baseRevision, afterRevision: requireDocument(this.options.workspace).revision });
    await this.options.operationLog.append({ kind: 'tool/execution-skipped', severity: 'warning', source: asStableId('studio.game-tools'), correlation: correlation(stored.call, stored.approval?.approvalId), payload: { preparationId: stored.view.id, toolId: stored.definition.id, status, decision: stored.approval?.decision ?? status } }).catch(() => {});
    return result;
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => {}, () => {});
    return result;
  }
  private async appendFact(definition: GameToolDefinition, event: OperationEventInput, signal?: AbortSignal): Promise<void> {
    try { await this.options.operationLog.append(event, { signal }); }
    catch (cause) {
      if (signal?.aborted) throw signal.reason ?? cause;
      if (definition.effect === 'observe') return;
      throw new GameToolProtocolError('tool.log-unavailable', `Operation Log rejected ${definition.id}: ${errorMessage(cause)}`);
    }
  }
  private async invalidatePendingApproval(stored: StoredPreparation): Promise<'stale' | null> {
    const approval = stored.approval;
    if (!approval || approval.decision !== 'pending') return null;
    let invalidation: 'stale' | null = null;
    const document = this.options.workspace.snapshot().document;
    if (!document || document.documentId !== approval.documentId || document.revision !== approval.baseRevision
      || sha256(canonicalStringify(stored.arguments)) !== approval.argumentsDigest
      || sha256(canonicalStringify(stored.preview as unknown as JsonObject)) !== approval.previewDigest) invalidation = 'stale';
    if (!invalidation) return null;
    stored.approval = Object.freeze({ ...approval, decision: invalidation });
    stored.view = Object.freeze({ ...stored.view, status: 'stale' });
    await this.options.operationLog.append({
      kind: `approval/${invalidation}`, severity: 'warning', source: asStableId('studio.game-tools'), correlation: correlation(stored.call, approval.approvalId),
      payload: { preparationId: stored.view.id, toolId: stored.definition.id, toolVersion: stored.definition.version, target: stored.preview.target, documentId: stored.view.documentId, baseRevision: stored.view.baseRevision, argumentsDigest: stored.view.argumentsDigest, previewDigest: stored.view.previewDigest },
    });
    return invalidation;
  }
  private assertActive(): void { if (this.disposed) throw new GameToolProtocolError('tool.runtime-disposed', 'Game tool runtime is disposed.'); }
}

async function executeHandler(stored: StoredPreparation, options: GameAuthoringToolRuntimeOptions, proposals: Map<StableId, ScriptEditProposal>, plans: Map<StableId, PreviewPlan>, signal: AbortSignal): Promise<JsonObject> {
  const args = stored.arguments as Record<string, JsonValue>;
  const scene = options.scene.snapshot();
  switch (stored.definition.id) {
    case 'project.snapshot': {
      const workspace = options.workspace.snapshot(); const document = requireDocument(options.workspace);
      return Object.freeze({ projectId: document.projectId, documentId: document.documentId, name: document.name, revision: document.revision, savedRevision: document.savedRevision, dirty: document.dirty, sceneRevision: scene.revision, camera: projectCameraFromSettings(document.settings) as unknown as JsonValue, logHealth: workspace.logging.health });
    }
    case 'engine.capabilities.describe': {
      const manifest = options.workspace.componentRegistry.capabilityManifest();
      return Object.freeze({ registryDigest: manifest.registryDigest, componentCount: manifest.components.length, components: manifest.components as unknown as JsonValue });
    }
    case 'component.describe': {
      const definition = resolveComponentDefinition(options.workspace, args.type as string, args.version as string | undefined);
      return Object.freeze({ definition: definition as unknown as JsonValue });
    }
    case 'component.get': {
      const target = resolveComponentTarget(options.workspace, args);
      return Object.freeze({ documentId: scene.documentId, revision: scene.revision, entityId: target.entityId, component: target.component as unknown as JsonValue });
    }
    case 'camera.get': {
      const document = requireDocument(options.workspace);
      return Object.freeze({ documentId: document.documentId, revision: document.revision, camera: projectCameraFromSettings(document.settings) as unknown as JsonValue });
    }
    case 'scene.list-entities': return Object.freeze({ documentId: scene.documentId, revision: scene.revision, entities: Object.freeze(scene.entities.slice(0, 200).map(entitySummary)), truncated: scene.entities.length > 200 });
    case 'entity.get': return Object.freeze({ documentId: scene.documentId, revision: scene.revision, entity: entitySummary(requireEntity(scene, args.entityId as StableId)) });
    case 'script.get': {
      const catalog = options.scripts.snapshot(); const resource = catalog.resources.find((item) => item.id === args.scriptId || item.entityId === args.entityId);
      if (!resource) throw new GameToolProtocolError('tool.script-missing', 'Requested script does not exist.');
      return Object.freeze({ documentId: catalog.documentId, revision: catalog.documentRevision, script: Object.freeze({ id: resource.id, entityId: resource.entityId, name: resource.name, text: resource.text.slice(0, 65_536), textRevision: resource.textRevision, truncated: resource.text.length > 65_536 }) });
    }
    case 'diagnostics.query': {
      const query = args as unknown as OperationLogQuery; const page = await options.diagnostics.query(query);
      const events = Object.freeze(page.events.map((item) => Object.freeze({ sequence: item.sequence, eventId: item.eventId, timestamp: item.timestamp, kind: item.kind, severity: item.severity, source: item.source, correlation: item.correlation as JsonObject, payloadDigest: prefixedDigest(item.payloadDigest), redactedFieldCount: item.redactedFields.length })));
      return Object.freeze({
        events, count: events.length, scanned: page.scanned,
        range: events.length ? Object.freeze({ first: events[0]!.sequence, last: events.at(-1)!.sequence }) : null,
        digest: sha256(canonicalStringify(events as unknown as JsonValue)),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    }
    case 'asset.search': {
      const catalog = controlledAssetCatalog(options.workspace);
      const assets = catalog.search({
        ...(args.text === undefined ? {} : { text: args.text as string }),
        ...(args.kind === undefined ? {} : { kind: args.kind as ControlledAssetKind }),
        ...(args.limit === undefined ? {} : { limit: args.limit as number }),
      });
      return Object.freeze({ assets: assets as unknown as JsonValue, count: assets.length });
    }
    case 'camera.set': {
      const camera = args.camera as JsonObject;
      const next = await options.workspace.execute({ id: commandId(stored.call.id), label: 'Set Camera', baseRevision: args.baseRevision as number, key: PROJECT_CAMERA_SETTING_KEY, value: camera }, signal);
      if (!next.document) throw new GameToolProtocolError('tool.project-missing', 'Project closed while setting its camera.');
      return Object.freeze({ documentId: next.document.documentId, revision: next.document.revision, camera: projectCameraFromSettings(next.document.settings) as unknown as JsonValue });
    }
    case 'entity.create': {
      const beforeIds = new Set(scene.entities.map((item) => item.id));
      const next = await options.scene.createEntity({ commandId: commandId(stored.call.id), baseRevision: args.baseRevision as number, kind: args.kind as SceneEntityKind, ...(args.name ? { name: args.name as string } : {}), ...('parentId' in args ? { parentId: args.parentId as StableId | null } : {}), ...(args.material ? { material: args.material as never } : {}), ...(args.color ? { color: args.color as unknown as SceneMaterialColor } : {}), ...(args.transform ? { transform: args.transform as unknown as TransformSnapshot } : {}) }, signal);
      const created = next.entities.find((item) => !beforeIds.has(item.id)); if (!created) throw new GameToolProtocolError('tool.result-invalid', 'Created entity was not projected.'); return Object.freeze({ entity: entitySummary(created), revision: next.revision });
    }
    case 'entity.rename': {
      const next = await options.scene.renameEntity({ commandId: commandId(stored.call.id), baseRevision: args.baseRevision as number, entityId: args.entityId as StableId, name: args.name as string }, signal);
      return Object.freeze({ entity: entitySummary(requireEntity(next, args.entityId as StableId)), revision: next.revision });
    }
    case 'transform.set': {
      const next = await options.scene.setTransform({ commandId: commandId(stored.call.id), baseRevision: args.baseRevision as number, entityId: args.entityId as StableId, transform: args.transform as unknown as TransformSnapshot }, signal);
      return Object.freeze({ entity: entitySummary(requireEntity(next, args.entityId as StableId)), revision: next.revision });
    }
    case 'material.set': {
      const next = await options.scene.setMaterial({ commandId: commandId(stored.call.id), baseRevision: args.baseRevision as number, entityId: args.entityId as StableId, material: args.material as never, ...(args.color ? { color: args.color as unknown as SceneMaterialColor } : {}) }, signal);
      return Object.freeze({ entity: entitySummary(requireEntity(next, args.entityId as StableId)), revision: next.revision });
    }
    case 'component.add': {
      const type = asStableId(args.type as string, 'component type'); const version = args.version as string;
      const component = options.workspace.componentRegistry.create({
        id: asStableId(`component:${randomUUID()}`), type, version,
        enabled: args.enabled as boolean, value: args.value as JsonObject,
      });
      const next = await options.workspace.executeBatch({ id: commandId(stored.call.id), label: `Add ${type}`, baseRevision: args.baseRevision as number, operations: [{ op: 'component.add', entityId: args.entityId as StableId, component }] }, signal);
      if (!next.document) throw new GameToolProtocolError('tool.project-missing', 'Project closed while adding a component.');
      return Object.freeze({ documentId: next.document.documentId, revision: next.document.revision, entityId: args.entityId as StableId, component: component as unknown as JsonValue });
    }
    case 'component.set': {
      const target = resolveComponentTarget(options.workspace, args);
      const component = options.workspace.componentRegistry.validate({ ...target.component, enabled: args.enabled === undefined ? target.component.enabled : args.enabled, value: args.value });
      const next = await options.workspace.executeBatch({ id: commandId(stored.call.id), label: `Set ${component.type}`, baseRevision: args.baseRevision as number, operations: [{ op: 'component.replace', component }] }, signal);
      if (!next.document) throw new GameToolProtocolError('tool.project-missing', 'Project closed while setting a component.');
      return Object.freeze({ documentId: next.document.documentId, revision: next.document.revision, entityId: target.entityId, component: component as unknown as JsonValue });
    }
    case 'component.remove': {
      const target = resolveComponentTarget(options.workspace, args);
      if (target.component.type === 'haiyue.transform.3d') throw new GameToolProtocolError('tool.component-required', 'The required Transform component cannot be removed.');
      const next = await options.workspace.executeBatch({ id: commandId(stored.call.id), label: `Remove ${target.component.type}`, baseRevision: args.baseRevision as number, operations: [{ op: 'component.remove', entityId: target.entityId, componentId: target.component.id }] }, signal);
      if (!next.document) throw new GameToolProtocolError('tool.project-missing', 'Project closed while removing a component.');
      return Object.freeze({ documentId: next.document.documentId, revision: next.document.revision, entityId: target.entityId, componentId: target.component.id, removedType: target.component.type });
    }
    case 'asset.import': {
      const catalog = controlledAssetCatalog(options.workspace);
      let entry;
      try {
        const bytes = await options.workspace.readControlledAsset(args.projectPath as string, 32 * 1024 * 1024, signal);
        entry = catalog.import({
          projectPath: args.projectPath as string,
          bytes,
          mimeType: args.mimeType as string,
          kind: args.kind as ControlledAssetKind,
          license: args.license as ControlledAssetLicense,
          provenance: args.provenance as string,
          decodedBytes: args.decodedBytes as number,
          ...(args.width === undefined ? {} : { width: args.width as number }),
          ...(args.height === undefined ? {} : { height: args.height as number }),
        });
      } catch (cause) { throw assetProtocolError(cause); }
      const next = await options.workspace.executeBatch({
        id: commandId(stored.call.id), label: 'Import Asset', baseRevision: args.baseRevision as number,
        operations: [
          { op: 'asset.upsert', asset: { id: entry.id, kind: entry.kind, digest: entry.digest, source: 'project' } },
          { op: 'setting.set', key: CONTROLLED_ASSET_CATALOG_SETTING_KEY, value: catalog.settingValue() },
        ],
      }, signal);
      if (!next.document) throw new GameToolProtocolError('tool.project-missing', 'Project closed while importing an asset.');
      return Object.freeze({ documentId: next.document.documentId, revision: next.document.revision, asset: entry as unknown as JsonValue });
    }
    case 'asset.assign': {
      const catalog = controlledAssetCatalog(options.workspace);
      const entityId = args.entityId as StableId;
      const usage = args.usage as AssetUsage;
      try { catalog.assignment(args.assetId as string, usage); } catch (cause) { throw assetProtocolError(cause); }
      const sceneEntity = requireEntity(scene, entityId);
      if (isPbrTextureUsage(usage) && !isSceneGeometryKind(sceneEntity.kind)) throw new GameToolProtocolError('asset.target-incompatible', `${usage} requires a geometry entity with Mesh3D.`);
      const result = options.workspace.queryGameDocument({ entityId, limit: 256 });
      if (!result.entities[0]) throw new GameToolProtocolError('tool.entity-missing', `Entity ${entityId} does not exist.`);
      const binding = assetBinding(usage, args.assetId as StableId);
      const existing = result.components.find((item) => item.type === binding.type && item.version === '1.0.0');
      let component: GameComponentInstanceV2;
      let operation;
      if (existing) {
        component = options.workspace.componentRegistry.validate({ ...existing, value: Object.freeze({ ...existing.value, ...binding.patch }) });
        operation = { op: 'component.replace' as const, component };
      } else {
        const definition = resolveComponentDefinition(options.workspace, binding.type, '1.0.0');
        component = options.workspace.componentRegistry.create({ id: asStableId(`component:${randomUUID()}`), type: binding.type, version: definition.version, enabled: true, value: Object.freeze({ ...definition.defaults, ...binding.patch }) });
        operation = { op: 'component.add' as const, entityId, component };
      }
      const next = await options.workspace.executeBatch({ id: commandId(stored.call.id), label: 'Assign Asset', baseRevision: args.baseRevision as number, operations: [operation] }, signal);
      if (!next.document) throw new GameToolProtocolError('tool.project-missing', 'Project closed while assigning an asset.');
      return Object.freeze({ documentId: next.document.documentId, revision: next.document.revision, entityId, assetId: args.assetId as StableId, usage, component: component as unknown as JsonValue });
    }
    case 'script.propose': {
      const proposal = await options.scripts.proposeEdit({ entityId: args.entityId as StableId, text: args.text as string, baseRevision: args.baseRevision as number, ...(args.capabilities ? { capabilities: args.capabilities as ScriptCapabilityName[] } : {}) });
      proposals.set(proposal.id, proposal);
      const diagnostics = proposal.diagnostics.map((item) => Object.freeze({ code: item.code, severity: item.severity, line: item.line, column: item.column, message: item.message }));
      const canApply = !proposal.diagnostics.some((item) => item.severity === 'error');
      return Object.freeze({ proposalId: proposal.id, scriptId: proposal.scriptId, entityId: proposal.entityId, baseRevision: proposal.baseRevision, nextTextRevision: proposal.nextTextRevision, digest: proposal.digest, addedLines: proposal.addedLines, removedLines: proposal.removedLines, capabilities: proposal.capabilities, diagnostics, canApply, requiredAction: canApply ? 'Call script.apply with this proposal.' : 'Rewrite the complete script to resolve every error diagnostic, then call script.propose again. Do not call script.apply for this proposal.' });
    }
    case 'script.apply': {
      const proposalId = args.proposalId as StableId; if (!proposals.has(proposalId)) throw new GameToolProtocolError('tool.proposal-missing', 'Script proposal is unavailable or already consumed.');
      const resource = await options.scripts.commitProposal(proposalId, commandId(stored.call.id), signal); proposals.delete(proposalId);
      return Object.freeze({ scriptId: resource.id, entityId: resource.entityId, textRevision: resource.textRevision, revision: options.scripts.snapshot().documentRevision });
    }
    case 'preview.validate': {
      if (!scene.entities.some((item) => isSceneGeometryKind(item.kind))) throw new GameToolProtocolError('tool.preview-no-renderables', 'Preview scene has no renderable geometry. Create at least one primitive before Play.');
      const scriptIds = args.scriptIds as readonly StableId[] | undefined;
      const plan = await options.scripts.prepare(scriptIds ? { scriptIds } : undefined); plans.set(plan.id, plan);
      return Object.freeze({
        planId: plan.id, documentId: plan.documentId, documentRevision: plan.documentRevision,
        selection: plan.selection, scriptSetDigest: plan.scriptSetDigest, scriptCount: plan.scripts.length,
        scripts: plan.scripts.map((script) => Object.freeze({ scriptId: script.scriptId, entityId: script.entityId, textRevision: script.textRevision, digest: script.digest, capabilities: script.capabilities })),
        capabilities: plan.capabilities, runtimeConfig: plan.runtimeConfig as unknown as JsonValue, risk: plan.risk,
        diagnostics: plan.diagnostics.map((item) => Object.freeze({ scriptId: item.scriptId, entityId: item.entityId, code: item.code, severity: item.severity, line: item.line, column: item.column, message: item.message })),
      });
    }
    case 'preview.start': {
      const planId = args.planId as StableId; const plan = plans.get(planId); if (!plan) throw new GameToolProtocolError('tool.preview-plan-missing', 'Validated preview plan is unavailable.');
      const grant = await options.scripts.decide(planId, true); if (!grant) throw new GameToolProtocolError('tool.preview-rejected', 'Preview authorization was rejected.');
      const consumed = options.scripts.consume(grant.id); if (consumed.scriptSetDigest !== plan.scriptSetDigest) throw new GameToolProtocolError('approval.digest-mismatch', 'Preview script set changed after approval.');
      const runtime = await options.preview.start(scene, consumed, signal); plans.delete(planId); return Object.freeze({ state: runtime.state, instanceId: runtime.instanceId, entityId: runtime.entityId, scriptSetDigest: runtime.scriptSetDigest, scriptCount: runtime.scriptCount, disposableCount: runtime.disposableCount });
    }
    case 'preview.stop': {
      const runtime = await options.preview.stop(signal); return Object.freeze({ state: runtime.state, instanceId: runtime.instanceId, disposedSideEffects: runtime.disposableCount });
    }
    default: throw new GameToolProtocolError('tool.not-found', `Tool ${stored.definition.id} has no handler.`);
  }
}

function validateToolCall(value: unknown): GameToolCall {
  if (!isRecord(value) || Object.keys(value).some((key) => !['schemaVersion', 'id', 'sessionId', 'turnId', 'toolId', 'toolVersion', 'arguments'].includes(key)) || value.schemaVersion !== 1 || !isRecord(value.arguments)) throw new GameToolProtocolError('tool.call-invalid', 'Tool call envelope is invalid.');
  assertBoundedJsonObject(value.arguments);
  return Object.freeze({ schemaVersion: 1, id: stable(value.id, 'tool call id'), sessionId: stable(value.sessionId, 'session id'), turnId: stable(value.turnId, 'turn id'), toolId: stable(value.toolId, 'tool id'), toolVersion: string(value.toolVersion, 'tool version', 32), arguments: value.arguments as JsonObject });
}

function normalizeArguments(toolId: StableId, value: JsonObject, currentRevision: number): JsonObject {
  const raw = value as Record<string, unknown>;
  switch (toolId) {
    case 'project.snapshot': case 'engine.capabilities.describe': case 'camera.get': case 'scene.list-entities': case 'preview.stop': exact(raw, [], [], toolId); return Object.freeze({});
    case 'component.describe': exact(raw, ['type'], ['version'], toolId); return Object.freeze({ type: componentTypeValue(raw.type), ...(raw.version === undefined ? {} : { version: componentVersionValue(raw.version) }) });
    case 'component.get': {
      exact(raw, [], ['componentId', 'entityId', 'type', 'version'], toolId);
      const hasId = raw.componentId !== undefined; const hasLookup = raw.entityId !== undefined || raw.type !== undefined || raw.version !== undefined;
      if (hasId === hasLookup || (hasLookup && (raw.entityId === undefined || raw.type === undefined))) throw invalid('component.get requires either componentId, or entityId plus type and optional version.');
      if (hasId) return Object.freeze({ componentId: stable(raw.componentId, 'component id') });
      return Object.freeze({ entityId: stable(raw.entityId, 'entity id'), type: componentTypeValue(raw.type), ...(raw.version === undefined ? {} : { version: componentVersionValue(raw.version) }) }) as JsonObject;
    }
    case 'entity.get': exact(raw, ['entityId'], [], toolId); return Object.freeze({ entityId: stable(raw.entityId, 'entity id') });
    case 'script.get': { exact(raw, [], ['entityId', 'scriptId'], toolId); if (!raw.entityId && !raw.scriptId) throw invalid('script.get requires entityId or scriptId.'); return Object.freeze({ ...(raw.entityId ? { entityId: stable(raw.entityId, 'entity id') } : {}), ...(raw.scriptId ? { scriptId: stable(raw.scriptId, 'script id') } : {}) }); }
    case 'diagnostics.query': return normalizeLogQuery(raw);
    case 'asset.search': {
      exact(raw, [], ['text', 'kind', 'limit'], toolId);
      return Object.freeze({
        ...(raw.text === undefined ? {} : { text: boundedString(raw.text, 'text', 256) }),
        ...(raw.kind === undefined ? {} : { kind: assetKindValue(raw.kind) }),
        ...(raw.limit === undefined ? {} : { limit: boundedInteger(raw.limit, 'limit', 1, 200) }),
      });
    }
    case 'camera.set': {
      exact(raw, ['camera'], ['baseRevision'], toolId);
      try {
        return Object.freeze({ baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), camera: normalizeProjectCamera(raw.camera) as unknown as JsonValue });
      } catch (cause) { throw invalid(cause instanceof Error ? cause.message : 'Camera is invalid.'); }
    }
    case 'entity.create': {
      exact(raw, ['kind'], ['baseRevision', 'name', 'parentId', 'material', 'color', 'transform'], toolId);
      if (!['empty', 'cube', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron', 'directional-light', 'point-light', 'ambient-light'].includes(String(raw.kind))) throw invalid('Entity kind is invalid.');
      if (raw.material !== undefined && !isSceneMaterialKind(raw.material)) throw invalid('Material kind is invalid.');
      if ((raw.material !== undefined || raw.color !== undefined) && !isSceneGeometryKind(raw.kind)) throw invalid('Only geometry entities can select a material appearance.');
      return Object.freeze({ baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), kind: raw.kind as JsonValue, ...(raw.name === undefined ? {} : { name: boundedString(raw.name, 'name', 80, true) }), ...(raw.parentId === undefined ? {} : { parentId: raw.parentId === null ? null : stable(raw.parentId, 'parent id') }), ...(raw.material === undefined ? {} : { material: raw.material as JsonValue }), ...(raw.color === undefined ? {} : { color: normalizeMaterialColor(raw.color) as unknown as JsonValue }), ...(raw.transform === undefined ? {} : { transform: normalizeTransform(raw.transform) as unknown as JsonValue }) });
    }
    case 'entity.rename': exact(raw, ['entityId', 'name'], ['baseRevision'], toolId); return Object.freeze({ baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), entityId: stable(raw.entityId, 'entity id'), name: boundedString(raw.name, 'name', 80, true) });
    case 'transform.set': exact(raw, ['entityId', 'transform'], ['baseRevision'], toolId); return Object.freeze({ baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), entityId: stable(raw.entityId, 'entity id'), transform: normalizeTransform(raw.transform) as unknown as JsonValue });
    case 'material.set': exact(raw, ['entityId', 'material'], ['baseRevision', 'color'], toolId); if (!isSceneMaterialKind(raw.material)) throw invalid('Material kind is invalid.'); return Object.freeze({ baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), entityId: stable(raw.entityId, 'entity id'), material: raw.material, ...(raw.color === undefined ? {} : { color: normalizeMaterialColor(raw.color) as unknown as JsonValue }) });
    case 'component.add': exact(raw, ['entityId', 'type'], ['baseRevision', 'version', 'enabled', 'value'], toolId); return Object.freeze({ baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), entityId: stable(raw.entityId, 'entity id'), type: componentTypeValue(raw.type), version: componentVersionValue(raw.version ?? '1.0.0'), enabled: raw.enabled === undefined ? true : booleanValue(raw.enabled, 'enabled'), value: jsonObjectValue(raw.value ?? {}, 'component value') as JsonValue });
    case 'component.set': exact(raw, ['componentId', 'value'], ['baseRevision', 'enabled'], toolId); return Object.freeze({ baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), componentId: stable(raw.componentId, 'component id'), ...(raw.enabled === undefined ? {} : { enabled: booleanValue(raw.enabled, 'enabled') }), value: jsonObjectValue(raw.value, 'component value') as JsonValue });
    case 'component.remove': exact(raw, ['componentId'], ['baseRevision'], toolId); return Object.freeze({ baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), componentId: stable(raw.componentId, 'component id') });
    case 'asset.import': {
      exact(raw, ['projectPath', 'kind', 'mimeType', 'license', 'provenance', 'decodedBytes'], ['baseRevision', 'width', 'height'], toolId);
      if ((raw.width === undefined) !== (raw.height === undefined)) throw invalid('Asset width and height must be supplied together.');
      const projectPath = boundedString(raw.projectPath, 'projectPath', 512, true).replaceAll('\\', '/');
      if (projectPath.startsWith('/') || /^[A-Za-z]:/u.test(projectPath) || projectPath.split('/').includes('..') || !projectPath.startsWith('assets/')) throw invalid('projectPath must stay under the project assets directory.');
      return Object.freeze({
        baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), projectPath,
        kind: assetKindValue(raw.kind), mimeType: boundedString(raw.mimeType, 'mimeType', 128, true),
        license: assetLicenseValue(raw.license), provenance: boundedString(raw.provenance, 'provenance', 512, true),
        decodedBytes: boundedInteger(raw.decodedBytes, 'decodedBytes', 1, 128 * 1024 * 1024),
        ...(raw.width === undefined ? {} : { width: boundedInteger(raw.width, 'width', 1, 8192), height: boundedInteger(raw.height, 'height', 1, 8192) }),
      });
    }
    case 'asset.assign': exact(raw, ['entityId', 'assetId', 'usage'], ['baseRevision'], toolId); return Object.freeze({ baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), entityId: stable(raw.entityId, 'entity id'), assetId: assetIdValue(raw.assetId), usage: assetUsageValue(raw.usage) });
    case 'script.propose': exact(raw, ['entityId', 'text'], ['baseRevision', 'capabilities'], toolId); return Object.freeze({ baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), entityId: stable(raw.entityId, 'entity id'), text: boundedString(raw.text, 'text', 65_536, true), ...(raw.capabilities ? { capabilities: normalizeCapabilities(raw.capabilities) } : {}) });
    case 'script.apply': exact(raw, ['proposalId'], ['baseRevision'], toolId); return Object.freeze({ baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), proposalId: stable(raw.proposalId, 'proposal id') });
    case 'preview.validate': {
      exact(raw, [], ['scriptIds'], toolId);
      if (raw.scriptIds === undefined) return Object.freeze({});
      if (!Array.isArray(raw.scriptIds) || raw.scriptIds.length < 1 || raw.scriptIds.length > 128) throw invalid('scriptIds must contain 1-128 script ids.');
      const scriptIds = raw.scriptIds.map((item) => stable(item, 'script id'));
      if (new Set(scriptIds).size !== scriptIds.length) throw invalid('scriptIds must be unique.');
      return Object.freeze({ scriptIds });
    }
    case 'preview.start': exact(raw, ['planId'], ['baseRevision'], toolId); return Object.freeze({ baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), planId: stable(raw.planId, 'plan id') });
    default: throw new GameToolProtocolError('tool.not-found', `Unknown tool ${toolId}.`);
  }
}

function normalizeLogQuery(raw: Record<string, unknown>): JsonObject {
  exact(raw, ['limit', 'traverseCorrelation'], ['severity', 'kinds', 'sessionId', 'turnId', 'toolCallId', 'entityId', 'pluginId', 'afterSequence', 'beforeSequence', 'cursor']);
  const limit = integer(raw.limit, 'limit'); if (limit < 1 || limit > 100) throw invalid('Diagnostic query limit must be 1-100.');
  if (typeof raw.traverseCorrelation !== 'boolean') throw invalid('traverseCorrelation must be boolean.');
  return Object.freeze({ limit, traverseCorrelation: raw.traverseCorrelation, ...optionalIdFields(raw, ['sessionId', 'turnId', 'toolCallId', 'entityId', 'pluginId']), ...optionalIntegers(raw, ['afterSequence', 'beforeSequence']), ...(raw.severity ? { severity: enumArray(raw.severity, ['debug', 'info', 'warning', 'error'], 4) } : {}), ...(raw.kinds ? { kinds: stringArray(raw.kinds, 32, 96) } : {}), ...(raw.cursor ? { cursor: boundedString(raw.cursor, 'cursor', 2_048, true) } : {}) });
}

function buildPreview(toolId: StableId, args: JsonObject, scene: SceneAuthoringService, proposals: ReadonlyMap<StableId, ScriptEditProposal>, plans: ReadonlyMap<StableId, PreviewPlan>): GameToolPreview {
  const raw = args as Record<string, unknown>; const snapshot = scene.snapshot();
  switch (toolId) {
    case 'camera.set': return preview('Set camera', snapshot.documentId, 'Replace the main project camera for authoring and game preview.', canonicalStringify(raw.camera as JsonObject));
    case 'entity.create': return preview('Create entity', snapshot.documentId, `Create ${raw.kind}${raw.name ? ` named ${raw.name}` : ''}.`, `+ ${raw.kind} ${raw.name ?? ''}`.trim());
    case 'entity.rename': { const entity = requireEntity(snapshot, raw.entityId as StableId); return preview('Rename entity', entity.id, `Rename ${entity.name} to ${raw.name}.`, `- ${entity.name}\n+ ${raw.name}`); }
    case 'transform.set': { const entity = requireEntity(snapshot, raw.entityId as StableId); return preview('Set Transform', entity.id, `Replace Transform for ${entity.name}.`, `${canonicalStringify(entity.transform as unknown as JsonObject)}\n→ ${canonicalStringify(raw.transform as JsonObject)}`); }
    case 'material.set': {
      const entity = requireEntity(snapshot, raw.entityId as StableId);
      if (!isSceneGeometryKind(entity.kind)) throw invalid('Only geometry entities can use materials.');
      const color = raw.color as readonly number[] | undefined;
      return preview('Set material appearance', entity.id, `Apply ${raw.material}${color ? ` rgba(${color.join(', ')})` : ''} to ${entity.name}.`, `${entity.appearance?.material ?? 'none'} ${entity.appearance?.color?.join(',') ?? ''} → ${raw.material}${color ? ` ${color.join(',')}` : ''}`);
    }
    case 'component.add': {
      return preview('Add component', raw.entityId as string, `Add ${raw.type} to ${raw.entityId}.`, `+ ${raw.type}@${raw.version} ${canonicalStringify(raw.value as JsonObject)}`);
    }
    case 'component.set': {
      const target = resolveSceneComponent(snapshot, raw.componentId as StableId);
      return preview('Set component', target.entityId, `Replace ${target.component.type} on ${target.entityName}.`, `${canonicalStringify(target.component.value as JsonObject)}\n→ ${canonicalStringify(raw.value as JsonObject)}`);
    }
    case 'component.remove': {
      const target = resolveSceneComponent(snapshot, raw.componentId as StableId);
      if (target.component.type === 'haiyue.transform.3d') throw new GameToolProtocolError('tool.component-required', 'The required Transform component cannot be removed.');
      return preview('Remove component', target.entityId, `Remove ${target.component.type} from ${target.entityName}.`, `- ${target.component.type}@${target.component.version}`);
    }
    case 'asset.import': return preview('Register project asset', snapshot.documentId, `Register ${raw.kind} asset ${String(raw.projectPath).split('/').at(-1)} with ${raw.license} provenance.`, `+ ${raw.kind} ${raw.mimeType} (${raw.decodedBytes} decoded bytes)`);
    case 'asset.assign': {
      const entity = requireEntity(snapshot, raw.entityId as StableId);
      if (isPbrTextureUsage(raw.usage as AssetUsage) && !isSceneGeometryKind(entity.kind)) throw new GameToolProtocolError('asset.target-incompatible', `${raw.usage} requires a geometry entity with Mesh3D.`);
      return preview('Assign project asset', entity.id, `Assign ${raw.assetId} as ${raw.usage} on ${entity.name}.`, `+ ${raw.usage} → ${raw.assetId}`);
    }
    case 'script.apply': {
      const proposal = proposals.get(raw.proposalId as StableId);
      if (!proposal) throw new GameToolProtocolError('tool.proposal-missing', 'Script proposal is unavailable.');
      if (proposal.baseRevision !== raw.baseRevision) throw new GameToolProtocolError('tool.stale-revision', 'Script proposal base revision differs.');
      const errors = proposal.diagnostics.filter((item) => item.severity === 'error');
      if (errors.length) throw new GameToolProtocolError('tool.script-validation-failed', `Script proposal has ${errors.length} validation error(s): ${errors.slice(0, 4).map((item) => `${item.code} ${item.line}:${item.column} ${item.message}`).join(' | ')} Rewrite and propose again before apply.`);
      return preview('Apply script proposal', proposal.scriptId, `Commit validated proposal with +${proposal.addedLines}/-${proposal.removedLines} lines.`, `digest ${proposal.digest}`);
    }
    case 'preview.start': { const plan = plans.get(raw.planId as StableId); if (!plan) throw new GameToolProtocolError('tool.preview-plan-missing', 'Preview plan is unavailable.'); if (plan.documentRevision !== raw.baseRevision) throw new GameToolProtocolError('tool.stale-revision', 'Preview plan base revision differs.'); return preview('Start trusted preview', plan.documentId, `Start ${plan.scripts.length} trusted project script(s) with ${plan.capabilities.join(', ')}.`, `script-set digest ${plan.scriptSetDigest}`); }
    default: return preview(GAME_AUTHORING_TOOL_BY_ID.get(toolId)?.title ?? toolId, snapshot.documentId, `Execute ${toolId}.`, 'No Document mutation in this step.');
  }
}

function approvalGrantDigest(documentId: StableId, sessionId: StableId, definition: GameToolDefinition, target: string): string {
  return sha256(canonicalStringify({ schemaVersion: 1, documentId, sessionId, toolId: definition.id, toolVersion: definition.version, effect: definition.effect, risk: definition.risk, target }));
}

function isAllowDecision(decision: GameToolApproval['decision']): boolean { return decision === 'allow-once' || decision === 'allow-always'; }

function preview(title: string, target: string, summary: string, diff: string): GameToolPreview { return Object.freeze({ title, target, summary, diff }); }
function requireDocument(workspace: ProjectWorkspace): NonNullable<ReturnType<ProjectWorkspace['snapshot']>['document']> { const document = workspace.snapshot().document; if (!document) throw new GameToolProtocolError('tool.project-missing', 'No project is open.'); return document; }
function requireEntity(scene: ReturnType<SceneAuthoringService['snapshot']>, id: StableId) { const entity = scene.entities.find((item) => item.id === id); if (!entity) throw new GameToolProtocolError('tool.entity-missing', `Entity ${id} does not exist.`); return entity; }
function resolveComponentDefinition(workspace: ProjectWorkspace, type: string, version?: string) {
  if (version) {
    try { return workspace.componentRegistry.get(type, version); }
    catch (cause) { throw new GameToolProtocolError('tool.component-definition-missing', errorMessage(cause)); }
  }
  const matches = workspace.componentRegistry.snapshot().definitions.filter((item) => item.type === type).sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }));
  if (!matches[0]) throw new GameToolProtocolError('tool.component-definition-missing', `Component definition ${type} does not exist.`);
  return matches[0];
}
function resolveComponentTarget(workspace: ProjectWorkspace, args: Readonly<Record<string, JsonValue>>): Readonly<{ entityId: StableId; component: GameComponentInstanceV2 }> {
  if (args.componentId) {
    const componentId = args.componentId as StableId; const entityId = workspace.componentOwner(componentId);
    if (!entityId) throw new GameToolProtocolError('tool.component-missing', `Component ${componentId} does not exist.`);
    const result = workspace.queryGameDocument({ entityId, limit: 1 }); const component = result.components.find((item) => item.id === componentId);
    if (!component) throw new GameToolProtocolError('tool.component-missing', `Component ${componentId} does not exist.`);
    return Object.freeze({ entityId, component });
  }
  const entityId = args.entityId as StableId; const type = args.type as string; const version = args.version as string | undefined;
  const result = workspace.queryGameDocument({ entityId, limit: 1 });
  if (!result.entities[0]) throw new GameToolProtocolError('tool.entity-missing', `Entity ${entityId} does not exist.`);
  const component = result.components.filter((item) => item.type === type && (version === undefined || item.version === version)).sort((left, right) => left.id.localeCompare(right.id))[0];
  if (!component) throw new GameToolProtocolError('tool.component-missing', `Entity ${entityId} has no ${type}${version ? `@${version}` : ''} component.`);
  return Object.freeze({ entityId, component });
}
function resolveSceneComponent(scene: ReturnType<SceneAuthoringService['snapshot']>, componentId: StableId): Readonly<{ entityId: StableId; entityName: string; component: GameComponentInstanceV2 }> {
  for (const entity of scene.entities) {
    const component = entity.components?.find((item) => item.id === componentId);
    if (component) return Object.freeze({ entityId: entity.id, entityName: entity.name, component });
  }
  throw new GameToolProtocolError('tool.component-missing', `Component ${componentId} does not exist.`);
}
function resolveComponentToolPolicy(definition: GameToolDefinition, args: JsonObject, workspace: ProjectWorkspace): GameToolDefinition {
  if (!['component.add', 'component.set', 'component.remove'].includes(definition.id)) return definition;
  let componentDefinition: ComponentDefinitionV2;
  if (definition.id === 'component.add') {
    const entityId = args.entityId as StableId; const result = workspace.queryGameDocument({ entityId, limit: 1 });
    if (!result.entities[0]) throw new GameToolProtocolError('tool.entity-missing', `Entity ${entityId} does not exist.`);
    componentDefinition = resolveComponentDefinition(workspace, args.type as string, args.version as string);
    if (componentDefinition.type === 'haiyue.transform.3d' && result.components.some((item) => item.type === componentDefinition.type)) throw new GameToolProtocolError('tool.component-duplicate', `Entity ${entityId} already has required component ${componentDefinition.type}.`);
    workspace.componentRegistry.create({ id: asStableId('component:policy-validation'), type: asStableId(componentDefinition.type, 'component type'), version: componentDefinition.version, enabled: args.enabled as boolean, value: args.value as JsonObject });
  } else {
    const target = resolveComponentTarget(workspace, args);
    componentDefinition = resolveComponentDefinition(workspace, target.component.type, target.component.version);
    if (definition.id === 'component.set') workspace.componentRegistry.validate({ ...target.component, enabled: args.enabled === undefined ? target.component.enabled : args.enabled, value: args.value });
    if (definition.id === 'component.remove' && target.component.type === 'haiyue.transform.3d') throw new GameToolProtocolError('tool.component-required', 'The required Transform component cannot be removed.');
  }
  return Object.freeze({ ...definition, risk: componentDefinition.risk, requiresApproval: componentDefinition.risk !== 'low' });
}
type AssetUsage = 'texture.base-color' | 'texture.metallic-roughness' | 'texture.normal' | 'texture.occlusion' | 'texture.emissive' | 'texture.environment-diffuse' | 'texture.environment-specular' | 'model' | 'audio' | 'animation';
function controlledAssetCatalog(workspace: ProjectWorkspace): ControlledAssetCatalog {
  try { return ControlledAssetCatalog.fromManifest(workspace.gameSnapshot().settings[CONTROLLED_ASSET_CATALOG_SETTING_KEY]); }
  catch (cause) { throw assetProtocolError(cause); }
}
function assetProtocolError(cause: unknown): GameToolProtocolError {
  if (cause instanceof GameToolProtocolError) return cause;
  if (cause instanceof ControlledAssetError) return new GameToolProtocolError(cause.code, cause.message);
  return new GameToolProtocolError('asset.operation-failed', errorMessage(cause));
}
function assetBinding(usage: AssetUsage, assetId: StableId): Readonly<{ type: StableId; patch: JsonObject }> {
  switch (usage) {
    case 'texture.base-color': return Object.freeze({ type: asStableId('haiyue.material.pbr'), patch: Object.freeze({ baseColorAssetId: assetId }) });
    case 'texture.metallic-roughness': return Object.freeze({ type: asStableId('haiyue.material.pbr'), patch: Object.freeze({ metallicRoughnessAssetId: assetId }) });
    case 'texture.normal': return Object.freeze({ type: asStableId('haiyue.material.pbr'), patch: Object.freeze({ normalAssetId: assetId }) });
    case 'texture.occlusion': return Object.freeze({ type: asStableId('haiyue.material.pbr'), patch: Object.freeze({ occlusionAssetId: assetId }) });
    case 'texture.emissive': return Object.freeze({ type: asStableId('haiyue.material.pbr'), patch: Object.freeze({ emissiveAssetId: assetId }) });
    case 'texture.environment-diffuse': return Object.freeze({ type: asStableId('haiyue.light.environment'), patch: Object.freeze({ diffuseAssetId: assetId }) });
    case 'texture.environment-specular': return Object.freeze({ type: asStableId('haiyue.light.environment'), patch: Object.freeze({ specularAssetId: assetId }) });
    case 'model': return Object.freeze({ type: asStableId('haiyue.model.gltf'), patch: Object.freeze({ assetId }) });
    case 'audio': return Object.freeze({ type: asStableId('haiyue.audio.source'), patch: Object.freeze({ assetIds: Object.freeze([assetId]) }) });
    case 'animation': return Object.freeze({ type: asStableId('haiyue.animation.2d'), patch: Object.freeze({ assetId }) });
  }
}
function isPbrTextureUsage(usage: AssetUsage): boolean { return ['texture.base-color', 'texture.metallic-roughness', 'texture.normal', 'texture.occlusion', 'texture.emissive'].includes(usage); }
function entitySummary(entity: ReturnType<SceneAuthoringService['snapshot']>['entities'][number]): JsonObject { return Object.freeze({ id: entity.id, name: entity.name, kind: entity.kind, parentId: entity.parentId, order: entity.order, transform: entity.transform as unknown as JsonValue, ...(entity.components ? { components: entity.components as unknown as JsonValue } : {}), ...(entity.appearance ? { appearance: entity.appearance as unknown as JsonValue } : {}), ...(entity.light ? { light: entity.light as unknown as JsonValue } : {}) }); }
function commandId(callId: StableId): StableId { return asStableId(`command:agent:${sha256(callId).slice(7, 31)}`); }
function historyLabel(toolId: StableId): string | undefined { return ({ 'camera.set': 'Set Camera', 'entity.create': 'Create Scene Entity', 'entity.rename': 'Rename Entity', 'transform.set': 'Edit Transform', 'material.set': 'Set Material', 'component.add': 'Add Component', 'component.set': 'Set Component', 'component.remove': 'Remove Component', 'asset.import': 'Import Asset', 'asset.assign': 'Assign Asset', 'script.apply': 'Edit Entity Script' } as Record<string, string>)[toolId]; }
function correlation(call: GameToolCall, approvalId?: StableId) {
  const args = call.arguments as Record<string, unknown>;
  return Object.freeze({
    sessionId: call.sessionId, turnId: call.turnId, toolCallId: call.id,
    ...(approvalId ? { approvalId } : {}),
    ...(historyLabel(call.toolId) ? { commandId: commandId(call.id) } : {}),
    ...optionalCorrelationId('entityId', args.entityId),
    ...optionalCorrelationId('scriptId', args.scriptId),
    ...optionalCorrelationId('previewId', args.planId),
  });
}
function optionalCorrelationId(key: 'entityId' | 'scriptId' | 'previewId', value: unknown): Partial<Record<typeof key, StableId>> {
  try { return value === undefined ? {} : { [key]: stable(value, key) } as Record<typeof key, StableId>; } catch { return {}; }
}
function readBaseRevision(args: JsonObject): number | undefined { return typeof args.baseRevision === 'number' ? args.baseRevision : undefined; }
function assertResultBudget(value: JsonObject, maximum: number): void { if (new TextEncoder().encode(canonicalStringify(value)).byteLength > maximum) throw new GameToolProtocolError('tool.result-too-large', `Tool result exceeds ${maximum} bytes.`); }
function enforceLogHealth(toolId: StableId, effect: GameToolDefinition['effect'], status: ReturnType<OperationLog['status']>): void { if (toolId === 'preview.stop' || effect === 'observe') return; const allowed = effect === 'reversible-edit' ? status.allowsMutation : effect === 'trusted-code' ? status.allowsTrustedCode : status.allowsRuntimeStart; if (!allowed) throw new GameToolProtocolError('tool.log-unavailable', `Operation Log health ${status.health} blocks ${effect}.`); }
function normalizeTransform(value: unknown): TransformSnapshot { if (!isRecord(value)) throw invalid('Transform must be an object.'); exact(value, ['position', 'rotationDegrees', 'scale']); const result = Object.freeze({ position: vec(value.position, 'position'), rotationDegrees: vec(value.rotationDegrees, 'rotationDegrees'), scale: vec(value.scale, 'scale') }); if (result.scale.x <= 0 || result.scale.y <= 0 || result.scale.z <= 0) throw invalid('Transform scale must be positive.'); return result; }
function normalizeMaterialColor(value: unknown): SceneMaterialColor { if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 1)) throw invalid('Material color must be an RGBA array with four finite channels from 0 to 1.'); return Object.freeze([...value] as [number, number, number, number]); }
function vec(value: unknown, label: string) { if (!isRecord(value)) throw invalid(`${label} must be an object.`); exact(value, ['x', 'y', 'z']); const result = { x: number(value.x, `${label}.x`), y: number(value.y, `${label}.y`), z: number(value.z, `${label}.z`) }; return Object.freeze(result); }
function normalizeCapabilities(value: unknown): readonly ScriptCapabilityName[] { return enumArray(value, ['read', 'input', 'debug', 'scene', 'physics', 'asset'], 6) as readonly ScriptCapabilityName[]; }
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = [], label = 'Tool'): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !(key in value));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length || unknown.length) throw invalid(`${label} arguments invalid; missing required fields: ${missing.join(', ') || 'none'}; unknown fields: ${unknown.join(', ') || 'none'}; allowed fields: ${[...allowed].join(', ') || 'none'}.`);
}
function optionalIdFields(value: Record<string, unknown>, keys: readonly string[]): JsonObject { return Object.freeze(Object.fromEntries(keys.flatMap((key) => value[key] === undefined ? [] : [[key, stable(value[key], key)]]))); }
function optionalIntegers(value: Record<string, unknown>, keys: readonly string[]): JsonObject { return Object.freeze(Object.fromEntries(keys.flatMap((key) => value[key] === undefined ? [] : [[key, integer(value[key], key)]]))); }
function enumArray(value: unknown, allowed: readonly string[], maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum || new Set(value).size !== value.length || value.some((item) => typeof item !== 'string' || !allowed.includes(item))) throw invalid('Enum array is invalid.');
  return Object.freeze([...value]);
}
function stringArray(value: unknown, maximum: number, maxLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum || new Set(value).size !== value.length || value.some((item) => typeof item !== 'string' || item.length > maxLength || !/^[a-z][a-z0-9./-]{2,95}$/u.test(item))) throw invalid('String array is invalid.');
  return Object.freeze([...value]);
}
function stable(value: unknown, label: string): StableId { if (typeof value !== 'string') throw invalid(`${label} is invalid.`); try { return asStableId(value, label); } catch { throw invalid(`${label} is invalid.`); } }
function assetIdValue(value: unknown): StableId { if (typeof value !== 'string' || !/^asset:[a-f0-9]{24}$/u.test(value)) throw invalid('asset id is invalid.'); return asStableId(value); }
function assetKindValue(value: unknown): ControlledAssetKind { if (!['texture', 'model', 'audio', 'animation'].includes(String(value))) throw invalid('asset kind is invalid.'); return value as ControlledAssetKind; }
function assetLicenseValue(value: unknown): ControlledAssetLicense { if (!['project-owned', 'cc0', 'cc-by-4.0', 'internal-test'].includes(String(value))) throw invalid('asset license is invalid.'); return value as ControlledAssetLicense; }
function assetUsageValue(value: unknown): AssetUsage { if (!['texture.base-color', 'texture.metallic-roughness', 'texture.normal', 'texture.occlusion', 'texture.emissive', 'texture.environment-diffuse', 'texture.environment-specular', 'model', 'audio', 'animation'].includes(String(value))) throw invalid('asset usage is invalid.'); return value as AssetUsage; }
function string(value: unknown, label: string, maximum: number): string { if (typeof value !== 'string' || !value || value.length > maximum) throw invalid(`${label} is invalid.`); return value; }
function boundedString(value: unknown, label: string, maximum: number, nonEmpty = false): string { if (typeof value !== 'string' || value.length > maximum || (nonEmpty && !value.trim())) throw invalid(`${label} is invalid.`); return value; }
function componentTypeValue(value: unknown): string { if (typeof value !== 'string' || !/^[a-z][a-z0-9._:-]{2,159}$/u.test(value)) throw invalid('component type is invalid.'); return value; }
function componentVersionValue(value: unknown): string { if (typeof value !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(value)) throw invalid('component version is invalid.'); return value; }
function booleanValue(value: unknown, label: string): boolean { if (typeof value !== 'boolean') throw invalid(`${label} is invalid.`); return value; }
function jsonObjectValue(value: unknown, label: string): JsonObject { if (!isRecord(value)) throw invalid(`${label} must be an object.`); assertBoundedJsonObject(value); return cloneJsonObject(value); }
function cloneJsonObject(value: Readonly<Record<string, unknown>>): JsonObject { return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]))) as JsonObject; }
function cloneJsonValue(value: unknown): JsonValue { if (Array.isArray(value)) return Object.freeze(value.map(cloneJsonValue)) as unknown as JsonValue; if (isRecord(value)) return cloneJsonObject(value); if (value === null || typeof value === 'boolean' || typeof value === 'string') return value; if (typeof value === 'number' && Number.isFinite(value)) return value; throw invalid('component value must contain JSON values only.'); }
function integer(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(`${label} is invalid.`); return value as number; }
function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number { const result = integer(value, label); if (result < minimum || result > maximum) throw invalid(`${label} must be between ${minimum} and ${maximum}.`); return result; }
function revisionOrCurrent(value: unknown, currentRevision: number): number { return value === undefined ? currentRevision : integer(value, 'baseRevision'); }
function number(value: unknown, label: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${label} is invalid.`); return value; }
function invalid(message: string): GameToolProtocolError { return new GameToolProtocolError('tool.arguments-invalid', message); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function assertBoundedJsonObject(value: Record<string, unknown>): void {
  const seen = new WeakSet<object>(); let nodes = 0; let stringBytes = 0;
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 20_000 || depth > 32) throw invalid('Tool arguments exceed the structural budget.');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) throw invalid('Tool arguments contain a non-finite number.'); return; }
    if (typeof item === 'string') { stringBytes += new TextEncoder().encode(item).byteLength; if (stringBytes > 256 * 1024) throw invalid('Tool arguments exceed the text budget.'); return; }
    if (typeof item !== 'object') throw invalid('Tool arguments must contain JSON values only.');
    if (seen.has(item)) throw invalid('Tool arguments contain a cycle.');
    seen.add(item);
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); }
    else for (const [key, child] of Object.entries(item)) { visit(key, depth + 1); visit(child, depth + 1); }
    seen.delete(item);
  };
  visit(value, 0);
}
function fuseAbort(signal: AbortSignal | undefined, controller: AbortController): () => void { if (!signal) return () => {}; const abort = () => controller.abort(signal.reason); if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); return () => signal.removeEventListener('abort', abort); }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function errorCode(value: unknown): string { return value instanceof GameToolProtocolError ? value.code : 'tool.execution-failed'; }
function prefixedDigest(value: string): string { return value.startsWith('sha256:') ? value : `sha256:${value}`; }
