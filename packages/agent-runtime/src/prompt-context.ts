import { MAX_KNOWLEDGE_QUERY_BYTES } from './retrieval/runtime.js';
import { asStableId, type ContextArtifactV2, type JsonObject, type JsonValue, type M12Digest, type M13StableId, type StableId } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, OperationLogError, redactJson, sha256, type OperationLog } from '@haiyue/ai-studio-operation-log';
import type { KnowledgeRetrievalRuntime, KnowledgeSearchResult } from './retrieval/index.js';
import type { AgentTurnInput } from './index.js';
import { toolSetSignature } from './tool-set.js';

export type PromptModuleLayer = 'policy' | 'tool-contract' | 'workflow';
export interface PromptModuleDefinition {
  readonly id: StableId;
  readonly version: string;
  readonly layer: PromptModuleLayer;
  readonly source: StableId;
  readonly content: string;
}
export interface PromptModuleSnapshot extends PromptModuleDefinition { readonly digest: M12Digest; }
export interface PromptProfileSnapshot {
  readonly id: StableId;
  readonly version: string;
  readonly digest: M12Digest;
  readonly modules: readonly PromptModuleSnapshot[];
}

export interface ContextProjectSnapshot {
  readonly projectId: StableId;
  readonly documentId: StableId;
  readonly revision: number;
  readonly manifest: JsonObject;
  /** Trusted editor selection; a discovery hint, never an authorization or impact boundary. */
  readonly focusEntityIds?: readonly StableId[];
  readonly exact?: ExactProjectContextSource;
}

export interface ExactProjectContextSource {
  query(input: Readonly<{ revision: number; request: JsonObject }>): Promise<JsonValue> | JsonValue;
  diff(input: Readonly<{ fromRevision: number; toRevision: number; request: JsonObject }>): Promise<JsonValue> | JsonValue;
}

export interface ContextCacheMetrics {
  readonly localArtifactHits: number;
  readonly localArtifactMisses: number;
  readonly deltaReuseBytes: number;
  readonly providerCacheEligibleBytes: number;
  readonly providerReportedHitTokens: number | null;
}

export interface PreparedTurnContext {
  readonly prompt: string;
  readonly promptDigest: M12Digest;
  readonly promptProfile: PromptProfileSnapshot;
  readonly contextArtifactIds: readonly StableId[];
  readonly contextDigest: M12Digest;
  readonly cache: ContextCacheMetrics;
  readonly reusedSessionId: StableId | null;
}

export interface VisibleConversationFacts {
  readonly goals?: readonly string[];
  readonly decisions?: readonly string[];
  readonly toolFacts?: readonly string[];
  readonly acceptance?: readonly string[];
  readonly blockers?: readonly string[];
}

export interface CommitConversationInput extends VisibleConversationFacts {
  readonly conversationKey: StableId;
  readonly backendId: StableId;
  readonly taskId: StableId;
  readonly sessionId: StableId;
  readonly turnId: StableId;
  readonly projectId: StableId | null;
  /** Exact tools of a successfully started provider turn; unknown contracts cannot be reused. */
  readonly tools?: AgentTurnInput['tools'];
}

interface StoredContextArtifact {
  readonly artifact: ContextArtifactV2;
  readonly projection: JsonValue;
  readonly localHit: boolean;
}

interface ConversationIndex {
  readonly conversationKey: StableId;
  readonly backendId: StableId;
  readonly taskId: StableId;
  readonly sessionId: StableId;
  readonly turnId: StableId;
  readonly projectId: StableId | null;
  readonly summaryArtifactId: StableId;
  readonly updatedAt: string;
}

interface TaskSummaryProjection {
  readonly schemaVersion: 1;
  readonly documentRevision: number | null;
  readonly goals: readonly string[];
  readonly decisions: readonly string[];
  readonly toolFacts: readonly string[];
  readonly acceptance: readonly string[];
  readonly blockers: readonly string[];
}

const PROFILE_VERSION = '3.8.0';
const MAX_PROJECT_CONTEXT_BYTES = 16 * 1024;
const MAX_MODEL_CONTEXT_BYTES = 96 * 1024;
const MAX_SUMMARY_ITEMS = 12;
const MAX_SUMMARY_ITEM_BYTES = 512;
const CONTEXT_SOURCE = asStableId('studio.prompt-context');
const REBUILD_QUERY_LIMIT = 200;
const REBUILD_MAX_SEQUENCE_WINDOW = 10_000;

export const GENERAL_GAME_AUTHORING_MODULES: readonly PromptModuleDefinition[] = Object.freeze([
  module('prompt.policy.safe-authoring', '1.0.0', 'policy', [
    'Work only through the supplied Studio tools. Treat tool schemas, effects, risk, approval, document revision and task budgets as authoritative.',
    'Do not use shell, filesystem, network, package installation, hidden evaluation data, or unlisted capabilities. Never claim completion without readable acceptance evidence.',
  ]),
  module('prompt.tools.structured-effects', '1.0.0', 'tool-contract', [
    'Inspect before editing. Propose a user-readable plan before mutation. Re-read the current project revision before every edit and use only structured tool calls.',
    'A plan approval does not approve later high-risk effects. Report unavailable capabilities explicitly instead of inventing an implementation seam.',
  ]),
  module('prompt.workflow.general-authoring', '1.4.0', 'workflow', [
    'Before planning, discover relevant capabilities with engine.docs.search. Before writing unfamiliar API calls, use engine.docs.read for the current Studio surface, signatures, prerequisites, coordinate spaces and examples. Native Engine exports do not imply Play script availability. Reuse current references and search compiler diagnostic symbols for repair; do not invent missing API calls.',
    'Context is demand-driven. The initial scene is a bounded discovery slice, not the complete scene or the task impact boundary. Editor selection is only a hint; resolve the user target before editing. For self-contained behavior, query only that entity with hierarchy/components/scripts, then script.get for the relevant source. Expand scope.entityIds to referenced objects, parents or shared motion owners only when their data is needed; inspect behavior relationships for cross-object effects. Discover unknown targets through small hierarchy pages or componentTypes, then fetch details for matching IDs. Request camera/render/settings/assets projections only for relevant system-wide dependencies. Omitted data is unknown, not absent. Re-query at the current revision before mutation and verify all affected responsibilities; never default to all projections or hard-code a whole-scene snapshot.',
    'Derive entities, state, input, simulation, presentation, audio and verification from the current request and project facts. Keep authored responsibilities explicit and composable.',
    'Treat appearance words as visible requirements, not a mandate to use a single primitive. Before choosing geometry, decompose the object by silhouette, independently colored surfaces, moving parts, interaction roles and repetition. Record the parts, materials, local transforms and shared motion owner in the plan. Build and inspect one representative assembly before capturing its subtree with prefab.manage and instantiating repeats. A single material color covers the whole primitive. Preserve explicit implementation constraints, but choose composition when one primitive cannot express the requested appearance.',
    'Verification must exercise real scene/camera transforms and resulting state, not just counters, event labels or HUD text. Use the actual inspected gameplay[index].value payload paths in assertions. play.capture returns a same-tick screenshot/state evidence bundle; evaluate its observations together. Do not invent fps or visual-analysis signals that no available tool produces.',
    'Call play.stop after the final test capture/inspection, also before repairing failed tests. Retain evidence for evaluation.',
    'After changes, run the strongest available repeatable and visual checks, diagnose failures from new evidence, and stop unchanged retries when the repair budget is exhausted.',
  ]),
  module('prompt.workflow.bounded-tool-batch', '1.0.0', 'workflow', [
    'Use Plan → Tool batch → Check. In one assistant step, group independent observations into one bounded tool batch and declare dependencies where a later call consumes an earlier result. Do not invent effects, risk, concurrency safety or approval state; Studio derives them from the tool registry.',
    'After each batch, check authoritative results before the next bounded repair batch. Respect at most 64 nodes, concurrency 4, 60 seconds, 1 MiB model-facing output and 3 repair rounds; never repeat an unchanged failed batch.',
  ]),
]);

const PLAYBOOKS = Object.freeze([
  playbook('prompt.playbook.interaction', /(?:input|keyboard|pointer|mouse|touch|drag|click|control|交互|输入|键盘|鼠标|拖拽|点击)/iu,
    'Map user actions to explicit state transitions. Define focus, repeat, cancellation and invalid-action behavior before implementing feedback. Use Engine interaction hits for object drags, not fixed screen rectangles. Route background drags only when no relevant object is hit. Apply motion to actual entities and the active camera: the editor OrbitControl is not inherited by Play.', '1.1.0'),
  playbook('prompt.playbook.motion', /(?:physics|collision|gravity|velocity|jump|drive|race|move|物理|碰撞|重力|速度|跳跃|移动|驾驶)/iu,
    'Use fixed-step state as authority. Separate simulation, presentation interpolation, collision response and reset conditions; verify with repeatable input replay.'),
  playbook('prompt.playbook.visual-feedback', /(?:visual|camera|light|shadow|particle|effect|animation|画面|相机|灯光|阴影|粒子|特效|动画)/iu,
    'Make framing, hierarchy, contrast and state feedback measurable. Pair structural assertions with captured visual evidence instead of inferring correctness from startup. Basic materials are unlit: dark basic colors remain dark with lights. Use independently colored parts for distinct faces; add lights/environment for lit materials. Inspect one assembly in Play before duplication.', '1.1.0'),
  playbook('prompt.playbook.runtime-repair', /(?:bug|fix|repair|error|crash|diagnostic|修复|错误|崩溃|诊断)/iu,
    'Reproduce first, preserve the failing evidence, change one bounded cause, and capture new evidence. Do not repeat identical actions against unchanged state.'),
]);

export class PromptModuleRegistry {
  private readonly ordered: readonly PromptModuleSnapshot[];
  readonly profile: PromptProfileSnapshot;

  constructor(definitions: readonly PromptModuleDefinition[] = GENERAL_GAME_AUTHORING_MODULES) {
    const ids = new Set<string>();
    this.ordered = Object.freeze(definitions.map((definition) => {
      validateModule(definition);
      if (ids.has(definition.id)) throw new PromptContextError('prompt.module-duplicate', `Prompt module ${definition.id} is duplicated.`);
      ids.add(definition.id);
      return Object.freeze({ ...definition, digest: digest(definition.content) });
    }));
    this.profile = Object.freeze({
      id: asStableId('prompt:game-authoring-general'), version: PROFILE_VERSION,
      digest: digest(canonicalStringify(this.ordered as unknown as JsonValue)), modules: this.ordered,
    });
  }

  stablePrefix(): string {
    return this.ordered.map((entry) => `[${entry.layer}:${entry.id}@${entry.version}]\n${entry.content}`).join('\n\n');
  }

  retrievePlaybooks(request: string): readonly PromptModuleSnapshot[] {
    return Object.freeze(PLAYBOOKS.filter((entry) => entry.pattern.test(request)).map((entry) => Object.freeze({
      id: entry.id, version: entry.version, layer: 'workflow' as const, source: CONTEXT_SOURCE, content: entry.content, digest: digest(entry.content),
    })));
  }
}

/** Durable, provider-neutral context assembler backed by the Operation Log CAS. */
export class PromptContextRuntime {
  readonly prompts: PromptModuleRegistry;
  private readonly metadata = new Map<StableId, ContextArtifactV2>();
  private readonly projectStates = new Map<StableId, ContextProjectSnapshot>();
  private readonly indexes = new Map<string, ConversationIndex>();
  private readonly liveSessions = new Map<string, Readonly<{ sessionId: StableId; toolSignature: string; artifactIds: ReadonlySet<string>; baseline?: ProjectBaseline }>>();
  private readonly pendingContexts = new Map<string, Readonly<{ taskId: StableId; toolSignature: string; reusedSessionId: StableId | null; artifactIds: readonly StableId[]; baseline?: ProjectBaseline }>>();
  private initialized = false;

  constructor(private readonly log: OperationLog, prompts = new PromptModuleRegistry(), private readonly retrieval?: KnowledgeRetrievalRuntime) { this.prompts = prompts; }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.retrieval?.initialize();
    await this.rebuildDurableState();
    this.initialized = true;
  }

  liveSession(conversationKey: StableId, backendId: StableId): StableId | null {
    return this.liveSessions.get(indexKey(conversationKey, backendId))?.sessionId ?? null;
  }

  async prepare(input: Readonly<{
    conversationKey: StableId;
    backendId: StableId;
    taskId: StableId;
    request: string;
    tools: readonly Readonly<{ id: StableId; description: string; inputSchema: JsonObject }>[];
    project: ContextProjectSnapshot | null;
  }>): Promise<PreparedTurnContext> {
    await this.initialize();
    const request = sanitizeText(input.request, 32_768);
    const key = indexKey(input.conversationKey, input.backendId);
    this.pendingContexts.delete(key);
    const liveSession = this.liveSessions.get(key);
    const toolSignature = toolSetSignature(input.tools);
    const reuseSessionId = liveSession?.toolSignature === toolSignature ? liveSession.sessionId : null;
    const knowledge = await this.retrieveKnowledge(request, input.conversationKey, input.project);
    const puts: StoredContextArtifact[] = [];
    puts.push(await this.put('policy', CONTEXT_SOURCE, null, {
      profile: this.prompts.profile, text: this.prompts.stablePrefix(),
    } as unknown as JsonValue));
    puts.push(await this.put('capability-manifest', asStableId('studio.agent-tools'), input.project?.revision ?? null, {
      tools: input.tools.map((tool) => ({ id: tool.id, description: sanitizeText(tool.description, 1024), inputSchemaDigest: digest(canonicalStringify(tool.inputSchema)) })),
    }));

    const summary = summaryForRevision(await this.latestSummary(input.conversationKey, input.backendId), input.project?.revision ?? null);
    puts.push(await this.put('task-summary', CONTEXT_SOURCE, input.project?.revision ?? null, summary as unknown as JsonValue));
    for (const playbook of this.prompts.retrievePlaybooks(request)) {
      puts.push(await this.put('playbook', playbook.id, null, { id: playbook.id, version: playbook.version, digest: playbook.digest, text: playbook.content }));
    }

    let deltaReuseBytes = 0;
    let baseline: ProjectBaseline | undefined;
    if (!input.project) {
      puts.push(await this.put('project-manifest', asStableId('studio.project-context'), null, { state: 'not-required', reason: 'No Studio project is currently open.' }));
    } else {
      const project = input.project;
      const sceneRequest = initialSceneRequest(project);
      const scopeDigest = digest(canonicalStringify(sceneRequest));
      const previous = reuseSessionId ? liveSession?.baseline : undefined;
      const canDiff = previous?.complete && previous.project.projectId === project.projectId
        && previous.project.documentId === project.documentId && previous.scopeDigest === scopeDigest;
      let kind: ContextArtifactV2['kind'] = 'project-manifest';
      let projection: JsonValue;
      let complete = true;
      if (project.exact) {
        let scene: JsonValue | undefined;
        let recovery: string | undefined;
        if (canDiff && previous.project.revision !== project.revision) {
          try {
            scene = await project.exact.diff({ fromRevision: previous.project.revision, toRevision: project.revision, request: sceneRequest });
            if (jsonBytes(scene) > MAX_PROJECT_CONTEXT_BYTES - 2048 || !completeScene(scene)) {
              recovery = 'context.delta-requires-snapshot'; scene = undefined;
            } else kind = 'document-delta';
          } catch (cause) {
            if (!recoverableExactFailure(cause)) throw cause;
            recovery = cause.code;
          }
        }
        const snapshot = scene === undefined ? await boundedSceneQuery(project, sceneRequest) : undefined;
        scene ??= snapshot!.scene;
        complete = completeScene(scene);
        projection = { identity: project.manifest, context: {
          mode: recovery ? 'snapshot-recovery' : kind === 'document-delta' ? 'scoped-delta' : 'discovery-slice',
          ...(recovery ? { diagnostic: recovery } : {}),
          selectionIsHint: true, impactScope: 'unresolved', request: snapshot?.request ?? sceneRequest,
          instruction: 'Resolve task targets and expand through scene.query only as needed. This slice does not prove other objects or dependencies absent.',
        }, scene };
      } else {
        projection = canDiff && previous.project.revision !== project.revision ? projectDelta(previous.project, project) : project.manifest;
        if (canDiff && previous.project.revision !== project.revision) {
          kind = 'document-delta'; deltaReuseBytes = unchangedJsonBytes(previous.project.manifest, project.manifest);
        }
      }
      if (jsonBytes(projection) > MAX_PROJECT_CONTEXT_BYTES) {
        projection = deferredProject(project, sceneRequest, 'context.project-byte-budget');
        kind = 'project-manifest'; complete = false;
      }
      puts.push(await this.put(kind, asStableId('studio.project-context'), project.revision, projection));
      baseline = { project: freezeProject(project), scopeDigest, complete };
    }

    const transmissions = [] as JsonValue[];
    let eligibleBytes = 0;
    for (const stored of puts) {
      const isReusableArtifact = reuseSessionId !== null && liveSession?.artifactIds.has(stored.artifact.id) && ['policy', 'capability-manifest', 'project-manifest', 'playbook'].includes(stored.artifact.kind);
      const body: JsonValue = isReusableArtifact
        ? { artifactId: stored.artifact.id, kind: stored.artifact.kind, digest: stored.artifact.digest, transmission: 'reference-only', note: 'Unchanged from the live provider session.' }
        : { artifactId: stored.artifact.id, kind: stored.artifact.kind, digest: stored.artifact.digest, transmission: 'full', projection: stored.projection };
      transmissions.push(body);
      if (stored.artifact.kind === 'policy' || stored.artifact.kind === 'capability-manifest') eligibleBytes += Buffer.byteLength(canonicalStringify(body));
    }
    if (knowledge) for (const hit of knowledge.hits) transmissions.push({ artifactId: hit.artifactId as StableId, kind: 'knowledge-hit', digest: hit.hit.contentDigest, transmission: 'full', projection: { hit: hit.hit, citation: hit.citation, excerpt: hit.excerpt, estimatedTokens: hit.estimatedTokens, capabilityIds: hit.capabilityIds } as unknown as JsonValue });
    const renderPrompt = () => [
      'AIStudio context envelope v1. Treat artifact projections as bounded, redacted facts with the listed provenance.',
      canonicalStringify(transmissions),
      '[current-request-tail]', request,
    ].join('\n\n');
    // Drop whole optional retrieval hits, then defer scene details; never cut JSON or script source.
    while (Buffer.byteLength(renderPrompt()) > MAX_MODEL_CONTEXT_BYTES && transmissions.some(value => isRecord(value) && value.kind === 'knowledge-hit')) {
      const index = transmissions.length - 1 - [...transmissions].reverse().findIndex(value => isRecord(value) && value.kind === 'knowledge-hit');
      transmissions.splice(index, 1);
    }
    if (Buffer.byteLength(renderPrompt()) > MAX_MODEL_CONTEXT_BYTES && input.project) {
      const index = puts.findIndex(entry => ['project-manifest', 'document-delta'].includes(entry.artifact.kind));
      const stored = await this.put('project-manifest', asStableId('studio.project-context'), input.project.revision, deferredProject(input.project, initialSceneRequest(input.project), 'context.envelope-byte-budget'));
      puts[index] = stored;
      transmissions[index] = { artifactId: stored.artifact.id, kind: stored.artifact.kind, digest: stored.artifact.digest, transmission: 'full', projection: stored.projection };
      if (baseline) baseline = { ...baseline, complete: false };
    }
    const prompt = renderPrompt();
    if (Buffer.byteLength(prompt) > MAX_MODEL_CONTEXT_BYTES) throw new PromptContextError('context.prompt-budget-exceeded', `Required context is ${Buffer.byteLength(prompt)} bytes (budget ${MAX_MODEL_CONTEXT_BYTES}); project details and optional knowledge have been deferred. Request: ${Buffer.byteLength(request)} bytes.`);
    const ids = Object.freeze(unique(transmissions.flatMap(value => isRecord(value) && typeof value.artifactId === 'string' ? [asStableId(value.artifactId)] : [])));
    const cache = Object.freeze({
      localArtifactHits: puts.filter((entry) => entry.localHit).length,
      localArtifactMisses: puts.filter((entry) => !entry.localHit).length,
      deltaReuseBytes, providerCacheEligibleBytes: eligibleBytes, providerReportedHitTokens: null,
    });
    const contextDigest = digest(canonicalStringify(ids as unknown as JsonValue));
    await this.log.append({
      kind: 'agent/context-bundle-prepared', severity: 'info', source: CONTEXT_SOURCE,
      payload: { taskId: input.taskId, backendId: input.backendId, conversationKey: input.conversationKey, contextArtifactIds: ids, contextDigest, promptDigest: digest(prompt), promptBytes: Buffer.byteLength(prompt), reusedSessionId: reuseSessionId, sessionReuse: reuseSessionId ? 'same-tool-contract' : liveSession ? 'tool-contract-changed' : 'no-live-contract', toolSignature, cache },
      artifactRefs: ids,
    });
    if (input.project) this.projectStates.set(input.project.projectId, freezeProject(input.project));
    this.pendingContexts.set(key, { taskId: input.taskId, toolSignature, reusedSessionId: reuseSessionId, artifactIds: ids, ...(baseline ? { baseline } : {}) });
    return Object.freeze({ prompt, promptDigest: digest(prompt), promptProfile: this.prompts.profile, contextArtifactIds: ids, contextDigest, cache, reusedSessionId: reuseSessionId });
  }

  async assertReadable(ids: readonly StableId[]): Promise<void> {
    if (ids.length === 0) throw new PromptContextError('context.artifacts-required', 'Every model turn requires at least one context artifact.');
    for (const id of unique(ids)) {
      const metadata = this.metadata.get(id);
      if (!metadata) { if (this.retrieval) { await this.retrieval.assertReadable([id]); continue; } throw new PromptContextError('context.artifact-not-approved', `Artifact ${id} was not created by the approved context projection path.`); }
      const record = await this.log.readArtifact(id);
      if (`sha256:${record.digest}` !== metadata.digest || record.bytes !== metadata.byteLength) throw new PromptContextError('context.artifact-integrity', `Artifact ${id} metadata no longer matches its CAS object.`);
    }
  }

  async commit(input: CommitConversationInput): Promise<ContextArtifactV2> {
    await this.initialize();
    const previous = await this.latestSummary(input.conversationKey, input.backendId);
    const summary: TaskSummaryProjection = Object.freeze({
      schemaVersion: 1, documentRevision: this.projectRevision(input.projectId),
      goals: mergeSummary(previous.goals, input.goals), decisions: mergeSummary(previous.decisions, input.decisions),
      toolFacts: mergeSummary(previous.toolFacts, input.toolFacts), acceptance: mergeSummary(previous.acceptance, input.acceptance),
      blockers: mergeSummary(previous.blockers, input.blockers),
    });
    const stored = await this.put('task-summary', CONTEXT_SOURCE, this.projectRevision(input.projectId), summary as unknown as JsonValue);
    const updatedAt = new Date().toISOString();
    const index: ConversationIndex = Object.freeze({
      conversationKey: input.conversationKey, backendId: input.backendId, taskId: input.taskId, sessionId: input.sessionId, turnId: input.turnId,
      projectId: input.projectId, summaryArtifactId: asStableId(stored.artifact.id), updatedAt,
    });
    this.indexes.set(indexKey(input.conversationKey, input.backendId), index);
    const key = indexKey(input.conversationKey, input.backendId);
    const pending = this.pendingContexts.get(key);
    const signature = input.tools ? toolSetSignature(input.tools) : null;
    if (pending?.taskId === input.taskId && signature === pending.toolSignature) {
      const prior = this.liveSessions.get(key);
      const inherited = pending.reusedSessionId === input.sessionId && prior?.sessionId === input.sessionId ? [...prior.artifactIds] : [];
      this.liveSessions.set(key, Object.freeze({ sessionId: input.sessionId, toolSignature: signature!, artifactIds: new Set([...inherited, ...pending.artifactIds]), ...(pending.baseline ? { baseline: pending.baseline } : {}) }));
    } else this.liveSessions.delete(key);
    this.pendingContexts.delete(key);
    await this.log.append({
      kind: 'agent/conversation-indexed', severity: 'info', source: CONTEXT_SOURCE,
      correlation: { sessionId: input.sessionId, turnId: input.turnId, ...(input.projectId ? { projectId: input.projectId } : {}) },
      payload: { ...index, summaryDigest: stored.artifact.digest }, artifactRefs: [asStableId(stored.artifact.id)],
    });
    await this.retrieval?.indexSessionDecision({
      sessionId: input.sessionId as M13StableId, turnId: input.turnId as M13StableId,
      permissionScope: conversationPermission(input.conversationKey) as M13StableId,
      projectRevision: null, summary: summary as unknown as JsonObject,
    });
    return stored.artifact;
  }

  private async retrieveKnowledge(request: string, conversationKey: StableId, project: ContextProjectSnapshot | null): Promise<KnowledgeSearchResult | null> {
    if (!this.retrieval || !request.trim()) return null;
    const query = boundedKnowledgeQuery(request);
    if (query !== request) await this.log.append({
      kind: 'knowledge/query-bounded', severity: 'info', source: CONTEXT_SOURCE,
      payload: { strategy: 'utf8-head-tail-v1', requestBytes: Buffer.byteLength(request), queryBytes: Buffer.byteLength(query) },
    });
    const scopes = [asStableId('knowledge:engine-local'), conversationPermission(conversationKey), ...(project ? [projectPermission(project.projectId)] : [])];
    return this.retrieval.search({ query, allowedPermissionScopes: scopes as M13StableId[], projectRevision: project?.revision ?? null, limit: 8, tokenBudget: 2_048 });
  }

  private async put(kind: ContextArtifactV2['kind'], source: StableId, documentRevision: number | null, projection: JsonValue): Promise<StoredContextArtifact> {
    const result = await this.log.putArtifactDetailed(projection, { schemaVersion: 'context-artifact/2', pluginVersion: PROFILE_VERSION });
    const artifact: ContextArtifactV2 = Object.freeze({
      schemaVersion: 2, id: result.reference.id, kind, digest: `sha256:${result.reference.digest}` as M12Digest, source, documentRevision,
      mediaType: result.reference.mediaType, byteLength: result.reference.bytes, redacted: result.reference.redactedFields.length > 0, createdAt: result.reference.createdAt,
    });
    this.metadata.set(asStableId(artifact.id), artifact);
    await this.log.append({
      kind: result.localHit ? 'agent/context-artifact-reused' : 'agent/context-artifact-created', severity: 'info', source: CONTEXT_SOURCE,
      payload: { artifact: artifact as unknown as JsonObject, localCasHit: result.localHit }, artifactRefs: [asStableId(artifact.id)],
    });
    const record = await this.log.readArtifact(asStableId(artifact.id));
    return Object.freeze({ artifact, projection: record.value, localHit: result.localHit });
  }

  private async latestSummary(conversationKey: StableId, backendId: StableId): Promise<TaskSummaryProjection> {
    const current = this.indexes.get(indexKey(conversationKey, backendId));
    if (!current) return emptySummary();
    const record = await this.log.readArtifact(current.summaryArtifactId);
    return validateSummary(record.value);
  }

  private projectRevision(projectId: StableId | null): number | null { return projectId ? this.projectStates.get(projectId)?.revision ?? null : null; }

  private async rebuildDurableState(): Promise<void> {
    const status = this.log.status();
    const untilSequence = status.nextSequence;
    let afterSequence = Math.max(-1, untilSequence - status.eventCount - 1);
    let windowSize = Math.max(1, Math.min(REBUILD_MAX_SEQUENCE_WINDOW, untilSequence - afterSequence - 1));
    while (afterSequence < untilSequence - 1) {
      const beforeSequence = Math.min(untilSequence, afterSequence + windowSize + 1);
      let cursor: string | undefined;
      try {
        do {
          const page = await this.log.query({
            kinds: ['agent/context-artifact-created', 'agent/context-artifact-reused', 'agent/conversation-indexed'],
            ...(afterSequence >= 0 ? { afterSequence } : {}), beforeSequence, limit: REBUILD_QUERY_LIMIT, traverseCorrelation: false,
            ...(cursor ? { cursor } : {}),
          });
          for (const event of page.events) {
            if (event.kind === 'agent/conversation-indexed') {
              const value = parseConversationIndex(event.payload, event.artifactRefs);
              this.indexes.set(indexKey(value.conversationKey, value.backendId), value);
            } else {
              const artifact = parseContextArtifact(event.payload.artifact, event.artifactRefs);
              this.metadata.set(asStableId(artifact.id), artifact);
            }
          }
          cursor = page.nextCursor;
        } while (cursor);
        afterSequence = beforeSequence - 1;
      } catch (cause) {
        if (!(cause instanceof OperationLogError) || cause.code !== 'query-scan-budget-exceeded' || windowSize === 1) throw cause;
        windowSize = Math.max(1, Math.floor(windowSize / 2));
      }
    }
  }
}

interface ProjectBaseline {
  readonly project: ContextProjectSnapshot;
  readonly scopeDigest: M12Digest;
  readonly complete: boolean;
}

function initialSceneRequest(project: ContextProjectSnapshot): JsonObject {
  const focus = unique(project.focusEntityIds ?? []).sort().slice(0, 8);
  return focus.length ? { scope: { entityIds: focus }, projection: ['hierarchy', 'components', 'scripts'], limit: 64 }
    : { projection: ['hierarchy'], limit: 32 };
}
function jsonBytes(value: JsonValue): number { return Buffer.byteLength(canonicalStringify(value)); }
function completeScene(value: JsonValue): boolean {
  if (!isRecord(value) || value.deferred === true) return false;
  const page = isRecord(value.diff) ? value.diff : value;
  return page.truncated !== true && !page.nextCursor;
}
async function boundedSceneQuery(project: ContextProjectSnapshot, initial: JsonObject): Promise<{ scene: JsonValue; request: JsonObject }> {
  let request = initial;
  for (;;) {
    const scene = await project.exact!.query({ revision: project.revision, request });
    if (jsonBytes(scene) <= MAX_PROJECT_CONTEXT_BYTES - 2048) return { scene, request };
    const limit = request.limit as number;
    if (limit <= 1) return { scene: { deferred: true, reason: 'context.single-item-byte-budget', documentId: project.documentId, revision: project.revision,
      instruction: 'Query hierarchy or scripts metadata first, then only the required componentTypes or script.get. No items were supplied; restart with this request and a narrower projection, not its nextCursor.' }, request };
    request = { ...request, limit: Math.max(1, Math.floor(limit / 2)) };
  }
}
function deferredProject(project: ContextProjectSnapshot, request: JsonObject, reason: string): JsonObject {
  return { projectId: project.projectId, documentId: project.documentId, revision: project.revision, deferred: true, reason, request,
    instruction: 'Scene details were omitted, not empty. Use project.snapshot for identity and scene.query with this revision, narrowed scope/projection and a small page; fetch script source only via script.get.' };
}

export class PromptContextError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'PromptContextError'; } }

function module(id: string, version: string, layer: PromptModuleLayer, lines: readonly string[]): PromptModuleDefinition {
  return Object.freeze({ id: asStableId(id), version, layer, source: CONTEXT_SOURCE, content: lines.join(' ') });
}
function playbook(id: string, pattern: RegExp, content: string, version = '1.0.0'): Readonly<{ id: StableId; version: string; pattern: RegExp; content: string }> { return Object.freeze({ id: asStableId(id), version, pattern, content }); }
function validateModule(value: PromptModuleDefinition): void {
  if (!/^\d+\.\d+\.\d+$/u.test(value.version) || !value.content.trim() || Buffer.byteLength(value.content) > 8192) throw new PromptContextError('prompt.module-invalid', `Prompt module ${value.id} is invalid.`);
}
function digest(value: string): M12Digest { return `sha256:${sha256(value)}` as M12Digest; }
function sanitizeText(value: string, maximumBytes: number): string {
  const safe = redactJson(value).value;
  const text = typeof safe === 'string' ? safe : '[REDACTED]';
  if (Buffer.byteLength(text) <= maximumBytes) return text;
  let end = Math.min(text.length, maximumBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > maximumBytes) end -= 1;
  return `${text.slice(0, Math.max(0, end - 16))}\n[TRUNCATED]`;
}
function projectDelta(previous: ContextProjectSnapshot, current: ContextProjectSnapshot): JsonObject {
  const before = previous.manifest; const after = current.manifest; const changed: Record<string, JsonValue> = {};
  const removed: string[] = [];
  for (const key of Object.keys(before).sort()) if (!Object.hasOwn(after, key)) removed.push(key);
  for (const [key, value] of Object.entries(after).sort(([a], [b]) => a.localeCompare(b))) {
    const delta = Object.hasOwn(before, key) ? jsonDelta(before[key]!, value) : Object.freeze({ op: 'add', value });
    if (delta !== undefined) changed[key] = delta;
  }
  return Object.freeze({ schemaVersion: 1, projectId: current.projectId, documentId: current.documentId, fromRevision: previous.revision, toRevision: current.revision, changed: Object.freeze(changed), removed: Object.freeze(removed) });
}
function jsonDelta(before: JsonValue, after: JsonValue): JsonValue | undefined {
  if (canonicalStringify(before) === canonicalStringify(after)) return undefined;
  if (Array.isArray(before) && Array.isArray(after) && [...before, ...after].every((entry) => isRecord(entry) && typeof entry.id === 'string')) {
    const oldById = new Map(before.map((entry) => [(entry as Record<string, JsonValue>).id as string, entry]));
    const newById = new Map(after.map((entry) => [(entry as Record<string, JsonValue>).id as string, entry]));
    const added = [...newById].filter(([id]) => !oldById.has(id)).map(([, value]) => value);
    const removed = [...oldById.keys()].filter((id) => !newById.has(id)).sort();
    const updated = [...newById].flatMap(([id, value]) => {
      const old = oldById.get(id); if (!old) return [];
      const delta = jsonDelta(old, value); return delta === undefined ? [] : [{ id, delta }];
    });
    return Object.freeze({ op: 'array-by-id', added: Object.freeze(added), updated: Object.freeze(updated), removed: Object.freeze(removed) });
  }
  if (isRecord(before) && isRecord(after)) {
    const changed: Record<string, JsonValue> = {}; const removed: string[] = [];
    for (const key of Object.keys(before).sort()) if (!Object.hasOwn(after, key)) removed.push(key);
    for (const [key, value] of Object.entries(after).sort(([a], [b]) => a.localeCompare(b))) {
      const delta = Object.hasOwn(before, key) ? jsonDelta(before[key]!, value) : Object.freeze({ op: 'add', value });
      if (delta !== undefined) changed[key] = delta;
    }
    return Object.freeze({ op: 'object', changed: Object.freeze(changed), removed: Object.freeze(removed) });
  }
  return Object.freeze({ op: 'replace', value: after });
}
function unchangedJsonBytes(before: JsonValue, after: JsonValue): number {
  if (canonicalStringify(before) === canonicalStringify(after)) return Buffer.byteLength(canonicalStringify(after));
  if (Array.isArray(before) && Array.isArray(after) && [...before, ...after].every((entry) => isRecord(entry) && typeof entry.id === 'string')) {
    const oldById = new Map(before.map((entry) => [(entry as Record<string, JsonValue>).id as string, entry]));
    return after.reduce((sum, entry) => sum + (oldById.has((entry as Record<string, JsonValue>).id as string) ? unchangedJsonBytes(oldById.get((entry as Record<string, JsonValue>).id as string)!, entry) : 0), 0);
  }
  if (isRecord(before) && isRecord(after)) return Object.entries(after).reduce((sum, [key, value]) => sum + (Object.hasOwn(before, key) ? unchangedJsonBytes(before[key]!, value) : 0), 0);
  return 0;
}
function freezeProject(value: ContextProjectSnapshot): ContextProjectSnapshot { return Object.freeze({ ...value, manifest: Object.freeze({ ...value.manifest }) }); }
function recoverableExactFailure(value: unknown): value is Readonly<{ code: string; recoverable: true }> { return value !== null && typeof value === 'object' && 'code' in value && typeof (value as { code?: unknown }).code === 'string' && 'recoverable' in value && (value as { recoverable?: unknown }).recoverable === true; }
function mergeSummary(previous: readonly string[], additions: readonly string[] | undefined): readonly string[] {
  const values = [...previous, ...(additions ?? []).map((item) => sanitizeText(item, MAX_SUMMARY_ITEM_BYTES)).filter(Boolean)];
  return Object.freeze(unique(values).slice(-MAX_SUMMARY_ITEMS));
}
function emptySummary(): TaskSummaryProjection { return Object.freeze({ schemaVersion: 1, documentRevision: null, goals: Object.freeze([]), decisions: Object.freeze([]), toolFacts: Object.freeze([]), acceptance: Object.freeze([]), blockers: Object.freeze([]) }); }
function validateSummary(value: JsonValue): TaskSummaryProjection {
  if (!isRecord(value) || value.schemaVersion !== 1 || (value.documentRevision !== null && (!Number.isSafeInteger(value.documentRevision) || (value.documentRevision as number) < 0))) throw new PromptContextError('context.summary-invalid', 'Durable task summary is invalid.');
  const result: Record<string, readonly string[]> = {};
  for (const key of ['goals', 'decisions', 'toolFacts', 'acceptance', 'blockers']) {
    const member = value[key]; if (!Array.isArray(member) || member.some((item) => typeof item !== 'string')) throw new PromptContextError('context.summary-invalid', `Task summary ${key} is invalid.`);
    result[key] = Object.freeze(member.slice(-MAX_SUMMARY_ITEMS) as string[]);
  }
  return Object.freeze({ schemaVersion: 1, documentRevision: value.documentRevision as number | null, goals: result.goals!, decisions: result.decisions!, toolFacts: result.toolFacts!, acceptance: result.acceptance!, blockers: result.blockers! });
}
function summaryForRevision(value: TaskSummaryProjection, revision: number | null): TaskSummaryProjection {
  if (value.documentRevision === null || value.documentRevision === revision) return Object.freeze({ ...value, documentRevision: revision });
  return Object.freeze({ schemaVersion: 1, documentRevision: revision, goals: value.goals, decisions: value.decisions, toolFacts: Object.freeze([]), acceptance: Object.freeze([]), blockers: Object.freeze([...value.blockers, `Project revision changed from ${value.documentRevision} to ${revision}; prior revision-bound tool facts and acceptance were invalidated.`].slice(-MAX_SUMMARY_ITEMS)) });
}
function parseConversationIndex(payload: JsonObject, artifactRefs: readonly StableId[]): ConversationIndex {
  const required = ['conversationKey', 'backendId', 'taskId', 'sessionId', 'turnId', 'summaryArtifactId', 'updatedAt'] as const;
  if (required.some((key) => typeof payload[key] !== 'string') || !artifactRefs.includes(payload.summaryArtifactId as StableId)) throw new PromptContextError('context.index-invalid', 'Durable conversation index is invalid.');
  return Object.freeze({
    conversationKey: asStableId(payload.conversationKey as string), backendId: asStableId(payload.backendId as string), taskId: asStableId(payload.taskId as string),
    sessionId: asStableId(payload.sessionId as string), turnId: asStableId(payload.turnId as string), projectId: typeof payload.projectId === 'string' ? asStableId(payload.projectId) : null,
    summaryArtifactId: asStableId(payload.summaryArtifactId as string), updatedAt: payload.updatedAt as string,
  });
}
function parseContextArtifact(value: JsonValue | undefined, artifactRefs: readonly StableId[]): ContextArtifactV2 {
  if (!isRecord(value) || value.schemaVersion !== 2 || typeof value.id !== 'string' || !artifactRefs.includes(asStableId(value.id)) || !['policy', 'capability-manifest', 'project-manifest', 'document-delta', 'task-summary', 'playbook'].includes(String(value.kind))
    || typeof value.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.digest) || typeof value.source !== 'string' || (value.documentRevision !== null && (!Number.isSafeInteger(value.documentRevision) || (value.documentRevision as number) < 0))
    || value.mediaType !== 'application/json' || !Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0 || (value.byteLength as number) > 512 * 1024 || typeof value.redacted !== 'boolean' || typeof value.createdAt !== 'string') {
    throw new PromptContextError('context.artifact-metadata-invalid', 'Durable context artifact metadata is invalid.');
  }
  return Object.freeze({ ...value }) as unknown as ContextArtifactV2;
}
function indexKey(conversationKey: StableId, backendId: StableId): string { return `${conversationKey}\0${backendId}`; }
function conversationPermission(conversationKey: StableId): StableId { return asStableId(`knowledge:conversation:${sha256(conversationKey).slice(0, 24)}`); }
function projectPermission(projectId: StableId): StableId { return asStableId(`knowledge:project:${sha256(projectId).slice(0, 24)}`); }
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
function isRecord(value: unknown): value is Record<string, JsonValue> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

/** Retrieval gets bounded excerpts; the full sanitized request remains in the model envelope. */
function boundedKnowledgeQuery(request: string): string {
  if (Buffer.byteLength(request) <= MAX_KNOWLEDGE_QUERY_BYTES) return request;
  const trimmed = request.trim();
  if (Buffer.byteLength(trimmed) <= MAX_KNOWLEDGE_QUERY_BYTES) return trimmed;
  const characters = Array.from(trimmed);
  const headBudget = Math.floor((MAX_KNOWLEDGE_QUERY_BYTES - 1) / 2);
  const tailBudget = MAX_KNOWLEDGE_QUERY_BYTES - 1 - headBudget;
  let head = ''; let tail = ''; let bytes = 0;
  for (const character of characters) {
    bytes += Buffer.byteLength(character);
    if (bytes > headBudget) break;
    head += character;
  }
  bytes = 0;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    bytes += Buffer.byteLength(character);
    if (bytes > tailBudget) break;
    tail = character + tail;
  }
  return `${head} ${tail}`;
}
