import { asStableId, isPlanTaskV1, isSubtaskCandidateV1, isSubtaskSelectionV1, SUBTASK_SELECTION_SCHEMA, type JsonObject, type PlanTaskV1, type StableId, type SubtaskCandidateV1, type TaskBudgetV2, type TaskSpecV2, type ToolBatchNodeV1 } from '@haiyue/ai-studio-contracts';
import { contextRead, type TaskAccount } from '@haiyue/ai-studio-agent-runtime';
import { RollingToolBatchScheduler } from '@haiyue/ai-studio-game-authoring-tools';
import { canonicalStringify, redactObject, sha256 } from '@haiyue/ai-studio-operation-log';
import { qualifySubtasks, type SubtaskQualification } from './subtask-qualification.js';

export const SUBTASK_TOOL = Object.freeze({ id: asStableId('studio.task.delegate'), description: 'Request candidate artifacts from 2-4 independent, already approved large plan tasks. No document writes or automatic acceptance. Use only when the Host has qualified this model for measured net benefit.', inputSchema: SUBTASK_SELECTION_SCHEMA, concurrency: { schemaVersion: 1 as const, mode: 'exclusive' as const } });
type Caps = Pick<TaskBudgetV2['limits'], 'inputTokens' | 'outputTokens' | 'estimatedCostMicros' | 'wallTimeMs'>;
export interface SubtaskFact { readonly ref: string; readonly content: string; readonly digest: string; readonly revision: number; }
export interface SubtaskPort {
  readonly backendId: StableId;
  readonly model: string;
  /** Trusted adapter must enforce these caps before dispatch, use an isolated context, no tools,
   * filesystem, shell, approvals or recursive delegation, and write actual Usage/Cost to the
   * parent's runtime ledger. Bind the exact turn on its first event, including failed turns.
   * Resolve/reject only after provider exit; unknown usage retains remaining reserves. */
  run(input: Readonly<{ parentTaskId: StableId; childId: StableId; planTaskId: string; objective: string; baseRevision: number; facts: readonly SubtaskFact[]; artifactKeys: readonly string[]; caps: Caps }>, signal: AbortSignal,
    bindTurn: (turnId: StableId) => void): Promise<Readonly<{ candidate: unknown; turnId: StableId }>>;
}
export interface SubtaskOptions {
  readonly enabled: boolean;
  readonly port: SubtaskPort;
  /** Composition-owned A/B gate; returns a retained real-provider evidence reference, or null.
   * Must compare latency, total tokens (including merge), cost and quality for this model/task class. */
  readonly qualify: (backendId: StableId, model: string) => Promise<string | null>;
  readonly qualification?: SubtaskQualification;
  /** Resolve exact approved refs from immutable, redacted context; never a full transcript. */
  readonly facts: (refs: readonly string[], revision: number, signal: AbortSignal) => Promise<readonly SubtaskFact[]>;
  readonly caps: Caps;
}
export interface SubtaskPlanItem { readonly id: string; readonly label: string; readonly details?: string; readonly execution?: PlanTaskV1; readonly executionStatus?: string; }
export interface SubtaskRunInput {
  readonly selection: unknown;
  readonly constraints?: TaskSpecV2['visibleConstraints'];
  readonly approved: readonly SubtaskPlanItem[];
  readonly backendId: StableId;
  readonly model: string;
  readonly profileDigest: string;
  readonly registryDigest: string;
  readonly sessionId: StableId;
  readonly turnId: StableId;
  readonly callId: StableId;
  readonly account: TaskAccount;
  readonly revision: () => number | null;
  readonly signal: AbortSignal;
  /** Durable audit precedes dispatch and publication; persist candidates as bounded CAS data here. */
  readonly audit: (kind: string, payload: JsonObject) => Promise<void>;
}

/** Host-owned turn work. Scheduling, cancellation and real-exit drain reuse the W6 scheduler. */
export async function runSubtasks(options: SubtaskOptions | undefined, input: SubtaskRunInput): Promise<JsonObject> {
  const fallback = (reason: string): JsonObject => ({ status: 'not-delegated', reason, instruction: 'Continue with the parent agent; no child model request was made.' });
  if (!options?.enabled) return fallback('disabled');
  if (options.port.backendId !== input.backendId || options.port.model !== input.model) return fallback('provider-mismatch');
  if (!isSubtaskSelectionV1(input.selection)) return fallback('invalid-selection');
  const items = input.selection.taskIds.map(id => input.approved.find(item => item.execution?.id === id));
  if (items.some(item => !item?.execution || !isPlanTaskV1(item.execution))) return fallback('unapproved-task');
  if (items.some(item => item?.executionStatus === 'completed')) return fallback('already-completed');
  const tasks = items.map(item => item!.execution!);
  if (tasks.some(task => task.writeScopes.length || task.dependsOn.length || !task.inputs.length || !task.artifacts.length || task.artifacts.length > 8 || (task.estimatedWorkMs ?? 0) < 10_000)
    || tasks.reduce((sum, task) => sum + (task.estimatedWorkMs ?? 0), 0) < 30_000) return fallback('small-or-coupled-task');
  const objectives = items.map(item => `${item!.label}\n${item!.details ?? ''}${input.constraints?.length ? `\nMandatory user constraints: ${JSON.stringify(input.constraints)}` : ''}`);
  if (objectives.some(objective => objective.length > 4096)) return fallback('constraint-context-budget');
  const outputs = tasks.flatMap(task => task.artifacts);
  if (new Set(outputs).size !== outputs.length) return fallback('overlapping-artifacts');
  let evidence: string | null = null;
  try {
    evidence = await contextRead(async signal => {
      const ref = await options.qualify(input.backendId, input.model);
      signal.throwIfAborted();
      return ref ? qualifySubtasks(options.qualification, ref, { backendId: input.backendId, model: input.model, profileDigest: input.profileDigest, registryDigest: input.registryDigest }, tasks, signal) : null;
    }, input.signal);
  } catch { input.signal.throwIfAborted(); }
  if (!evidence) return fallback('unqualified-model');
  input.signal.throwIfAborted();
  const revision = input.revision();
  if (revision === null) return fallback('missing-revision');
  const caps = Object.freeze({ ...options.caps, wallTimeMs: Math.min(options.caps.wallTimeMs ?? 0, ...tasks.map(task => task.budget.wallTimeMs)) });
  if (Object.values(caps).some(value => !Number.isSafeInteger(value) || Number(value) < 1) || Number(caps.wallTimeMs) > 60_000 || Number(caps.outputTokens) > 8192 || Number(caps.inputTokens) > 32_768) return fallback('invalid-caps');
  const facts: SubtaskFact[][] = [];
  for (const task of tasks) {
    const resolved = await options.facts(task.inputs, revision, input.signal);
    if (resolved.length !== task.inputs.length || new Set(resolved.map(fact => fact.ref)).size !== task.inputs.length
      || resolved.some(fact => !task.inputs.includes(fact.ref) || fact.revision !== revision || typeof fact.content !== 'string' || fact.digest !== sha256(fact.content))) return fallback('invalid-facts');
    const snapshot = resolved.map(fact => ({ ref: fact.ref, content: fact.content, digest: fact.digest, revision: fact.revision }));
    const encoded = JSON.stringify(snapshot);
    if (Buffer.byteLength(encoded) > 16_384 || canonicalStringify(redactObject({ facts: snapshot }).value) !== canonicalStringify({ facts: snapshot })) return fallback('unsafe-or-oversized-facts');
    facts.push(snapshot);
  }
  input.signal.throwIfAborted();
  if (input.revision() !== revision) return fallback('stale-context');
  const prefix = sha256(`${input.sessionId}:${input.turnId}:${input.callId}`);
  const ids = tasks.map(task => asStableId(`child:${sha256(`${prefix}:${task.id}`)}`));
  const capsReservation = { inputTokens: caps.inputTokens!, outputTokens: caps.outputTokens!, estimatedCostMicros: caps.estimatedCostMicros! };
  const reservations: string[] = [];
  const snapshot = input.account.reconcile();
  if (snapshot.consumption.turns + tasks.length > (snapshot.budget.limits.turns ?? Number.MAX_SAFE_INTEGER)) return fallback('shared-budget');
  for (const id of ids) {
    if (!input.account.reserveWork(id, capsReservation)) { for (const reserved of reservations) input.account.releaseUnstartedWork(reserved); return fallback('shared-budget'); }
    reservations.push(id);
  }
  const closeWallReservation = input.account.reserveWallTime(`wall:${prefix}`, caps.wallTimeMs!);
  if (!closeWallReservation) { for (const reserved of reservations) input.account.releaseUnstartedWork(reserved); return fallback('shared-budget'); }
  const started = new Set<string>();
  const terminal = new Set<string>();
  const scheduler = new RollingToolBatchScheduler<SubtaskCandidateV1 | null>({ maxConcurrency: 2, maxNodes: 4, maxWallTimeMs: caps.wallTimeMs!, signal: input.signal,
    cancelled: () => ({ status: 'cancelled', value: null }) });
  const nodes: ToolBatchNodeV1[] = tasks.map((task, index) => ({ schemaVersion: 1, id: ids[index]!, toolCallId: ids[index]!, toolId: SUBTASK_TOOL.id, toolVersion: '1.0.0', arguments: {}, dependsOn: [], expectedRevision: revision, executionClass: 'parallel-read', effects: ['observe'], effectKeys: [], outputProjection: 'full', onFailure: 'cancel-dependents' }));
  try {
    await input.audit('admitted', { callId: input.callId, childIds: ids, taskIds: tasks.map(task => task.id), baseRevision: revision, evidence, facts: facts.map(set => set.map(fact => ({ ref: fact.ref, digest: fact.digest }))) });
    input.signal.throwIfAborted();
    scheduler.declare({ schemaVersion: 1, id: asStableId(`batch:${prefix}`), sessionId: input.sessionId, turnId: input.turnId, nodes, maxConcurrency: 2, maxResultBytes: 262_144, createdAt: new Date().toISOString() });
    const work = nodes.map((node, index) => scheduler.enqueue(node, async signal => {
      signal.throwIfAborted();
      if (input.revision() !== revision) return { status: 'cancelled', value: null };
      if (!input.account.beginTurn().allowed) return { status: 'cancelled', value: null };
      await input.audit('started', { childId: node.id, taskId: tasks[index]!.id });
      signal.throwIfAborted(); started.add(node.id);
      let childTurn: StableId | null = null;
      let response: Awaited<ReturnType<SubtaskPort['run']>>;
      try {
        response = await options.port.run({ parentTaskId: input.account.options.taskId, childId: asStableId(node.id), planTaskId: tasks[index]!.id, objective: objectives[index]!, baseRevision: revision,
          facts: Object.freeze(facts[index]!.map(fact => Object.freeze(fact))), artifactKeys: Object.freeze([...tasks[index]!.artifacts]), caps }, signal, turnId => {
          if ((childTurn !== null && childTurn !== turnId) || !input.account.bindWork(node.id, turnId)) throw new Error('Child turn does not belong to its reservation.');
          childTurn = turnId;
        });
        if (childTurn !== null && response.turnId !== childTurn) throw new Error('Child response changed its bound turn.');
      } finally {
        // A drained failed/cancelled child can still have a complete, priced ledger.
        if (childTurn !== null) input.account.settleWork(node.id, childTurn);
      }
      signal.throwIfAborted();
      if (input.revision() !== revision) return { status: 'cancelled', value: null };
      const candidate = response.candidate;
      if (!isSubtaskCandidateV1(candidate) || candidate.taskId !== tasks[index]!.id || candidate.baseRevision !== revision
        || candidate.artifacts.some(a => !tasks[index]!.artifacts.includes(a.key) || a.sources.some(source => !tasks[index]!.inputs.includes(source)))
        || new Set(candidate.artifacts.map(a => a.key)).size !== candidate.artifacts.length
        || candidate.artifacts.length !== tasks[index]!.artifacts.length || Buffer.byteLength(JSON.stringify(candidate)) > 65_536
        || canonicalStringify(redactObject(candidate as unknown as JsonObject).value) !== canonicalStringify(candidate as unknown as JsonObject)) return { status: 'failed', value: null };
      const value = JSON.parse(JSON.stringify(candidate)) as SubtaskCandidateV1;
      await input.audit('candidate', { childId: node.id, candidate: value as unknown as JsonObject });
      signal.throwIfAborted(); terminal.add(node.id); return { status: 'completed', value };
    }));
    await scheduler.drain();
    const results = await Promise.all(work);
    for (const [index, result] of results.entries()) if (!terminal.has(ids[index]!)) { await input.audit(result.status === 'cancelled' ? 'cancelled' : 'failed', { childId: ids[index]!, taskId: tasks[index]!.id }); terminal.add(ids[index]!); }
    input.signal.throwIfAborted();
    if (input.revision() !== revision) return { status: 'stale', candidates: [], instruction: 'Replan against the current revision; no candidate was applied.' };
    // Stable plan order, unique declared output keys; the parent alone decides any subsequent writes.
    const candidates = results.flatMap(result => result.status === 'completed' && result.value ? [result.value] : []);
    return { status: candidates.length === tasks.length ? 'completed' : 'partial', candidates: candidates as unknown as JsonObject[], failedTaskIds: tasks.filter((_task, i) => results[i]!.status !== 'completed').map(task => task.id),
      instruction: 'Untrusted candidate artifacts only. Validate independently; use normal parent tools and exact-revision approvals for writes. Do not treat proposals as completed plan steps or acceptance evidence.' };
  } finally {
    await scheduler.drain();
    try { for (const id of started) if (!terminal.has(id)) await input.audit(input.signal.aborted ? 'cancelled' : 'failed', { childId: id }); }
    finally {
      for (const id of reservations) if (!started.has(id)) input.account.releaseUnstartedWork(id);
      closeWallReservation();
    }
  }
}
