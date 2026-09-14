import { assertAssemblyPlan, normalizeAssemblyArguments, planAssembly, inspectAssembly } from './assemblies.js';
import { scopePlayInspection } from './play-inspection.js';
import { QUERY_PAGE_SIZE } from './query-limits.js';
import type { EngineDocumentation } from './engine-docs.js';
import { roundedBoxParameters } from '@haiyue/ai-studio-editor-plugins/render';
import { randomUUID } from 'node:crypto';
import { asStableId, type ComponentDefinitionV2, type GameComponentInstanceV2, type GameDocumentOperationV2, type JsonObject, type JsonValue, type StableId } from '@haiyue/ai-studio-contracts';
import { isSceneGeometryKind, isSceneMaterialKind, normalizeProjectCamera, projectCameraFromSettings, PROJECT_CAMERA_SETTING_KEY, type ProjectWorkspace, type SceneAuthoringService, type SceneContextProjection, type SceneContextScope, type SceneDiffInput, type SceneEntityKind, type SceneMaterialColor, type SceneQueryInput, type TransformSnapshot } from '@haiyue/ai-studio-editor-plugins';
import { CONTROLLED_ASSET_CATALOG_SETTING_KEY, ControlledAssetCatalog, ControlledAssetError, type ControlledAssetKind, type ControlledAssetLicense } from '@haiyue/ai-studio-editor-plugins/assets';
import { canonicalStringify, sha256, projectLogQuery, type DiagnosticsQueryService, type OperationEventInput, type OperationLog, type OperationLogQuery } from '@haiyue/ai-studio-operation-log';
import type { PreviewPlan, ScriptCapabilityName, ScriptEditProposal, ScriptPreviewStudioService } from '@haiyue/ai-studio-script-preview';
import { normalizeCanvasTextureRecipe, type CanvasTextureRenderer } from './canvas-texture.js';
import { GAME_AUTHORING_TOOL_BY_ID, GAME_AUTHORING_TOOL_DEFINITIONS } from './definitions.js';
import { DeterministicTaskEvaluator, PlayObservationRepository } from './observations.js';
import { classifyToolConcurrency } from './scheduler/classify.js';
import { EffectLockManager, effectLockKeys } from './scheduler/effect-locks.js';
import { SceneTransactionCoordinator } from './transactions.js';
import { ToolCatalogRuntime, type ToolSchemaSelection } from './catalog/index.js';
import { BehaviorToolReader, isBehaviorTool, normalizeBehaviorArguments, type GameBehaviorSource } from './behavior.js';
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
  type GameToolTransactionInput,
  type GameToolTransactionResult,
} from './types.js';

export interface GameAuthoringToolRuntimeOptions {
  readonly workspace: ProjectWorkspace;
  readonly documentation?: EngineDocumentation;
  readonly textureRenderer?: CanvasTextureRenderer;
  readonly scene: SceneAuthoringService;
  readonly scripts: ScriptPreviewStudioService;
  readonly diagnostics: DiagnosticsQueryService;
  readonly operationLog: OperationLog;
  readonly preview: GamePreviewControl;
  readonly timeoutCeilingMs?: number;
  readonly observationByteLimit?: number;
  readonly effectLocks?: EffectLockManager;
  readonly behaviorSource?: GameBehaviorSource;
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

interface ReversibleTransactionMemberPlan {
  readonly stored: StoredPreparation;
  readonly label: string;
  readonly operations: readonly GameDocumentOperationV2[];
  readonly result: (afterRevision: number) => JsonObject;
}
interface TransactionPlanningContext { assemblyWrite?: boolean; readonly createOffsets: Map<string, number>; assetCatalog?: ControlledAssetCatalog; }

const PREFAB_REGISTRY_SETTING_KEY = 'studio.prefabs.v1';
const MAX_PREFABS = 64;
const MAX_PREFAB_ENTITIES = 128;
const MAX_PREFAB_REGISTRY_BYTES = 512 * 1024;
interface StoredPrefabEntity {
  readonly id: StableId;
  readonly name: string;
  readonly parentId: StableId | null;
  readonly order: number;
  readonly componentIds: readonly StableId[];
}
interface StoredPrefab {
  readonly schemaVersion: 1;
  readonly id: StableId;
  readonly name: string;
  readonly rootEntityId: StableId;
  readonly entities: readonly StoredPrefabEntity[];
  readonly components: readonly GameComponentInstanceV2[];
  readonly scripts: readonly ReturnType<ProjectWorkspace['gameSnapshot']>['scripts'][number][];
  readonly digest: `sha256:${string}`;
}
interface StoredPrefabRegistry { readonly schemaVersion: 1; readonly prefabs: readonly StoredPrefab[]; }

export class GameAuthoringToolRuntime {
  private readonly preparations = new Map<StableId, StoredPreparation>();
  private readonly proposals = new Map<StableId, ScriptEditProposal>();
  private readonly previewPlans = new Map<StableId, PreviewPlan>();
  private readonly active = new Map<StableId, AbortController>();
  private readonly approvalGrants = new Set<string>();
  private mutationTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly observations: PlayObservationRepository;
  private readonly evaluator: DeterministicTaskEvaluator;
  private readonly effectLocks: EffectLockManager;
  private readonly transactions: SceneTransactionCoordinator;
  private readonly catalog: ToolCatalogRuntime;
  private readonly behavior: BehaviorToolReader;
  private disposal: Promise<void> | undefined;

  constructor(private readonly options: GameAuthoringToolRuntimeOptions) {
    if (options.timeoutCeilingMs !== undefined && (!Number.isSafeInteger(options.timeoutCeilingMs) || options.timeoutCeilingMs < 1 || options.timeoutCeilingMs > 20_000)) throw new TypeError('Tool timeout ceiling must be between one millisecond and twenty seconds.');
    this.observations = new PlayObservationRepository(options.operationLog, options.observationByteLimit);
    this.evaluator = new DeterministicTaskEvaluator(this.observations, () => requireDocument(options.workspace).revision);
    this.effectLocks = options.effectLocks ?? new EffectLockManager();
    this.transactions = new SceneTransactionCoordinator(options.workspace, options.operationLog, this.effectLocks);
    this.catalog = new ToolCatalogRuntime(GAME_AUTHORING_TOOL_DEFINITIONS, () => options.workspace.componentRegistry.snapshot().definitions);
    this.behavior = new BehaviorToolReader(options.behaviorSource, () => requireDocument(options.workspace));
  }

  assertAssemblyPlan(expectations: readonly JsonObject[], toolId: string, args: JsonObject): void { this.assertActive(); assertAssemblyPlan(this.options.workspace.gameSnapshot(), expectations, toolId, args); }

  definitions(): readonly GameToolDefinition[] { this.assertActive(); return GAME_AUTHORING_TOOL_DEFINITIONS; }
  selectDefinitions(request: string, expandedIds: readonly StableId[] = []): ToolSchemaSelection { this.assertActive(); return this.catalog.selectDefinitions(request, expandedIds); }
  snapshot(): GameToolRuntimeSnapshot { return Object.freeze({ definitions: GAME_AUTHORING_TOOL_DEFINITIONS, pendingPreparations: this.preparations.size, pendingApprovals: [...this.preparations.values()].filter((item) => item.approval?.decision === 'pending').length, activeCalls: this.active.size, activeApprovalGrants: this.approvalGrants.size, effectLocks: this.effectLocks.snapshot(), disposed: this.disposed }); }

  async prepare(value: unknown, signal?: AbortSignal): Promise<GameToolPreparation> {
    this.assertActive();
    const call = validateToolCall(value);
    const project = this.options.workspace.snapshot().document;
    if (project) callProjects.set(call, { projectId: project.projectId, documentId: project.documentId });
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
    const operation = () => this.executeWithEffectLock(stored, signal);
    return (stored.definition.effect === 'observe' && !stored.definition.id.startsWith('play.')) || stored.definition.id === 'script.propose' || stored.definition.id === 'preview.validate' || stored.definition.id === 'preview.stop'
      ? operation() : this.serializeMutation(operation);
  }

  async executeTransaction(input: GameToolTransactionInput, signal?: AbortSignal): Promise<GameToolTransactionResult> {
    this.assertActive();
    if (!input || !Array.isArray(input.preparationIds) || input.preparationIds.length < 1 || input.preparationIds.length > 100) throw new GameToolProtocolError('scene-transaction.members-invalid', 'A Scene transaction requires 1-100 prepared members.');
    if (new Set(input.preparationIds).size !== input.preparationIds.length) throw new GameToolProtocolError('scene-transaction.members-invalid', 'Scene transaction preparation ids must be unique.');
    return this.serializeMutation(async () => {
      const storedMembers = input.preparationIds.map((id) => {
        const stored = this.preparations.get(id);
        if (!stored) throw new GameToolProtocolError('tool.preparation-missing', `Preparation ${id} is missing or consumed.`);
        return stored;
      });
      const first = storedMembers[0]!;
      if (first.call.sessionId !== input.sessionId || first.call.turnId !== input.turnId) throw new GameToolProtocolError('scene-transaction.coordinate-mismatch', 'Scene transaction coordinates do not match its prepared members.');
      for (const stored of storedMembers) {
        if (stored.call.sessionId !== input.sessionId || stored.call.turnId !== input.turnId || stored.view.documentId !== first.view.documentId || stored.view.baseRevision !== first.view.baseRevision) throw new GameToolProtocolError('scene-transaction.coordinate-mismatch', 'Every Scene transaction member must share one session, turn, document and base revision.');
        if (stored.definition.effect !== 'reversible-edit') throw new GameToolProtocolError('scene-transaction.member-ineligible', `${stored.definition.id} is not a reversible Scene mutation.`);
        if (stored.approval?.decision === 'pending') await this.invalidatePendingApproval(stored);
        if (stored.view.status !== 'ready' || (stored.approval && !isAllowDecision(stored.approval.decision))) throw new GameToolProtocolError('scene-transaction.approval-required', `Preparation ${stored.view.id} is not approved and ready.`);
        if (sha256(canonicalStringify(stored.arguments)) !== stored.view.argumentsDigest || sha256(canonicalStringify(stored.preview as unknown as JsonObject)) !== stored.view.previewDigest) throw new GameToolProtocolError('approval.digest-mismatch', 'Prepared arguments or preview changed.');
      }
      const document = requireDocument(this.options.workspace);
      if (document.documentId !== first.view.documentId || document.revision !== first.view.baseRevision) throw new GameToolProtocolError('tool.stale-revision', 'Document changed after transaction preparation; prepare every member again.', true);
      const planning: TransactionPlanningContext = { createOffsets: new Map<string, number>() };
      const plans: ReversibleTransactionMemberPlan[] = [];
      for (const stored of storedMembers) plans.push(await planReversibleTransactionMember(stored, this.options, planning, signal));
      for (const plan of plans) await this.appendFact(plan.stored.definition, { kind: 'tool/execution-started', severity: 'info', source: asStableId('studio.game-tools'), correlation: correlation(plan.stored.call, plan.stored.approval?.approvalId), payload: { preparationId: plan.stored.view.id, toolId: plan.stored.definition.id, argumentsDigest: plan.stored.view.argumentsDigest, previewDigest: plan.stored.view.previewDigest, batchId: input.batchId, transaction: true } }, signal);
      const prepared = await this.transactions.prepare({
        sessionId: input.sessionId, turnId: input.turnId, batchId: input.batchId, documentId: first.view.documentId, baseRevision: first.view.baseRevision,
        label: plans.length === 1 ? plans[0]!.label : `Agent batch · ${plans.length} edits`,
        members: plans.map((plan) => {
          const classification = classifyToolConcurrency(plan.stored.definition, plan.stored.arguments);
          return Object.freeze({ nodeId: plan.stored.call.id, toolCallId: plan.stored.call.id, toolId: plan.stored.definition.id, toolVersion: plan.stored.definition.version, effectKeys: effectLockKeys(classification.executionClass, classification.effectKeys), operations: plan.operations });
        }),
      }, signal);
      const committed = await this.transactions.commit(prepared.id, signal);
      const receipt = committed.commit.receipt;
      const transaction = Object.freeze({ transactionId: prepared.id, idempotencyKey: prepared.idempotencyKey, receiptDigest: receipt.receiptDigest, receiptArtifactId: receipt.artifactId, memberCount: plans.length, replayed: committed.commit.replayed });
      const results = Object.freeze(plans.map((plan): GameToolResult => {
        this.preparations.delete(plan.stored.view.id); plan.stored.view = Object.freeze({ ...plan.stored.view, status: 'consumed' });
        return Object.freeze({ schemaVersion: 1, callId: plan.stored.call.id, toolId: plan.stored.definition.id, status: 'completed', value: plan.result(receipt.afterRevision), documentId: receipt.documentId, beforeRevision: receipt.beforeRevision, afterRevision: receipt.afterRevision, historyLabel: receipt.historyLabel, transaction });
      }));
      for (const result of results) {
        const stored = storedMembers.find((candidate) => candidate.call.id === result.callId)!;
        await this.appendFact(stored.definition, { kind: 'tool/execution-completed', severity: 'info', source: asStableId('studio.game-tools'), correlation: correlation(stored.call, stored.approval?.approvalId), artifactRefs: [receipt.artifactId], payload: { toolId: stored.definition.id, beforeRevision: result.beforeRevision, afterRevision: result.afterRevision, resultDigest: sha256(canonicalStringify(result.value)), historyLabel: result.historyLabel ?? null, transactionId: prepared.id, idempotencyKey: prepared.idempotencyKey, receiptDigest: receipt.receiptDigest, receiptArtifactId: receipt.artifactId } });
      }
      return Object.freeze({ transactionId: prepared.id, idempotencyKey: prepared.idempotencyKey, receiptDigest: receipt.receiptDigest, receiptArtifactId: receipt.artifactId, beforeRevision: receipt.beforeRevision, afterRevision: receipt.afterRevision, replayed: committed.commit.replayed, results });
    });
  }

  private async executeWithEffectLock(stored: StoredPreparation, signal?: AbortSignal): Promise<GameToolResult> {
    const classification = classifyToolConcurrency(stored.definition, stored.arguments);
    if (classification.executionClass === 'parallel-read') return this.executeStored(stored, signal);
    const ownerId = asStableId(`effect-lock:${sha256(stored.call.id).slice(0, 24)}`);
    const keys = effectLockKeys(classification.executionClass, classification.effectKeys);
    const lease = await this.effectLocks.acquire(ownerId, keys, signal);
    await this.appendFact(stored.definition, {
      kind: 'tool/effect-lock-acquired', severity: 'info', source: asStableId('studio.game-tools'), correlation: correlation(stored.call, stored.approval?.approvalId),
      payload: { toolId: stored.definition.id, executionClass: classification.executionClass, effectKeys: keys, waitMs: lease.waitMs },
    }, signal);
    try { return await this.executeStored(stored, signal); }
    finally {
      lease.release();
      await this.options.operationLog.append({
        kind: 'tool/effect-lock-released', severity: 'info', source: asStableId('studio.game-tools'), correlation: correlation(stored.call, stored.approval?.approvalId),
        payload: { toolId: stored.definition.id, executionClass: classification.executionClass, effectKeys: keys },
      }).catch(() => undefined);
    }
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

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    for (const controller of this.active.values()) controller.abort(new GameToolProtocolError('tool.runtime-disposed', 'Game tool runtime disposed.'));
    this.active.clear(); this.preparations.clear(); this.proposals.clear(); this.previewPlans.clear(); this.approvalGrants.clear();
    return this.disposal = this.behavior.dispose();
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
      const value = await executeHandler(stored, this.options, this.proposals, this.previewPlans, this.observations, this.evaluator, this.catalog, this.behavior, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason ?? new GameToolProtocolError('tool.cancelled', 'Tool call was cancelled.');
      assertResultBudget(value, stored.definition.maxResultBytes);
      const after = requireDocument(this.options.workspace);
      if (isBehaviorTool(stored.definition.id) && (after.documentId !== stored.view.documentId || after.revision !== stored.view.baseRevision)) throw new GameToolProtocolError('behavior.stale', 'Project changed during the behavior read.', true);
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

async function planReversibleTransactionMember(stored: StoredPreparation, options: GameAuthoringToolRuntimeOptions, planning: TransactionPlanningContext, signal?: AbortSignal): Promise<ReversibleTransactionMemberPlan> {
  if (signal?.aborted) throw signal.reason ?? new GameToolProtocolError('tool.cancelled', 'Tool transaction planning was cancelled.');
  const args = stored.arguments as Record<string, JsonValue>;
  const scene = options.scene.snapshot();
  const result = (label: string, operations: readonly GameDocumentOperationV2[], project: (afterRevision: number) => JsonObject): ReversibleTransactionMemberPlan => Object.freeze({ stored, label, operations: Object.freeze([...operations]), result: project });
  switch (stored.definition.id) {
    case 'assembly.create': case 'assembly.instantiate': {
      if (planning.assemblyWrite) throw invalid('Use one assembly mutation per document transaction to preserve its registry.');
      planning.assemblyWrite = true;
      const plan = planAssembly(stored.definition.id, stored.arguments, options.workspace, stored.call.id);
      return result('Author composite assembly', plan.operations, revision => ({ ...plan.value, revision }));
    }
    case 'camera.set': {
      const camera = args.camera as JsonObject;
      return result('Set Camera', [{ op: 'setting.set', key: PROJECT_CAMERA_SETTING_KEY, value: camera }], (revision) => Object.freeze({ documentId: stored.view.documentId, revision, camera: projectCameraFromSettings(requireDocument(options.workspace).settings) as unknown as JsonValue }));
    }
    case 'camera.author': return planCameraAuthorMember(stored, options, args);
    case 'entity.create': {
      const kind = args.kind as SceneEntityKind;
      const parentId = 'parentId' in args ? args.parentId as StableId | null : null;
      const parentKey = parentId ?? '';
      const offset = planning.createOffsets.get(parentKey) ?? 0; planning.createOffsets.set(parentKey, offset + 1);
      const id = transactionGeneratedId('entity', stored.call.id);
      const name = typeof args.name === 'string' ? args.name : transactionEntityLabel(kind);
      const transform = (args.transform ?? DEFAULT_TRANSACTION_TRANSFORM) as unknown as TransformSnapshot;
      const operations: GameDocumentOperationV2[] = [
        { op: 'entity.add', entity: { id, sceneId: options.workspace.primarySceneId(), name, parentId, order: scene.entities.filter((item) => item.parentId === parentId).length + offset, componentIds: [] } },
        { op: 'component.add', entityId: id, component: options.workspace.componentRegistry.create({ id: transactionGeneratedId('component-transform', stored.call.id), type: asStableId('haiyue.transform.3d'), version: '1.0.0', value: transform as unknown as JsonObject }) },
      ];
      if (isSceneGeometryKind(kind)) {
        const appearance = Object.freeze({ material: (args.material ?? 'basic') as string, color: (args.color ?? DEFAULT_TRANSACTION_COLOR) as JsonValue }) as unknown as JsonObject;
        operations.push({ op: 'component.add', entityId: id, component: options.workspace.componentRegistry.create({ id: transactionGeneratedId('component-geometry', stored.call.id), type: asStableId('haiyue.render.geometry'), version: '1.0.0', value: { kind, ...roundedBoxParameters(kind, args), ...(args.plane ? { plane: args.plane } : {}) } }) });
        operations.push({ op: 'component.add', entityId: id, component: options.workspace.componentRegistry.create({ id: transactionGeneratedId('component-material', stored.call.id), type: asStableId('haiyue.render.material'), version: '1.0.0', value: appearance }) });
      } else if (kind === 'directional-light' || kind === 'point-light' || kind === 'ambient-light') {
        const type = kind === 'directional-light' ? 'haiyue.light.directional' : kind === 'point-light' ? 'haiyue.light.point' : 'haiyue.light.ambient';
        operations.push({ op: 'component.add', entityId: id, component: options.workspace.componentRegistry.create({ id: transactionGeneratedId('component-light', stored.call.id), type: asStableId(type), version: '1.0.0', value: transactionDefaultLight(kind) }) });
      }
      return result(`Create ${transactionEntityLabel(kind)}`, operations, (revision) => Object.freeze({ entity: entitySummary(requireEntity(options.scene.snapshot(), id)), revision }));
    }
    case 'entity.create-many': {
      const items = args.entities as readonly JsonObject[];
      const ids: StableId[] = [];
      const operations: GameDocumentOperationV2[] = [];
      for (const [index, item] of items.entries()) {
        const entry = item as Record<string, JsonValue>;
        const kind = entry.kind as SceneEntityKind;
        const parentId = 'parentId' in entry ? entry.parentId as StableId | null : null;
        if (parentId) requireEntity(scene, parentId);
        const parentKey = parentId ?? '';
        const offset = planning.createOffsets.get(parentKey) ?? 0; planning.createOffsets.set(parentKey, offset + 1);
        const itemCallId = asStableId(`toolcall:create-many:${sha256(`${stored.call.id}:${index}`).slice(0, 24)}`);
        const id = transactionGeneratedId('entity', itemCallId); ids.push(id);
        const name = typeof entry.name === 'string' ? entry.name : transactionEntityLabel(kind);
        const transform = (entry.transform ?? DEFAULT_TRANSACTION_TRANSFORM) as unknown as TransformSnapshot;
        operations.push(
          { op: 'entity.add', entity: { id, sceneId: options.workspace.primarySceneId(), name, parentId, order: scene.entities.filter((candidate) => candidate.parentId === parentId).length + offset, componentIds: [] } },
          { op: 'component.add', entityId: id, component: options.workspace.componentRegistry.create({ id: transactionGeneratedId('component-transform', itemCallId), type: asStableId('haiyue.transform.3d'), version: '1.0.0', value: transform as unknown as JsonObject }) },
        );
        if (isSceneGeometryKind(kind)) {
          const appearance = Object.freeze({ material: (entry.material ?? 'basic') as string, color: (entry.color ?? DEFAULT_TRANSACTION_COLOR) as JsonValue }) as unknown as JsonObject;
          operations.push({ op: 'component.add', entityId: id, component: options.workspace.componentRegistry.create({ id: transactionGeneratedId('component-geometry', itemCallId), type: asStableId('haiyue.render.geometry'), version: '1.0.0', value: { kind, ...roundedBoxParameters(kind, entry), ...(entry.plane ? { plane: entry.plane } : {}) } }) });
          operations.push({ op: 'component.add', entityId: id, component: options.workspace.componentRegistry.create({ id: transactionGeneratedId('component-material', itemCallId), type: asStableId('haiyue.render.material'), version: '1.0.0', value: appearance }) });
        } else if (kind === 'directional-light' || kind === 'point-light' || kind === 'ambient-light') {
          const type = kind === 'directional-light' ? 'haiyue.light.directional' : kind === 'point-light' ? 'haiyue.light.point' : 'haiyue.light.ambient';
          operations.push({ op: 'component.add', entityId: id, component: options.workspace.componentRegistry.create({ id: transactionGeneratedId('component-light', itemCallId), type: asStableId(type), version: '1.0.0', value: transactionDefaultLight(kind) }) });
        }
      }
      return result(`Create ${items.length} Scene Entities`, operations, (revision) => Object.freeze({ entities: Object.freeze(ids.map((id) => entitySummary(requireEntity(options.scene.snapshot(), id)))), count: ids.length, revision }));
    }
    case 'entity.rename': {
      const entityId = args.entityId as StableId; const name = args.name as string;
      requireEntity(scene, entityId);
      return result('Rename Entity', [{ op: 'entity.update', entityId, patch: { name } }], (revision) => Object.freeze({ entity: entitySummary(requireEntity(options.scene.snapshot(), entityId)), revision }));
    }
    case 'entity.hierarchy': return planEntityHierarchyMember(stored, options, args);
    case 'prefab.manage': return planPrefabMember(stored, options, args);
    case 'transform.set': {
      const entityId = args.entityId as StableId; const component = ownedComponent(options.workspace, entityId, 'haiyue.transform.3d');
      const replacement = options.workspace.componentRegistry.validate({ ...component, value: args.transform as JsonObject });
      return result('Edit Transform', [{ op: 'component.replace', component: replacement }], (revision) => Object.freeze({ entity: entitySummary(requireEntity(options.scene.snapshot(), entityId)), revision }));
    }
    case 'transform.batch': return planTransformBatchMember(stored, options, args);
    case 'material.set': {
      const entityId = args.entityId as StableId; const target = requireEntity(scene, entityId);
      if (!isSceneGeometryKind(target.kind) || !target.appearance) throw new GameToolProtocolError('tool.material-target-invalid', 'Only geometry entities can use materials.');
      const component = ownedComponent(options.workspace, entityId, 'haiyue.render.material');
      const replacement = options.workspace.componentRegistry.validate({ ...component, value: Object.freeze({ material: args.material, color: args.color ?? target.appearance.color }) as JsonObject });
      const pbr = target.components?.find(item => item.type === 'haiyue.material.pbr');
      const operations: GameDocumentOperationV2[] = [{ op: 'component.replace', component: replacement }];
      if (pbr) operations.push({ op: 'component.replace', component: options.workspace.componentRegistry.validate({ ...pbr, enabled: args.material === 'pbr', value: { ...pbr.value, ...(args.color ? { baseColor: args.color } : {}) } }) });
      return result('Set Material', operations, (revision) => Object.freeze({ entity: entitySummary(requireEntity(options.scene.snapshot(), entityId)), revision }));
    }
    case 'component.add': {
      const entityId = args.entityId as StableId; const type = asStableId(args.type as string, 'component type'); const definition = resolveComponentDefinition(options.workspace, type, args.version as string | undefined);
      const component = options.workspace.componentRegistry.create({ id: transactionGeneratedId('component', stored.call.id), type, version: definition.version, enabled: args.enabled as boolean, value: args.value as JsonObject });
      return result(`Add ${type}`, [{ op: 'component.add', entityId, component }], (revision) => Object.freeze({ documentId: stored.view.documentId, revision, entityId, component: component as unknown as JsonValue }));
    }
    case 'component.set': {
      const target = resolveComponentTarget(options.workspace, args); const component = options.workspace.componentRegistry.validate({ ...target.component, enabled: args.enabled === undefined ? target.component.enabled : args.enabled, value: args.value });
      return result(`Set ${component.type}`, [{ op: 'component.replace', component }], (revision) => Object.freeze({ documentId: stored.view.documentId, revision, entityId: target.entityId, component: component as unknown as JsonValue }));
    }
    case 'component.remove': {
      const target = resolveComponentTarget(options.workspace, args); if (target.component.type === 'haiyue.transform.3d') throw new GameToolProtocolError('tool.component-required', 'The required Transform component cannot be removed.');
      return result(`Remove ${target.component.type}`, [{ op: 'component.remove', entityId: target.entityId, componentId: target.component.id }], (revision) => Object.freeze({ documentId: stored.view.documentId, revision, entityId: target.entityId, componentId: target.component.id, removedType: target.component.type }));
    }
    case 'component.configure': {
      const entityId = args.entityId as StableId; const type = asStableId(args.type as string, 'component type'); const version = args.version as string;
      const definition = resolveComponentDefinition(options.workspace, type, version); const existing = ownedComponentByType(options.workspace, entityId, type, version);
      if (args.action === 'remove') {
        if (!existing) throw new GameToolProtocolError('tool.component-missing', `Entity ${entityId} has no ${type}@${version} component.`);
        if (existing.type === 'haiyue.transform.3d') throw new GameToolProtocolError('tool.component-required', 'The required Transform component cannot be removed.');
        return result(`Remove ${type}`, [{ op: 'component.remove', entityId, componentId: existing.id }], (revision) => Object.freeze({ documentId: stored.view.documentId, revision, action: 'remove', entityId, componentId: existing.id, type, version }));
      }
      const value = mergeJsonObjects(existing?.value ?? definition.defaults, (args.patch ?? {}) as JsonObject);
      const component = existing
        ? options.workspace.componentRegistry.validate({ ...existing, enabled: args.enabled === undefined ? existing.enabled : args.enabled as boolean, value })
        : options.workspace.componentRegistry.create({ id: semanticGeneratedId('component', stored.call.id, `${type}@${version}`), type, version, enabled: args.enabled === undefined ? true : args.enabled as boolean, value });
      const operation: GameDocumentOperationV2 = existing ? { op: 'component.replace', component } : { op: 'component.add', entityId, component };
      return result(`Configure ${type}`, [operation], (revision) => Object.freeze({ documentId: stored.view.documentId, revision, action: existing ? 'update' : 'add', entityId, component: component as unknown as JsonValue }));
    }
    case 'asset.import': {
      const catalog = planning.assetCatalog ??= controlledAssetCatalog(options.workspace); let entry;
      try {
        const bytes = await options.workspace.readControlledAsset(args.projectPath as string, 32 * 1024 * 1024, signal);
        entry = catalog.import({ projectPath: args.projectPath as string, bytes, mimeType: args.mimeType as string, kind: args.kind as ControlledAssetKind, license: args.license as ControlledAssetLicense, provenance: args.provenance as string, decodedBytes: args.decodedBytes as number, ...(args.width === undefined ? {} : { width: args.width as number }), ...(args.height === undefined ? {} : { height: args.height as number }) });
      } catch (cause) { throw assetProtocolError(cause); }
      return result('Import Asset', [{ op: 'asset.upsert', asset: { id: entry.id, kind: entry.kind, digest: entry.digest, source: 'project' } }, { op: 'setting.set', key: CONTROLLED_ASSET_CATALOG_SETTING_KEY, value: catalog.settingValue() }], (revision) => Object.freeze({ documentId: stored.view.documentId, revision, asset: entry as unknown as JsonValue }));
    }
    case 'asset.assign': {
      const catalog = planning.assetCatalog ??= controlledAssetCatalog(options.workspace); const entityId = args.entityId as StableId; const usage = args.usage as AssetUsage;
      try { catalog.assignment(args.assetId as string, usage); } catch (cause) { throw assetProtocolError(cause); }
      const sceneEntity = requireEntity(scene, entityId); if (isPbrTextureUsage(usage) && !isSceneGeometryKind(sceneEntity.kind)) throw new GameToolProtocolError('asset.target-incompatible', `${usage} requires a geometry entity with Mesh3D.`);
      const query = options.workspace.queryGameDocument({ entityId, limit: 256 }); const binding = assetBinding(usage, args.assetId as StableId); const existing = query.components.find((item) => item.type === binding.type && item.version === '1.0.0');
      const component = existing ? options.workspace.componentRegistry.validate({ ...existing, ...(isPbrTextureUsage(usage) ? { enabled: true } : {}), value: Object.freeze({ ...existing.value, ...binding.patch }) }) : options.workspace.componentRegistry.create({ id: transactionGeneratedId('component-asset', stored.call.id), type: binding.type, version: resolveComponentDefinition(options.workspace, binding.type, '1.0.0').version, enabled: true, value: Object.freeze({ ...resolveComponentDefinition(options.workspace, binding.type, '1.0.0').defaults, ...textureMaterialDefaults(usage, sceneEntity), ...binding.patch }) });
      const operation: GameDocumentOperationV2 = existing ? { op: 'component.replace', component } : { op: 'component.add', entityId, component };
      return result('Assign Asset', [operation], (revision) => Object.freeze({ documentId: stored.view.documentId, revision, entityId, assetId: args.assetId as StableId, usage, component: component as unknown as JsonValue }));
    }
    default: throw new GameToolProtocolError('scene-transaction.member-ineligible', `${stored.definition.id} cannot participate in an atomic Scene transaction.`);
  }
}

const DEFAULT_TRANSACTION_TRANSFORM = Object.freeze({ position: Object.freeze({ x: 0, y: 0, z: 0 }), rotationDegrees: Object.freeze({ x: 0, y: 0, z: 0 }), scale: Object.freeze({ x: 1, y: 1, z: 1 }) });
const DEFAULT_TRANSACTION_COLOR = Object.freeze([0.16, 0.58, 1, 1]);
function transactionGeneratedId(prefix: string, callId: StableId): StableId { return asStableId(`${prefix}:m13:${sha256(`${prefix}:${callId}`).slice(0, 24)}`); }
function transactionEntityLabel(kind: SceneEntityKind): string { return ({ empty: 'Empty', cube: 'Cube', 'rounded-box': 'Rounded Box', sphere: 'Sphere', cone: 'Cone', cylinder: 'Cylinder', plane: 'Plane', torus: 'Torus', icosahedron: 'Icosahedron', 'directional-light': 'Directional Light', 'point-light': 'Point Light', 'ambient-light': 'Ambient Light' } as Record<SceneEntityKind, string>)[kind]; }
function transactionDefaultLight(kind: 'directional-light' | 'point-light' | 'ambient-light'): JsonObject {
  if (kind === 'directional-light') return Object.freeze({ color: Object.freeze([1, 1, 1]), intensity: 1, direction: Object.freeze([-0.5, -1, -0.35]), castShadow: true });
  if (kind === 'point-light') return Object.freeze({ color: Object.freeze([1, 0.9, 0.75]), intensity: 2, range: 12 });
  return Object.freeze({ color: Object.freeze([0.7, 0.8, 1]), intensity: 0.25 });
}
function ownedComponent(workspace: ProjectWorkspace, entityId: StableId, type: string): GameComponentInstanceV2 {
  const query = workspace.queryGameDocument({ entityId, limit: 256 }); const entity = query.entities[0];
  const component = entity ? query.components.find((candidate) => entity.componentIds.includes(candidate.id) && candidate.type === type) : undefined;
  if (!component) throw new GameToolProtocolError('tool.component-missing', `Entity ${entityId} does not contain ${type}.`);
  return component;
}

function planCameraAuthorMember(stored: StoredPreparation, options: GameAuthoringToolRuntimeOptions, args: Readonly<Record<string, JsonValue>>): ReversibleTransactionMemberPlan {
  const action = args.action as 'create' | 'activate' | 'frame' | 'frame-bounds' | 'orbit' | 'follow' | 'projection' | 'viewport';
  const document = options.workspace.gameSnapshot(); const scene = options.scene.snapshot();
  const member = (label: string, operations: readonly GameDocumentOperationV2[], result: (revision: number) => JsonObject): ReversibleTransactionMemberPlan => Object.freeze({ stored, label, operations: Object.freeze([...operations]), result });
  if (action === 'create') {
    const entityId = transactionGeneratedId('entity', stored.call.id); const transform = (args.transform ?? DEFAULT_TRANSACTION_TRANSFORM) as unknown as TransformSnapshot;
    const definition = resolveComponentDefinition(options.workspace, 'haiyue.camera.3d', '1.0.0');
    const patch = Object.freeze(Object.fromEntries(['projection', 'fovDegrees', 'orthographicHeight', 'near', 'far', 'viewport'].flatMap((key) => args[key] === undefined ? [] : [[key, args[key]]]))) as JsonObject;
    const component = options.workspace.componentRegistry.create({ id: semanticGeneratedId('component', stored.call.id, 'camera:descriptor'), type: asStableId('haiyue.camera.3d'), version: definition.version, value: mergeJsonObjects(definition.defaults, patch) });
    const operations: readonly GameDocumentOperationV2[] = Object.freeze([
      { op: 'entity.add', entity: { id: entityId, sceneId: options.workspace.primarySceneId(), name: (args.name as string | undefined) ?? 'Gameplay Camera', parentId: null, order: siblingCount(document.entities, null), componentIds: [] } },
      { op: 'component.add', entityId, component: options.workspace.componentRegistry.create({ id: semanticGeneratedId('component', stored.call.id, 'camera:transform'), type: asStableId('haiyue.transform.3d'), version: '1.0.0', value: transform as unknown as JsonObject }) },
      { op: 'component.add', entityId, component },
    ]);
    return member('Create Gameplay Camera', operations, (revision) => Object.freeze({ revision, action, entity: entitySummary(requireEntity(options.scene.snapshot(), entityId)), cameraComponent: component as unknown as JsonValue }));
  }
  if (action === 'frame' || action === 'frame-bounds' || action === 'orbit') {
    const current = projectCameraFromSettings(requireDocument(options.workspace).settings);
    let camera;
    if (action === 'frame') {
      const target = requireEntity(scene, args.targetEntityId as StableId); const padding = (args.padding as number | undefined) ?? 2;
      const extent = Math.max(target.transform.scale.x, target.transform.scale.y, target.transform.scale.z, 0.5) * padding;
      camera = normalizeProjectCamera({ ...current, target: target.transform.position, distance: Math.max(1, extent * 2), orthographicSize: Math.max(1, extent * 2) });
    } else if (action === 'frame-bounds') {
      const bounds = args.bounds as unknown as { readonly minimum: TransformSnapshot['position']; readonly maximum: TransformSnapshot['position'] };
      const plane = args.plane as 'xy' | 'xz' | 'yz'; const targetSize = args.targetSize as unknown as { readonly width: number; readonly height: number }; const aspect = targetSize.width / targetSize.height; const padding = (args.padding as number | undefined) ?? 1.1;
      const spans = { x: bounds.maximum.x - bounds.minimum.x, y: bounds.maximum.y - bounds.minimum.y, z: bounds.maximum.z - bounds.minimum.z };
      const [horizontal, vertical] = plane === 'xz' ? [spans.x, spans.z] : plane === 'xy' ? [spans.x, spans.y] : [spans.z, spans.y];
      const orientation = plane === 'xz' ? { azimuthDegrees: 0, elevationDegrees: 89.5 } : plane === 'xy' ? { azimuthDegrees: 0, elevationDegrees: 0 } : { azimuthDegrees: 90, elevationDegrees: 0 };
      camera = normalizeProjectCamera({
        ...current, ...orientation, projection: 'orthographic',
        target: { x: (bounds.minimum.x + bounds.maximum.x) / 2, y: (bounds.minimum.y + bounds.maximum.y) / 2, z: (bounds.minimum.z + bounds.maximum.z) / 2 },
        distance: Math.max(current.distance, Math.min(500, Math.max(spans.x, spans.y, spans.z, 0.5) * 2)),
        orthographicSize: Math.max(vertical, horizontal / aspect, 0.5) * padding,
      });
    } else camera = normalizeProjectCamera({ ...current, azimuthDegrees: current.azimuthDegrees + ((args.azimuthDelta as number | undefined) ?? 0), elevationDegrees: Math.max(-89.9, Math.min(90, current.elevationDegrees + ((args.elevationDelta as number | undefined) ?? 0))), distance: (args.distance as number | undefined) ?? current.distance });
    const label = action === 'frame' ? 'Frame Entity with Camera' : action === 'frame-bounds' ? 'Frame World Bounds with Camera' : 'Orbit Camera';
    return member(label, [{ op: 'setting.set', key: PROJECT_CAMERA_SETTING_KEY, value: camera as unknown as JsonValue }], (revision) => Object.freeze({ revision, action, camera: projectCameraFromSettings(requireDocument(options.workspace).settings) as unknown as JsonValue }));
  }

  const entityId = args.entityId as StableId; requireEntity(scene, entityId);
  if (action === 'activate') {
    const cameraComponents = document.components.filter((component) => component.type === 'haiyue.camera.3d' || component.type === 'haiyue.camera.2d');
    const owners = new Map(document.entities.flatMap((entity) => entity.componentIds.map((componentId) => [componentId, entity.id] as const)));
    if (!cameraComponents.some((component) => owners.get(component.id) === entityId)) throw new GameToolProtocolError('tool.camera-missing', `Entity ${entityId} has no gameplay camera component.`);
    const operations = cameraComponents.flatMap((component): GameDocumentOperationV2[] => {
      const active = owners.get(component.id) === entityId; if (component.value.active === active) return [];
      return [{ op: 'component.replace', component: options.workspace.componentRegistry.validate({ ...component, value: Object.freeze({ ...component.value, active }) }) }];
    });
    if (!operations.length) throw new GameToolProtocolError('tool.no-change', 'The requested gameplay camera is already the only active camera.');
    return member('Activate Gameplay Camera', operations, (revision) => Object.freeze({ revision, action, entityId, deactivatedCount: cameraComponents.length - 1 }));
  }
  if (action === 'follow') {
    requireEntity(scene, args.targetEntityId as StableId); ownedComponent(options.workspace, entityId, 'haiyue.camera.3d');
    const definition = resolveComponentDefinition(options.workspace, 'haiyue.camera.follow', '1.0.0'); const existing = ownedComponentByType(options.workspace, entityId, 'haiyue.camera.follow', '1.0.0');
    const patch = Object.freeze(Object.fromEntries(['targetEntityId', 'mode', 'offset', 'lookAtOffset', 'smoothing'].flatMap((key) => args[key] === undefined ? [] : [[key, args[key]]]))) as JsonObject;
    const component = existing ? options.workspace.componentRegistry.validate({ ...existing, value: mergeJsonObjects(existing.value, patch) }) : options.workspace.componentRegistry.create({ id: semanticGeneratedId('component', stored.call.id, 'camera:follow'), type: asStableId('haiyue.camera.follow'), version: definition.version, value: mergeJsonObjects(definition.defaults, patch) });
    return member('Configure Camera Follow', [existing ? { op: 'component.replace', component } : { op: 'component.add', entityId, component }], (revision) => Object.freeze({ revision, action, entityId, component: component as unknown as JsonValue }));
  }
  const component = ownedComponent(options.workspace, entityId, 'haiyue.camera.3d');
  const keys = action === 'projection' ? ['projection', 'fovDegrees', 'orthographicHeight', 'near', 'far'] : ['viewport'];
  const patch = Object.freeze(Object.fromEntries(keys.flatMap((key) => args[key] === undefined ? [] : [[key, args[key]]]))) as JsonObject;
  const replacement = options.workspace.componentRegistry.validate({ ...component, value: mergeJsonObjects(component.value, patch) });
  return member(action === 'projection' ? 'Set Camera Projection' : 'Set Camera Viewport', [{ op: 'component.replace', component: replacement }], (revision) => Object.freeze({ revision, action, entityId, component: replacement as unknown as JsonValue }));
}
function ownedComponentByType(workspace: ProjectWorkspace, entityId: StableId, type: string, version?: string): GameComponentInstanceV2 | undefined {
  const query = workspace.queryGameDocument({ entityId, limit: 256 }); const entity = query.entities[0];
  if (!entity) throw new GameToolProtocolError('tool.entity-missing', `Entity ${entityId} does not exist.`);
  return query.components.find((candidate) => entity.componentIds.includes(candidate.id) && candidate.type === type && (version === undefined || candidate.version === version));
}
function mergeJsonObjects(base: JsonObject, patch: JsonObject): JsonObject {
  const entries = Object.entries(base).map(([key, value]) => [key, value] as const);
  const result: Record<string, JsonValue> = Object.fromEntries(entries);
  for (const [key, value] of Object.entries(patch)) {
    const previous = result[key];
    result[key] = isRecord(previous) && isRecord(value) ? mergeJsonObjects(previous as JsonObject, value as JsonObject) : value;
  }
  return Object.freeze(result);
}

function planEntityHierarchyMember(stored: StoredPreparation, options: GameAuthoringToolRuntimeOptions, args: Readonly<Record<string, JsonValue>>): ReversibleTransactionMemberPlan {
  const document = options.workspace.gameSnapshot();
  const entityId = args.entityId as StableId;
  const root = document.entities.find((entity) => entity.id === entityId);
  if (!root) throw new GameToolProtocolError('tool.entity-missing', `Entity ${entityId} does not exist.`);
  const action = args.action as 'clone' | 'reparent' | 'delete';
  if (action === 'reparent') {
    const parentId = args.parentId as StableId | null;
    if (parentId === entityId) throw new GameToolProtocolError('tool.parent-cycle', 'An entity cannot be its own parent.');
    if (parentId !== null) {
      const parent = document.entities.find((entity) => entity.id === parentId);
      if (!parent) throw new GameToolProtocolError('tool.entity-missing', `Parent entity ${parentId} does not exist.`);
      if (parent.sceneId !== root.sceneId) throw new GameToolProtocolError('tool.parent-scene-mismatch', 'Parent and child must belong to the same scene.');
    }
    const patch = Object.freeze({ parentId, ...(args.order === undefined ? {} : { order: args.order as number }) });
    const operations: readonly GameDocumentOperationV2[] = Object.freeze([{ op: 'entity.update', entityId, patch }]);
    return Object.freeze({ stored, label: 'Reparent Entity', operations, result: (revision: number) => Object.freeze({ revision, action, entity: entitySummary(requireEntity(options.scene.snapshot(), entityId)) }) });
  }

  const subtree = hierarchySubtree(document.entities, entityId);
  if (subtree.length > 128) throw new GameToolProtocolError('tool.hierarchy-limit', 'Entity hierarchy operations are limited to 128 entities.');
  const includeDescendants = args.includeDescendants === true;
  if (!includeDescendants && subtree.length > 1 && action === 'delete') throw new GameToolProtocolError('tool.entity-has-children', 'The entity has descendants; set includeDescendants to true for a recoverable subtree removal.');
  const selected = includeDescendants ? subtree : Object.freeze([root]);

  if (action === 'delete') {
    const selectedIds = new Set(selected.map((entity) => entity.id));
    const operations: GameDocumentOperationV2[] = [];
    for (const script of document.scripts.filter((candidate) => selectedIds.has(candidate.entityId)).sort((left, right) => left.id.localeCompare(right.id))) operations.push({ op: 'script.remove', scriptId: script.id });
    for (const entity of [...selected].reverse()) {
      for (const componentId of [...entity.componentIds].sort()) operations.push({ op: 'component.remove', entityId: entity.id, componentId });
      operations.push({ op: 'entity.remove', entityId: entity.id });
    }
    assertSemanticOperationLimit(operations);
    const removedEntityIds = Object.freeze(selected.map((entity) => entity.id));
    return Object.freeze({ stored, label: selected.length === 1 ? 'Delete Entity' : `Delete Entity Subtree (${selected.length})`, operations: Object.freeze(operations), result: (revision: number) => Object.freeze({ revision, action, removedEntityIds, removedCount: removedEntityIds.length }) });
  }

  const cloneIds = new Map<string, StableId>(selected.map((entity) => [entity.id, semanticGeneratedId('entity', stored.call.id, entity.id)]));
  const operations: GameDocumentOperationV2[] = [];
  for (const source of selected) {
    const cloneId = cloneIds.get(source.id)!;
    const isRoot = source.id === entityId;
    const parentIdValue = isRoot
      ? (Object.hasOwn(args, 'parentId') ? args.parentId as StableId | null : source.parentId)
      : cloneIds.get(source.parentId as StableId) ?? source.parentId;
    const parentId = parentIdValue === null ? null : asStableId(parentIdValue, 'parent id');
    if (parentId !== null) {
      const parent = document.entities.find((entity) => entity.id === parentId) ?? selected.find((entity) => cloneIds.get(entity.id) === parentId);
      if (!parent || parent.sceneId !== source.sceneId) throw new GameToolProtocolError('tool.parent-scene-mismatch', 'Clone parent must belong to the same scene.');
    }
    const cloneName = isRoot ? (args.name as string | undefined) ?? `${source.name} Copy` : source.name;
    operations.push({ op: 'entity.add', entity: { id: cloneId, sceneId: source.sceneId, name: cloneName, parentId, order: isRoot ? siblingCount(document.entities, parentId) : source.order, componentIds: [] } });
    for (const componentId of source.componentIds) {
      const component = document.components.find((candidate) => candidate.id === componentId);
      if (!component) throw new GameToolProtocolError('tool.component-missing', `Component ${componentId} does not exist.`);
      const cloned = options.workspace.componentRegistry.validate({ ...component, id: semanticGeneratedId('component', stored.call.id, component.id) });
      operations.push({ op: 'component.add', entityId: cloneId, component: cloned });
    }
    for (const script of document.scripts.filter((candidate) => candidate.entityId === source.id).sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))) {
      const scriptId = semanticGeneratedId('script', stored.call.id, script.id);
      operations.push({ op: 'script.upsert', script: { ...script, id: scriptId, entityId: cloneId, name: isRoot ? `${script.name} Copy` : script.name, sourcePath: `scripts/${scriptId.replaceAll(':', '-')}.ts` } });
    }
  }
  assertSemanticOperationLimit(operations);
  const clonedEntityIds = Object.freeze(selected.map((entity) => cloneIds.get(entity.id)!));
  const clonedRootId = cloneIds.get(entityId)!;
  return Object.freeze({ stored, label: selected.length === 1 ? 'Clone Entity' : `Clone Entity Subtree (${selected.length})`, operations: Object.freeze(operations), result: (revision: number) => Object.freeze({ revision, action, clonedEntityIds, entity: entitySummary(requireEntity(options.scene.snapshot(), clonedRootId)) }) });
}

function planPrefabMember(stored: StoredPreparation, options: GameAuthoringToolRuntimeOptions, args: Readonly<Record<string, JsonValue>>): ReversibleTransactionMemberPlan {
  const action = args.action as 'capture' | 'instantiate' | 'remove';
  const prefabId = args.prefabId as StableId;
  const document = options.workspace.gameSnapshot();
  const registry = readPrefabRegistry(options.workspace);
  const existing = registry.prefabs.find((item) => item.id === prefabId);
  const member = (label: string, operations: readonly GameDocumentOperationV2[], project: (revision: number) => JsonObject): ReversibleTransactionMemberPlan => Object.freeze({ stored, label, operations: Object.freeze([...operations]), result: project });

  if (action === 'capture') {
    const rootId = args.entityId as StableId;
    const root = document.entities.find((item) => item.id === rootId);
    if (!root) throw new GameToolProtocolError('tool.entity-missing', `Entity ${rootId} does not exist.`);
    const entities = hierarchySubtree(document.entities, rootId);
    if (entities.length > MAX_PREFAB_ENTITIES) throw new GameToolProtocolError('tool.prefab-limit', `Prefab capture is limited to ${MAX_PREFAB_ENTITIES} entities.`);
    if (!existing && registry.prefabs.length >= MAX_PREFABS) throw new GameToolProtocolError('tool.prefab-limit', `A project may contain at most ${MAX_PREFABS} prefabs.`);
    const selectedIds = new Set(entities.map((item) => item.id));
    const componentIds = new Set(entities.flatMap((item) => [...item.componentIds]));
    const components = Object.freeze(document.components.filter((item) => componentIds.has(item.id)).map((item) => options.workspace.componentRegistry.validate(item)));
    if (components.length !== componentIds.size) throw new GameToolProtocolError('tool.component-missing', 'Prefab subtree references a missing component.');
    const scripts = Object.freeze(document.scripts.filter((item) => selectedIds.has(item.entityId)).sort((left, right) => left.entityId.localeCompare(right.entityId) || left.order - right.order || left.id.localeCompare(right.id)));
    const storedEntities: readonly StoredPrefabEntity[] = Object.freeze(entities.map((item) => Object.freeze({ id: asStableId(item.id), name: item.name, parentId: item.id === rootId ? null : item.parentId === null ? null : asStableId(item.parentId), order: item.order, componentIds: Object.freeze(item.componentIds.map((componentId) => asStableId(componentId))) })));
    const body = Object.freeze({ schemaVersion: 1 as const, id: prefabId, name: (args.name as string | undefined) ?? root.name, rootEntityId: rootId, entities: storedEntities, components, scripts });
    const prefab = Object.freeze({ ...body, digest: prefabDigest(body) });
    const prefabs = Object.freeze([...registry.prefabs.filter((item) => item.id !== prefabId), prefab].sort((left, right) => left.id.localeCompare(right.id)));
    const nextRegistry = checkedPrefabRegistryValue(prefabs);
    return member(existing ? 'Update Prefab' : 'Capture Prefab', [{ op: 'setting.set', key: PREFAB_REGISTRY_SETTING_KEY, value: nextRegistry }], (revision) => Object.freeze({ revision, action, prefab: prefabSummary(prefab), replaced: Boolean(existing) }));
  }

  if (!existing) throw new GameToolProtocolError('tool.prefab-missing', `Prefab ${prefabId} does not exist.`);
  if (action === 'remove') {
    const prefabs = Object.freeze(registry.prefabs.filter((item) => item.id !== prefabId));
    const operations: readonly GameDocumentOperationV2[] = prefabs.length === 0
      ? Object.freeze([{ op: 'setting.remove', key: PREFAB_REGISTRY_SETTING_KEY }])
      : Object.freeze([{ op: 'setting.set', key: PREFAB_REGISTRY_SETTING_KEY, value: checkedPrefabRegistryValue(prefabs) }]);
    return member('Remove Prefab', operations, (revision) => Object.freeze({ revision, action, prefabId, removed: true, remainingCount: prefabs.length }));
  }

  const parentId = Object.hasOwn(args, 'parentId') ? args.parentId as StableId | null : null;
  if (parentId !== null && !document.entities.some((item) => item.id === parentId && item.sceneId === options.workspace.primarySceneId())) throw new GameToolProtocolError('tool.parent-scene-mismatch', 'Prefab parent must exist in the active scene.');
  const entityIds = new Map(existing.entities.map((item) => [item.id, semanticGeneratedId('entity', stored.call.id, `${prefabId}:${item.id}`)]));
  const operations: GameDocumentOperationV2[] = [];
  for (const source of existing.entities) {
    const entityId = entityIds.get(source.id)!;
    const isRoot = source.id === existing.rootEntityId;
    const mappedParent = isRoot ? parentId : entityIds.get(source.parentId!);
    if (!isRoot && !mappedParent) throw new GameToolProtocolError('tool.prefab-invalid', `Prefab ${prefabId} contains a disconnected entity.`);
    operations.push({ op: 'entity.add', entity: { id: entityId, sceneId: options.workspace.primarySceneId(), name: isRoot ? (args.name as string | undefined) ?? source.name : source.name, parentId: mappedParent ?? null, order: isRoot ? siblingCount(document.entities, parentId) : source.order, componentIds: [] } });
    for (const componentId of source.componentIds) {
      const sourceComponent = existing.components.find((item) => item.id === componentId);
      if (!sourceComponent) throw new GameToolProtocolError('tool.prefab-invalid', `Prefab ${prefabId} references missing component ${componentId}.`);
      const component = options.workspace.componentRegistry.validate({ ...sourceComponent, id: semanticGeneratedId('component', stored.call.id, `${prefabId}:${componentId}`) });
      operations.push({ op: 'component.add', entityId, component });
    }
    for (const script of existing.scripts.filter((item) => item.entityId === source.id).sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))) {
      const scriptId = semanticGeneratedId('script', stored.call.id, `${prefabId}:${script.id}`);
      operations.push({ op: 'script.upsert', script: { ...script, id: scriptId, entityId, sourcePath: `scripts/${scriptId.replaceAll(':', '-')}.ts` } });
    }
  }
  assertSemanticOperationLimit(operations);
  const instantiatedEntityIds = Object.freeze(existing.entities.map((item) => entityIds.get(item.id)!));
  const rootEntityId = entityIds.get(existing.rootEntityId)!;
  return member(`Instantiate Prefab · ${existing.name}`, operations, (revision) => Object.freeze({ revision, action, prefab: prefabSummary(existing), rootEntityId, instantiatedEntityIds, entity: entitySummary(requireEntity(options.scene.snapshot(), rootEntityId)) }));
}

function readPrefabRegistry(workspace: ProjectWorkspace): StoredPrefabRegistry {
  const value = workspace.gameSnapshot().settings[PREFAB_REGISTRY_SETTING_KEY];
  if (value === undefined) return Object.freeze({ schemaVersion: 1, prefabs: Object.freeze([]) });
  if (new TextEncoder().encode(canonicalStringify(value)).byteLength > MAX_PREFAB_REGISTRY_BYTES) throw new GameToolProtocolError('tool.prefab-registry-invalid', 'Prefab registry exceeds its serialized byte limit.');
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.prefabs) || value.prefabs.length > MAX_PREFABS) throw new GameToolProtocolError('tool.prefab-registry-invalid', 'Prefab registry is invalid.');
  const prefabs = Object.freeze(value.prefabs.map((item, index) => parseStoredPrefab(workspace, item, index)));
  if (new Set(prefabs.map((item) => item.id)).size !== prefabs.length) throw new GameToolProtocolError('tool.prefab-registry-invalid', 'Prefab ids must be unique.');
  return Object.freeze({ schemaVersion: 1, prefabs });
}

function parseStoredPrefab(workspace: ProjectWorkspace, value: unknown, index: number): StoredPrefab {
  if (!isRecord(value)) throw new GameToolProtocolError('tool.prefab-registry-invalid', `Prefab ${index} must be an object.`);
  exact(value, ['schemaVersion', 'id', 'name', 'rootEntityId', 'entities', 'components', 'scripts', 'digest'], [], `prefab[${index}]`);
  if (value.schemaVersion !== 1 || typeof value.id !== 'string' || !/^prefab:[A-Za-z0-9._:-]{3,120}$/u.test(value.id)) throw new GameToolProtocolError('tool.prefab-registry-invalid', `Prefab ${index} id is invalid.`);
  const id = asStableId(value.id); const name = boundedString(value.name, 'prefab name', 80, true); const rootEntityId = stable(value.rootEntityId, 'prefab root entity id');
  if (!Array.isArray(value.entities) || value.entities.length < 1 || value.entities.length > MAX_PREFAB_ENTITIES || !Array.isArray(value.components) || !Array.isArray(value.scripts)) throw new GameToolProtocolError('tool.prefab-registry-invalid', `Prefab ${id} collections are invalid.`);
  const entities = Object.freeze(value.entities.map((entry, entityIndex) => {
    if (!isRecord(entry)) throw new GameToolProtocolError('tool.prefab-registry-invalid', `Prefab ${id} entity ${entityIndex} is invalid.`);
    exact(entry, ['id', 'name', 'parentId', 'order', 'componentIds'], [], `prefab ${id} entity`);
    const componentIds = stableIdArray(entry.componentIds, 'prefab componentIds', 1_000);
    if (new Set(componentIds).size !== componentIds.length) throw new GameToolProtocolError('tool.prefab-registry-invalid', `Prefab ${id} component ids must be unique per entity.`);
    return Object.freeze({ id: stable(entry.id, 'prefab entity id'), name: boundedString(entry.name, 'prefab entity name', 80, true), parentId: entry.parentId === null ? null : stable(entry.parentId, 'prefab parent id'), order: boundedInteger(entry.order, 'prefab entity order', 0, 1_000_000), componentIds });
  }));
  const entityIdSet = new Set(entities.map((item) => item.id));
  if (entityIdSet.size !== entities.length || !entityIdSet.has(rootEntityId)) throw new GameToolProtocolError('tool.prefab-registry-invalid', `Prefab ${id} entity ids or root are invalid.`);
  const root = entities.find((item) => item.id === rootEntityId)!;
  if (root.parentId !== null || entities.some((item) => item.id !== rootEntityId && (item.parentId === null || !entityIdSet.has(item.parentId) || item.parentId === item.id))) throw new GameToolProtocolError('tool.prefab-registry-invalid', `Prefab ${id} hierarchy is disconnected.`);
  const reachable = hierarchySubtree(entities.map((item) => ({ ...item, sceneId: asStableId('scene:prefab') })), rootEntityId);
  if (reachable.length !== entities.length) throw new GameToolProtocolError('tool.prefab-registry-invalid', `Prefab ${id} hierarchy contains a cycle or disconnected entity.`);
  const components = Object.freeze(value.components.map((entry) => {
    if (!isRecord(entry)) throw new GameToolProtocolError('tool.prefab-registry-invalid', `Prefab ${id} component is invalid.`);
    try { return workspace.componentRegistry.validate(entry as unknown as GameComponentInstanceV2); }
    catch (cause) { throw new GameToolProtocolError('tool.prefab-registry-invalid', `Prefab ${id} component is invalid: ${errorMessage(cause)}`); }
  }));
  const allComponentIds = new Set<string>(entities.flatMap((item) => [...item.componentIds]));
  if (new Set(components.map((item) => item.id)).size !== components.length || components.length !== allComponentIds.size || components.some((item) => !allComponentIds.has(item.id))) throw new GameToolProtocolError('tool.prefab-registry-invalid', `Prefab ${id} component ownership is invalid.`);
  const scripts = Object.freeze(value.scripts.map((entry, scriptIndex) => parseStoredPrefabScript(entry, id, scriptIndex, entityIdSet)));
  if (new Set(scripts.map((item) => item.id)).size !== scripts.length) throw new GameToolProtocolError('tool.prefab-registry-invalid', `Prefab ${id} script ids must be unique.`);
  if (typeof value.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.digest)) throw new GameToolProtocolError('tool.prefab-registry-invalid', `Prefab ${id} digest is invalid.`);
  const body = Object.freeze({ schemaVersion: 1 as const, id, name, rootEntityId, entities, components, scripts });
  const digest = prefabDigest(body);
  if (digest !== value.digest) throw new GameToolProtocolError('tool.prefab-registry-invalid', `Prefab ${id} digest does not match its contents.`);
  return Object.freeze({ ...body, digest });
}

function parseStoredPrefabScript(value: unknown, prefabId: StableId, index: number, entityIds: ReadonlySet<StableId>): ReturnType<ProjectWorkspace['gameSnapshot']>['scripts'][number] {
  if (!isRecord(value)) throw new GameToolProtocolError('tool.prefab-registry-invalid', `Prefab ${prefabId} script ${index} is invalid.`);
  exact(value, ['id', 'entityId', 'name', 'sourcePath', 'source', 'textRevision', 'enabled', 'order', 'capabilities', 'digest'], [], `prefab ${prefabId} script`);
  const id = stable(value.id, 'prefab script id'); const entityId = stable(value.entityId, 'prefab script entity id');
  const source = boundedString(value.source, 'prefab script source', 65_536, true);
  if (!entityIds.has(entityId) || typeof value.digest !== 'string' || value.digest !== `sha256:${sha256(source)}`) throw new GameToolProtocolError('tool.prefab-registry-invalid', `Prefab ${prefabId} script ${id} ownership or digest is invalid.`);
  const capabilities = normalizeCapabilities(value.capabilities);
  return Object.freeze({ id, entityId, name: boundedString(value.name, 'prefab script name', 80, true), sourcePath: boundedString(value.sourcePath, 'prefab script sourcePath', 512, true), source, textRevision: boundedInteger(value.textRevision, 'prefab script textRevision', 1, 1_000_000_000), enabled: booleanValue(value.enabled, 'prefab script enabled'), order: boundedInteger(value.order, 'prefab script order', 0, 1_000_000), capabilities, digest: value.digest as `sha256:${string}` });
}

function prefabDigest(value: Omit<StoredPrefab, 'digest'>): `sha256:${string}` { return `sha256:${sha256(canonicalStringify(value as unknown as JsonValue))}`; }
function prefabSummary(prefab: StoredPrefab): JsonObject { return Object.freeze({ id: prefab.id, name: prefab.name, digest: prefab.digest, rootEntityId: prefab.rootEntityId, entityCount: prefab.entities.length, componentCount: prefab.components.length, scriptCount: prefab.scripts.length }); }
function checkedPrefabRegistryValue(prefabs: readonly StoredPrefab[]): JsonObject {
  const value = Object.freeze({ schemaVersion: 1 as const, prefabs: Object.freeze([...prefabs]) });
  if (new TextEncoder().encode(canonicalStringify(value as unknown as JsonValue)).byteLength > MAX_PREFAB_REGISTRY_BYTES) throw new GameToolProtocolError('tool.prefab-limit', 'Prefab registry exceeds its serialized byte limit.');
  return value as unknown as JsonObject;
}

function planTransformBatchMember(stored: StoredPreparation, options: GameAuthoringToolRuntimeOptions, args: Readonly<Record<string, JsonValue>>): ReversibleTransactionMemberPlan {
  const action = args.action as 'set' | 'align' | 'distribute' | 'snap' | 'look-at';
  const assignments = new Map<StableId, TransformSnapshot>();
  if (action === 'set') {
    for (const assignment of args.transforms as unknown as readonly Readonly<{ entityId: StableId; transform: TransformSnapshot }>[]) assignments.set(assignment.entityId, assignment.transform);
  } else {
    const entityIds = args.entityIds as readonly StableId[];
    const current = new Map(entityIds.map((entityId) => [entityId, ownedComponent(options.workspace, entityId, 'haiyue.transform.3d').value as unknown as TransformSnapshot]));
    if (action === 'align') {
      const axis = args.axis as Axis; const values = [...current.values()].map((value) => value.position[axis]);
      const coordinate = args.mode === 'min' ? Math.min(...values) : args.mode === 'max' ? Math.max(...values) : (Math.min(...values) + Math.max(...values)) / 2;
      for (const [entityId, value] of current) assignments.set(entityId, withPosition(value, axis, coordinate));
    } else if (action === 'distribute') {
      const axis = args.axis as Axis;
      const ordered = [...current.entries()].sort((left, right) => left[1].position[axis] - right[1].position[axis] || left[0].localeCompare(right[0]));
      const start = ordered[0]![1].position[axis];
      const spacing = args.spacing === undefined ? (ordered.at(-1)![1].position[axis] - start) / Math.max(1, ordered.length - 1) : args.spacing as number;
      ordered.forEach(([entityId, value], index) => assignments.set(entityId, withPosition(value, axis, start + spacing * index)));
    } else if (action === 'snap') {
      const grid = args.grid as number; const axis = args.axis as Axis | undefined;
      for (const [entityId, value] of current) {
        const position = { ...value.position };
        for (const key of axis ? [axis] : AXES) position[key] = Math.round(position[key] / grid) * grid;
        assignments.set(entityId, Object.freeze({ ...value, position: Object.freeze(position) }));
      }
    } else {
      const target = args.target as unknown as TransformSnapshot['position'];
      for (const [entityId, value] of current) assignments.set(entityId, lookAtTransform(value, target));
    }
  }
  const operations: GameDocumentOperationV2[] = [];
  for (const [entityId, transform] of assignments) {
    const component = ownedComponent(options.workspace, entityId, 'haiyue.transform.3d');
    operations.push({ op: 'component.replace', component: options.workspace.componentRegistry.validate({ ...component, value: transform as unknown as JsonObject }) });
  }
  assertSemanticOperationLimit(operations);
  const entityIds = Object.freeze([...assignments.keys()]);
  return Object.freeze({ stored, label: `Transform Batch · ${action} (${entityIds.length})`, operations: Object.freeze(operations), result: (revision: number) => Object.freeze({ revision, action, entityIds, entities: Object.freeze(entityIds.map((id) => entitySummary(requireEntity(options.scene.snapshot(), id)))) }) });
}

type Axis = 'x' | 'y' | 'z';
const AXES: readonly Axis[] = Object.freeze(['x', 'y', 'z']);
function withPosition(transform: TransformSnapshot, axis: Axis, coordinate: number): TransformSnapshot { return Object.freeze({ ...transform, position: Object.freeze({ ...transform.position, [axis]: coordinate }) }); }
function lookAtTransform(transform: TransformSnapshot, target: TransformSnapshot['position']): TransformSnapshot {
  const dx = target.x - transform.position.x; const dy = target.y - transform.position.y; const dz = target.z - transform.position.z;
  const horizontal = Math.hypot(dx, dz);
  if (horizontal < 1e-9 && Math.abs(dy) < 1e-9) throw new GameToolProtocolError('tool.look-at-degenerate', 'Look-at target must differ from every entity position.');
  return Object.freeze({ ...transform, rotationDegrees: Object.freeze({ x: -(Math.atan2(dy, horizontal) * 180) / Math.PI, y: (Math.atan2(dx, dz) * 180) / Math.PI, z: transform.rotationDegrees.z }) });
}
function hierarchySubtree(entities: ReturnType<ProjectWorkspace['gameSnapshot']>['entities'], rootId: string): readonly ReturnType<ProjectWorkspace['gameSnapshot']>['entities'][number][] {
  const result: ReturnType<ProjectWorkspace['gameSnapshot']>['entities'][number][] = [];
  const visit = (id: string) => { const entity = entities.find((candidate) => candidate.id === id); if (!entity) return; result.push(entity); for (const child of entities.filter((candidate) => candidate.parentId === id).sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))) visit(child.id); };
  visit(rootId); return Object.freeze(result);
}
function siblingCount(entities: ReturnType<ProjectWorkspace['gameSnapshot']>['entities'], parentId: string | null): number { return entities.filter((entity) => entity.parentId === parentId).length; }
function semanticGeneratedId(namespace: 'entity' | 'component' | 'script', callId: StableId, sourceId: string): StableId { return asStableId(`${namespace}:m13:${sha256(`${namespace}:${callId}:${sourceId}`).slice(0, 24)}`); }
function assertSemanticOperationLimit(operations: readonly GameDocumentOperationV2[]): void { if (operations.length < 1 || operations.length > 1_000) throw new GameToolProtocolError('tool.operation-limit', 'Semantic operation expands to more than 1000 Document operations.'); }
type ScriptLineEdit = Readonly<{ startLine: number; endLine: number; text: string }>;
function resolveScriptResource(catalog: ReturnType<ScriptPreviewStudioService['snapshot']>, args: Readonly<Record<string, JsonValue>>) {
  const byScript = args.scriptId === undefined ? undefined : catalog.resources.find((item) => item.id === args.scriptId);
  const byEntity = args.entityId === undefined ? undefined : catalog.resources.find((item) => item.entityId === args.entityId);
  if (args.scriptId !== undefined && args.entityId !== undefined && (!byScript || !byEntity || byScript.id !== byEntity.id)) throw new GameToolProtocolError('tool.script-target-mismatch', 'scriptId and entityId do not identify the same script.');
  const resource = byScript ?? byEntity;
  if (!resource) throw new GameToolProtocolError('tool.script-missing', 'Requested script does not exist.');
  return resource;
}
function gestureEffects(before: JsonObject, after: JsonObject): JsonObject {
  const state = (value: JsonObject): JsonObject => isRecord(value.state) ? value.state as JsonObject : {};
  const entities = (value: JsonObject): Map<string, JsonValue> => new Map((Array.isArray(state(value).entities) ? state(value).entities as JsonValue[] : []).filter((item): item is JsonObject => isRecord(item) && typeof item.id === 'string').map(item => [item.id as string, item]));
  const previous = entities(before), current = entities(after);
  const changed = [...new Set([...previous.keys(), ...current.keys()])].filter(id => canonicalStringify(previous.get(id) ?? null) !== canonicalStringify(current.get(id) ?? null)).sort();
  return Object.freeze({ changedEntityCount: changed.length, changedEntityIds: changed.slice(0, 32).map(id => id.slice(0, 200)), changedEntityIdsTruncated: changed.length > 32, cameraChanged: canonicalStringify(state(before).camera ?? null) !== canonicalStringify(state(after).camera ?? null) });
}

function scriptProposalResult(proposal: ScriptEditProposal, owner: ReturnType<SceneAuthoringService['snapshot']>['entities'][number] | undefined): JsonObject {
  const diagnostics = Object.freeze(proposal.diagnostics.map((item) => Object.freeze({ code: item.code, severity: item.severity, line: item.line, column: item.column, message: item.message })));
  const authoringHints = /\bset(?:Position|Rotation|Scale)\s*\(/u.test(proposal.text) && !/\b(?:time|delta)\b|api\.input|api\.scene\.observe/u.test(proposal.text)
    ? ['This script may only initialize transforms. Persist fixed values using transform.set or entity.create transform (parent-local position/scale, rotationDegrees in degrees) instead of attaching a script. Keep a script only if it performs actual runtime behavior.'] : [];
  const pointer = owner?.components?.find(item => item.enabled && item.type === 'haiyue.interaction.pointer');
  const bindingContext = { ownerId: proposal.entityId, ownerName: owner?.name ?? null, ownerKind: owner?.kind ?? null, selfPointerEvents: pointer?.value.events ?? [], interactionScope: 'selfInteractions matches ownerId; interactions is global. Child hits do not bubble.', effectTarget: 'entity refers to this owner. Use an explicit stable id for deliberate cross-object effects.' };
  if (proposal.text.includes('api.input.selfInteractions') && !pointer) authoringHints.push('The script owner has no enabled pointer component. Configure the required hit events on this owner before preview, or bind local behavior to the actual hit object.');
  const canApply = !proposal.diagnostics.some((item) => item.severity === 'error');
  return Object.freeze({ proposalId: proposal.id, scriptId: proposal.scriptId, entityId: proposal.entityId, baseRevision: proposal.baseRevision, nextTextRevision: proposal.nextTextRevision, digest: proposal.digest, addedLines: proposal.addedLines, removedLines: proposal.removedLines, capabilities: proposal.capabilities, bindingContext, authoringHints, repairs: proposal.repairs, diagnostics, canApply, requiredAction: canApply ? 'Call script.apply with this proposal.' : 'Resolve every error diagnostic with another script.patch or script.propose call. Look up unfamiliar or missing API symbols with engine.docs.search and engine.docs.read on the studio-script surface. Do not call script.apply for this proposal.' });
}
function applyScriptLineEdits(source: string, edits: readonly ScriptLineEdit[]): string {
  const lines = source.split('\n');
  for (const edit of [...edits].sort((left, right) => right.startLine - left.startLine)) {
    if (edit.endLine > lines.length) throw new GameToolProtocolError('tool.script-patch-range', `Patch line ${edit.endLine} exceeds the current ${lines.length}-line script.`, true);
    lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...edit.text.split('\n'));
  }
  const result = lines.join('\n');
  if (result.length < 1 || result.length > 65_536) throw new GameToolProtocolError('tool.script-patch-size', 'Patched script must contain 1-65536 characters.');
  return result;
}
function extractScriptSymbols(source: string): JsonObject {
  const collect = (pattern: RegExp, group = 1, maximum = 128) => Object.freeze([...new Set([...source.matchAll(pattern)].map((match) => match[group]).filter((value): value is string => Boolean(value)))].sort().slice(0, maximum));
  const functions = Object.freeze([...new Set([...collect(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/gu), ...collect(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/gu)])].sort().slice(0, 128));
  return Object.freeze({
    lineCount: source.split('\n').length, byteLength: new TextEncoder().encode(source).byteLength,
    functions,
    variables: collect(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gu),
    apiNamespaces: collect(/\bapi\.([A-Za-z_$][\w$]*)/gu),
    inputActions: collect(/\b(?:wasPressed|isPressed|isDown)\(\s*['"]([^'"]+)['"]/gu),
    observationIds: collect(/\bapi\.scene\.observe\(\s*['"]([^'"]+)['"]/gu),
  });
}
function catalogMatchScore(query: string, candidate: string): number { const text = candidate.toLocaleLowerCase(); if (text === query) return 0; if (text.startsWith(query)) return 1; const index = text.indexOf(query); return index < 0 ? 100 : 2 + Math.min(index / 1_000, 0.9); }
function collectAssetReferences(value: JsonValue, path: string, output: { assetId: string; path: string }[]): void {
  if (typeof value === 'string') { if (/^asset:[A-Za-z0-9._:-]{3,120}$/u.test(value)) output.push({ assetId: value, path: path || '/' }); return; }
  if (Array.isArray(value)) { value.forEach((item, index) => collectAssetReferences(item, `${path}/${index}`, output)); return; }
  if (isRecord(value)) for (const [key, child] of Object.entries(value)) collectAssetReferences(child as JsonValue, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, output);
}

async function executeHandler(stored: StoredPreparation, options: GameAuthoringToolRuntimeOptions, proposals: Map<StableId, ScriptEditProposal>, plans: Map<StableId, PreviewPlan>, observations: PlayObservationRepository, evaluator: DeterministicTaskEvaluator, catalog: ToolCatalogRuntime, behavior: BehaviorToolReader, signal: AbortSignal): Promise<JsonObject> {
  if (isBehaviorTool(stored.definition.id)) return behavior.execute(stored.definition.id, stored.arguments, signal);
  const args = stored.arguments as Record<string, JsonValue>;
  const scene = options.scene.snapshot();
  switch (stored.definition.id) {
    case 'assembly.inspect': return inspectAssembly(options.workspace.gameSnapshot(), stored.arguments);
    case 'project.snapshot': {
      const workspace = options.workspace.snapshot(); const document = requireDocument(options.workspace);
      return Object.freeze({ projectId: document.projectId, documentId: document.documentId, name: document.name, revision: document.revision, savedRevision: document.savedRevision, dirty: document.dirty, counts: document.counts, registryDigest: document.registryDigest, logHealth: workspace.logging.health });
    }
    case 'scene.query': return options.workspace.queryScene(args as unknown as SceneQueryInput) as unknown as JsonObject;
    case 'scene.diff': return options.workspace.diffScene(args as unknown as SceneDiffInput) as unknown as JsonObject;
    case 'scene.get-many': {
      const entityIds = args.entityIds as readonly StableId[]; const includeComponents = args.includeComponents !== false;
      const byId = new Map(scene.entities.map((entity) => [entity.id, entity]));
      const entities = Object.freeze(entityIds.flatMap((entityId) => { const entity = byId.get(entityId); return entity ? [entitySummary(entity, includeComponents)] : []; }));
      const missingEntityIds = Object.freeze(entityIds.filter((entityId) => !byId.has(entityId)));
      return Object.freeze({ documentId: scene.documentId, revision: scene.revision, entities, missingEntityIds, count: entities.length, requestedCount: entityIds.length, includeComponents });
    }
    case 'engine.docs.search': case 'engine.docs.read': {
      if (!options.documentation) throw new GameToolProtocolError('engine.docs.unavailable', 'Local Engine documentation is unavailable.');
      const value = stored.definition.id === 'engine.docs.search' ? options.documentation.search(args) : options.documentation.read(args);
      const artifact = await options.operationLog.putArtifact(value, { schemaVersion: 'engine-documentation-result/1' });
      await options.operationLog.append({ kind: 'engine/documentation-read', severity: 'info', source: asStableId('studio.game-tools'), correlation: correlation(stored.call), artifactRefs: [artifact.id], payload: { toolId: stored.definition.id, bundleDigest: value.bundleDigest, documentationId: value.id ?? null } }, { signal });
      return value;
    }
    case 'tool.search': {
      const candidates = catalog.search(args.text as string, { limit: QUERY_PAGE_SIZE, includeSchemas: args.includeSchemas === true });
      const binding = sha256(canonicalStringify({ text: args.text, includeSchemas: args.includeSchemas, limit: args.limit, ids: candidates.map(item => [item.id, item.version]) }));
      let offset = 0;
      if (args.cursor !== undefined) {
        let cursor: unknown;
        try { cursor = JSON.parse(Buffer.from(args.cursor as string, 'base64url').toString('utf8')); } catch { throw invalid('Use the exact tool.search nextCursor.'); }
        if (!isRecord(cursor) || cursor.binding !== binding || !Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0 || (cursor.offset as number) >= candidates.length) throw invalid('tool.search cursor does not match this query. Keep text, includeSchemas and limit unchanged, or start without cursor.');
        offset = cursor.offset as number;
      }
      const matches: JsonValue[] = [];
      let nextCursor: string | null = null;
      for (const match of candidates.slice(offset, offset + (args.limit as number))) {
        const nextOffset = offset + matches.length + 1;
        const cursor = nextOffset < candidates.length ? Buffer.from(JSON.stringify({ binding, offset: nextOffset })).toString('base64url') : null;
        if (Buffer.byteLength(canonicalStringify({ matches: [...matches, match as unknown as JsonValue], nextCursor: cursor })) > 60 * 1024) break;
        matches.push(match as unknown as JsonValue); nextCursor = cursor;
      }
      return Object.freeze({ query: args.text as string, matches, count: matches.length, requestedCount: args.limit!, candidateCount: candidates.length, nextCursor, truncated: offset + matches.length < candidates.length, source: 'authoritative-tool-and-component-registries', semantic: true });
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
    case 'scene.list-entities': return Object.freeze({ documentId: scene.documentId, revision: scene.revision, entities: Object.freeze(scene.entities.slice(0, 200).map((entity) => entitySummary(entity))), truncated: scene.entities.length > 200 });
    case 'entity.get': return Object.freeze({ documentId: scene.documentId, revision: scene.revision, entity: entitySummary(requireEntity(scene, args.entityId as StableId)) });
    case 'script.get': {
      const catalog = options.scripts.snapshot(); const resource = resolveScriptResource(catalog, args);
      return Object.freeze({ documentId: catalog.documentId, revision: catalog.documentRevision, script: Object.freeze({ id: resource.id, entityId: resource.entityId, name: resource.name, text: resource.text.slice(0, 65_536), textRevision: resource.textRevision, truncated: resource.text.length > 65_536 }) });
    }
    case 'script.symbols': {
      const catalog = options.scripts.snapshot(); const resource = resolveScriptResource(catalog, args);
      return Object.freeze({ documentId: catalog.documentId, revision: catalog.documentRevision, scriptId: resource.id, entityId: resource.entityId, textRevision: resource.textRevision, digest: resource.digest, symbols: extractScriptSymbols(resource.text) });
    }
    case 'diagnostics.query': {
      if (requireDocument(options.workspace).documentId !== stored.view.documentId) throw new GameToolProtocolError('tool.stale', 'Project changed before diagnostics query.');
      const query = projectLogQuery(args as unknown as OperationLogQuery, requireDocument(options.workspace).projectId); const page = await options.diagnostics.query(query);
      const events = Object.freeze(page.events.map((item) => Object.freeze({ sequence: item.sequence, eventId: item.eventId, timestamp: item.timestamp, kind: item.kind, severity: item.severity, source: item.source, correlation: item.correlation as JsonObject, payloadDigest: prefixedDigest(item.payloadDigest), redactedFieldCount: item.redactedFields.length })));
      return Object.freeze({
        events, count: events.length, scanned: page.scanned,
        range: events.length ? Object.freeze({ first: events[0]!.sequence, last: events.at(-1)!.sequence }) : null,
        digest: sha256(canonicalStringify(events as unknown as JsonValue)),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    }
    case 'history.query': {
      const workspace = options.workspace.snapshot(); const document = requireDocument(options.workspace);
      const beforeEntryId = args.beforeEntryId as number | undefined; const limit = args.limit as number;
      const eligible = workspace.history.entries.filter((entry) => beforeEntryId === undefined || entry.id < beforeEntryId);
      const entries = Object.freeze(eligible.slice(Math.max(0, eligible.length - limit)).reverse().map((entry) => Object.freeze({ id: entry.id, label: entry.label, estimatedBytes: entry.estimatedBytes })));
      return Object.freeze({ documentId: document.documentId, documentRevision: document.revision, historyRevision: workspace.history.revision, canUndo: workspace.history.canUndo, canRedo: workspace.history.canRedo, undoLabel: workspace.history.undoLabel ?? null, redoLabel: workspace.history.redoLabel ?? null, busy: workspace.history.busy, estimatedBytes: workspace.history.estimatedBytes, entries, count: entries.length, truncated: eligible.length > entries.length, nextBeforeEntryId: eligible.length > entries.length ? entries.at(-1)!.id : null });
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
    case 'asset.dependencies': {
      const document = options.workspace.gameSnapshot(); const requestedAssetId = args.assetId as StableId | undefined; const requestedEntityId = args.entityId as StableId | undefined;
      if (requestedEntityId && !document.entities.some((entity) => entity.id === requestedEntityId)) throw new GameToolProtocolError('tool.entity-missing', `Entity ${requestedEntityId} does not exist.`);
      const owners = new Map(document.entities.flatMap((entity) => entity.componentIds.map((componentId) => [componentId, entity.id] as const)));
      const references: JsonObject[] = [];
      for (const component of document.components) {
        const entityId = owners.get(component.id); if (!entityId || (requestedEntityId && entityId !== requestedEntityId)) continue;
        const found: { assetId: string; path: string }[] = []; collectAssetReferences(component.value, '', found);
        for (const reference of found) if (!requestedAssetId || reference.assetId === requestedAssetId) references.push(Object.freeze({ assetId: reference.assetId, entityId, componentId: component.id, componentType: component.type, path: reference.path }));
      }
      const bounded = Object.freeze(references.slice(0, 500));
      return Object.freeze({ documentId: document.id, revision: document.revision, references: bounded, count: bounded.length, truncated: references.length > bounded.length });
    }
    case 'camera.set': {
      const camera = args.camera as JsonObject;
      const next = await options.workspace.execute({ id: commandId(stored.call.id), label: 'Set Camera', baseRevision: args.baseRevision as number, key: PROJECT_CAMERA_SETTING_KEY, value: camera }, signal);
      if (!next.document) throw new GameToolProtocolError('tool.project-missing', 'Project closed while setting its camera.');
      return Object.freeze({ documentId: next.document.documentId, revision: next.document.revision, camera: projectCameraFromSettings(next.document.settings) as unknown as JsonValue });
    }
    case 'entity.create': {
      const beforeIds = new Set(scene.entities.map((item) => item.id));
      const next = await options.scene.createEntity({ commandId: commandId(stored.call.id), baseRevision: args.baseRevision as number, kind: args.kind as SceneEntityKind, ...roundedBoxParameters(args.kind, args), ...(args.plane ? { plane: args.plane as 'xy' | 'xz' | 'yz' } : {}), ...(args.name ? { name: args.name as string } : {}), ...('parentId' in args ? { parentId: args.parentId as StableId | null } : {}), ...(args.material ? { material: args.material as never } : {}), ...(args.color ? { color: args.color as unknown as SceneMaterialColor } : {}), ...(args.transform ? { transform: args.transform as unknown as TransformSnapshot } : {}) }, signal);
      const created = next.entities.find((item) => !beforeIds.has(item.id)); if (!created) throw new GameToolProtocolError('tool.result-invalid', 'Created entity was not projected.'); return Object.freeze({ entity: entitySummary(created), revision: next.revision });
    }
    case 'entity.rename': {
      const next = await options.scene.renameEntity({ commandId: commandId(stored.call.id), baseRevision: args.baseRevision as number, entityId: args.entityId as StableId, name: args.name as string }, signal);
      return Object.freeze({ entity: entitySummary(requireEntity(next, args.entityId as StableId)), revision: next.revision });
    }
    case 'assembly.create': case 'assembly.instantiate': case 'camera.author': case 'entity.create-many': case 'entity.hierarchy': case 'prefab.manage': case 'transform.batch': case 'component.configure': {
      const planning: TransactionPlanningContext = { createOffsets: new Map<string, number>() };
      const plan = await planReversibleTransactionMember(stored, options, planning, signal);
      const next = await options.workspace.executeBatch({ id: commandId(stored.call.id), label: plan.label, baseRevision: args.baseRevision as number, operations: plan.operations }, signal);
      if (!next.document) throw new GameToolProtocolError('tool.project-missing', 'Project closed while applying a semantic Scene operation.');
      return plan.result(next.document.revision);
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
    case 'asset.generate-texture': {
      if (!options.textureRenderer) throw new GameToolProtocolError('texture.canvas-unavailable', 'Canvas texture rendering is unavailable on this host.');
      const recipe = normalizeCanvasTextureRecipe(args.recipe);
      const bytes = await options.textureRenderer.render(recipe, signal);
      signal.throwIfAborted();
      const result = await options.workspace.importGeneratedTexture({ id: commandId(stored.call.id), documentId: stored.view.documentId, baseRevision: args.baseRevision as number, bytes, width: recipe.width, height: recipe.height, recipeDigest: `sha256:${sha256(canonicalStringify(args.recipe as JsonObject))}` }, signal);
      return Object.freeze({ documentId: stored.view.documentId, revision: result.revision, asset: result.asset as unknown as JsonValue });
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
        component = options.workspace.componentRegistry.validate({ ...existing, ...(isPbrTextureUsage(usage) ? { enabled: true } : {}), value: Object.freeze({ ...existing.value, ...binding.patch }) });
        operation = { op: 'component.replace' as const, component };
      } else {
        const definition = resolveComponentDefinition(options.workspace, binding.type, '1.0.0');
        component = options.workspace.componentRegistry.create({ id: asStableId(`component:${randomUUID()}`), type: binding.type, version: definition.version, enabled: true, value: Object.freeze({ ...definition.defaults, ...textureMaterialDefaults(usage, sceneEntity), ...binding.patch }) });
        operation = { op: 'component.add' as const, entityId, component };
      }
      const next = await options.workspace.executeBatch({ id: commandId(stored.call.id), label: 'Assign Asset', baseRevision: args.baseRevision as number, operations: [operation] }, signal);
      if (!next.document) throw new GameToolProtocolError('tool.project-missing', 'Project closed while assigning an asset.');
      return Object.freeze({ documentId: next.document.documentId, revision: next.document.revision, entityId, assetId: args.assetId as StableId, usage, component: component as unknown as JsonValue });
    }
    case 'script.propose': {
      const proposal = await options.scripts.proposeEdit({ entityId: args.entityId as StableId, text: args.text as string, baseRevision: args.baseRevision as number, ...(args.capabilities ? { capabilities: args.capabilities as ScriptCapabilityName[] } : {}) });
      proposals.set(proposal.id, proposal);
      return scriptProposalResult(proposal, scene.entities.find(item => item.id === proposal.entityId));
    }
    case 'script.patch': {
      const catalog = options.scripts.snapshot(); const resource = resolveScriptResource(catalog, args);
      if (resource.digest !== args.expectedDigest) throw new GameToolProtocolError('tool.script-stale', 'Script digest changed; read script.symbols or script.get and prepare a new patch.', true);
      const text = applyScriptLineEdits(resource.text, args.edits as unknown as readonly ScriptLineEdit[]);
      const proposal = await options.scripts.proposeEdit({ entityId: resource.entityId, text, baseRevision: args.baseRevision as number, ...(args.capabilities ? { capabilities: args.capabilities as ScriptCapabilityName[] } : { capabilities: resource.capabilities }) });
      proposals.set(proposal.id, proposal);
      return Object.freeze({ ...scriptProposalResult(proposal, scene.entities.find(item => item.id === proposal.entityId)), patchedFromDigest: resource.digest, editCount: (args.edits as readonly JsonValue[]).length });
    }
    case 'script.apply': {
      const proposalId = args.proposalId as StableId; if (!proposals.has(proposalId)) throw new GameToolProtocolError('tool.proposal-missing', 'Script proposal is unavailable or already consumed.');
      const resource = await options.scripts.commitProposal(proposalId, commandId(stored.call.id), signal); proposals.delete(proposalId);
      return Object.freeze({ scriptId: resource.id, entityId: resource.entityId, textRevision: resource.textRevision, revision: options.scripts.snapshot().documentRevision });
    }
    case 'preview.validate': {
      if (!scene.entities.some((item) => isSceneGeometryKind(item.kind))) throw new GameToolProtocolError('tool.preview-no-renderables', 'Preview scene has no renderable geometry. Create at least one primitive before Play.');
      const litGeometry = scene.entities.filter((item) => item.appearance?.material === 'pbr' || item.appearance?.material === 'blinn-phong');
      const hasLighting = scene.entities.some((item) => ['directional-light', 'point-light', 'ambient-light'].includes(item.kind)
        || item.components?.some((component) => component.enabled && component.type === 'haiyue.light.environment'));
      if (litGeometry.length > 0 && !hasLighting) {
        const names = litGeometry.slice(0, 5).map((item) => item.name).join(', ');
        throw new GameToolProtocolError('tool.preview-light-required', `Lit materials would render black without lighting (${names}). Create an ambient/directional/point light or switch these gameplay entities to basic material before Play.`);
      }
      const scriptIds = args.scriptIds as readonly StableId[] | undefined;
      const plan = await options.scripts.prepare(scriptIds ? { scriptIds } : undefined); plans.set(plan.id, plan);
      return Object.freeze({
        planId: plan.id, documentId: plan.documentId, documentRevision: plan.documentRevision,
        selection: plan.selection, scriptSetDigest: plan.scriptSetDigest, scriptCount: plan.scripts.length,
        scripts: plan.scripts.map((script) => Object.freeze({ scriptId: script.scriptId, entityId: script.entityId, textRevision: script.textRevision, digest: script.digest, capabilities: script.capabilities })),
        pointerTargets: { count: scene.entities.filter(item => item.components?.some(component => component.enabled && component.type === 'haiyue.interaction.pointer')).length, entities: scene.entities.filter(item => item.components?.some(component => component.enabled && component.type === 'haiyue.interaction.pointer')).slice(0, 16).map(item => ({ id: item.id, name: item.name, kind: item.kind })), sampleLimit: 16 },
        capabilities: plan.capabilities, runtimeConfig: plan.runtimeConfig as unknown as JsonValue, risk: plan.risk,
        diagnostics: plan.diagnostics.map((item) => Object.freeze({ scriptId: item.scriptId, entityId: item.entityId, code: item.code, severity: item.severity, line: item.line, column: item.column, message: item.message })),
      });
    }
    case 'preview.start': case 'play.start': {
      const planId = args.planId as StableId; const plan = plans.get(planId); if (!plan) throw new GameToolProtocolError('tool.preview-plan-missing', 'Validated preview plan is unavailable.');
      const grant = await options.scripts.decide(planId, true); if (!grant) throw new GameToolProtocolError('tool.preview-rejected', 'Preview authorization was rejected.');
      const consumed = options.scripts.consume(grant.id); if (consumed.scriptSetDigest !== plan.scriptSetDigest) throw new GameToolProtocolError('approval.digest-mismatch', 'Preview script set changed after approval.');
      const runtime = await options.preview.start(scene, consumed, signal); plans.delete(planId); return Object.freeze({ state: runtime.state, instanceId: runtime.instanceId, entityId: runtime.entityId, scriptSetDigest: runtime.scriptSetDigest, scriptCount: runtime.scriptCount, disposableCount: runtime.disposableCount });
    }
    case 'preview.stop': {
      const runtime = await options.preview.stop(signal); return Object.freeze({ state: runtime.state, instanceId: runtime.instanceId, disposedSideEffects: runtime.disposableCount });
    }
    case 'play.stop': {
      const before = options.preview.snapshot().state === 'stopped' ? null : await options.preview.inspect(signal);
      const runtime = await options.preview.stop(signal);
      if (!before) return Object.freeze({ state: runtime.state, instanceId: runtime.instanceId, disposedSideEffects: runtime.disposableCount, alreadyStopped: true });
      const lifecycle = await observations.persistState(stored.call, { ...before, value: Object.freeze({ state: runtime.state, disposedSideEffects: runtime.disposableCount, cleanupComplete: runtime.state === 'stopped' }) }, 'lifecycle');
      return Object.freeze({ state: runtime.state, instanceId: runtime.instanceId, disposedSideEffects: runtime.disposableCount, observation: lifecycle.artifact as unknown as JsonValue, projection: lifecycle.projection as JsonValue, projectionTruncated: lifecycle.projectionTruncated });
    }
    case 'play.step': {
      const observation = await options.preview.step(args.count as number, signal);
      const persisted = await observations.persistState(stored.call, observation);
      return Object.freeze({ observation: persisted.artifact as unknown as JsonValue, projection: persisted.projection as JsonValue, projectionTruncated: persisted.projectionTruncated });
    }
    case 'play.pointer-gesture': {
      // step() pauses before advancing, so queued events cannot race display frames.
      const before = await options.preview.step(1, signal);
      const baseline = await observations.persistState(stored.call, before);
      let current = before;
      const steps: JsonObject[] = [];
      for (const point of args.points as readonly JsonObject[]) {
        if (signal?.aborted) throw signal.reason;
        await options.preview.input({ kind: 'pointer', source: 'synthetic', tick: current.tick + 1, pointerId: args.pointerId as number, button: 0, phase: point.phase as 'down' | 'move' | 'up' | 'cancel', x: point.x as number, y: point.y as number }, signal);
        current = await options.preview.step(1, signal);
        const interactions = Array.isArray(current.value.interactions) ? current.value.interactions.filter(item => isRecord(item) && item.pointerId === args.pointerId) as JsonObject[] : [];
        const hit = interactions.find(item => item.type === point.phase) ?? interactions[0];
        const vector = (value: JsonValue | undefined): JsonValue => Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(item => typeof item === 'number' && Number.isFinite(item)) ? value.slice(0, 3) : null;
        steps.push(Object.freeze({ phase: point.phase!, tick: current.tick, x: point.x!, y: point.y!, interactionTargetId: typeof hit?.entityId === 'string' ? hit.entityId.slice(0, 200) : null, point: vector(hit?.point), normal: vector(hit?.normal), interactionCount: interactions.length }));
      }
      if (Number(args.settleTicks) > 0) current = await options.preview.step(Number(args.settleTicks), signal);
      const after = await observations.persistInspection(stored.call, current);
      return Object.freeze({ baseline: baseline.artifact as unknown as JsonValue, baselineProjection: baseline.projection as JsonValue, baselineProjectionTruncated: baseline.projectionTruncated, observations: after.map(item => item.artifact) as unknown as JsonValue, projection: after[0]!.projection as JsonValue, projectionTruncated: after[0]!.projectionTruncated, steps, effects: gestureEffects(before.value, current.value), executedEvents: (args.points as readonly JsonValue[]).length, fromTick: before.tick, toTick: current.tick });
    }
    case 'play.input': {
      const observation = await options.preview.input(args.event as never, signal);
      const persisted = await observations.persistState(stored.call, observation);
      return Object.freeze({ observation: persisted.artifact as unknown as JsonValue, projection: persisted.projection as JsonValue, projectionTruncated: persisted.projectionTruncated });
    }
    case 'play.physics-query': {
      const observation = await options.preview.physicsQuery(args as never, signal);
      const persisted = await observations.persistState(stored.call, observation);
      return Object.freeze({ observation: persisted.artifact as unknown as JsonValue, projection: persisted.projection as JsonValue, projectionTruncated: persisted.projectionTruncated });
    }
    case 'play.inspect': {
      const observation = scopePlayInspection(await options.preview.inspect(signal), args);
      const bundle = await observations.persistInspection(stored.call, observation);
      return Object.freeze({ observation: bundle[0]!.artifact as unknown as JsonValue, observations: bundle.map((item) => item.artifact) as unknown as JsonValue, projection: bundle[0]!.projection as JsonValue, projectionTruncated: bundle[0]!.projectionTruncated });
    }
    case 'play.capture': {
      const capture = await options.preview.capture(signal);
      const persisted = await observations.persistCapture(stored.call, capture);
      const bundle = capture.state ? await observations.persistInspection(stored.call, { ...capture, value: capture.state }) : [];
      return Object.freeze({ observation: persisted.artifact as unknown as JsonValue, observations: [persisted, ...bundle].map((item) => item.artifact) as unknown as JsonValue, projection: persisted.projection as JsonValue, projectionTruncated: persisted.projectionTruncated });
    }
    case 'task.evaluate': return evaluator.evaluate(args, stored.call.taskId ?? asStableId(`task:${stored.call.sessionId}`)) as unknown as JsonObject;
    default: throw new GameToolProtocolError('tool.not-found', `Tool ${stored.definition.id} has no handler.`);
  }
}

function validateToolCall(value: unknown): GameToolCall {
  if (!isRecord(value) || Object.keys(value).some((key) => !['schemaVersion', 'id', 'sessionId', 'turnId', 'taskId', 'toolId', 'toolVersion', 'arguments'].includes(key)) || value.schemaVersion !== 1 || !isRecord(value.arguments)) throw new GameToolProtocolError('tool.call-invalid', 'Tool call envelope is invalid.');
  assertBoundedJsonObject(value.arguments);
  return Object.freeze({ schemaVersion: 1, id: stable(value.id, 'tool call id'), sessionId: stable(value.sessionId, 'session id'), turnId: stable(value.turnId, 'turn id'), ...(value.taskId === undefined ? {} : { taskId: stable(value.taskId, 'task id') }), toolId: stable(value.toolId, 'tool id'), toolVersion: string(value.toolVersion, 'tool version', 32), arguments: value.arguments as JsonObject });
}

function normalizeArguments(toolId: StableId, value: JsonObject, currentRevision: number): JsonObject {
  if (isBehaviorTool(toolId)) return normalizeBehaviorArguments(toolId, value);
  const raw = value as Record<string, unknown>;
  switch (toolId) {
    case 'assembly.create': case 'assembly.inspect': case 'assembly.instantiate': return normalizeAssemblyArguments(toolId, value);
    case 'project.snapshot': case 'engine.capabilities.describe': case 'camera.get': case 'scene.list-entities': case 'preview.stop': case 'play.stop': case 'play.capture': exact(raw, [], [], toolId); return Object.freeze({});
    case 'play.inspect': {
      exact(raw, [], ['entityIds', 'includeGameplay'], toolId);
      const ids = raw.entityIds === undefined ? undefined : stableIdArray(raw.entityIds, 'entityIds', 128);
      if (ids && (ids.length < 1 || new Set(ids).size !== ids.length)) throw invalid('entityIds requires 1-128 unique entity ids.');
      return Object.freeze({ ...(ids ? { entityIds: ids } : {}), ...(raw.includeGameplay === undefined ? {} : { includeGameplay: booleanValue(raw.includeGameplay, 'includeGameplay') }) });
    }
    case 'scene.query': return normalizeSceneContextArguments(raw, false);
    case 'scene.diff': return normalizeSceneContextArguments(raw, true);
    case 'scene.get-many': {
      exact(raw, ['entityIds'], ['includeComponents'], toolId);
      const entityIds = stableIdArray(raw.entityIds, 'entityIds', 128);
      if (entityIds.length < 1) throw invalid('scene.get-many requires 1-128 entity ids.');
      return Object.freeze({ entityIds, includeComponents: raw.includeComponents === undefined ? true : booleanValue(raw.includeComponents, 'includeComponents') });
    }
    case 'engine.docs.search': {
      if (raw.continueFrom !== undefined) {
        exact(raw, ['continueFrom'], ['maxBytes'], toolId);
        return Object.freeze({ continueFrom: boundedString(raw.continueFrom, 'continueFrom', 100, true), ...(raw.maxBytes === undefined ? {} : { maxBytes: boundedInteger(raw.maxBytes, 'maxBytes', 1024, 16384) }) });
      }
      if (raw.query === undefined || raw.requested !== undefined) throw invalid('engine.docs.search requires query for a new search, for example {"query":"pointer interactions","limit":12}. The count field is limit, not requested. To continue a returned page, use its nextCall.arguments ({"continueFrom":"<returned resultRef>"}); Studio restores all search arguments. Never invent or decode a cursor.');
      exact(raw, ['query'], ['surface', 'limit', 'cursor', 'maxBytes'], toolId);
      if (raw.surface !== undefined && !['studio-script', 'authoring', 'engine-native', 'all'].includes(raw.surface as string)) throw invalid('Unknown documentation surface.');
      return Object.freeze({ query: boundedString(raw.query, 'query', 2048, true), ...(raw.surface === undefined ? {} : { surface: raw.surface as string }), ...(raw.cursor === undefined ? {} : { cursor: boundedString(raw.cursor, 'cursor', 512, true) }), limit: raw.limit === undefined ? 6 : boundedInteger(raw.limit, 'limit', 1, QUERY_PAGE_SIZE), maxBytes: raw.maxBytes === undefined ? 4096 : boundedInteger(raw.maxBytes, 'maxBytes', 1024, 16384) });
    }
    case 'engine.docs.read': {
      exact(raw, [], ['fromSearch', 'ref', 'id', 'bundleDigest', 'cursor', 'maxBytes'], toolId);
      return Object.freeze({ ...(raw.fromSearch === undefined ? {} : { fromSearch: jsonObjectValue(raw.fromSearch, 'fromSearch') }), ...(raw.ref === undefined ? {} : { ref: boundedString(raw.ref, 'ref', 100, true) }), ...(raw.id === undefined ? {} : { id: boundedString(raw.id, 'id', 100, true) }), ...(raw.bundleDigest === undefined ? {} : { bundleDigest: boundedString(raw.bundleDigest, 'bundleDigest', 100, true) }), ...(raw.cursor === undefined ? {} : { cursor: boundedString(raw.cursor, 'cursor', 512, true) }), maxBytes: raw.maxBytes === undefined ? 16384 : boundedInteger(raw.maxBytes, 'maxBytes', 1024, 32768) });
    }
    case 'tool.search': exact(raw, ['text'], ['limit', 'cursor', 'includeSchemas'], toolId); return Object.freeze({ text: boundedString(raw.text, 'text', 512, true), limit: raw.limit === undefined ? 12 : boundedInteger(raw.limit, 'limit', 1, QUERY_PAGE_SIZE), ...(raw.cursor === undefined ? {} : { cursor: boundedString(raw.cursor, 'cursor', 512, true) }), includeSchemas: raw.includeSchemas === true });
    case 'component.describe': exact(raw, ['type'], ['version'], toolId); return Object.freeze({ type: componentTypeValue(raw.type), ...(raw.version === undefined ? {} : { version: componentVersionValue(raw.version) }) });
    case 'component.get': {
      exact(raw, [], ['componentId', 'entityId', 'type', 'version'], toolId);
      const hasId = raw.componentId !== undefined; const hasLookup = raw.entityId !== undefined || raw.type !== undefined || raw.version !== undefined;
      if (hasId === hasLookup || (hasLookup && (raw.entityId === undefined || raw.type === undefined))) throw invalid('component.get requires either componentId, or entityId plus type and optional version.');
      if (hasId) return Object.freeze({ componentId: stable(raw.componentId, 'component id') });
      return Object.freeze({ entityId: stable(raw.entityId, 'entity id'), type: componentTypeValue(raw.type), ...(raw.version === undefined ? {} : { version: componentVersionValue(raw.version) }) }) as JsonObject;
    }
    case 'entity.get': exact(raw, ['entityId'], [], toolId); return Object.freeze({ entityId: stable(raw.entityId, 'entity id') });
    case 'script.get': case 'script.symbols': { exact(raw, [], ['entityId', 'scriptId'], toolId); if (!raw.entityId && !raw.scriptId) throw invalid(`${toolId} requires entityId or scriptId.`); return Object.freeze({ ...(raw.entityId ? { entityId: stable(raw.entityId, 'entity id') } : {}), ...(raw.scriptId ? { scriptId: stable(raw.scriptId, 'script id') } : {}) }); }
    case 'diagnostics.query': return normalizeLogQuery(raw);
    case 'history.query': {
      exact(raw, [], ['beforeEntryId', 'limit'], toolId);
      return Object.freeze({ ...(raw.beforeEntryId === undefined ? {} : { beforeEntryId: boundedInteger(raw.beforeEntryId, 'beforeEntryId', 1, Number.MAX_SAFE_INTEGER) }), limit: raw.limit === undefined ? 20 : boundedInteger(raw.limit, 'limit', 1, 100) });
    }
    case 'asset.search': {
      exact(raw, [], ['text', 'kind', 'limit'], toolId);
      return Object.freeze({
        ...(raw.text === undefined ? {} : { text: boundedString(raw.text, 'text', 256) }),
        ...(raw.kind === undefined ? {} : { kind: assetKindValue(raw.kind) }),
        ...(raw.limit === undefined ? {} : { limit: boundedInteger(raw.limit, 'limit', 1, 200) }),
      });
    }
    case 'asset.dependencies': exact(raw, [], ['assetId', 'entityId'], toolId); return Object.freeze({ ...(raw.assetId === undefined ? {} : { assetId: assetIdValue(raw.assetId) }), ...(raw.entityId === undefined ? {} : { entityId: stable(raw.entityId, 'entity id') }) });
    case 'camera.set': {
      exact(raw, ['baseRevision', 'camera'], [], toolId);
      try {
        return Object.freeze({ baseRevision: integer(raw.baseRevision, 'baseRevision'), camera: normalizeProjectCamera(raw.camera) as unknown as JsonValue });
      } catch (cause) { throw invalid(cause instanceof Error ? cause.message : 'Camera is invalid.'); }
    }
    case 'camera.author': return normalizeCameraAuthorArguments(raw);
    case 'entity.create': {
      exact(raw, ['baseRevision', 'kind'], ['name', 'parentId', 'material', 'color', 'transform', 'plane', 'radius', 'segments'], toolId);
      if (!['empty', 'cube', 'rounded-box', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron', 'directional-light', 'point-light', 'ambient-light'].includes(String(raw.kind))) throw invalid('Entity kind is invalid.');
      if (raw.material !== undefined && !isSceneMaterialKind(raw.material)) throw invalid('Material kind is invalid.');
      if ((raw.material !== undefined || raw.color !== undefined) && !isSceneGeometryKind(raw.kind)) throw invalid('Only geometry entities can select a material appearance.');
      return Object.freeze({ baseRevision: integer(raw.baseRevision, 'baseRevision'), kind: raw.kind as JsonValue, ...normalizedPlane(raw), ...normalizedRoundedBox(raw), ...(raw.name === undefined ? {} : { name: boundedString(raw.name, 'name', 80, true) }), ...(raw.parentId === undefined ? {} : { parentId: raw.parentId === null ? null : stable(raw.parentId, 'parent id') }), ...(raw.material === undefined ? {} : { material: raw.material as JsonValue }), ...(raw.color === undefined ? {} : { color: normalizeMaterialColor(raw.color) as unknown as JsonValue }), ...(raw.transform === undefined ? {} : { transform: normalizeTransform(raw.transform) as unknown as JsonValue }) });
    }
    case 'entity.create-many': {
      exact(raw, ['baseRevision', 'entities'], [], toolId);
      if (!Array.isArray(raw.entities) || raw.entities.length < 1 || raw.entities.length > 32) throw invalid('entity.create-many entities must contain 1-32 items.');
      const entities = raw.entities.map((item, index) => {
        if (!isRecord(item)) throw invalid(`entity.create-many entities[${index}] must be an object.`);
        exact(item, ['kind'], ['name', 'parentId', 'material', 'color', 'transform', 'plane', 'radius', 'segments'], `entity.create-many entities[${index}]`);
        if (!['empty', 'cube', 'rounded-box', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron', 'directional-light', 'point-light', 'ambient-light'].includes(String(item.kind))) throw invalid(`entity.create-many entities[${index}] kind is invalid.`);
        if (item.material !== undefined && !isSceneMaterialKind(item.material)) throw invalid(`entity.create-many entities[${index}] material is invalid.`);
        if ((item.material !== undefined || item.color !== undefined) && !isSceneGeometryKind(item.kind)) throw invalid('Only geometry entities can select a material appearance.');
        return Object.freeze({ kind: item.kind as JsonValue, ...normalizedPlane(item), ...normalizedRoundedBox(item), ...(item.name === undefined ? {} : { name: boundedString(item.name, `entities[${index}].name`, 80, true) }), ...(item.parentId === undefined ? {} : { parentId: item.parentId === null ? null : stable(item.parentId, `entities[${index}].parentId`) }), ...(item.material === undefined ? {} : { material: item.material as JsonValue }), ...(item.color === undefined ? {} : { color: normalizeMaterialColor(item.color) as unknown as JsonValue }), ...(item.transform === undefined ? {} : { transform: normalizeTransform(item.transform) as unknown as JsonValue }) });
      });
      return Object.freeze({ baseRevision: integer(raw.baseRevision, 'baseRevision'), entities: Object.freeze(entities) });
    }
    case 'entity.rename': exact(raw, ['baseRevision', 'entityId', 'name'], [], toolId); return Object.freeze({ baseRevision: integer(raw.baseRevision, 'baseRevision'), entityId: stable(raw.entityId, 'entity id'), name: boundedString(raw.name, 'name', 80, true) });
    case 'entity.hierarchy': return normalizeEntityHierarchyArguments(raw);
    case 'prefab.manage': return normalizePrefabArguments(raw);
    case 'transform.set': exact(raw, ['baseRevision', 'entityId', 'transform'], [], toolId); return Object.freeze({ baseRevision: integer(raw.baseRevision, 'baseRevision'), entityId: stable(raw.entityId, 'entity id'), transform: normalizeTransform(raw.transform) as unknown as JsonValue });
    case 'transform.batch': return normalizeTransformBatchArguments(raw);
    case 'material.set': exact(raw, ['baseRevision', 'entityId', 'material'], ['color'], toolId); if (!isSceneMaterialKind(raw.material)) throw invalid('Material kind is invalid.'); return Object.freeze({ baseRevision: integer(raw.baseRevision, 'baseRevision'), entityId: stable(raw.entityId, 'entity id'), material: raw.material, ...(raw.color === undefined ? {} : { color: normalizeMaterialColor(raw.color) as unknown as JsonValue }) });
    case 'component.add': exact(raw, ['baseRevision', 'entityId', 'type'], ['version', 'enabled', 'value'], toolId); return Object.freeze({ baseRevision: integer(raw.baseRevision, 'baseRevision'), entityId: stable(raw.entityId, 'entity id'), type: componentTypeValue(raw.type), version: componentVersionValue(raw.version ?? '1.0.0'), enabled: raw.enabled === undefined ? true : booleanValue(raw.enabled, 'enabled'), value: jsonObjectValue(raw.value ?? {}, 'component value') as JsonValue });
    case 'component.set': exact(raw, ['baseRevision', 'componentId', 'value'], ['enabled'], toolId); return Object.freeze({ baseRevision: integer(raw.baseRevision, 'baseRevision'), componentId: stable(raw.componentId, 'component id'), ...(raw.enabled === undefined ? {} : { enabled: booleanValue(raw.enabled, 'enabled') }), value: jsonObjectValue(raw.value, 'component value') as JsonValue });
    case 'component.remove': exact(raw, ['baseRevision', 'componentId'], [], toolId); return Object.freeze({ baseRevision: integer(raw.baseRevision, 'baseRevision'), componentId: stable(raw.componentId, 'component id') });
    case 'component.configure': {
      exact(raw, ['baseRevision', 'action', 'entityId', 'type'], ['version', 'enabled', 'patch'], toolId);
      const action = String(raw.action); if (!['upsert', 'remove'].includes(action)) throw invalid('component.configure action is invalid.');
      if (action === 'remove' && (raw.enabled !== undefined || raw.patch !== undefined)) throw invalid('component.configure remove does not accept enabled or patch.');
      return Object.freeze({ baseRevision: integer(raw.baseRevision, 'baseRevision'), action, entityId: stable(raw.entityId, 'entity id'), type: componentTypeValue(raw.type), version: componentVersionValue(raw.version ?? '1.0.0'), ...(raw.enabled === undefined ? {} : { enabled: booleanValue(raw.enabled, 'enabled') }), ...(raw.patch === undefined ? {} : { patch: jsonObjectValue(raw.patch, 'component patch') as JsonValue }) });
    }
    case 'asset.generate-texture': {
      exact(raw, ['baseRevision', 'recipe'], [], toolId);
      try { return Object.freeze({ baseRevision: integer(raw.baseRevision, 'baseRevision'), recipe: normalizeCanvasTextureRecipe(raw.recipe) as unknown as JsonValue }); } catch { throw invalid('Invalid Canvas texture recipe. Use schemaVersion 1, bounded drawing commands and hexadecimal colors.'); }
    }
    case 'asset.import': {
      exact(raw, ['baseRevision', 'projectPath', 'kind', 'mimeType', 'license', 'provenance', 'decodedBytes'], ['width', 'height'], toolId);
      if ((raw.width === undefined) !== (raw.height === undefined)) throw invalid('Asset width and height must be supplied together.');
      const projectPath = boundedString(raw.projectPath, 'projectPath', 512, true).replaceAll('\\', '/');
      if (projectPath.startsWith('/') || /^[A-Za-z]:/u.test(projectPath) || projectPath.split('/').includes('..') || !projectPath.startsWith('assets/')) throw invalid('projectPath must stay under the project assets directory.');
      return Object.freeze({
        baseRevision: integer(raw.baseRevision, 'baseRevision'), projectPath,
        kind: assetKindValue(raw.kind), mimeType: boundedString(raw.mimeType, 'mimeType', 128, true),
        license: assetLicenseValue(raw.license), provenance: boundedString(raw.provenance, 'provenance', 512, true),
        decodedBytes: boundedInteger(raw.decodedBytes, 'decodedBytes', 1, 128 * 1024 * 1024),
        ...(raw.width === undefined ? {} : { width: boundedInteger(raw.width, 'width', 1, 8192), height: boundedInteger(raw.height, 'height', 1, 8192) }),
      });
    }
    case 'asset.assign': exact(raw, ['baseRevision', 'entityId', 'assetId', 'usage'], [], toolId); return Object.freeze({ baseRevision: integer(raw.baseRevision, 'baseRevision'), entityId: stable(raw.entityId, 'entity id'), assetId: assetIdValue(raw.assetId), usage: assetUsageValue(raw.usage) });
    case 'script.propose': exact(raw, ['baseRevision', 'entityId', 'text'], ['capabilities'], toolId); return Object.freeze({ baseRevision: integer(raw.baseRevision, 'baseRevision'), entityId: stable(raw.entityId, 'entity id'), text: boundedString(raw.text, 'text', 65_536, true), ...(raw.capabilities ? { capabilities: normalizeCapabilities(raw.capabilities) } : {}) });
    case 'script.patch': {
      exact(raw, ['baseRevision', 'expectedDigest', 'edits'], ['entityId', 'scriptId', 'capabilities'], toolId);
      if (raw.entityId === undefined && raw.scriptId === undefined) throw invalid('script.patch requires entityId, scriptId, or both.');
      if (typeof raw.expectedDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(raw.expectedDigest)) throw invalid('script.patch expectedDigest is invalid.');
      if (!Array.isArray(raw.edits) || raw.edits.length < 1 || raw.edits.length > 64) throw invalid('script.patch edits must contain 1-64 edits.');
      const edits = raw.edits.map((edit, index) => {
        if (!isRecord(edit)) throw invalid(`script.patch edits[${index}] must be an object.`);
        exact(edit, ['startLine', 'endLine', 'text'], [], `script.patch edits[${index}]`);
        const startLine = boundedInteger(edit.startLine, 'startLine', 1, 100_000); const endLine = boundedInteger(edit.endLine, 'endLine', 1, 100_000);
        if (endLine < startLine) throw invalid('script.patch edit endLine must be >= startLine.');
        return Object.freeze({ startLine, endLine, text: boundedString(edit.text, 'edit text', 32_768) });
      }).sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
      if (edits.some((edit, index) => index > 0 && edits[index - 1]!.endLine >= edit.startLine)) throw invalid('script.patch edits must not overlap.');
      return Object.freeze({ baseRevision: integer(raw.baseRevision, 'baseRevision'), expectedDigest: raw.expectedDigest, edits: Object.freeze(edits) as unknown as JsonValue, ...(raw.entityId === undefined ? {} : { entityId: stable(raw.entityId, 'entity id') }), ...(raw.scriptId === undefined ? {} : { scriptId: stable(raw.scriptId, 'script id') }), ...(raw.capabilities ? { capabilities: normalizeCapabilities(raw.capabilities) } : {}) });
    }
    case 'script.apply': exact(raw, ['baseRevision', 'proposalId'], [], toolId); return Object.freeze({ baseRevision: integer(raw.baseRevision, 'baseRevision'), proposalId: stable(raw.proposalId, 'proposal id') });
    case 'preview.validate': {
      exact(raw, [], ['baseRevision', 'scriptIds'], toolId);
      const baseRevision = raw.baseRevision === undefined ? currentRevision : integer(raw.baseRevision, 'baseRevision');
      if (raw.scriptIds === undefined) return Object.freeze({ baseRevision });
      if (!Array.isArray(raw.scriptIds) || raw.scriptIds.length < 1 || raw.scriptIds.length > 128) throw invalid('scriptIds must contain 1-128 script ids.');
      const scriptIds = raw.scriptIds.map((item) => stable(item, 'script id'));
      if (new Set(scriptIds).size !== scriptIds.length) throw invalid('scriptIds must be unique.');
      return Object.freeze({ baseRevision, scriptIds });
    }
    case 'preview.start': case 'play.start': exact(raw, ['baseRevision', 'planId'], [], toolId); return Object.freeze({ baseRevision: integer(raw.baseRevision, 'baseRevision'), planId: stable(raw.planId, 'plan id') });
    case 'play.step': exact(raw, ['count'], [], toolId); return Object.freeze({ count: boundedInteger(raw.count, 'count', 1, 10_000) });
    case 'play.pointer-gesture': {
      exact(raw, ['points'], ['pointerId', 'settleTicks'], toolId);
      if (!Array.isArray(raw.points) || raw.points.length < 2 || raw.points.length > 32) throw invalid('Gesture requires 2-32 pointer points.');
      const points = raw.points.map((point, index) => {
        if (!isRecord(point)) throw invalid('Gesture point must be an object.');
        exact(point, ['phase', 'x', 'y'], [], toolId);
        const allowed = index === 0 ? ['down'] : index === (raw.points as unknown[]).length - 1 ? ['up', 'cancel'] : ['move'];
        if (!allowed.includes(String(point.phase))) throw invalid('Gesture must be down, optional moves, then up/cancel.');
        const event = normalizePlayInput({ ...point, tick: 1, kind: 'pointer', pointerId: 1 });
        return Object.freeze({ phase: point.phase, x: event.x, y: event.y }) as JsonObject;
      });
      return Object.freeze({ points, pointerId: raw.pointerId === undefined ? 1 : boundedInteger(raw.pointerId, 'pointerId', 0, 1_000_000), settleTicks: raw.settleTicks === undefined ? 1 : boundedInteger(raw.settleTicks, 'settleTicks', 0, 600) });
    }
    case 'play.input': exact(raw, ['event'], [], toolId); return Object.freeze({ event: normalizePlayInput(raw.event) as unknown as JsonValue });
    case 'play.physics-query': return normalizePhysicsQuery(raw);
    case 'task.evaluate': return normalizeEvaluationArguments(raw);
    default: throw new GameToolProtocolError('tool.not-found', `Unknown tool ${toolId}.`);
  }
}

function normalizeCameraAuthorArguments(raw: Record<string, unknown>): JsonObject {
  exact(raw, ['baseRevision', 'action'], ['entityId', 'targetEntityId', 'name', 'transform', 'projection', 'fovDegrees', 'orthographicHeight', 'near', 'far', 'viewport', 'mode', 'offset', 'lookAtOffset', 'smoothing', 'padding', 'bounds', 'plane', 'targetSize', 'azimuthDelta', 'elevationDelta', 'distance'], 'camera.author');
  const action = String(raw.action); if (!['create', 'activate', 'frame', 'frame-bounds', 'orbit', 'follow', 'projection', 'viewport'].includes(action)) throw invalid('camera.author action is invalid.');
  const actionFields: Record<string, readonly string[]> = {
    create: ['name', 'transform', 'projection', 'fovDegrees', 'orthographicHeight', 'near', 'far', 'viewport'], activate: ['entityId'], frame: ['targetEntityId', 'padding'], 'frame-bounds': ['bounds', 'plane', 'targetSize', 'padding'], orbit: ['azimuthDelta', 'elevationDelta', 'distance'],
    follow: ['entityId', 'targetEntityId', 'mode', 'offset', 'lookAtOffset', 'smoothing'], projection: ['entityId', 'projection', 'fovDegrees', 'orthographicHeight', 'near', 'far'], viewport: ['entityId', 'viewport'],
  };
  const allowed = new Set(['action', 'baseRevision', ...actionFields[action]!]);
  const unexpected = Object.keys(raw).filter((key) => !allowed.has(key)); if (unexpected.length) throw invalid(`camera.author ${action} does not accept: ${unexpected.join(', ')}.`);
  if (['activate', 'projection', 'viewport', 'follow'].includes(action) && raw.entityId === undefined) throw invalid(`camera.author ${action} requires entityId.`);
  if (['frame', 'follow'].includes(action) && raw.targetEntityId === undefined) throw invalid(`camera.author ${action} requires targetEntityId.`);
  if (action === 'frame-bounds' && (raw.bounds === undefined || raw.plane === undefined || raw.targetSize === undefined)) throw invalid('camera.author frame-bounds requires bounds, plane, and targetSize.');
  if (action === 'projection' && raw.projection === undefined) throw invalid('camera.author projection requires projection.');
  if (action === 'viewport' && raw.viewport === undefined) throw invalid('camera.author viewport requires viewport.');
  if (action === 'orbit' && raw.azimuthDelta === undefined && raw.elevationDelta === undefined && raw.distance === undefined) throw invalid('camera.author orbit requires azimuthDelta, elevationDelta, or distance.');
  const projection = raw.projection === undefined ? undefined : String(raw.projection); if (projection && !['perspective', 'orthographic'].includes(projection)) throw invalid('camera projection is invalid.');
  const mode = raw.mode === undefined ? undefined : String(raw.mode); if (mode && !['position', 'look-at', 'position-and-look-at'].includes(mode)) throw invalid('camera follow mode is invalid.');
  const plane = raw.plane === undefined ? undefined : String(raw.plane); if (plane && !['xy', 'xz', 'yz'].includes(plane)) throw invalid('camera frame plane is invalid.');
  let bounds: Readonly<{ minimum: ReturnType<typeof vec>; maximum: ReturnType<typeof vec> }> | undefined;
  if (raw.bounds !== undefined) {
    if (!isRecord(raw.bounds)) throw invalid('bounds must be an object.'); exact(raw.bounds, ['minimum', 'maximum'], [], 'bounds');
    bounds = Object.freeze({ minimum: vec(raw.bounds.minimum, 'bounds.minimum'), maximum: vec(raw.bounds.maximum, 'bounds.maximum') });
    for (const axis of ['x', 'y', 'z'] as const) if (bounds.maximum[axis] < bounds.minimum[axis]) throw invalid(`bounds.maximum.${axis} must be greater than or equal to bounds.minimum.${axis}.`);
    if (plane) {
      const axes: readonly ('x' | 'y' | 'z')[] = plane === 'xz' ? ['x', 'z'] : plane === 'xy' ? ['x', 'y'] : ['z', 'y'];
      if (axes.some((axis) => bounds!.maximum[axis] === bounds!.minimum[axis])) throw invalid(`bounds must have non-zero ${plane} width and height.`);
    }
  }
  let targetSize: Readonly<{ width: number; height: number }> | undefined;
  if (raw.targetSize !== undefined) {
    if (!isRecord(raw.targetSize)) throw invalid('targetSize must be an object.'); exact(raw.targetSize, ['width', 'height'], [], 'targetSize');
    targetSize = Object.freeze({ width: boundedInteger(raw.targetSize.width, 'targetSize.width', 1, 16_384), height: boundedInteger(raw.targetSize.height, 'targetSize.height', 1, 16_384) });
  }
  return Object.freeze({
    baseRevision: integer(raw.baseRevision, 'baseRevision'), action,
    ...(raw.entityId === undefined ? {} : { entityId: stable(raw.entityId, 'entity id') }), ...(raw.targetEntityId === undefined ? {} : { targetEntityId: stable(raw.targetEntityId, 'target entity id') }),
    ...(raw.name === undefined ? {} : { name: boundedString(raw.name, 'name', 80, true) }), ...(raw.transform === undefined ? {} : { transform: normalizeTransform(raw.transform) as unknown as JsonValue }),
    ...(projection === undefined ? {} : { projection }), ...(raw.fovDegrees === undefined ? {} : { fovDegrees: boundedNumber(raw.fovDegrees, 'fovDegrees', 1, 179) }),
    ...(raw.orthographicHeight === undefined ? {} : { orthographicHeight: boundedNumber(raw.orthographicHeight, 'orthographicHeight', 0.01, 10_000) }),
    ...(raw.near === undefined ? {} : { near: boundedNumber(raw.near, 'near', 0.0001, 1_000) }), ...(raw.far === undefined ? {} : { far: boundedNumber(raw.far, 'far', 0.001, 1_000_000) }),
    ...(raw.viewport === undefined ? {} : { viewport: normalizeViewport(raw.viewport) as unknown as JsonValue }), ...(mode === undefined ? {} : { mode }),
    ...(raw.offset === undefined ? {} : { offset: vec(raw.offset, 'offset') as unknown as JsonValue }), ...(raw.lookAtOffset === undefined ? {} : { lookAtOffset: vec(raw.lookAtOffset, 'lookAtOffset') as unknown as JsonValue }),
    ...(raw.smoothing === undefined ? {} : { smoothing: boundedNumber(raw.smoothing, 'smoothing', 0, 1) }), ...(raw.padding === undefined ? {} : { padding: boundedNumber(raw.padding, 'padding', 1, 100) }),
    ...(bounds === undefined ? {} : { bounds: bounds as unknown as JsonValue }), ...(plane === undefined ? {} : { plane }), ...(targetSize === undefined ? {} : { targetSize: targetSize as unknown as JsonValue }),
    ...(raw.azimuthDelta === undefined ? {} : { azimuthDelta: boundedNumber(raw.azimuthDelta, 'azimuthDelta', -360, 360) }), ...(raw.elevationDelta === undefined ? {} : { elevationDelta: boundedNumber(raw.elevationDelta, 'elevationDelta', -180, 180) }),
    ...(raw.distance === undefined ? {} : { distance: boundedNumber(raw.distance, 'distance', 0.5, 500) }),
  });
}

function normalizeViewport(value: unknown): JsonObject { if (!isRecord(value)) throw invalid('viewport must be an object.'); exact(value, ['x', 'y', 'width', 'height'], [], 'viewport'); const result = { x: boundedNumber(value.x, 'viewport.x', 0, 1), y: boundedNumber(value.y, 'viewport.y', 0, 1), width: boundedNumber(value.width, 'viewport.width', Number.EPSILON, 1), height: boundedNumber(value.height, 'viewport.height', Number.EPSILON, 1) }; if (result.x + result.width > 1 || result.y + result.height > 1) throw invalid('viewport must remain inside normalized bounds.'); return Object.freeze(result); }

function normalizeEntityHierarchyArguments(raw: Record<string, unknown>): JsonObject {
  exact(raw, ['baseRevision', 'action', 'entityId'], ['parentId', 'name', 'order', 'includeDescendants'], 'entity.hierarchy');
  const action = String(raw.action);
  if (!['clone', 'reparent', 'delete'].includes(action)) throw invalid('entity.hierarchy action is invalid.');
  if (action === 'reparent' && !Object.hasOwn(raw, 'parentId')) throw invalid('entity.hierarchy reparent requires parentId, which may be null.');
  if (action === 'delete' && (raw.parentId !== undefined || raw.name !== undefined || raw.order !== undefined)) throw invalid('entity.hierarchy delete only accepts includeDescendants.');
  if (action === 'reparent' && (raw.name !== undefined || raw.includeDescendants !== undefined)) throw invalid('entity.hierarchy reparent only accepts parentId and optional order.');
  return Object.freeze({
    baseRevision: integer(raw.baseRevision, 'baseRevision'), action, entityId: stable(raw.entityId, 'entity id'),
    ...(Object.hasOwn(raw, 'parentId') ? { parentId: raw.parentId === null ? null : stable(raw.parentId, 'parent id') } : {}),
    ...(raw.name === undefined ? {} : { name: boundedString(raw.name, 'name', 80, true) }),
    ...(raw.order === undefined ? {} : { order: boundedInteger(raw.order, 'order', 0, 1_000_000) }),
    ...(raw.includeDescendants === undefined ? {} : { includeDescendants: booleanValue(raw.includeDescendants, 'includeDescendants') }),
  });
}

function normalizePrefabArguments(raw: Record<string, unknown>): JsonObject {
  exact(raw, ['baseRevision', 'action', 'prefabId'], ['entityId', 'parentId', 'name'], 'prefab.manage');
  const action = String(raw.action);
  if (!['capture', 'instantiate', 'remove'].includes(action)) throw invalid('prefab.manage action is invalid.');
  if (typeof raw.prefabId !== 'string' || !/^prefab:[A-Za-z0-9._:-]{3,120}$/u.test(raw.prefabId)) throw invalid('prefab.manage prefabId is invalid.');
  if (action === 'capture' && raw.entityId === undefined) throw invalid('prefab.manage capture requires entityId.');
  if (action === 'capture' && raw.parentId !== undefined) throw invalid('prefab.manage capture does not accept parentId.');
  if (action === 'instantiate' && raw.entityId !== undefined) throw invalid('prefab.manage instantiate does not accept entityId.');
  if (action === 'remove' && (raw.entityId !== undefined || raw.parentId !== undefined || raw.name !== undefined)) throw invalid('prefab.manage remove only accepts prefabId and baseRevision.');
  return Object.freeze({
    baseRevision: integer(raw.baseRevision, 'baseRevision'), action, prefabId: asStableId(raw.prefabId),
    ...(raw.entityId === undefined ? {} : { entityId: stable(raw.entityId, 'entity id') }),
    ...(Object.hasOwn(raw, 'parentId') ? { parentId: raw.parentId === null ? null : stable(raw.parentId, 'parent id') } : {}),
    ...(raw.name === undefined ? {} : { name: boundedString(raw.name, 'name', 80, true) }),
  });
}

function normalizeTransformBatchArguments(raw: Record<string, unknown>): JsonObject {
  exact(raw, ['baseRevision', 'action'], ['entityIds', 'transforms', 'axis', 'mode', 'spacing', 'grid', 'target'], 'transform.batch');
  const action = String(raw.action);
  if (!['set', 'align', 'distribute', 'snap', 'look-at'].includes(action)) throw invalid('transform.batch action is invalid.');
  const entityIds = raw.entityIds === undefined ? undefined : stableIdArray(raw.entityIds, 'entityIds', 128);
  if (entityIds && entityIds.length < 1) throw invalid('transform.batch entityIds must contain 1-128 ids.');
  let transforms: readonly JsonObject[] | undefined;
  if (raw.transforms !== undefined) {
    if (!Array.isArray(raw.transforms) || raw.transforms.length < 1 || raw.transforms.length > 128) throw invalid('transform.batch transforms must contain 1-128 assignments.');
    transforms = Object.freeze(raw.transforms.map((entry, index) => {
      if (!isRecord(entry)) throw invalid(`transform.batch transforms[${index}] must be an object.`);
      exact(entry, ['entityId', 'transform'], [], `transform.batch transforms[${index}]`);
      return Object.freeze({ entityId: stable(entry.entityId, 'entity id'), transform: normalizeTransform(entry.transform) as unknown as JsonValue });
    }));
    if (new Set(transforms.map((entry) => entry.entityId)).size !== transforms.length) throw invalid('transform.batch transform entity ids must be unique.');
  }
  if (action === 'set') {
    if (!transforms || entityIds || raw.axis !== undefined || raw.mode !== undefined || raw.spacing !== undefined || raw.grid !== undefined || raw.target !== undefined) throw invalid('transform.batch set requires only transforms.');
  } else {
    if (!entityIds || transforms) throw invalid(`transform.batch ${action} requires entityIds and does not accept transforms.`);
    if (action === 'align' && (raw.axis === undefined || raw.mode === undefined || raw.spacing !== undefined || raw.grid !== undefined || raw.target !== undefined)) throw invalid('transform.batch align requires axis and mode only.');
    if (action === 'distribute' && (raw.axis === undefined || raw.mode !== undefined || raw.grid !== undefined || raw.target !== undefined)) throw invalid('transform.batch distribute requires axis and optional spacing.');
    if (action === 'distribute' && entityIds.length < 2) throw invalid('transform.batch distribute requires at least two entities.');
    if (action === 'snap' && (raw.grid === undefined || raw.mode !== undefined || raw.spacing !== undefined || raw.target !== undefined)) throw invalid('transform.batch snap requires grid and optional axis.');
    if (action === 'look-at' && (raw.target === undefined || raw.axis !== undefined || raw.mode !== undefined || raw.spacing !== undefined || raw.grid !== undefined)) throw invalid('transform.batch look-at requires target only.');
  }
  const axis = raw.axis === undefined ? undefined : String(raw.axis);
  if (axis !== undefined && !['x', 'y', 'z'].includes(axis)) throw invalid('transform.batch axis is invalid.');
  const mode = raw.mode === undefined ? undefined : String(raw.mode);
  if (mode !== undefined && !['min', 'center', 'max'].includes(mode)) throw invalid('transform.batch mode is invalid.');
  const grid = raw.grid === undefined ? undefined : number(raw.grid, 'grid');
  if (grid !== undefined && grid <= 0) throw invalid('transform.batch grid must be positive.');
  return Object.freeze({
    baseRevision: integer(raw.baseRevision, 'baseRevision'), action,
    ...(entityIds ? { entityIds } : {}), ...(transforms ? { transforms: transforms as unknown as JsonValue } : {}),
    ...(axis === undefined ? {} : { axis }), ...(mode === undefined ? {} : { mode }),
    ...(raw.spacing === undefined ? {} : { spacing: number(raw.spacing, 'spacing') }),
    ...(grid === undefined ? {} : { grid }), ...(raw.target === undefined ? {} : { target: vec(raw.target, 'target') as unknown as JsonValue }),
  });
}

function normalizeSceneContextArguments(raw: Record<string, unknown>, diff: boolean): JsonObject {
  exact(raw, diff ? ['fromRevision'] : [], diff ? ['toRevision', 'scope', 'projection', 'cursor', 'limit'] : ['revision', 'scope', 'projection', 'cursor', 'limit'], diff ? 'scene.diff' : 'scene.query');
  const scope = raw.scope === undefined ? undefined : normalizeSceneScope(raw.scope);
  const projection = raw.projection === undefined ? undefined : enumArray(raw.projection, ['hierarchy', 'components', 'scripts', 'assets', 'camera', 'render', 'settings'], 7) as readonly SceneContextProjection[];
  const common = {
    ...(scope ? { scope: scope as unknown as JsonValue } : {}),
    ...(projection ? { projection: projection as unknown as JsonValue } : {}),
    ...(raw.cursor === undefined ? {} : { cursor: boundedString(raw.cursor, 'cursor', 2_048, true) }),
    ...(raw.limit === undefined ? {} : { limit: boundedInteger(raw.limit, 'limit', 1, 1_000) }),
  };
  if (diff) return Object.freeze({ fromRevision: boundedInteger(raw.fromRevision, 'fromRevision', 0, Number.MAX_SAFE_INTEGER), ...(raw.toRevision === undefined ? {} : { toRevision: boundedInteger(raw.toRevision, 'toRevision', 0, Number.MAX_SAFE_INTEGER) }), ...common });
  return Object.freeze({ ...(raw.revision === undefined ? {} : { revision: boundedInteger(raw.revision, 'revision', 0, Number.MAX_SAFE_INTEGER) }), ...common });
}

function normalizeSceneScope(value: unknown): SceneContextScope {
  if (!isRecord(value)) throw invalid('scene scope must be an object.');
  exact(value, [], ['sceneId', 'entityIds', 'componentTypes'], 'scene scope');
  const entityIds = value.entityIds === undefined ? undefined : stableIdArray(value.entityIds, 'entityIds', 1_000);
  const componentTypes = value.componentTypes === undefined ? undefined : componentTypeArray(value.componentTypes, 128);
  return Object.freeze({ ...(value.sceneId === undefined ? {} : { sceneId: sceneScopeId(value.sceneId) }), ...(entityIds ? { entityIds } : {}), ...(componentTypes ? { componentTypes } : {}) });
}

function sceneScopeId(value: unknown): StableId {
  try { return stable(value, 'scene id'); }
  catch { throw new GameToolProtocolError('scene.scope-invalid', 'scope.sceneId is malformed. Omit scope.sceneId to query the current scene, or copy the exact scene id from a successful scene.query. Never use placeholders such as scene:??.', true); }
}

function stableIdArray(value: unknown, label: string, maximum: number): readonly StableId[] {
  if (!Array.isArray(value) || value.length > maximum) throw invalid(`${label} must contain at most ${maximum} ids.`);
  const result = value.map((entry) => stable(entry, label)); if (new Set(result).size !== result.length) throw invalid(`${label} must be unique.`); return Object.freeze(result);
}
function componentTypeArray(value: unknown, maximum: number): readonly StableId[] {
  if (!Array.isArray(value) || value.length > maximum) throw invalid(`componentTypes must contain at most ${maximum} values.`);
  const result = value.map((entry) => asStableId(componentTypeValue(entry))); if (new Set(result).size !== result.length) throw invalid('componentTypes must be unique.'); return Object.freeze(result);
}

function normalizeLogQuery(raw: Record<string, unknown>): JsonObject {
  exact(raw, ['limit', 'traverseCorrelation'], ['severity', 'kinds', 'sessionId', 'turnId', 'toolCallId', 'entityId', 'pluginId', 'afterSequence', 'beforeSequence', 'cursor']);
  const limit = integer(raw.limit, 'limit'); if (limit < 1 || limit > 100) throw invalid('Diagnostic query limit must be 1-100.');
  if (typeof raw.traverseCorrelation !== 'boolean') throw invalid('traverseCorrelation must be boolean.');
  return Object.freeze({ limit, traverseCorrelation: raw.traverseCorrelation, ...optionalIdFields(raw, ['sessionId', 'turnId', 'toolCallId', 'entityId', 'pluginId']), ...optionalIntegers(raw, ['afterSequence', 'beforeSequence']), ...(raw.severity ? { severity: enumArray(raw.severity, ['debug', 'info', 'warning', 'error'], 4) } : {}), ...(raw.kinds ? { kinds: stringArray(raw.kinds, 32, 96) } : {}), ...(raw.cursor ? { cursor: boundedString(raw.cursor, 'cursor', 2_048, true) } : {}) });
}

function normalizePlayInput(value: unknown): JsonObject {
  if (!isRecord(value)) throw invalid('play.input event must be an object.');
  exact(value, ['tick', 'kind'], ['source', 'action', 'phase', 'pointerId', 'x', 'y', 'button', 'wheelX', 'wheelY', 'value', 'reason'], 'play.input event');
  const kind = String(value.kind);
  if (!['action', 'pointer', 'reset'].includes(kind)) throw invalid('play.input event kind is invalid.');
  const event: Record<string, JsonValue> = { tick: boundedInteger(value.tick, 'tick', 0, 1_000_000_000), kind };
  if (value.source !== undefined) { const source = String(value.source); if (!['synthetic', 'keyboard', 'pointer', 'gamepad', 'system'].includes(source)) throw invalid('input source is invalid.'); event.source = source; }
  if (value.action !== undefined) event.action = boundedString(value.action, 'action', 80, true);
  if (value.phase !== undefined) { const phase = String(value.phase); if (!['down', 'value', 'up', 'move', 'cancel', 'wheel'].includes(phase)) throw invalid('input phase is invalid.'); event.phase = phase; }
  if (value.pointerId !== undefined) event.pointerId = boundedInteger(value.pointerId, 'pointerId', 0, 1_000_000);
  if (value.x !== undefined) event.x = boundedNumber(value.x, 'x', 0, 1);
  if (value.y !== undefined) event.y = boundedNumber(value.y, 'y', 0, 1);
  if (value.button !== undefined) event.button = boundedInteger(value.button, 'button', 0, 31);
  if (value.wheelX !== undefined) event.wheelX = number(value.wheelX, 'wheelX');
  if (value.wheelY !== undefined) event.wheelY = number(value.wheelY, 'wheelY');
  if (value.value !== undefined) event.value = number(value.value, 'value');
  if (value.reason !== undefined) { const reason = String(value.reason); if (!['blur', 'disconnect', 'stop', 'restart', 'cancel', 'manual'].includes(reason)) throw invalid('reset reason is invalid.'); event.reason = reason; }
  if (kind === 'action' && (event.action === undefined || !['down', 'value', 'up'].includes(String(event.phase)))) throw invalid('Action input requires action and down/value/up phase.');
  if (kind === 'pointer' && (event.pointerId === undefined || event.x === undefined || event.y === undefined || !['down', 'move', 'up', 'cancel', 'wheel'].includes(String(event.phase)))) throw invalid('Pointer input requires pointerId, x, y and a pointer phase.');
  if (kind === 'reset' && event.reason === undefined) throw invalid('Reset input requires reason.');
  return Object.freeze(event);
}

function normalizePhysicsQuery(raw: Record<string, unknown>): JsonObject {
  exact(raw, ['kind'], ['dimension', 'entityId', 'origin', 'direction', 'center', 'size', 'maxDistance', 'sinceTick', 'limit'], 'play.physics-query');
  const kind = String(raw.kind);
  if (!['status', 'events', 'body', 'raycast', 'overlap'].includes(kind)) throw invalid('Physics query kind is invalid.');
  const allowedByKind: Readonly<Record<string, readonly string[]>> = Object.freeze({
    status: [], events: ['sinceTick', 'limit'], body: ['entityId'], raycast: ['dimension', 'origin', 'direction', 'maxDistance'], overlap: ['dimension', 'center', 'size', 'limit'],
  });
  const allowed = new Set(['kind', ...allowedByKind[kind]!]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw invalid(`play.physics-query ${kind} does not accept ${key}.`);
  const requiredByKind: Readonly<Record<string, readonly string[]>> = Object.freeze({ status: [], events: [], body: ['entityId'], raycast: ['dimension', 'origin', 'direction'], overlap: ['dimension', 'center', 'size'] });
  for (const key of requiredByKind[kind]!) if (raw[key] === undefined) throw invalid(`play.physics-query ${kind} requires ${key}.`);
  const dimension = raw.dimension === undefined ? undefined : String(raw.dimension);
  if (dimension !== undefined && dimension !== '2d' && dimension !== '3d') throw invalid('Physics query dimension is invalid.');
  return Object.freeze({
    kind,
    ...(dimension === undefined ? {} : { dimension }),
    ...(raw.entityId === undefined ? {} : { entityId: stable(raw.entityId, 'entity id') }),
    ...(raw.origin === undefined ? {} : { origin: normalizeVec3Value(raw.origin, 'origin') as JsonValue }),
    ...(raw.direction === undefined ? {} : { direction: normalizeVec3Value(raw.direction, 'direction') as JsonValue }),
    ...(raw.center === undefined ? {} : { center: normalizeVec3Value(raw.center, 'center') as JsonValue }),
    ...(raw.size === undefined ? {} : { size: normalizePositiveVec3Value(raw.size, 'size') as JsonValue }),
    ...(raw.maxDistance === undefined ? {} : { maxDistance: boundedNumber(raw.maxDistance, 'maxDistance', Number.EPSILON, 1_000_000) }),
    ...(raw.sinceTick === undefined ? {} : { sinceTick: boundedInteger(raw.sinceTick, 'sinceTick', 0, 1_000_000_000) }),
    ...(raw.limit === undefined ? {} : { limit: boundedInteger(raw.limit, 'limit', 1, 256) }),
  });
}

function normalizeVec3Value(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw invalid(`${label} must be an object.`); exact(value, ['x', 'y', 'z'], [], label);
  return Object.freeze({ x: number(value.x, `${label}.x`), y: number(value.y, `${label}.y`), z: number(value.z, `${label}.z`) });
}
function normalizePositiveVec3Value(value: unknown, label: string): JsonObject {
  const result = normalizeVec3Value(value, label) as Readonly<Record<string, number>>;
  if (result.x <= 0 || result.y <= 0 || result.z <= 0) throw invalid(`${label} members must be greater than zero.`);
  return result as unknown as JsonObject;
}

function normalizeEvaluationArguments(raw: Record<string, unknown>): JsonObject {
  exact(raw, ['taskSpec', 'observationIds'], ['acceptanceEvidence', 'budgetStatus', 'usageRecordIds', 'costRecordIds'], 'task.evaluate');
  const ids = (value: unknown, label: string, minimum: number): readonly StableId[] => {
    if (!Array.isArray(value) || value.length < minimum || value.length > 256) throw invalid(`${label} is invalid.`);
    const result = value.map((item) => stable(item, label));
    if (new Set(result).size !== result.length) throw invalid(`${label} must be unique.`);
    return Object.freeze(result);
  };
  if (!isRecord(raw.taskSpec)) throw invalid('taskSpec must be an object.');
  const budgetStatus = raw.budgetStatus === undefined ? 'within' : String(raw.budgetStatus);
  if (!['within', 'soft-exceeded', 'hard-exceeded'].includes(budgetStatus)) throw invalid('budgetStatus is invalid.');
  return Object.freeze({
    taskSpec: jsonObjectValue(raw.taskSpec, 'taskSpec') as JsonValue,
    observationIds: ids(raw.observationIds, 'observationIds', 1), budgetStatus,
    ...(raw.acceptanceEvidence === undefined ? {} : { acceptanceEvidence: jsonObjectValue(raw.acceptanceEvidence, 'acceptanceEvidence') }),
    usageRecordIds: raw.usageRecordIds === undefined ? Object.freeze([]) : ids(raw.usageRecordIds, 'usageRecordIds', 0),
    costRecordIds: raw.costRecordIds === undefined ? Object.freeze([]) : ids(raw.costRecordIds, 'costRecordIds', 0),
  });
}

function buildPreview(toolId: StableId, args: JsonObject, scene: SceneAuthoringService, proposals: ReadonlyMap<StableId, ScriptEditProposal>, plans: ReadonlyMap<StableId, PreviewPlan>): GameToolPreview {
  const raw = args as Record<string, unknown>; const snapshot = scene.snapshot();
  switch (toolId) {
    case 'assembly.create': case 'assembly.instantiate': return preview('组合原型与实例', String(args.assemblyId), `${toolId}: ${args.assemblyId}`, JSON.stringify(args).slice(0, 12000));
    case 'camera.set': return preview('Set camera', snapshot.documentId, 'Replace the main project camera for authoring and game preview.', canonicalStringify(raw.camera as JsonObject));
    case 'camera.author': return preview('Author gameplay camera', String(raw.entityId ?? raw.targetEntityId ?? snapshot.documentId), `${raw.action} gameplay camera state through one recoverable operation.`, `${raw.action}${raw.projection ? ` · ${raw.projection}` : ''}${raw.viewport ? ` · ${canonicalStringify(raw.viewport as JsonObject)}` : ''}`);
    case 'entity.create': return preview('Create entity', snapshot.documentId, `Create ${raw.kind}${raw.name ? ` named ${raw.name}` : ''}.`, `+ ${raw.kind} ${raw.name ?? ''}`.trim());
    case 'entity.create-many': { const count = Array.isArray(raw.entities) ? raw.entities.length : 0; return preview('Create scene entities', snapshot.documentId, `Create ${count} scene entities atomically in one document revision.`, `+ ${count} scene entities`); }
    case 'entity.rename': { const entity = requireEntity(snapshot, raw.entityId as StableId); return preview('Rename entity', entity.id, `Rename ${entity.name} to ${raw.name}.`, `- ${entity.name}\n+ ${raw.name}`); }
    case 'entity.hierarchy': {
      const entity = requireEntity(snapshot, raw.entityId as StableId); const action = String(raw.action);
      const scope = raw.includeDescendants === true ? ' including descendants' : '';
      if (action === 'clone') return preview('Clone entity hierarchy', entity.id, `Clone ${entity.name}${scope} through Document History.`, `+ clone ${entity.id}${raw.parentId !== undefined ? ` under ${raw.parentId ?? 'scene root'}` : ''}`);
      if (action === 'reparent') return preview('Reparent entity', entity.id, `Move ${entity.name} under ${raw.parentId ?? 'the scene root'}.`, `${entity.parentId ?? 'scene root'} → ${raw.parentId ?? 'scene root'}`);
      return preview('Recoverably delete entity hierarchy', entity.id, `Remove ${entity.name}${scope}; Undo restores entities, components and scripts.`, `- ${entity.id}${scope}`);
    }
    case 'prefab.manage': {
      const action = String(raw.action); const prefabId = String(raw.prefabId);
      if (action === 'capture') { const entity = requireEntity(snapshot, raw.entityId as StableId); return preview('Capture project prefab', entity.id, `Capture ${entity.name} and its bounded subtree as ${prefabId}.`, `~ ${prefabId} from ${entity.id}`); }
      if (action === 'instantiate') return preview('Instantiate project prefab', String(raw.parentId ?? snapshot.documentId), `Instantiate ${prefabId} with fresh entity, component and script ids.`, `+ ${prefabId}${raw.parentId !== undefined ? ` under ${raw.parentId ?? 'scene root'}` : ''}`);
      return preview('Remove project prefab', prefabId, `Recoverably remove ${prefabId} from the project registry.`, `- ${prefabId}`);
    }
    case 'transform.set': { const entity = requireEntity(snapshot, raw.entityId as StableId); return preview('Set Transform', entity.id, `Replace Transform for ${entity.name}.`, `${canonicalStringify(entity.transform as unknown as JsonObject)}\n→ ${canonicalStringify(raw.transform as JsonObject)}`); }
    case 'transform.batch': {
      const count = Array.isArray(raw.transforms) ? raw.transforms.length : Array.isArray(raw.entityIds) ? raw.entityIds.length : 0;
      return preview('Batch spatial transform', snapshot.documentId, `${raw.action} ${count} entities in one History transaction.`, `${raw.action} · ${count} entities${raw.axis ? ` · ${raw.axis} axis` : ''}`);
    }
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
    case 'component.configure': {
      const entity = requireEntity(snapshot, raw.entityId as StableId); const action = String(raw.action);
      return preview(`${action === 'remove' ? 'Remove' : 'Configure'} semantic component`, entity.id, `${action} ${raw.type}@${raw.version} on ${entity.name} using the Component Registry.`, `${action === 'remove' ? '-' : '~'} ${raw.type}@${raw.version}${raw.patch ? ` ${canonicalStringify(raw.patch as JsonObject)}` : ''}`);
    }
    case 'asset.generate-texture': { const recipe = raw.recipe as JsonObject; return preview('Draw PNG texture', snapshot.documentId, `Generate a ${recipe.width} × ${recipe.height} PNG with ${(recipe.commands as readonly JsonValue[]).length} drawing commands.`, canonicalStringify(recipe).slice(0, 8192)); }
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
    case 'script.patch': return preview('Patch script lines', String(raw.scriptId ?? raw.entityId), `Validate ${(raw.edits as readonly unknown[]).length} bounded line edit(s) against ${raw.expectedDigest}.`, `patch digest ${sha256(canonicalStringify(raw.edits as JsonValue))}`);
    case 'preview.start': case 'play.start': { const plan = plans.get(raw.planId as StableId); if (!plan) throw new GameToolProtocolError('tool.preview-plan-missing', 'Preview plan is unavailable.'); if (plan.documentRevision !== raw.baseRevision) throw new GameToolProtocolError('tool.stale-revision', 'Preview plan base revision differs.'); return preview('Start trusted preview', plan.documentId, `Start ${plan.scripts.length} trusted project script(s) with ${plan.capabilities.join(', ')}.`, `script-set digest ${plan.scriptSetDigest}`); }
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
  if (!['component.add', 'component.set', 'component.remove', 'component.configure'].includes(definition.id)) return definition;
  let componentDefinition: ComponentDefinitionV2;
  if (definition.id === 'component.configure') {
    const entityId = args.entityId as StableId; const result = workspace.queryGameDocument({ entityId, limit: 256 });
    if (!result.entities[0]) throw new GameToolProtocolError('tool.entity-missing', `Entity ${entityId} does not exist.`);
    componentDefinition = resolveComponentDefinition(workspace, args.type as string, args.version as string);
    const existing = result.components.find((item) => item.type === componentDefinition.type && item.version === componentDefinition.version);
    if (args.action === 'remove') {
      if (!existing) throw new GameToolProtocolError('tool.component-missing', `Entity ${entityId} has no ${componentDefinition.type}@${componentDefinition.version} component.`);
      if (existing.type === 'haiyue.transform.3d') throw new GameToolProtocolError('tool.component-required', 'The required Transform component cannot be removed.');
    } else {
      const value = mergeJsonObjects(existing?.value ?? componentDefinition.defaults, (args.patch ?? {}) as JsonObject);
      if (existing) workspace.componentRegistry.validate({ ...existing, enabled: args.enabled === undefined ? existing.enabled : args.enabled as boolean, value });
      else workspace.componentRegistry.create({ id: asStableId('component:policy-validation'), type: asStableId(componentDefinition.type), version: componentDefinition.version, enabled: args.enabled === undefined ? true : args.enabled as boolean, value });
    }
  } else if (definition.id === 'component.add') {
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
function entitySummary(entity: ReturnType<SceneAuthoringService['snapshot']>['entities'][number], includeComponents = true): JsonObject { return Object.freeze({ id: entity.id, name: entity.name, kind: entity.kind, parentId: entity.parentId, order: entity.order, transform: entity.transform as unknown as JsonValue, ...(includeComponents && entity.components ? { components: entity.components as unknown as JsonValue } : {}), ...(entity.appearance ? { appearance: entity.appearance as unknown as JsonValue } : {}), ...(entity.light ? { light: entity.light as unknown as JsonValue } : {}) }); }
function commandId(callId: StableId): StableId { return asStableId(`command:agent:${sha256(callId).slice(7, 31)}`); }
function normalizedPlane(raw: Record<string, unknown>): JsonObject {
  if (raw.plane === undefined) return {};
  if (raw.kind !== 'plane' || !['xy', 'xz', 'yz'].includes(String(raw.plane))) throw invalid('plane is valid only for plane geometry and must be xy, xz or yz.');
  return { plane: raw.plane as string };
}
// A color map supplies the surface color. New bindings must not inherit the registry's blue swatch.
function textureMaterialDefaults(usage: AssetUsage, entity: Readonly<{ appearance?: Readonly<{ color: readonly number[] }> }>): JsonObject {
  return isPbrTextureUsage(usage) ? Object.freeze({ baseColor: usage === 'texture.base-color' ? Object.freeze([1, 1, 1, 1]) : entity.appearance?.color ?? Object.freeze([1, 1, 1, 1]) }) : Object.freeze({});
}

function historyLabel(toolId: StableId): string | undefined { return ({ 'assembly.create': 'Create Composite Prototype', 'assembly.instantiate': 'Replicate Composite', 'camera.set': 'Set Camera', 'camera.author': 'Author Gameplay Camera', 'entity.create': 'Create Scene Entity', 'entity.create-many': 'Create Scene Entities', 'entity.rename': 'Rename Entity', 'entity.hierarchy': 'Edit Entity Hierarchy', 'prefab.manage': 'Manage Project Prefab', 'transform.set': 'Edit Transform', 'transform.batch': 'Batch Transform', 'material.set': 'Set Material', 'component.add': 'Add Component', 'component.set': 'Set Component', 'component.remove': 'Remove Component', 'component.configure': 'Configure Component', 'asset.generate-texture': 'Draw PNG Texture', 'asset.import': 'Import Asset', 'asset.assign': 'Assign Asset', 'script.apply': 'Edit Entity Script' } as Record<string, string>)[toolId]; }
const callProjects = new WeakMap<GameToolCall, { projectId: StableId; documentId: StableId }>();
function correlation(call: GameToolCall, approvalId?: StableId) {
  const args = call.arguments as Record<string, unknown>;
  return Object.freeze({
    ...callProjects.get(call), sessionId: call.sessionId, turnId: call.turnId, toolCallId: call.id,
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
function number(value: unknown, label: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${label} is invalid.`); return value; }
function boundedNumber(value: unknown, label: string, minimum: number, maximum: number): number { const result = number(value, label); if (result < minimum || result > maximum) throw invalid(`${label} must be between ${minimum} and ${maximum}.`); return result; }
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

function normalizedRoundedBox(raw: Record<string, unknown>): { radius?: number; segments?: number } {
  try { return roundedBoxParameters(raw.kind, raw); } catch (cause) { throw invalid((cause as Error).message); }
}
