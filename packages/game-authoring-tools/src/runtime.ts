import { randomUUID } from 'node:crypto';
import { asStableId, type JsonObject, type JsonValue, type StableId } from '@haiyue/ai-studio-contracts';
import { isSceneGeometryKind, isSceneMaterialKind, type ProjectWorkspace, type SceneAuthoringService, type SceneEntityKind, type TransformSnapshot } from '@haiyue/ai-studio-editor-plugins';
import { canonicalStringify, sha256, type DiagnosticsQueryService, type OperationLog, type OperationLogQuery } from '@haiyue/ai-studio-operation-log';
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
  readonly clock?: () => number;
  readonly approvalTtlMs?: number;
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
  private readonly clock: () => number;
  private readonly approvalTtlMs: number;

  constructor(private readonly options: GameAuthoringToolRuntimeOptions) {
    this.clock = options.clock ?? Date.now;
    this.approvalTtlMs = options.approvalTtlMs ?? 60_000;
  }

  definitions(): readonly GameToolDefinition[] { this.assertActive(); return GAME_AUTHORING_TOOL_DEFINITIONS; }
  snapshot(): GameToolRuntimeSnapshot { return Object.freeze({ definitions: GAME_AUTHORING_TOOL_DEFINITIONS, pendingPreparations: this.preparations.size, pendingApprovals: [...this.preparations.values()].filter((item) => item.approval?.decision === 'pending').length, activeCalls: this.active.size, activeApprovalGrants: this.approvalGrants.size, disposed: this.disposed }); }

  async prepare(value: unknown, signal?: AbortSignal): Promise<GameToolPreparation> {
    this.assertActive();
    const call = validateToolCall(value);
    const definition = GAME_AUTHORING_TOOL_BY_ID.get(call.toolId);
    if (!definition || call.toolVersion !== definition.version) throw new GameToolProtocolError('tool.not-found', `Tool ${call.toolId}@${call.toolVersion} is not registered.`);
    const document = requireDocument(this.options.workspace);
    const args = normalizeArguments(definition.id, call.arguments, document.revision);
    enforceLogHealth(definition.id, definition.effect, this.options.operationLog.status());
    const requestedRevision = readBaseRevision(args);
    if (requestedRevision !== undefined && requestedRevision !== document.revision) throw new GameToolProtocolError('tool.stale-revision', `Tool expected document revision ${requestedRevision}; current revision is ${document.revision}.`, true);
    const preview = buildPreview(definition.id, args, this.options.scene, this.proposals, this.previewPlans);
    const argumentsDigest = sha256(canonicalStringify(args));
    const previewDigest = sha256(canonicalStringify(preview as unknown as JsonObject));
    const preparationId = asStableId(`tool-preparation:${randomUUID()}`);
    const approvalScopeDigest = definition.requiresApproval ? approvalGrantDigest(document.documentId, definition, preview.target) : undefined;
    const autoAllowed = approvalScopeDigest !== undefined && this.approvalGrants.has(approvalScopeDigest);
    const approvalId = definition.requiresApproval && !autoAllowed ? asStableId(`approval:${randomUUID()}`) : undefined;
    const expiresAt = approvalId ? new Date(this.clock() + this.approvalTtlMs).toISOString() : undefined;
    const status = approvalId ? 'approval-required' : 'ready';
    const view: GameToolPreparation = Object.freeze({
      schemaVersion: 1, id: preparationId, callId: call.id, sessionId: call.sessionId, turnId: call.turnId,
      toolId: definition.id, toolVersion: definition.version, effect: definition.effect, risk: definition.risk,
      documentId: document.documentId, baseRevision: document.revision, argumentsDigest, previewDigest, preview, status,
      ...(approvalId ? { approvalId, expiresAt } : {}),
    });
    const stored: StoredPreparation = { call, definition, arguments: args, preview, view, ...(approvalScopeDigest ? { approvalScopeDigest } : {}) };
    if (approvalId && expiresAt) stored.approval = Object.freeze({
      schemaVersion: 1, approvalId, preparationId, toolCallId: call.id, toolId: definition.id, toolVersion: definition.version,
      effect: definition.effect as Exclude<GameToolDefinition['effect'], 'observe'>,
      risk: definition.risk as Exclude<GameToolDefinition['risk'], 'low'>,
      argumentsDigest, previewDigest, documentId: document.documentId, baseRevision: document.revision, target: preview.target,
      expiresAt, decision: 'pending',
    });
    this.preparations.set(preparationId, stored);
    await this.options.operationLog.append({
      kind: 'tool/call-prepared', severity: 'info', source: asStableId('studio.game-tools'),
      correlation: correlation(call, approvalId), payload: { toolId: definition.id, toolVersion: definition.version, effect: definition.effect, risk: definition.risk, argumentsDigest, previewDigest, preparationId, status },
    }, { signal });
    if (stored.approval) await this.options.operationLog.append({
      kind: 'approval/requested', severity: 'warning', source: asStableId('studio.game-tools'), correlation: correlation(call, stored.approval.approvalId),
      payload: { preparationId, toolId: definition.id, effect: definition.effect, risk: definition.risk, target: preview.target, argumentsDigest, previewDigest, documentId: document.documentId, baseRevision: document.revision, expiresAt: stored.approval.expiresAt },
    }, { signal });
    else if (autoAllowed && approvalScopeDigest) await this.options.operationLog.append({
      kind: 'approval/auto-allowed', severity: 'info', source: asStableId('studio.game-tools'), correlation: correlation(call),
      payload: { preparationId, toolId: definition.id, toolVersion: definition.version, effect: definition.effect, risk: definition.risk, target: preview.target, documentId: document.documentId, scope: 'project-session', scopeDigest: approvalScopeDigest, argumentsDigest, previewDigest },
    }, { signal });
    return view;
  }

  approval(id: StableId): GameToolApproval | undefined { this.assertActive(); return [...this.preparations.values()].find((item) => item.approval?.approvalId === id)?.approval; }

  async decide(approvalId: StableId, decision: GameToolApprovalResolution): Promise<GameToolApproval> {
    this.assertActive();
    const stored = [...this.preparations.values()].find((item) => item.approval?.approvalId === approvalId);
    if (!stored?.approval || stored.approval.decision !== 'pending') throw new GameToolProtocolError('approval.unavailable', `Approval ${approvalId} is not pending.`);
    const expired = Date.parse(stored.approval.expiresAt) <= this.clock();
    const nextDecision = expired ? 'expired' : decision;
    if (nextDecision === 'allow-always' && stored.approvalScopeDigest) this.approvalGrants.add(stored.approvalScopeDigest);
    stored.approval = Object.freeze({ ...stored.approval, decision: nextDecision });
    stored.view = Object.freeze({ ...stored.view, status: isAllowDecision(nextDecision) ? 'ready' : nextDecision === 'expired' ? 'expired' : 'rejected' });
    await this.options.operationLog.append({
      kind: `approval/${nextDecision}`, severity: isAllowDecision(nextDecision) ? 'info' : 'warning', source: asStableId('studio.game-tools'),
      correlation: correlation(stored.call, approvalId), payload: { preparationId: stored.view.id, toolId: stored.definition.id, toolVersion: stored.definition.version, decision: nextDecision, scope: nextDecision === 'allow-always' ? 'project-session' : 'operation', scopeDigest: stored.approvalScopeDigest ?? null, target: stored.preview.target, documentId: stored.view.documentId, argumentsDigest: stored.view.argumentsDigest, previewDigest: stored.view.previewDigest },
    });
    return stored.approval;
  }

  async execute(preparationId: StableId, signal?: AbortSignal): Promise<GameToolResult> {
    this.assertActive();
    const stored = this.preparations.get(preparationId);
    if (!stored) throw new GameToolProtocolError('tool.preparation-missing', `Preparation ${preparationId} is missing or consumed.`);
    if (stored.view.status === 'rejected' && !stored.approval) return this.finishWithoutExecution(stored, 'cancelled');
    if (stored.approval?.decision === 'pending') throw new GameToolProtocolError('approval.required', 'The exact tool operation still requires approval.');
    if (stored.approval && !isAllowDecision(stored.approval.decision)) return this.finishWithoutExecution(stored, stored.approval.decision === 'cancel' ? 'cancelled' : 'rejected');
    if (stored.view.expiresAt && Date.parse(stored.view.expiresAt) <= this.clock()) {
      stored.view = Object.freeze({ ...stored.view, status: 'expired' });
      if (stored.approval) stored.approval = Object.freeze({ ...stored.approval, decision: 'expired' });
      return this.finishWithoutExecution(stored, 'rejected');
    }
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
    const timer = setTimeout(() => controller.abort(new GameToolProtocolError('tool.timeout', `Tool ${stored.definition.id} exceeded ${stored.definition.timeoutMs} ms.`, true)), stored.definition.timeoutMs);
    try {
      await this.options.operationLog.append({ kind: 'tool/execution-started', severity: 'info', source: asStableId('studio.game-tools'), correlation: correlation(stored.call, stored.approval?.approvalId), payload: { preparationId: stored.view.id, toolId: stored.definition.id, argumentsDigest: stored.view.argumentsDigest, previewDigest: stored.view.previewDigest } }, { signal: controller.signal });
      const value = await executeHandler(stored, this.options, this.proposals, this.previewPlans, controller.signal);
      assertResultBudget(value, stored.definition.maxResultBytes);
      const after = requireDocument(this.options.workspace);
      const result: GameToolResult = Object.freeze({
        schemaVersion: 1, callId: stored.call.id, toolId: stored.definition.id, status: 'completed', value,
        documentId: after.documentId, beforeRevision: stored.view.baseRevision, afterRevision: after.revision,
        ...(historyLabel(stored.definition.id) ? { historyLabel: historyLabel(stored.definition.id) } : {}),
      });
      await this.options.operationLog.append({ kind: 'tool/execution-completed', severity: 'info', source: asStableId('studio.game-tools'), correlation: correlation(stored.call, stored.approval?.approvalId), payload: { toolId: stored.definition.id, beforeRevision: result.beforeRevision, afterRevision: result.afterRevision, resultDigest: sha256(canonicalStringify(value)), historyLabel: result.historyLabel ?? null } });
      return result;
    } catch (cause) {
      await this.options.operationLog.append({ kind: 'tool/execution-failed', severity: 'error', source: asStableId('studio.game-tools'), correlation: correlation(stored.call, stored.approval?.approvalId), payload: { toolId: stored.definition.id, code: cause instanceof GameToolProtocolError ? cause.code : 'tool.execution-failed', message: errorMessage(cause) } }).catch(() => {});
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
  private assertActive(): void { if (this.disposed) throw new GameToolProtocolError('tool.runtime-disposed', 'Game tool runtime is disposed.'); }
}

async function executeHandler(stored: StoredPreparation, options: GameAuthoringToolRuntimeOptions, proposals: Map<StableId, ScriptEditProposal>, plans: Map<StableId, PreviewPlan>, signal: AbortSignal): Promise<JsonObject> {
  const args = stored.arguments as Record<string, JsonValue>;
  const scene = options.scene.snapshot();
  switch (stored.definition.id) {
    case 'project.snapshot': {
      const workspace = options.workspace.snapshot(); const document = requireDocument(options.workspace);
      return Object.freeze({ projectId: document.projectId, documentId: document.documentId, name: document.name, revision: document.revision, savedRevision: document.savedRevision, dirty: document.dirty, sceneRevision: scene.revision, logHealth: workspace.logging.health });
    }
    case 'scene.list-entities': return Object.freeze({ documentId: scene.documentId, revision: scene.revision, entities: Object.freeze(scene.entities.slice(0, 200).map(entitySummary)), truncated: scene.entities.length > 200 });
    case 'entity.get': return Object.freeze({ documentId: scene.documentId, revision: scene.revision, entity: entitySummary(requireEntity(scene, args.entityId as StableId)) });
    case 'script.get': {
      const catalog = options.scripts.snapshot(); const resource = catalog.resources.find((item) => item.id === args.scriptId || item.entityId === args.entityId);
      if (!resource) throw new GameToolProtocolError('tool.script-missing', 'Requested script does not exist.');
      return Object.freeze({ documentId: catalog.documentId, revision: catalog.documentRevision, script: Object.freeze({ id: resource.id, entityId: resource.entityId, name: resource.name, text: resource.text.slice(0, 65_536), textRevision: resource.textRevision, truncated: resource.text.length > 65_536 }) });
    }
    case 'diagnostics.query': {
      const query = args as unknown as OperationLogQuery; const page = await options.diagnostics.safeSummaries(query);
      const events = Object.freeze(page.map((item) => Object.freeze({ sequence: item.sequence, eventId: item.eventId, timestamp: item.timestamp, kind: item.kind, severity: item.severity, source: item.source, correlation: item.correlation as JsonObject, payloadDigest: item.payloadDigest, redactedFieldCount: item.redactedFieldCount })));
      return Object.freeze({ events, count: events.length, range: events.length ? Object.freeze({ first: events[0]!.sequence, last: events.at(-1)!.sequence }) : null, digest: sha256(canonicalStringify(events as unknown as JsonValue)) });
    }
    case 'entity.create': {
      const beforeIds = new Set(scene.entities.map((item) => item.id));
      const next = await options.scene.createEntity({ commandId: commandId(stored.call.id), baseRevision: args.baseRevision as number, kind: args.kind as SceneEntityKind, ...(args.name ? { name: args.name as string } : {}), ...('parentId' in args ? { parentId: args.parentId as StableId | null } : {}), ...(args.material ? { material: args.material as never } : {}), ...(args.transform ? { transform: args.transform as unknown as TransformSnapshot } : {}) }, signal);
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
      const next = await options.scene.setMaterial({ commandId: commandId(stored.call.id), baseRevision: args.baseRevision as number, entityId: args.entityId as StableId, material: args.material as never }, signal);
      return Object.freeze({ entity: entitySummary(requireEntity(next, args.entityId as StableId)), revision: next.revision });
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
      const plan = await options.scripts.prepare(args.scriptId as StableId, args.capabilities as ScriptCapabilityName[] | undefined); plans.set(plan.id, plan);
      return Object.freeze({ planId: plan.id, scriptId: plan.scriptId, entityId: plan.entityId, documentRevision: plan.documentRevision, textRevision: plan.textRevision, digest: plan.digest, capabilities: plan.capabilities, risk: plan.risk, diagnostics: plan.diagnostics.map((item) => Object.freeze({ code: item.code, severity: item.severity, line: item.line, column: item.column, message: item.message })) });
    }
    case 'preview.start': {
      const planId = args.planId as StableId; const plan = plans.get(planId); if (!plan) throw new GameToolProtocolError('tool.preview-plan-missing', 'Validated preview plan is unavailable.');
      const grant = await options.scripts.decide(planId, true); if (!grant) throw new GameToolProtocolError('tool.preview-rejected', 'Preview authorization was rejected.');
      const consumed = options.scripts.consume(grant.id); if (consumed.digest !== plan.digest) throw new GameToolProtocolError('approval.digest-mismatch', 'Preview plan changed after approval.');
      const runtime = await options.preview.start(scene, consumed, signal); plans.delete(planId); return Object.freeze({ state: runtime.state, instanceId: runtime.instanceId, entityId: runtime.entityId, disposableCount: runtime.disposableCount });
    }
    case 'preview.stop': {
      const runtime = await options.preview.stop(signal); return Object.freeze({ state: runtime.state, instanceId: runtime.instanceId, disposedSideEffects: runtime.disposableCount });
    }
    default: throw new GameToolProtocolError('tool.not-found', `Tool ${stored.definition.id} has no handler.`);
  }
}

function validateToolCall(value: unknown): GameToolCall {
  if (!isRecord(value) || Object.keys(value).some((key) => !['schemaVersion', 'id', 'sessionId', 'turnId', 'toolId', 'toolVersion', 'arguments'].includes(key)) || value.schemaVersion !== 1 || !isRecord(value.arguments)) throw new GameToolProtocolError('tool.call-invalid', 'Tool call envelope is invalid.');
  return Object.freeze({ schemaVersion: 1, id: stable(value.id, 'tool call id'), sessionId: stable(value.sessionId, 'session id'), turnId: stable(value.turnId, 'turn id'), toolId: stable(value.toolId, 'tool id'), toolVersion: string(value.toolVersion, 'tool version', 32), arguments: value.arguments as JsonObject });
}

function normalizeArguments(toolId: StableId, value: JsonObject, currentRevision: number): JsonObject {
  const raw = value as Record<string, unknown>;
  switch (toolId) {
    case 'project.snapshot': case 'scene.list-entities': case 'preview.stop': exact(raw, [], [], toolId); return Object.freeze({});
    case 'entity.get': exact(raw, ['entityId'], [], toolId); return Object.freeze({ entityId: stable(raw.entityId, 'entity id') });
    case 'script.get': { exact(raw, [], ['entityId', 'scriptId'], toolId); if (!raw.entityId && !raw.scriptId) throw invalid('script.get requires entityId or scriptId.'); return Object.freeze({ ...(raw.entityId ? { entityId: stable(raw.entityId, 'entity id') } : {}), ...(raw.scriptId ? { scriptId: stable(raw.scriptId, 'script id') } : {}) }); }
    case 'diagnostics.query': return normalizeLogQuery(raw);
    case 'entity.create': {
      exact(raw, ['kind'], ['baseRevision', 'name', 'parentId', 'material', 'transform'], toolId);
      if (!['empty', 'cube', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron', 'directional-light', 'point-light', 'ambient-light'].includes(String(raw.kind))) throw invalid('Entity kind is invalid.');
      if (raw.material !== undefined && !isSceneMaterialKind(raw.material)) throw invalid('Material kind is invalid.');
      if (raw.material !== undefined && !isSceneGeometryKind(raw.kind)) throw invalid('Only geometry entities can select a material.');
      return Object.freeze({ baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), kind: raw.kind as JsonValue, ...(raw.name === undefined ? {} : { name: boundedString(raw.name, 'name', 80, true) }), ...(raw.parentId === undefined ? {} : { parentId: raw.parentId === null ? null : stable(raw.parentId, 'parent id') }), ...(raw.material === undefined ? {} : { material: raw.material as JsonValue }), ...(raw.transform === undefined ? {} : { transform: normalizeTransform(raw.transform) as unknown as JsonValue }) });
    }
    case 'entity.rename': exact(raw, ['entityId', 'name'], ['baseRevision'], toolId); return Object.freeze({ baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), entityId: stable(raw.entityId, 'entity id'), name: boundedString(raw.name, 'name', 80, true) });
    case 'transform.set': exact(raw, ['entityId', 'transform'], ['baseRevision'], toolId); return Object.freeze({ baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), entityId: stable(raw.entityId, 'entity id'), transform: normalizeTransform(raw.transform) as unknown as JsonValue });
    case 'material.set': exact(raw, ['entityId', 'material'], ['baseRevision'], toolId); if (!isSceneMaterialKind(raw.material)) throw invalid('Material kind is invalid.'); return Object.freeze({ baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), entityId: stable(raw.entityId, 'entity id'), material: raw.material });
    case 'script.propose': exact(raw, ['entityId', 'text'], ['baseRevision', 'capabilities'], toolId); return Object.freeze({ baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), entityId: stable(raw.entityId, 'entity id'), text: boundedString(raw.text, 'text', 65_536, true), ...(raw.capabilities ? { capabilities: normalizeCapabilities(raw.capabilities) } : {}) });
    case 'script.apply': exact(raw, ['proposalId'], ['baseRevision'], toolId); return Object.freeze({ baseRevision: revisionOrCurrent(raw.baseRevision, currentRevision), proposalId: stable(raw.proposalId, 'proposal id') });
    case 'preview.validate': exact(raw, ['scriptId'], ['capabilities'], toolId); return Object.freeze({ scriptId: stable(raw.scriptId, 'script id'), ...(raw.capabilities ? { capabilities: normalizeCapabilities(raw.capabilities) } : {}) });
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
    case 'entity.create': return preview('Create entity', snapshot.documentId, `Create ${raw.kind}${raw.name ? ` named ${raw.name}` : ''}.`, `+ ${raw.kind} ${raw.name ?? ''}`.trim());
    case 'entity.rename': { const entity = requireEntity(snapshot, raw.entityId as StableId); return preview('Rename entity', entity.id, `Rename ${entity.name} to ${raw.name}.`, `- ${entity.name}\n+ ${raw.name}`); }
    case 'transform.set': { const entity = requireEntity(snapshot, raw.entityId as StableId); return preview('Set Transform', entity.id, `Replace Transform for ${entity.name}.`, `${canonicalStringify(entity.transform as unknown as JsonObject)}\n→ ${canonicalStringify(raw.transform as JsonObject)}`); }
    case 'material.set': {
      const entity = requireEntity(snapshot, raw.entityId as StableId);
      if (!isSceneGeometryKind(entity.kind)) throw invalid('Only geometry entities can use materials.');
      return preview('Set material', entity.id, `Apply ${raw.material} material to ${entity.name}.`, `${entity.appearance?.material ?? 'none'} → ${raw.material}`);
    }
    case 'script.apply': {
      const proposal = proposals.get(raw.proposalId as StableId);
      if (!proposal) throw new GameToolProtocolError('tool.proposal-missing', 'Script proposal is unavailable.');
      if (proposal.baseRevision !== raw.baseRevision) throw new GameToolProtocolError('tool.stale-revision', 'Script proposal base revision differs.');
      const errors = proposal.diagnostics.filter((item) => item.severity === 'error');
      if (errors.length) throw new GameToolProtocolError('tool.script-validation-failed', `Script proposal has ${errors.length} validation error(s): ${errors.slice(0, 4).map((item) => `${item.code} ${item.line}:${item.column} ${item.message}`).join(' | ')} Rewrite and propose again before apply.`);
      return preview('Apply script proposal', proposal.scriptId, `Commit validated proposal with +${proposal.addedLines}/-${proposal.removedLines} lines.`, `digest ${proposal.digest}`);
    }
    case 'preview.start': { const plan = plans.get(raw.planId as StableId); if (!plan) throw new GameToolProtocolError('tool.preview-plan-missing', 'Preview plan is unavailable.'); if (plan.documentRevision !== raw.baseRevision) throw new GameToolProtocolError('tool.stale-revision', 'Preview plan base revision differs.'); return preview('Start trusted preview', plan.scriptId, `Start trusted-project preview with ${plan.capabilities.join(', ')}.`, `script digest ${plan.digest}`); }
    default: return preview(GAME_AUTHORING_TOOL_BY_ID.get(toolId)?.title ?? toolId, snapshot.documentId, `Execute ${toolId}.`, 'No Document mutation in this step.');
  }
}

function approvalGrantDigest(documentId: StableId, definition: GameToolDefinition, target: string): string {
  return sha256(canonicalStringify({ schemaVersion: 1, documentId, toolId: definition.id, toolVersion: definition.version, effect: definition.effect, risk: definition.risk, target }));
}

function isAllowDecision(decision: GameToolApproval['decision']): boolean { return decision === 'allow-once' || decision === 'allow-always'; }

function preview(title: string, target: string, summary: string, diff: string): GameToolPreview { return Object.freeze({ title, target, summary, diff }); }
function requireDocument(workspace: ProjectWorkspace): NonNullable<ReturnType<ProjectWorkspace['snapshot']>['document']> { const document = workspace.snapshot().document; if (!document) throw new GameToolProtocolError('tool.project-missing', 'No project is open.'); return document; }
function requireEntity(scene: ReturnType<SceneAuthoringService['snapshot']>, id: StableId) { const entity = scene.entities.find((item) => item.id === id); if (!entity) throw new GameToolProtocolError('tool.entity-missing', `Entity ${id} does not exist.`); return entity; }
function entitySummary(entity: ReturnType<SceneAuthoringService['snapshot']>['entities'][number]): JsonObject { return Object.freeze({ id: entity.id, name: entity.name, kind: entity.kind, parentId: entity.parentId, order: entity.order, transform: entity.transform as unknown as JsonValue, ...(entity.appearance ? { appearance: entity.appearance as unknown as JsonValue } : {}), ...(entity.light ? { light: entity.light as unknown as JsonValue } : {}) }); }
function commandId(callId: StableId): StableId { return asStableId(`command:agent:${sha256(callId).slice(7, 31)}`); }
function historyLabel(toolId: StableId): string | undefined { return ({ 'entity.create': 'Create Scene Entity', 'entity.rename': 'Rename Entity', 'transform.set': 'Edit Transform', 'material.set': 'Set Material', 'script.apply': 'Edit Entity Script' } as Record<string, string>)[toolId]; }
function correlation(call: GameToolCall, approvalId?: StableId) { return Object.freeze({ sessionId: call.sessionId, turnId: call.turnId, toolCallId: call.id, ...(approvalId ? { approvalId } : {}) }); }
function readBaseRevision(args: JsonObject): number | undefined { return typeof args.baseRevision === 'number' ? args.baseRevision : undefined; }
function assertResultBudget(value: JsonObject, maximum: number): void { if (new TextEncoder().encode(canonicalStringify(value)).byteLength > maximum) throw new GameToolProtocolError('tool.result-too-large', `Tool result exceeds ${maximum} bytes.`); }
function enforceLogHealth(toolId: StableId, effect: GameToolDefinition['effect'], status: ReturnType<OperationLog['status']>): void { if (toolId === 'preview.stop' || effect === 'observe') return; const allowed = effect === 'reversible-edit' ? status.allowsMutation : effect === 'trusted-code' ? status.allowsTrustedCode : status.allowsRuntimeStart; if (!allowed) throw new GameToolProtocolError('tool.log-unavailable', `Operation Log health ${status.health} blocks ${effect}.`); }
function normalizeTransform(value: unknown): TransformSnapshot { if (!isRecord(value)) throw invalid('Transform must be an object.'); exact(value, ['position', 'rotationDegrees', 'scale']); const result = Object.freeze({ position: vec(value.position, 'position'), rotationDegrees: vec(value.rotationDegrees, 'rotationDegrees'), scale: vec(value.scale, 'scale') }); if (result.scale.x <= 0 || result.scale.y <= 0 || result.scale.z <= 0) throw invalid('Transform scale must be positive.'); return result; }
function vec(value: unknown, label: string) { if (!isRecord(value)) throw invalid(`${label} must be an object.`); exact(value, ['x', 'y', 'z']); const result = { x: number(value.x, `${label}.x`), y: number(value.y, `${label}.y`), z: number(value.z, `${label}.z`) }; return Object.freeze(result); }
function normalizeCapabilities(value: unknown): readonly ScriptCapabilityName[] { return enumArray(value, ['read', 'input', 'debug', 'scene'], 4) as readonly ScriptCapabilityName[]; }
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = [], label = 'Tool'): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !(key in value));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length || unknown.length) throw invalid(`${label} arguments invalid; missing required fields: ${missing.join(', ') || 'none'}; unknown fields: ${unknown.join(', ') || 'none'}; allowed fields: ${[...allowed].join(', ') || 'none'}.`);
}
function optionalIdFields(value: Record<string, unknown>, keys: readonly string[]): JsonObject { return Object.freeze(Object.fromEntries(keys.flatMap((key) => value[key] === undefined ? [] : [[key, stable(value[key], key)]]))); }
function optionalIntegers(value: Record<string, unknown>, keys: readonly string[]): JsonObject { return Object.freeze(Object.fromEntries(keys.flatMap((key) => value[key] === undefined ? [] : [[key, integer(value[key], key)]]))); }
function enumArray(value: unknown, allowed: readonly string[], maximum: number): readonly string[] { if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== 'string' || !allowed.includes(item))) throw invalid('Enum array is invalid.'); return Object.freeze([...new Set(value)]); }
function stringArray(value: unknown, maximum: number, maxLength: number): readonly string[] { if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== 'string' || item.length > maxLength)) throw invalid('String array is invalid.'); return Object.freeze([...new Set(value)]); }
function stable(value: unknown, label: string): StableId { if (typeof value !== 'string') throw invalid(`${label} is invalid.`); try { return asStableId(value, label); } catch { throw invalid(`${label} is invalid.`); } }
function string(value: unknown, label: string, maximum: number): string { if (typeof value !== 'string' || !value || value.length > maximum) throw invalid(`${label} is invalid.`); return value; }
function boundedString(value: unknown, label: string, maximum: number, nonEmpty = false): string { if (typeof value !== 'string' || value.length > maximum || (nonEmpty && !value.trim())) throw invalid(`${label} is invalid.`); return value; }
function integer(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(`${label} is invalid.`); return value as number; }
function revisionOrCurrent(value: unknown, currentRevision: number): number { return value === undefined ? currentRevision : integer(value, 'baseRevision'); }
function number(value: unknown, label: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${label} is invalid.`); return value; }
function invalid(message: string): GameToolProtocolError { return new GameToolProtocolError('tool.arguments-invalid', message); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function fuseAbort(signal: AbortSignal | undefined, controller: AbortController): () => void { if (!signal) return () => {}; const abort = () => controller.abort(signal.reason); if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); return () => signal.removeEventListener('abort', abort); }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
