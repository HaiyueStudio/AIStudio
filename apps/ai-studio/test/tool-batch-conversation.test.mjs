import assert from 'node:assert/strict';
import test from 'node:test';
import { StudioConversationHost } from '@haiyue/ai-studio-agent-orchestration';
import { TaskAccountingRegistry, UsageLedgerStore } from '@haiyue/ai-studio-agent-runtime';

const backendId = 'backend:tool-batch';
const sessionId = 'session:tool-batch';
const turnId = 'turn:tool-batch';

test('Conversation Host overlaps safe bodies, honors an exclusive barrier, and commits in provider order', async (t) => {
  const submitted = [];
  const releases = new Map();
  const executionEvents = [];
  const sessionOps = [];
  let activeBodies = 0; let maxActiveBodies = 0;
  const calls = [
    { id: 'call:slow-read', toolId: 'scene.query', delay: 90 },
    { id: 'call:fast-read', toolId: 'diagnostics.query', delay: 90 },
    { id: 'call:exclusive', toolId: 'fixture.unknown-exclusive', delay: 25 },
    { id: 'call:after-barrier', toolId: 'asset.search', delay: 25 },
  ];
  const backend = {
    descriptor: { id: backendId, kind: 'codex-app-server', protocolVersion: 'fixture', capabilities: {} },
    async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture', description: 'Fixture', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 8192, isDefault: true }] }; },
    async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; },
    async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async answerQuestion() {}, async resolveBackendApproval() {},
    async submitToolResult(id, result) { submitted.push({ id, result }); releases.get(id)?.(); },
  };
  const usage = new UsageLedgerStore();
  const runtime = {
    context: contextFixture(), usage, accounting: new TaskAccountingRegistry(usage),
    registry: { descriptors: () => [backend.descriptor], get: () => backend },
    sessions: { async open() { return { id: sessionId, async append(op) { sessionOps.push(op); }, async dispose() {} }; } },
    turns: {
      async *start(_backendId, input) {
        usage.open({ taskId: input.taskId, sessionId, turnId, providerRequestDigest: null, startedAtMs: Date.now() });
        yield event('status', { status: 'running' });
        const waits = calls.map((call) => new Promise((resolve) => releases.set(call.id, resolve)));
        for (const call of calls) yield event('tool-request', { toolCallId: call.id, toolId: call.toolId, arguments: {} });
        await Promise.all(waits);
        yield event('completed', { status: 'completed' });
      },
      async *resume() {}, async cancel() {}, async recordToolResult(_turnId, toolCallId, result) { const ledger = usage.get(turnId); ledger.reconcile({ eventId: `output:${toolCallId}`, sequence: ledger.snapshot().acceptedEvents + 1, mode: 'delta', toolCallId, toolOutputBytes: Buffer.byteLength(JSON.stringify(result)), observedAtMs: Date.now() }); },
    },
  };
  const definitions = [definition('scene.query', true), definition('diagnostics.query', true), definition('asset.search', true)];
  const tools = {
    definitions: () => definitions,
    async prepare(call) { return { id: `preparation:${call.id}`, callId: call.id, sessionId, turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: 'observe', risk: 'low', documentId: 'document:test', baseRevision: 1, argumentsDigest: digest('a'), previewDigest: digest('b'), preview: { title: 'Read', target: 'Project', summary: call.toolId, diff: '' }, status: 'ready' }; },
    async execute(preparationId) {
      const call = calls.find((candidate) => preparationId === `preparation:${candidate.id}`);
      activeBodies += 1; maxActiveBodies = Math.max(maxActiveBodies, activeBodies); executionEvents.push(`start:${call.id}`);
      await new Promise((resolve) => setTimeout(resolve, call.delay));
      executionEvents.push(`end:${call.id}`); activeBodies -= 1;
      return { schemaVersion: 1, callId: call.id, toolId: call.toolId, status: 'completed', value: { callId: call.id }, documentId: 'document:test', beforeRevision: 1, afterRevision: 1 };
    },
  };
  const host = new StudioConversationHost({ runtime, tools, operationLog: { async append() {} }, isProjectOpen: () => true, projectContext: () => ({ projectId: 'project:test', documentId: 'document:test', revision: 1, manifest: {} }) });
  await host.initialize();
  const startedAt = Date.now();
  await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Inspect independent context in one batch.' });
  await waitFor(() => host.replay().busy === false);
  const elapsed = Date.now() - startedAt;

  assert.equal(maxActiveBodies, 2);
  assert.deepEqual(submitted.map((item) => item.id), calls.map((item) => item.id));
  assert.ok(executionEvents.indexOf('end:call:slow-read') < executionEvents.indexOf('start:call:exclusive'));
  assert.ok(executionEvents.indexOf('end:call:fast-read') < executionEvents.indexOf('start:call:exclusive'));
  assert.ok(executionEvents.indexOf('end:call:exclusive') < executionEvents.indexOf('start:call:after-barrier'));
  // Wall time includes host projection/accounting and machine load; prove overlap directly.
  assert.ok(executionEvents.indexOf('start:call:fast-read') < executionEvents.indexOf('end:call:slow-read'));
  t.diagnostic(`Host batch wall time: ${elapsed}ms`);
  assert.deepEqual(sessionOps.filter((op) => op.kind === 'tool.completed').map((op) => op.payload.toolCallId), calls.map((item) => item.id));
  assert.deepEqual(sessionOps.filter((op) => op.kind.startsWith('tool-batch.')).map((op) => op.kind), ['tool-batch.planned', 'tool-batch.started', 'tool-batch.planned', 'tool-batch.planned', 'tool-batch.planned', 'tool-batch.planned', 'tool-batch.completed']);
  assert.deepEqual(sessionOps.filter((op) => op.kind === 'tool-batch.planned' && op.nodeId).map((op) => op.payload.profile), ['tool-node-plan/1', 'tool-node-plan/1', 'tool-node-plan/1', 'tool-node-plan/1']);
  assert.ok(sessionOps.filter((op) => op.kind === 'tool.completed').every((op) => Number.isInteger(op.payload.latencyMs) && Number.isInteger(op.payload.outputBytes) && typeof op.payload.usageRecordId === 'string' && typeof op.payload.costRecordId === 'string' && op.payload.costAttribution === 'turn-shared'));
  await host.dispose();
});

test('Conversation Host commits an all-mutation batch once and records one durable transaction receipt', async () => {
  const calls = ['call:tx-a', 'call:tx-b', 'call:tx-c'];
  const submitted = []; const sessionOps = []; let transactionCalls = 0; let releasePlan;
  const planSubmitted = new Promise((resolve) => { releasePlan = resolve; });
  let releaseMutations; const mutationsSubmitted = new Promise((resolve) => { releaseMutations = resolve; });
  const backend = {
    descriptor: { id: backendId, kind: 'codex-app-server', protocolVersion: 'fixture', capabilities: {} },
    async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture', description: 'Fixture', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 8192, isDefault: true }] }; },
    async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async answerQuestion() {}, async resolveBackendApproval() {},
    async submitToolResult(id, result) { if (id === 'call:tx-plan') releasePlan(); else { submitted.push({ id, result }); if (submitted.length === calls.length) releaseMutations(); } },
  };
  const usage = new UsageLedgerStore();
  const handle = { id: sessionId, async append(op) { sessionOps.push(op); return {}; }, async checkpoint() { sessionOps.push({ kind: 'fixture.checkpoint' }); return {}; }, async dispose() {} };
  const runtime = {
    context: contextFixture(), usage, accounting: new TaskAccountingRegistry(usage), registry: { descriptors: () => [backend.descriptor], get: () => backend }, sessions: { async open() { return handle; } },
    turns: {
      async *start(_backendId, input) {
        usage.open({ taskId: input.taskId, sessionId, turnId, providerRequestDigest: null, startedAtMs: Date.now() });
        yield event('tool-request', { toolCallId: 'call:tx-plan', toolId: 'studio.plan.propose', arguments: { title: 'Atomic batch', summary: 'Create three independent entities atomically.', items: calls.map((id) => ({ label: id, details: `Create ${id}.` })) } });
        await planSubmitted;
        for (const [index, id] of calls.entries()) yield event('tool-request', { toolCallId: id, toolId: 'entity.create', arguments: { baseRevision: 1, kind: 'cube', name: `Entity ${index + 1}` } });
        await mutationsSubmitted;
        yield event('completed', { status: 'completed' });
      }, async *resume() {}, async cancel() {}, async recordToolResult() {},
    },
  };
  const preparations = new Map();
  const tools = {
    definitions: () => [{ ...definition('entity.create', false), effect: 'reversible-edit' }],
    async prepare(call) { const value = { id: `preparation:${call.id}`, callId: call.id, sessionId, turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: 'reversible-edit', risk: 'low', documentId: 'document:test', baseRevision: 1, argumentsDigest: digest('a'), previewDigest: digest('b'), preview: { title: 'Create', target: 'Scene', summary: call.id, diff: `+ ${call.id}` }, status: 'ready' }; preparations.set(value.id, value); return value; },
    async execute() { throw new Error('individual mutation execution must not run'); }, async cancel() {},
    async executeTransaction(input) {
      transactionCalls += 1; assert.deepEqual(input.preparationIds, calls.map((id) => `preparation:${id}`));
      const transaction = { transactionId: 'transaction:g07-host', idempotencyKey: 'idempotency:g07-host', receiptDigest: `sha256:${'9'.repeat(64)}`, receiptArtifactId: `artifact:sha256:${'8'.repeat(64)}`, memberCount: calls.length, replayed: false };
      return { ...transaction, beforeRevision: 1, afterRevision: 2, results: calls.map((id) => ({ schemaVersion: 1, callId: id, toolId: 'entity.create', status: 'completed', value: { entityId: `entity:${id}` }, documentId: 'document:test', beforeRevision: 1, afterRevision: 2, historyLabel: 'Agent batch · 3 edits', transaction })) };
    },
  };
  const host = new StudioConversationHost({ runtime, tools, operationLog: { async append() {} }, isProjectOpen: () => true, projectContext: () => ({ projectId: 'project:test', documentId: 'document:test', revision: 1, manifest: {} }) });
  await host.initialize(); await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Create an atomic batch.' });
  await waitFor(() => host.replay().events.some((item) => item.node.kind === 'plan' && item.node.status === 'pending'));
  const plan = host.replay().events.map((item) => item.node).find((node) => node.kind === 'plan' && node.status === 'pending');
  await host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map((item) => item.id), mode: 'approve' });
  await waitFor(() => host.replay().busy === false);
  assert.equal(transactionCalls, 1); assert.deepEqual(submitted.map((item) => item.id), calls);
  assert.equal(new Set(submitted.map((item) => item.result.transaction.transactionId)).size, 1);
  assert.equal(sessionOps.filter((op) => op.kind === 'document.committed').length, 1);
  assert.equal(sessionOps.filter((op) => op.kind === 'tool.completed' && op.payload.transactionId === 'transaction:g07-host').length, 3);
  await host.dispose();
});

test('Conversation Host overlaps documentation with a real transaction and delays all state reads until commit', async () => {
  const calls = ['call:tx-a', 'call:docs', 'call:state-a', 'call:state-b'];
  let startTransaction, startDocs, committed = false;
  const transactionStarted = new Promise(resolve => { startTransaction = resolve; });
  const docsStarted = new Promise(resolve => { startDocs = resolve; });
  const submitted = []; const sessionOps = []; let transactionCalls = 0; let releasePlan;
  const planSubmitted = new Promise((resolve) => { releasePlan = resolve; });
  let releaseMutations; const mutationsSubmitted = new Promise((resolve) => { releaseMutations = resolve; });
  const backend = {
    descriptor: { id: backendId, kind: 'codex-app-server', protocolVersion: 'fixture', capabilities: {} },
    async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture', description: 'Fixture', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 8192, isDefault: true }] }; },
    async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async answerQuestion() {}, async resolveBackendApproval() {},
    async submitToolResult(id, result) { if (id === 'call:tx-plan') releasePlan(); else { submitted.push({ id, result }); if (submitted.length === calls.length) releaseMutations(); } },
  };
  const usage = new UsageLedgerStore();
  const handle = { id: sessionId, async append(op) { sessionOps.push(op); return {}; }, async checkpoint() { sessionOps.push({ kind: 'fixture.checkpoint' }); return {}; }, async dispose() {} };
  const runtime = {
    context: contextFixture(), usage, accounting: new TaskAccountingRegistry(usage), registry: { descriptors: () => [backend.descriptor], get: () => backend }, sessions: { async open() { return handle; } },
    turns: {
      async *start(_backendId, input) {
        usage.open({ taskId: input.taskId, sessionId, turnId, providerRequestDigest: null, startedAtMs: Date.now() });
        yield event('tool-request', { toolCallId: 'call:tx-plan', toolId: 'studio.plan.propose', arguments: { title: 'Atomic batch', summary: 'Create three independent entities atomically.', items: calls.map((id) => ({ label: id, details: `Create ${id}.` })) } });
        await planSubmitted;
        yield event('tool-request', { toolCallId: calls[0], toolId: 'entity.create', arguments: { baseRevision: 1, kind: 'cube', name: 'Body' } });
        yield event('tool-request', { toolCallId: calls[1], toolId: 'engine.docs.search', arguments: { query: 'pointer' } });
        for (const id of calls.slice(2)) yield event('tool-request', { toolCallId: id, toolId: 'scene.query', arguments: {} });
        await mutationsSubmitted;
        yield event('completed', { status: 'completed' });
      }, async *resume() {}, async cancel() {}, async recordToolResult() {},
    },
  };
  const preparations = new Map();
  const tools = {
    definitions: () => [{ ...definition('entity.create', false), effect: 'reversible-edit' }, definition('engine.docs.search', true), definition('scene.query', true)],
    async prepare(call) { const value = { id: `preparation:${call.id}`, callId: call.id, sessionId, turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: call.toolId === 'entity.create' ? 'reversible-edit' : 'observe', risk: 'low', documentId: 'document:test', baseRevision: 1, argumentsDigest: digest('a'), previewDigest: digest('b'), preview: { title: 'Create', target: 'Scene', summary: call.id, diff: `+ ${call.id}` }, status: 'ready' }; preparations.set(value.id, value); return value; },
    async execute(id) {
      const prepared = preparations.get(id);
      if (prepared.toolId === 'engine.docs.search') { startDocs(); await transactionStarted; }
      else { assert.equal(prepared.toolId, 'scene.query'); assert.equal(committed, true, 'state reads must wait for the actual Document commit'); }
      return { schemaVersion: 1, callId: prepared.callId, toolId: prepared.toolId, status: 'completed', value: { ok: true }, documentId: 'document:test', beforeRevision: 1, afterRevision: committed ? 2 : 1 };
    }, async cancel() {},
    async executeTransaction(input) {
      transactionCalls += 1; assert.deepEqual(input.preparationIds, [`preparation:${calls[0]}`]);
      startTransaction(); await docsStarted; committed = true;
      const transaction = { transactionId: 'transaction:g07-host', idempotencyKey: 'idempotency:g07-host', receiptDigest: `sha256:${'9'.repeat(64)}`, receiptArtifactId: `artifact:sha256:${'8'.repeat(64)}`, memberCount: 1, replayed: false };
      return { ...transaction, beforeRevision: 1, afterRevision: 2, results: calls.slice(0, 1).map((id) => ({ schemaVersion: 1, callId: id, toolId: 'entity.create', status: 'completed', value: { entityId: `entity:${id}` }, documentId: 'document:test', beforeRevision: 1, afterRevision: 2, historyLabel: 'Agent batch · 3 edits', transaction })) };
    },
  };
  const host = new StudioConversationHost({ runtime, tools, operationLog: { async append() {} }, isProjectOpen: () => true, projectContext: () => ({ projectId: 'project:test', documentId: 'document:test', revision: 1, manifest: {} }) });
  await host.initialize(); await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Create an atomic batch.' });
  await waitFor(() => host.replay().events.some((item) => item.node.kind === 'plan' && item.node.status === 'pending'));
  const plan = host.replay().events.map((item) => item.node).find((node) => node.kind === 'plan' && node.status === 'pending');
  await host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map((item) => item.id), mode: 'approve' });
  await waitFor(() => host.replay().busy === false);
  assert.equal(transactionCalls, 1); assert.deepEqual(submitted.map((item) => item.id), calls);
  assert.ok(submitted.every(item => item.result.status === 'completed'), JSON.stringify(submitted));
  assert.equal(committed, true);
  assert.equal(sessionOps.filter((op) => op.kind === 'document.committed').length, 1);
  assert.equal(sessionOps.filter((op) => op.kind === 'tool.completed' && op.payload.transactionId === 'transaction:g07-host').length, 1);
  await host.dispose();
});

function definition(id, concurrencySafe) { return { schemaVersion: 1, id, version: '1.0.0', title: id, description: id, effect: 'observe', risk: 'low', requiredCapabilities: [], inputSchema: {}, outputSchema: {}, redactedFields: [], presentation: { intent: id, result: id }, timeoutMs: 1000, maxResultBytes: 4096, requiresApproval: false, concurrencySafe }; }
function event(kind, payload) { return { schemaVersion: 1, backendId, sessionId, turnId, kind, payload }; }
function digest(character) { return character.repeat(64); }
function contextFixture() { const profile = { id: 'prompt:fixture', version: '1.0.0', digest: `sha256:${'c'.repeat(64)}`, modules: [] }; return { prompts: { profile }, async prepare({ request }) { return { prompt: request, promptDigest: `sha256:${'d'.repeat(64)}`, promptProfile: profile, contextArtifactIds: [`artifact:sha256:${'e'.repeat(64)}`], contextDigest: `sha256:${'f'.repeat(64)}`, cache: { localArtifactHits: 0, localArtifactMisses: 1, deltaReuseBytes: 0, providerCacheEligibleBytes: 0, providerReportedHitTokens: null }, reusedSessionId: null }; }, async commit() {} }; }
async function waitFor(predicate) { for (let index = 0; index < 300; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error('Timed out waiting for fixture state.'); }

test('Conversation Host seals a committed transaction before accepting later streamed mutations', async () => {
  const calls = ['call:tx-a', 'call:tx-b', 'call:tx-c'];
  const submitted = []; const sessionOps = []; let transactionCalls = 0; let releasePlan;
  const releases = new Map();
  const planSubmitted = new Promise((resolve) => { releasePlan = resolve; });
  let releaseMutations; const mutationsSubmitted = new Promise((resolve) => { releaseMutations = resolve; });
  const backend = {
    descriptor: { id: backendId, kind: 'codex-app-server', protocolVersion: 'fixture', capabilities: {} },
    async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture', description: 'Fixture', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 8192, isDefault: true }] }; },
    async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async answerQuestion() {}, async resolveBackendApproval() {},
    async submitToolResult(id, result) { if (id === 'call:tx-plan') releasePlan(); else { submitted.push({ id, result }); releases.get(id)?.(); if (submitted.length === calls.length) releaseMutations(); } },
  };
  const usage = new UsageLedgerStore();
  const handle = { id: sessionId, async append(op) { sessionOps.push(op); return {}; }, async checkpoint() { sessionOps.push({ kind: 'fixture.checkpoint' }); return {}; }, async dispose() {} };
  const runtime = {
    context: contextFixture(), usage, accounting: new TaskAccountingRegistry(usage), registry: { descriptors: () => [backend.descriptor], get: () => backend }, sessions: { async open() { return handle; } },
    turns: {
      async *start(_backendId, input) {
        usage.open({ taskId: input.taskId, sessionId, turnId, providerRequestDigest: null, startedAtMs: Date.now() });
        yield event('tool-request', { toolCallId: 'call:tx-plan', toolId: 'studio.plan.propose', arguments: { title: 'Atomic batch', summary: 'Create three independent entities atomically.', items: calls.map((id) => ({ label: id, details: `Create ${id}.` })) } });
        await planSubmitted;
        for (const [index, id] of calls.entries()) {
          const delivered = new Promise(resolve => releases.set(id, resolve));
          yield event('tool-request', { toolCallId: id, toolId: 'entity.create', arguments: { baseRevision: index + 1, kind: 'cube', name: `Entity ${index + 1}` } });
          await delivered;
        }
        await mutationsSubmitted;
        yield event('completed', { status: 'completed' });
      }, async *resume() {}, async cancel() {}, async recordToolResult() {},
    },
  };
  const preparations = new Map();
  const tools = {
    definitions: () => [{ ...definition('entity.create', false), effect: 'reversible-edit' }],
    async prepare(call) { const value = { id: `preparation:${call.id}`, callId: call.id, sessionId, turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: 'reversible-edit', risk: 'low', documentId: 'document:test', baseRevision: call.arguments.baseRevision, argumentsDigest: digest('a'), previewDigest: digest('b'), preview: { title: 'Create', target: 'Scene', summary: call.id, diff: `+ ${call.id}` }, status: 'ready' }; preparations.set(value.id, value); return value; },
    async execute() { throw new Error('individual mutation execution must not run'); }, async cancel() {},
    async executeTransaction(input) {
      transactionCalls += 1; assert.deepEqual(input.preparationIds, [`preparation:${calls[transactionCalls - 1]}`]);
      const transaction = { transactionId: `transaction:streamed-${transactionCalls}`, idempotencyKey: 'idempotency:g07-host', receiptDigest: `sha256:${'9'.repeat(64)}`, receiptArtifactId: `artifact:sha256:${'8'.repeat(64)}`, memberCount: 1, replayed: false };
      return { ...transaction, beforeRevision: transactionCalls, afterRevision: transactionCalls + 1, results: [calls[transactionCalls - 1]].map((id) => ({ schemaVersion: 1, callId: id, toolId: 'entity.create', status: 'completed', value: { entityId: `entity:${id}` }, documentId: 'document:test', beforeRevision: transactionCalls, afterRevision: transactionCalls + 1, historyLabel: 'Agent batch · 3 edits', transaction })) };
    },
  };
  const host = new StudioConversationHost({ runtime, tools, operationLog: { async append() {} }, isProjectOpen: () => true, projectContext: () => ({ projectId: 'project:test', documentId: 'document:test', revision: 1, manifest: {} }) });
  await host.initialize(); await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Create an atomic batch.' });
  await waitFor(() => host.replay().events.some((item) => item.node.kind === 'plan' && item.node.status === 'pending'));
  const plan = host.replay().events.map((item) => item.node).find((node) => node.kind === 'plan' && node.status === 'pending');
  await host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map((item) => item.id), mode: 'approve' });
  await waitFor(() => host.replay().busy === false);
  assert.equal(transactionCalls, 3); assert.deepEqual(submitted.map((item) => item.id), calls);
  assert.equal(new Set(submitted.map((item) => item.result.transaction.transactionId)).size, 3);
  assert.equal(sessionOps.filter((op) => op.kind === 'document.committed').length, 3);
  assert.equal(sessionOps.filter((op) => op.kind === 'tool.completed' && op.payload.transactionId?.startsWith('transaction:streamed-')).length, 3);
  await host.dispose();
});

test('Conversation Host exposes plan progress and retains exact approved IDs without changing scene execution', async () => {
  const calls = ['call:tx-a', 'call:tx-b', 'call:tx-c'];
  const submitted = []; const sessionOps = []; let transactionCalls = 0; let releasePlan; let approvedItems; let releaseProgress; const progressSubmitted = new Promise(resolve => { releaseProgress = resolve; });
  const planSubmitted = new Promise((resolve) => { releasePlan = resolve; });
  let releaseMutations; const mutationsSubmitted = new Promise((resolve) => { releaseMutations = resolve; });
  const backend = {
    descriptor: { id: backendId, kind: 'codex-app-server', protocolVersion: 'fixture', capabilities: {} },
    async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture', description: 'Fixture', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 8192, isDefault: true }] }; },
    async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async answerQuestion() {}, async resolveBackendApproval() {},
    async submitToolResult(id, result) { if (id === 'call:tx-plan') { approvedItems = result.value.items; releasePlan(); } else if (id === 'call:progress') { assert.equal(result.status, 'completed'); releaseProgress(); } else { submitted.push({ id, result }); if (submitted.length === calls.length) releaseMutations(); } },
  };
  const usage = new UsageLedgerStore();
  const handle = { id: sessionId, async append(op) { sessionOps.push(op); return {}; }, async checkpoint() { sessionOps.push({ kind: 'fixture.checkpoint' }); return {}; }, async dispose() {} };
  const runtime = {
    context: contextFixture(), usage, accounting: new TaskAccountingRegistry(usage), registry: { descriptors: () => [backend.descriptor], get: () => backend }, sessions: { async open() { return handle; } },
    turns: {
      async *start(_backendId, input) {
        usage.open({ taskId: input.taskId, sessionId, turnId, providerRequestDigest: null, startedAtMs: Date.now() });
        yield event('tool-request', { toolCallId: 'call:tx-plan', toolId: 'studio.plan.propose', arguments: { title: 'Atomic batch', summary: 'Create three independent entities atomically.', items: calls.map((id) => ({ label: id, details: `Create ${id}.` })) } });
        await planSubmitted;
        assert.ok(input.tools.some(tool => tool.id === 'studio.plan.update'));
        yield event('tool-request', { toolCallId: 'call:progress', toolId: 'studio.plan.update', arguments: { updates: approvedItems.slice(0, 2).map(item => ({ stepId: item.id, status: 'in_progress', summary: `创建 ${item.label}` })) } });
        await progressSubmitted;
        for (const [index, id] of calls.entries()) yield event('tool-request', { toolCallId: id, toolId: 'entity.create', arguments: { baseRevision: 1, kind: 'cube', name: `Entity ${index + 1}` } });
        await mutationsSubmitted;
        yield event('completed', { status: 'completed' });
      }, async *resume() {}, async cancel() {}, async recordToolResult() {},
    },
  };
  const preparations = new Map();
  const tools = {
    definitions: () => [{ ...definition('entity.create', false), effect: 'reversible-edit' }],
    async prepare(call) { const value = { id: `preparation:${call.id}`, callId: call.id, sessionId, turnId, toolId: call.toolId, toolVersion: '1.0.0', effect: 'reversible-edit', risk: 'low', documentId: 'document:test', baseRevision: 1, argumentsDigest: digest('a'), previewDigest: digest('b'), preview: { title: 'Create', target: 'Scene', summary: call.id, diff: `+ ${call.id}` }, status: 'ready' }; preparations.set(value.id, value); return value; },
    async execute() { throw new Error('individual mutation execution must not run'); }, async cancel() {},
    async executeTransaction(input) {
      transactionCalls += 1; assert.deepEqual(input.preparationIds, calls.map((id) => `preparation:${id}`));
      const transaction = { transactionId: 'transaction:g07-host', idempotencyKey: 'idempotency:g07-host', receiptDigest: `sha256:${'9'.repeat(64)}`, receiptArtifactId: `artifact:sha256:${'8'.repeat(64)}`, memberCount: calls.length, replayed: false };
      return { ...transaction, beforeRevision: 1, afterRevision: 2, results: calls.map((id) => ({ schemaVersion: 1, callId: id, toolId: 'entity.create', status: 'completed', value: { entityId: `entity:${id}` }, documentId: 'document:test', beforeRevision: 1, afterRevision: 2, historyLabel: 'Agent batch · 3 edits', transaction })) };
    },
  };
  const host = new StudioConversationHost({ runtime, tools, operationLog: { async append() {} }, isProjectOpen: () => true, projectContext: () => ({ projectId: 'project:test', documentId: 'document:test', revision: 1, manifest: {} }) });
  await host.initialize(); await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Create an atomic batch.' });
  await waitFor(() => host.replay().events.some((item) => item.node.kind === 'plan' && item.node.status === 'pending'));
  const plan = host.replay().events.map((item) => item.node).find((node) => node.kind === 'plan' && node.status === 'pending');
  await host.dispatch({ type: 'conversation/accept-plan', nodeId: plan.id, acceptedItemIds: plan.content.items.map((item) => item.id), mode: 'approve' });
  await waitFor(() => host.replay().busy === false);
  assert.equal(transactionCalls, 1, JSON.stringify(host.replay().events.filter(item => ['diagnostic', 'tool-result'].includes(item.node.kind)).map(item => item.node.content))); assert.deepEqual(submitted.map((item) => item.id), calls);
  assert.equal(new Set(submitted.map((item) => item.result.transaction.transactionId)).size, 1);
  assert.equal(sessionOps.filter((op) => op.kind === 'document.committed').length, 1);
  assert.equal(sessionOps.filter((op) => op.kind === 'tool.completed' && op.payload.transactionId === 'transaction:g07-host').length, 3);
  const updated = [...new Map(host.replay().events.map(item => [item.node.id, item.node])).values()].find(node => node.kind === 'plan');
  assert.equal(updated.content.items.filter(item => item.executionStatus === 'in_progress').length, 2);
  assert.ok(updated.content.items.every(item => item.status === 'accepted'));
  assert.equal(updated.content.taskId, host.replay().taskRuns.at(-1).taskId);
  await host.dispose();
});
