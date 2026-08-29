import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentPreviewBroker } from '../dist/agent-preview-broker.js';
import { StudioConversationHost } from '../dist/conversation-host.js';
import { selectProjectRunScript } from '../dist/run-script-selection.js';
import { TaskAccountingRegistry, UsageLedgerStore } from '@haiyue/ai-studio-agent-runtime';

const backendId = 'backend:test-agent';
const sessionId = 'session:test-agent';
const turnId = 'turn:test-agent';
const toolCallId = 'tool-call:test-agent';
const planToolCallId = 'tool-call:plan-test-agent';
const approvalId = 'approval:test-agent';

test('G10 conversation host runs typed tools through scoped approval and replay', async () => {
  let submitted;
  let startedInput;
  let openedHandoff;
  let releaseTool;
  let releasePlan;
  const toolReleased = new Promise((resolve) => { releaseTool = resolve; });
  const planReleased = new Promise((resolve) => { releasePlan = resolve; });
  const backend = {
    descriptor: { id: backendId, kind: 'harness-api-key', protocolVersion: 'fixture', capabilities: {} },
    async modelCatalog() { return modelCatalog(); },
    async status() { return { state: 'ready', authMode: 'api-key', rateLimits: [] }; },
    async authenticate() { return { id: 'login:test-agent', kind: 'browser', url: 'https://example.invalid/login' }; }, async logout() {}, async cancelTurn() {}, async dispose() {},
    async submitToolResult(id, result) { if (id === planToolCallId) releasePlan(); else { submitted = result; releaseTool(); } },
    async answerQuestion() {}, async resolveBackendApproval() {},
  };
  const context = contextFixture();
  const runtime = {
    context,
    accounting: accountingFixture(),
    registry: { descriptors: () => [backend.descriptor], get: () => backend },
    turns: {
      async *start(_backendId, input) {
        startedInput = input;
        yield event('status', { status: 'running' });
        yield event('tool-request', { toolCallId: planToolCallId, toolId: 'studio.plan.propose', arguments: {
          title: 'Player scene plan', summary: 'Create one independently editable player entity.',
          items: [{ label: 'Create Player', details: 'One cube entity owns the visible player geometry and Transform.' }],
        } });
        await planReleased;
        yield event('tool-request', { toolCallId, toolId: 'entity.create', arguments: { baseRevision: 1, kind: 'cube', name: 'Player' } });
        await toolReleased;
        yield event('conversation-node', { nodeKind: 'text', status: 'streaming', delta: 'Created the Player cube.' });
        yield event('completed', { status: 'completed' });
      },
      async *resume() {}, async cancel() {}, async recordToolResult() {},
    },
  };
  let decision;
  const tools = {
    definitions: () => [{ id: 'entity.create', description: 'Create entity', effect: 'reversible-edit', risk: 'medium', inputSchema: {} }],
    async prepare() { return { id: 'preparation:test-agent', callId: toolCallId, sessionId, turnId, toolId: 'entity.create', toolVersion: '1.0.0', effect: 'reversible-edit', risk: 'medium', documentId: 'document:test', baseRevision: 1, argumentsDigest: digest('a'), previewDigest: digest('b'), preview: { title: 'Create', target: 'Scene', summary: 'Create Player cube', diff: '+ Player' }, status: 'approval-required', approvalId }; },
    approval() { return { schemaVersion: 1, approvalId, preparationId: 'preparation:test-agent', toolCallId, toolId: 'entity.create', toolVersion: '1.0.0', effect: 'reversible-edit', risk: 'medium', argumentsDigest: digest('a'), previewDigest: digest('b'), documentId: 'document:test', baseRevision: 1, target: 'Scene', decision: 'pending' }; },
    async decide(_id, value) { decision = value; return { ...this.approval(), decision: value }; },
    async execute() { return { schemaVersion: 1, callId: toolCallId, toolId: 'entity.create', status: 'completed', value: { entityId: 'entity:player' }, documentId: 'document:test', beforeRevision: 1, afterRevision: 2, historyLabel: 'Create Cube/Empty' }; },
  };
  const logEvents = [];
  const host = new StudioConversationHost({
    runtime, tools, operationLog: { async append(value) { logEvents.push(value); } },
    isProjectOpen: () => true, projectContext: projectContextFixture,
    async openLoginHandoff(id, handoff) { openedHandoff = { id, handoff }; },
  });
  await host.initialize();
  const observedBusy = [];
  const subscription = host.subscribe(() => observedBusy.push(host.replay().busy));
  assert.equal(host.replay().backendId, backendId);
  await host.dispatch({ type: 'backend/authenticate', backendId });
  assert.deepEqual(openedHandoff, { id: backendId, handoff: { id: 'login:test-agent', kind: 'browser', url: 'https://example.invalid/login' } });
  await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Create a Player cube' });
  await waitFor(() => nodes(host).some((node) => node.kind === 'plan' && node.status === 'pending'));
  const pendingPlan = nodes(host).find((node) => node.kind === 'plan' && node.status === 'pending');
  await host.dispatch({ type: 'conversation/accept-plan', nodeId: pendingPlan.id, acceptedItemIds: pendingPlan.content.items.map((item) => item.id), mode: 'approve' });
  await waitFor(() => nodes(host).some((node) => node.kind === 'approval' && node.status === 'pending'));
  await host.dispatch({ type: 'conversation/resolve-approval', approvalId, decision: 'allow-always' });
  await waitFor(() => host.replay().busy === false);
  assert.equal(decision, 'allow-always');
  assert.match(startedInput.prompt, /AIStudio context envelope/);
  assert.match(startedInput.prompt, /"projectRevision":1/);
  assert.match(startedInput.prompt, /\[current-request-tail\]\nCreate a Player cube$/);
  assert.ok(startedInput.contextArtifactIds.length > 0);
  assert.equal(startedInput.contextCache.providerReportedHitTokens, null);
  assert.doesNotMatch(startedInput.prompt, /SnakeBody|snake body segment|贪吃蛇/iu);
  assert.equal(context.commits.length, 1);
  assert.ok(context.commits[0].toolFacts.some((fact) => fact.includes('entity.create')));
  assert.equal(submitted.status, 'completed');
  assert.ok(startedInput.tools.some((tool) => tool.id === 'studio.plan.propose'));
  assert.ok(nodes(host).some((node) => node.kind === 'plan' && node.status === 'completed' && node.content.decision === 'approved'));
  assert.ok(nodes(host).some((node) => node.kind === 'approval' && node.status === 'completed'));
  const approvalNode = nodes(host).find((node) => node.kind === 'approval');
  assert.equal(approvalNode.content.argsDigest, `sha256:${'a'.repeat(64)}`);
  assert.equal(approvalNode.content.previewDigest, `sha256:${'b'.repeat(64)}`);
  assert.equal(approvalNode.content.expiresAt, undefined);
  assert.ok(nodes(host).some((node) => node.kind === 'tool-result' && node.status === 'completed'));
  const toolResult = nodes(host).find((node) => node.kind === 'tool-result' && node.status === 'completed' && node.content.toolId === 'entity.create');
  assert.match(toolResult.content.summary, /已创建/);
  assert.match(toolResult.content.details, /entity:player/);
  assert.ok(nodes(host).some((node) => node.kind === 'text' && node.content.text.includes('Player cube')));
  const completion = nodes(host).find((node) => node.kind === 'completion' && node.content.terminalStatus === 'completed');
  assert.ok(completion);
  assert.match(completion.content.summary, /Completed: entity\.create:/);
  assert.match(completion.content.summary, /Incomplete or blocked: none/);
  assert.ok(nodes(host).some((node) => node.kind === 'text' && node.content.role === 'user' && node.content.text === 'Create a Player cube'));
  assert.ok(nodes(host).some((node) => node.kind === 'progress' && node.content.phase === 'awaiting-first-step' && node.status === 'completed'));
  assert.ok(observedBusy.includes(true));
  assert.equal(observedBusy.at(-1), false);
  assert.ok(logEvents.some((item) => item.kind === 'conversation/intent' && item.payload.promptDigest && !JSON.stringify(item).includes('Create a Player cube')));
  await assert.rejects(host.dispatch({ type: 'conversation/resolve-approval', approvalId, decision: 'allow-always' }), /stale|already resolved/);
  subscription.dispose();
  await host.dispose();
  await host.dispose();
});

test('an approved plan that ends without edits continues once and executes without asking for the same plan again', async () => {
  let starts = 0;
  let planReleased;
  let editReleased;
  let executeCount = 0;
  let continuationInput;
  const waitForPlanResult = new Promise((resolve) => { planReleased = resolve; });
  const waitForEditResult = new Promise((resolve) => { editReleased = resolve; });
  const secondSessionId = 'session:approved-continuation';
  const secondTurnId = 'turn:approved-continuation';
  const backend = {
    descriptor: { id: backendId, kind: 'harness-api-key', protocolVersion: 'fixture', capabilities: {} },
    async modelCatalog() { return modelCatalog(); },
    async status() { return { state: 'ready', authMode: 'api-key', rateLimits: [] }; },
    async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {},
    async submitToolResult(id) { if (id === planToolCallId) planReleased(); else editReleased(); },
    async answerQuestion() {}, async resolveBackendApproval() {},
  };
  const context = contextFixture();
  const runtime = {
    context,
    accounting: accountingFixture(),
    registry: { descriptors: () => [backend.descriptor], get: () => backend },
    turns: {
      async *start(_backendId, input) {
        starts += 1;
        if (starts === 1) {
          yield event('tool-request', { toolCallId: planToolCallId, toolId: 'studio.plan.propose', arguments: {
            title: 'Approved cube plan', summary: 'Create one visible cube.',
            items: [{ label: 'Create Player', details: 'One Cube entity owns the visible player.' }],
          } });
          await waitForPlanResult;
          yield event('conversation-node', { nodeKind: 'text', status: 'streaming', delta: 'Waiting for approval.' });
          yield event('completed', { status: 'completed' });
          return;
        }
        continuationInput = input;
        yield eventAt(secondSessionId, secondTurnId, 'tool-request', { toolCallId, toolId: 'entity.create', arguments: { kind: 'cube', name: 'Player' } });
        await waitForEditResult;
        yield eventAt(secondSessionId, secondTurnId, 'completed', { status: 'completed' });
      },
      async *resume() {}, async cancel() {}, async recordToolResult() {},
    },
  };
  const tools = {
    definitions: () => [{ id: 'entity.create', description: 'Create entity', effect: 'reversible-edit', risk: 'medium', inputSchema: {} }],
    async prepare(call) { return { id: 'preparation:continuation', callId: call.id, sessionId: call.sessionId, turnId: call.turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: 'reversible-edit', risk: 'medium', documentId: 'document:test', baseRevision: 1, argumentsDigest: digest('a'), previewDigest: digest('b'), preview: { title: 'Create', target: 'Scene', summary: 'Create Player cube', diff: '+ Player' }, status: 'ready' }; },
    async execute() { executeCount += 1; return { schemaVersion: 1, callId: toolCallId, toolId: 'entity.create', status: 'completed', value: { entity: { id: 'entity:player', name: 'Player' } }, documentId: 'document:test', beforeRevision: 1, afterRevision: 2, historyLabel: 'Create Player' }; },
  };
  const host = new StudioConversationHost({ runtime, tools, operationLog: { async append() {} }, isProjectOpen: () => true, projectContext: projectContextFixture });
  await host.initialize();
  await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Create a Player cube' });
  await waitFor(() => nodes(host).some((node) => node.kind === 'plan' && node.status === 'pending'));
  const pendingPlan = nodes(host).find((node) => node.kind === 'plan' && node.status === 'pending');
  await host.dispatch({ type: 'conversation/accept-plan', nodeId: pendingPlan.id, acceptedItemIds: pendingPlan.content.items.map((item) => item.id), mode: 'approve' });
  await waitFor(() => host.replay().busy === false);
  assert.equal(starts, 2);
  assert.equal(executeCount, 1);
  assert.match(continuationInput.prompt, /already approved plan/);
  assert.match(continuationInput.prompt, /Do not request the same plan approval again/);
  assert.equal(continuationInput.sessionId, sessionId);
  assert.doesNotMatch(continuationInput.prompt, /SnakeBody|snake body segment/iu);
  assert.ok(nodes(host).some((node) => node.kind === 'progress' && node.content.phase === 'approved-plan-execution'));
  assert.equal(nodes(host).filter((node) => node.kind === 'completion').length, 1);
  assert.ok(!nodes(host).some((node) => node.kind === 'diagnostic' && node.content.code === 'plan.execution-not-started'));
  await host.dispose();
});

test('plan review pauses hard wall time so a user can return later, approve, and continue editing', async () => {
  let releasePlan; let releaseEdit;
  const planReleased = new Promise((resolve) => { releasePlan = resolve; });
  const editReleased = new Promise((resolve) => { releaseEdit = resolve; });
  const usage = new UsageLedgerStore();
  const accounting = new TaskAccountingRegistry(usage);
  const backend = {
    descriptor: { id: backendId, kind: 'harness-api-key', protocolVersion: 'fixture', capabilities: {} },
    async modelCatalog() { return modelCatalog(); }, async status() { return { state: 'ready', authMode: 'api-key', rateLimits: [] }; },
    async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async answerQuestion() {}, async resolveBackendApproval() {},
    async submitToolResult(id) { if (id === planToolCallId) releasePlan(); else releaseEdit(); },
  };
  const runtime = { context: contextFixture(), usage, accounting, registry: { descriptors: () => [backend.descriptor], get: () => backend }, turns: {
    async *start(_backendId, input) {
      const ledger = usage.open({ taskId: input.taskId, sessionId, turnId, providerRequestDigest: null, startedAtMs: Date.now() });
      yield event('tool-request', { toolCallId: planToolCallId, toolId: 'studio.plan.propose', arguments: {
        title: 'Return later plan', summary: 'Create one cube after the user returns.',
        items: [{ label: 'Create cube', details: 'Create one independently editable cube entity.' }],
      } });
      await planReleased;
      yield event('tool-request', { toolCallId, toolId: 'entity.create', arguments: { baseRevision: 1, kind: 'cube', name: 'Returned Player' } });
      await editReleased;
      ledger.markTerminal('stop', Date.now());
      yield event('completed', { status: 'completed' });
    }, async *resume() {}, async cancel() {}, async recordToolResult() {},
  } };
  const tools = {
    definitions: () => [{ id: 'entity.create', description: 'Create entity', effect: 'reversible-edit', risk: 'low', inputSchema: {} }],
    async prepare(call) { return { id: 'preparation:return-later', callId: call.id, sessionId: call.sessionId, turnId: call.turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: 'reversible-edit', risk: 'low', documentId: 'document:test', baseRevision: 1, argumentsDigest: digest('a'), previewDigest: digest('b'), preview: { title: 'Create', target: 'Scene', summary: 'Create returned cube', diff: '+ cube' }, status: 'ready' }; },
    async execute() { return { schemaVersion: 1, callId: toolCallId, toolId: 'entity.create', status: 'completed', value: { entity: { id: 'entity:return-later', name: 'Returned Player' } }, documentId: 'document:test', beforeRevision: 1, afterRevision: 2, historyLabel: 'Create Returned Player' }; },
  };
  const host = new StudioConversationHost({ runtime, tools, operationLog: { async append() {} }, isProjectOpen: () => true, projectContext: projectContextFixture });
  await host.initialize();
  await host.dispatch({ type: 'agent/configure', backendId, model: 'fixture-model', reasoningEffort: 'high', outputTokenLimit: 4096, budget: { schemaVersion: 2, id: 'budget:return-later', enforcement: 'hard', limits: { inputTokens: 100_000, outputTokens: 10_000, estimatedCostMicros: 1_000_000, wallTimeMs: 80, turns: 2, toolCalls: 4, repairIterations: 1, observationBytes: 100_000 } } });
  await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Create a cube after I approve the plan.' });
  await waitFor(() => nodes(host).some((node) => node.kind === 'plan' && node.status === 'pending'));
  await new Promise((resolve) => setTimeout(resolve, 160));
  const pendingPlan = nodes(host).find((node) => node.kind === 'plan' && node.status === 'pending');
  assert.ok(pendingPlan);
  assert.equal(host.replay().busy, true);
  assert.equal(host.replay().taskAccounting.budgetStatus, 'within');
  await host.dispatch({ type: 'conversation/accept-plan', nodeId: pendingPlan.id, acceptedItemIds: pendingPlan.content.items.map((item) => item.id), mode: 'approve' });
  await waitFor(() => host.replay().busy === false);
  assert.ok(nodes(host).some((node) => node.kind === 'plan' && node.status === 'completed' && node.content.decision === 'approved'));
  assert.ok(nodes(host).some((node) => node.kind === 'tool-result' && node.content.toolId === 'entity.create' && node.status === 'completed'));
  assert.equal(host.replay().taskAccounting.budgetStatus, 'within');
  assert.ok(host.replay().taskAccounting.usage.wallTimeMs < 80, `active wall time should exclude user wait: ${host.replay().taskAccounting.usage.wallTimeMs}`);
  assert.ok(!nodes(host).some((node) => node.kind === 'diagnostic' && /Hard wall-time budget/u.test(String(node.content.message))));
  await host.dispose();
});

test('cancelling while a plan is pending terminalizes the plan so the composer can recover', async () => {
  const backend = {
    descriptor: { id: backendId, kind: 'harness-api-key', protocolVersion: 'fixture', capabilities: {} }, async modelCatalog() { return modelCatalog(); }, async status() { return { state: 'ready', authMode: 'api-key', rateLimits: [] }; },
    async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async submitToolResult() {}, async answerQuestion() {}, async resolveBackendApproval() {},
  };
  const runtime = { context: contextFixture(), accounting: accountingFixture(), registry: { descriptors: () => [backend.descriptor], get: () => backend }, turns: {
    async *start(_backendId, _input, signal) {
      yield event('tool-request', { toolCallId: planToolCallId, toolId: 'studio.plan.propose', arguments: { title: 'Cancelable plan', summary: 'Wait for review.', items: [{ label: 'Wait', details: 'Remain pending until cancelled.' }] } });
      await new Promise((resolve, reject) => { const abort = () => reject(signal.reason); if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); });
    },
    async *resume() {}, async cancel() {}, async recordToolResult() {},
  } };
  const host = new StudioConversationHost({ runtime, tools: { definitions: () => [] }, operationLog: { async append() {} }, isProjectOpen: () => true });
  await host.initialize(); await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Prepare a plan.' });
  await waitFor(() => nodes(host).some((node) => node.kind === 'plan' && node.status === 'pending'));
  await host.dispatch({ type: 'conversation/cancel', backendId, sessionId, turnId });
  await waitFor(() => nodes(host).some((node) => node.kind === 'plan' && node.status === 'cancelled'));
  const cancelledPlan = nodes(host).find((node) => node.kind === 'plan' && node.status === 'cancelled');
  assert.equal(nodes(host).filter((node) => node.id === cancelledPlan.id).at(-1).status, 'cancelled');
  await waitFor(() => host.replay().busy === false);
  await host.dispose();
});

test('project Run prefers a current controller script over an incidentally selected board script', () => {
  const entities = [
    { id: 'entity:game', name: 'SnakeGame', kind: 'empty' },
    { id: 'entity:board', name: 'Board_20x20', kind: 'cube' },
  ];
  const scripts = [
    { id: 'script:board', entityId: 'entity:board', textRevision: 1 },
    { id: 'script:game', entityId: 'entity:game', textRevision: 3 },
  ];
  assert.equal(selectProjectRunScript(entities, scripts, 'entity:board')?.id, 'script:game');
  assert.equal(selectProjectRunScript(entities, scripts, 'entity:missing')?.id, 'script:game');
});

test('G10 conversation host gives project-missing turns recovery instructions that work across independent turns', async () => {
  let startedInput;
  const backend = {
    descriptor: { id: backendId, kind: 'harness-api-key', protocolVersion: 'fixture', capabilities: {} },
    async modelCatalog() { return modelCatalog(); },
    async status() { return { state: 'ready', authMode: 'api-key', rateLimits: [] }; },
    async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {},
    async submitToolResult() {}, async answerQuestion() {}, async resolveBackendApproval() {},
  };
  const runtime = {
    context: contextFixture(),
    accounting: accountingFixture(),
    registry: { descriptors: () => [backend.descriptor], get: () => backend },
    turns: {
      async *start(_backendId, input) { startedInput = input; yield event('completed', { status: 'completed' }); },
      async *resume() {}, async cancel() {}, async recordToolResult() {},
    },
  };
  const tools = { definitions: () => [{ id: 'project.snapshot', description: 'Read project', effect: 'observe', risk: 'low', inputSchema: {} }] };
  const host = new StudioConversationHost({ runtime, tools, operationLog: { async append() {} }, isProjectOpen: () => false });
  await host.initialize();
  await host.dispatch({ type: 'conversation/send', backendId, prompt: '创建一个游戏' });
  await waitFor(() => host.replay().busy === false);
  assert.match(startedInput.prompt, /"state":"not-required"/);
  assert.match(startedInput.prompt, /No Studio project is currently open/);
  assert.match(startedInput.tools.find((tool) => tool.id === 'project.snapshot').description, /Inspect this before planning/);
  await host.dispose();
});

test('hard task budget releases the live tool call and continues in a fresh turn after a bounded user grant', async () => {
  const releases = []; const submitted = []; let prepareCount = 0; let executeCount = 0; let startCount = 0;
  const backend = {
    descriptor: { id: backendId, kind: 'harness-api-key', protocolVersion: 'fixture', capabilities: {} }, async modelCatalog() { return modelCatalog(); }, async status() { return { state: 'ready', authMode: 'api-key', rateLimits: [] }; },
    async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async answerQuestion() {}, async resolveBackendApproval() {},
    async submitToolResult(id, result) { submitted.push({ id, result }); releases.shift()?.(); },
  };
  const runtime = { context: contextFixture(), registry: { descriptors: () => [backend.descriptor], get: () => backend }, accounting: new TaskAccountingRegistry(new UsageLedgerStore()), turns: {
    async *start() {
      startCount += 1;
      if (startCount === 1) {
        const first = new Promise((resolve) => releases.push(resolve)); yield event('tool-request', { toolCallId: 'tool-call:budget-one', toolId: 'project.snapshot', arguments: {} }); await first;
        const second = new Promise((resolve) => releases.push(resolve)); yield event('tool-request', { toolCallId: 'tool-call:budget-two', toolId: 'diagnostics.query', arguments: {} }); await second;
      } else {
        const retry = new Promise((resolve) => releases.push(resolve)); yield event('tool-request', { toolCallId: 'tool-call:budget-two-retry', toolId: 'diagnostics.query', arguments: {} }); await retry;
      }
      yield event('completed', { status: 'completed' });
    }, async *resume() {}, async cancel() {}, async recordToolResult() {},
  } };
  const tools = { definitions: () => ['project.snapshot', 'diagnostics.query'].map((id) => ({ id, description: id, effect: 'observe', risk: 'low', inputSchema: {} })),
    async prepare(call) { prepareCount += 1; return { id: `preparation:${prepareCount}`, callId: call.id, sessionId, turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: 'observe', risk: 'low', documentId: 'document:test', baseRevision: 1, argumentsDigest: digest('a'), previewDigest: digest('b'), preview: { title: 'Read', target: 'Project', summary: 'Read only', diff: '' }, status: 'ready' }; },
    async execute() { executeCount += 1; return { schemaVersion: 1, callId: 'tool-call:budget-one', toolId: 'project.snapshot', status: 'completed', value: {}, documentId: 'document:test', beforeRevision: 1, afterRevision: 1 }; } };
  const host = new StudioConversationHost({ runtime, tools, operationLog: { async append() {} }, isProjectOpen: () => true }); await host.initialize();
  await host.dispatch({ type: 'agent/configure', backendId, model: 'fixture-model', reasoningEffort: 'high', outputTokenLimit: 4096, budget: { schemaVersion: 2, id: 'budget:hard-integration', enforcement: 'hard', limits: { inputTokens: 100_000, outputTokens: 10_000, estimatedCostMicros: 1_000_000, wallTimeMs: 60_000, turns: 2, toolCalls: 1, repairIterations: 1, observationBytes: 100_000 } } });
  await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Inspect twice' });
  await waitFor(() => nodes(host).some((node) => node.kind === 'question' && node.status === 'pending' && node.content.options?.some((option) => String(option.id).includes('budget-continue'))));
  const budgetQuestion = nodes(host).filter((node) => node.kind === 'question' && node.status === 'pending').at(-1);
  const continueOption = budgetQuestion.content.options.find((option) => String(option.id).includes('budget-continue'));
  assert.equal(prepareCount, 1); assert.equal(executeCount, 1); assert.equal(submitted.length, 2);
  assert.equal(submitted[1].result.status, 'cancelled'); assert.equal(submitted[1].result.value.code, 'budget.continuation-required');
  await host.dispatch({ type: 'conversation/answer-question', nodeId: budgetQuestion.id, answer: { optionIds: [continueOption.id] } });
  await waitFor(() => host.replay().busy === false);
  assert.equal(startCount, 2); assert.equal(prepareCount, 2); assert.equal(executeCount, 2); assert.equal(submitted.length, 3); assert.equal(submitted[2].result.status, 'completed');
  assert.equal(host.replay().taskAccounting.budgetStatus, 'within'); assert.equal(host.replay().taskAccounting.budget.limits.toolCalls, 2); await host.dispose();
});

test('declining a budget continuation stops without rolling back completed tool output', async () => {
  const releases = []; const submitted = []; let prepareCount = 0; let executeCount = 0;
  const backend = {
    descriptor: { id: backendId, kind: 'harness-api-key', protocolVersion: 'fixture', capabilities: {} }, async modelCatalog() { return modelCatalog(); }, async status() { return { state: 'ready', authMode: 'api-key', rateLimits: [] }; },
    async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async answerQuestion() {}, async resolveBackendApproval() {},
    async submitToolResult(id, result) { submitted.push({ id, result }); releases.shift()?.(); },
  };
  const runtime = { context: contextFixture(), registry: { descriptors: () => [backend.descriptor], get: () => backend }, accounting: new TaskAccountingRegistry(new UsageLedgerStore()), turns: {
    async *start() {
      const first = new Promise((resolve) => releases.push(resolve)); yield event('tool-request', { toolCallId: 'tool-call:preserve-one', toolId: 'project.snapshot', arguments: {} }); await first;
      const second = new Promise((resolve) => releases.push(resolve)); yield event('tool-request', { toolCallId: 'tool-call:preserve-two', toolId: 'diagnostics.query', arguments: {} }); await second;
      yield event('completed', { status: 'completed' });
    }, async *resume() {}, async cancel() {}, async recordToolResult() {},
  } };
  const tools = { definitions: () => ['project.snapshot', 'diagnostics.query'].map((id) => ({ id, description: id, effect: 'observe', risk: 'low', inputSchema: {} })),
    async prepare(call) { prepareCount += 1; return { id: `preparation:preserve:${prepareCount}`, callId: call.id, sessionId, turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: 'observe', risk: 'low', documentId: 'document:test', baseRevision: 1, argumentsDigest: digest('a'), previewDigest: digest('b'), preview: { title: 'Read', target: 'Project', summary: 'Read only', diff: '' }, status: 'ready' }; },
    async execute() { executeCount += 1; return { schemaVersion: 1, callId: 'tool-call:preserve-one', toolId: 'project.snapshot', status: 'completed', value: { retained: true }, documentId: 'document:test', beforeRevision: 1, afterRevision: 1 }; } };
  const host = new StudioConversationHost({ runtime, tools, operationLog: { async append() {} }, isProjectOpen: () => true }); await host.initialize();
  await host.dispatch({ type: 'agent/configure', backendId, model: 'fixture-model', reasoningEffort: 'high', outputTokenLimit: 4096, budget: { schemaVersion: 2, id: 'budget:preserve-integration', enforcement: 'hard', limits: { inputTokens: 100_000, outputTokens: 10_000, estimatedCostMicros: 1_000_000, wallTimeMs: 60_000, turns: 2, toolCalls: 1, repairIterations: 1, observationBytes: 100_000 } } });
  await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Inspect twice and preserve the first result' });
  await waitFor(() => nodes(host).some((node) => node.kind === 'question' && node.status === 'pending' && node.content.options?.some((option) => String(option.id).includes('budget-stop'))));
  const budgetQuestion = nodes(host).filter((node) => node.kind === 'question' && node.status === 'pending').at(-1);
  const stopOption = budgetQuestion.content.options.find((option) => String(option.id).includes('budget-stop'));
  assert.equal(submitted.length, 2); assert.equal(submitted[1].result.status, 'cancelled'); assert.equal(submitted[1].result.value.code, 'budget.continuation-required');
  await host.dispatch({ type: 'conversation/answer-question', nodeId: budgetQuestion.id, answer: { optionIds: [stopOption.id] } });
  await waitFor(() => host.replay().busy === false);
  assert.equal(prepareCount, 1); assert.equal(executeCount, 1); assert.equal(submitted.length, 2);
  assert.equal(submitted[1].result.status, 'cancelled'); assert.equal(submitted[1].result.value.preserved, true);
  assert.ok(nodes(host).some((node) => node.kind === 'completion' && /project changes preserved/u.test(String(node.content.summary))));
  assert.equal(host.replay().taskAccounting.budgetStatus, 'hard-exceeded'); await host.dispose();
});

test('G10 renderer preview broker uses one pending command and rejects stale acknowledgements', async () => {
  const broker = new AgentPreviewBroker();
  const scriptSetDigest = `sha256:${'a'.repeat(64)}`;
  const plan = { id: 'preview-plan:test', documentId: 'document:test', documentRevision: 1, selection: 'all-enabled', scriptSetDigest, scripts: [{ scriptId: 'script:test', entityId: 'entity:test', order: 0, textRevision: 1, digest: 'a'.repeat(64), capabilities: ['read'], diagnostics: [], emittedText: 'return;' }], capabilities: ['read'], runtimeConfig: { schemaVersion: 1, mode: 'fixed-step', tickRateHz: 60, maxSubSteps: 1000, seed: 'test' }, risk: 'trusted-project', diagnostics: [] };
  const scene = { schemaVersion: 1, revision: 1, documentId: 'document:test', entities: [{ id: 'entity:test', name: 'Player', kind: 'cube', parentId: null, order: 0, transform: { position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }] };
  const started = broker.start(scene, plan);
  const command = broker.command().command;
  assert.equal(command.kind, 'start');
  assert.equal(command.scene.entities[0].kind, 'cube');
  const runningScript = { scriptId: 'script:test', entityId: 'entity:test', order: 0, state: 'playing', position: { x: 0, y: 0, z: 0 }, disposableCount: 0, errorCount: 0 };
  broker.resolve(command.id, { instanceId: 'preview:test', state: 'playing', scriptSetDigest, scriptCount: 1, scripts: [runningScript], entityId: 'entity:test', position: { x: 0, y: 0, z: 0 }, disposableCount: 0, errors: [] });
  assert.equal((await started).state, 'playing');
  assert.throws(() => broker.resolve(command.id, { instanceId: null, state: 'stopped', scriptSetDigest: null, scriptCount: 0, scripts: [], entityId: null, position: null, disposableCount: 0, errors: [] }), /missing, stale/);
  const stopped = broker.stop();
  const stopCommand = broker.command().command;
  broker.resolve(stopCommand.id, { instanceId: null, state: 'stopped', scriptSetDigest: null, scriptCount: 0, scripts: [], entityId: null, position: null, disposableCount: 0, errors: [] });
  assert.equal((await stopped).state, 'stopped');
  broker.dispose(); broker.dispose();
});

function event(kind, payload) { return { schemaVersion: 1, backendId, sessionId, turnId, kind, payload }; }
function eventAt(nextSessionId, nextTurnId, kind, payload) { return { schemaVersion: 1, backendId, sessionId: nextSessionId, turnId: nextTurnId, kind, payload }; }
function digest(character) { return character.repeat(64); }
function modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture model', description: 'fixture', reasoningEfforts: ['off', 'low', 'high'], defaultReasoningEffort: 'high', maxOutputTokens: 8192, isDefault: true }] }; }
function accountingFixture() {
  const accounts = new Map();
  return { open({ taskId, budget }) { const snapshot = () => ({ taskId, budget, budgetDecision: { allowed: true, status: 'within', violations: [], warning: null, hardStopLatched: false }, consumption: { inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0, wallTimeMs: 0, turns: 1, toolCalls: 0, repairIterations: 0, observationBytes: 0 }, usage: { inputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, toolInputBytes: 0, toolOutputBytes: 0, wallTimeMs: 0 }, cost: { status: 'unknown', amountMicros: null, currency: null, cacheSavingMicros: null, explanation: 'fixture', final: false }, turnIds: [] }); const account = { options: { taskId, budget }, beginTurn: () => ({ allowed: true, status: 'within', violations: [], warning: null, hardStopLatched: false }), bindTurn() {}, preflightTool: () => ({ allowed: true, status: 'within', violations: [], warning: null, hardStopLatched: false }), commitTool: () => ({ allowed: true, status: 'within', violations: [], warning: null, hardStopLatched: false }), expireWallTime: () => ({ allowed: false, status: 'hard-exceeded', violations: [], warning: 'expired', hardStopLatched: true }), reconcile: snapshot, snapshot }; accounts.set(taskId, account); return account; }, get(id) { return accounts.get(id); } };
}
function contextFixture() {
  let liveSession = null; const commits = [];
  const profile = { id: 'prompt:game-authoring-general', version: '3.0.0', digest: `sha256:${'c'.repeat(64)}`, modules: [] };
  return { prompts: { profile }, commits, async prepare({ request, project }) { return { prompt: `AIStudio context envelope\n${JSON.stringify(project ? { projectRevision: project.revision } : { state: 'not-required', reason: 'No Studio project is currently open.' })}\n[current-request-tail]\n${request}`, promptDigest: `sha256:${'d'.repeat(64)}`, promptProfile: profile, contextArtifactIds: [`artifact:sha256:${'e'.repeat(64)}`], contextDigest: `sha256:${'f'.repeat(64)}`, cache: { localArtifactHits: liveSession ? 1 : 0, localArtifactMisses: liveSession ? 0 : 1, deltaReuseBytes: 0, providerCacheEligibleBytes: 128, providerReportedHitTokens: null }, reusedSessionId: liveSession }; }, async commit(value) { commits.push(value); liveSession = value.sessionId; return { id: `artifact:sha256:${'a'.repeat(64)}` }; } };
}
function projectContextFixture() { return { projectId: 'project:test', documentId: 'document:test', revision: 1, manifest: { schemaVersion: 1, scene: { entities: [] }, scripts: { resources: [] } } }; }
function nodes(host) { return host.replay().events.map((entry) => entry.node); }
async function waitFor(predicate) { for (let index = 0; index < 100; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error('Timed out waiting for fixture state.'); }
