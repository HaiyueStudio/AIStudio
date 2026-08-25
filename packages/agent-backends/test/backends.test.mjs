import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import { asStableId } from '@haiyue/ai-studio-contracts';
import { CODEX_DISABLED_FEATURES, CODEX_ENABLED_FEATURES, CodexAppServerBackend, HarnessApiKeyBackend, sanitizedCodexEnvironment } from '../dist/index.js';

const promptProfile = Object.freeze({ id: asStableId('prompt:fixture'), version: '2.0.0', digest: `sha256:${'a'.repeat(64)}` });
function turnInput(backendId, model, reasoningEffort = 'high') { return { taskId: asStableId('task:fixture'), config: { schemaVersion: 2, backendId, model, reasoningEffort, outputTokenLimit: 8_192, taskBudgetId: asStableId('budget:fixture'), promptProfile, requestedCapabilities: ['agent.model-config', 'agent.usage', 'agent.cache', 'agent.context'] }, prompt: 'Create a cube', contextArtifactIds: [], tools: [{ id: asStableId('studio.entity.create'), description: 'Create entity', inputSchema: { type: 'object' } }] }; }
const harnessInput = turnInput(asStableId('backend:harness-api-key'), 'deepseek-v4-flash');
const input = turnInput(asStableId('backend:codex-app-server'), 'gpt-5.6-sol');

test('Harness and Codex normalize equivalent multi-step turns to the same semantic event kinds', async () => {
  const harness = new HarnessApiKeyBackend({ transport: fakeHarnessTransport(), clearApiKey: async () => {} });
  const codexTransport = new FakeCodexTransport(); const codex = new CodexAppServerBackend({ transport: codexTransport, isolatedCwd: 'D:\\isolated-ai-studio' });
  const harnessEvents = await collect(harness.startTurn(harnessInput));
  const codexEventsPromise = collect(codex.startTurn(input));
  await codexTransport.waitForTool(); await new Promise((resolve) => setImmediate(resolve)); await codex.submitToolResult(asStableId('call:1'), { entityId: 'cube' });
  const codexEvents = await codexEventsPromise;
  assert.deepEqual(harnessEvents.map((item) => item.kind), ['status', 'conversation-node', 'tool-request', 'usage', 'completed']);
  assert.deepEqual(codexEvents.map((item) => item.kind), ['status', 'conversation-node', 'tool-request', 'usage', 'completed']);
  assert.deepEqual(semanticProjection(codexEvents), semanticProjection(harnessEvents));
  for (const events of [harnessEvents, codexEvents]) {
    assert.equal(events[0].payload.model, events === harnessEvents ? 'deepseek-v4-flash' : 'gpt-5.6-sol');
    assert.equal(events[0].payload.reasoningEffort, 'high');
    const usage = events.find((item) => item.kind === 'usage').payload;
    assert.deepEqual({ inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, cacheWriteTokens: usage.cacheWriteTokens, outputTokens: usage.outputTokens, reasoningTokens: usage.reasoningTokens }, { inputTokens: 3, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 0 });
    assert.equal(events.at(-1).payload.finishReason, 'stop');
  }
  const threadStart = codexTransport.requests.find((item) => item.method === 'thread/start');
  assert.equal(threadStart.params.sandbox, 'read-only'); assert.equal(threadStart.params.approvalPolicy, 'never'); assert.deepEqual(threadStart.params.runtimeWorkspaceRoots, []); assert.deepEqual(threadStart.params.environments, []);
  assert.match(threadStart.params.dynamicTools[0].name, /^studio_0_[A-Za-z0-9_-]+$/); assert.doesNotMatch(threadStart.params.dynamicTools[0].name, /\./);
  assert.equal(codexEvents.find((item) => item.kind === 'tool-request').payload.toolId, 'studio.entity.create');
  assert.deepEqual(threadStart.params.input, undefined);
  assert.equal(threadStart.params.model, 'gpt-5.6-sol'); assert.equal(threadStart.params.allowProviderModelFallback, false);
  const turnStart = codexTransport.requests.find((item) => item.method === 'turn/start'); assert.equal(turnStart.params.model, 'gpt-5.6-sol'); assert.equal(turnStart.params.effort, 'high');
  assert.ok(['shell_tool', 'unified_exec', 'browser_use', 'apps', 'plugins', 'view_image'].every((feature) => CODEX_DISABLED_FEATURES.includes(feature)));
  assert.deepEqual(CODEX_ENABLED_FEATURES, ['default_mode_request_user_input']);
  await assertGeneratedClientSchema(codexTransport.requests);
  assert.deepEqual((await collect(harness.resumeTurn(asStableId('thread:1'), asStableId('turn:1')))).map((item) => item.kind), harnessEvents.map((item) => item.kind));
  assert.deepEqual((await collect(codex.resumeTurn(asStableId('thread:1'), asStableId('turn:1')))).map((item) => item.kind), codexEvents.map((item) => item.kind));
  await harness.dispose(); await codex.dispose();
});

test('both backends advertise model/reasoning capabilities and reject unsupported config without provider execution', async () => {
  const harness = new HarnessApiKeyBackend({ transport: fakeHarnessTransport(), clearApiKey: async () => {} });
  const codexTransport = new FakeCodexTransport(); const codex = new CodexAppServerBackend({ transport: codexTransport, isolatedCwd: 'D:\\isolated-ai-studio' });
  assert.deepEqual((await harness.modelCatalog()).models[0].reasoningEfforts, ['off', 'low', 'high', 'xhigh']);
  assert.deepEqual((await codex.modelCatalog()).models[0].reasoningEfforts, ['low', 'medium', 'high', 'xhigh']);
  assert.equal((await harness.negotiate({ ...harnessInput.config, reasoningEffort: 'medium' })).status, 'degraded');
  const codexNegotiation = await codex.negotiate(input.config); assert.equal(codexNegotiation.status, 'degraded'); assert.ok(codexNegotiation.diagnostics.some((item) => item.code === 'codex.output-limit-local'));
  assert.equal((await codex.negotiate({ ...input.config, model: 'not-advertised' })).status, 'rejected');
  assert.equal(codexTransport.requests.filter((item) => item.method === 'thread/start').length, 0);
  await harness.dispose(); await codex.dispose();
});

test('Harness preserves unknown provider cache evidence and Codex reuses a live thread without another thread/start', async () => {
  const transport = fakeHarnessTransport();
  transport.start = async function* () {
    yield { type: 'turn-start', sessionId: 'thread:unknown-cache', turnId: 'turn:unknown-cache' };
    yield { type: 'usage', sessionId: 'thread:unknown-cache', turnId: 'turn:unknown-cache', inputTokens: 4, outputTokens: 1 };
    yield { type: 'turn-end', sessionId: 'thread:unknown-cache', turnId: 'turn:unknown-cache', status: 'completed', finishReason: 'stop' };
  };
  const harness = new HarnessApiKeyBackend({ transport, clearApiKey: async () => {} });
  const usage = (await collect(harness.startTurn(harnessInput))).find((event) => event.kind === 'usage').payload;
  assert.deepEqual({ cached: usage.cachedInputTokens, written: usage.cacheWriteTokens, reasoning: usage.reasoningTokens }, { cached: null, written: null, reasoning: null });
  await harness.dispose();

  const codexTransport = new ReuseCodexTransport();
  const codex = new CodexAppServerBackend({ transport: codexTransport, isolatedCwd: 'D:\\isolated-ai-studio' });
  const noTools = { ...input, tools: [] };
  const first = await collect(codex.startTurn(noTools));
  const threadId = first[0].sessionId;
  const second = await collect(codex.startTurn({ ...noTools, sessionId: threadId, prompt: 'Continue with the durable summary.' }));
  assert.equal(second[0].sessionId, threadId);
  assert.equal(codexTransport.requests.filter((frame) => frame.method === 'thread/start').length, 1);
  assert.equal(codexTransport.requests.filter((frame) => frame.method === 'turn/start').length, 2);
  const codexDrift = await collect(codex.startTurn({ ...input, sessionId: threadId }));
  assert.ok(codexDrift.some((event) => event.kind === 'diagnostic' && event.payload.code === 'codex.thread-toolset-drift'));
  assert.equal(codexTransport.requests.filter((frame) => frame.method === 'turn/start').length, 2);
  await codex.dispose();
});

test('Harness session reuse rejects a changed Studio tool allowlist before provider execution', async () => {
  const transport = fakeHarnessTransport();
  let starts = 0;
  const originalStart = transport.start;
  transport.start = async function* (...args) { starts += 1; yield* originalStart.apply(this, args); };
  const backend = new HarnessApiKeyBackend({ transport, clearApiKey: async () => {} });
  await collect(backend.startTurn(harnessInput));
  const drift = await collect(backend.startTurn({ ...harnessInput, sessionId: asStableId('thread:1'), tools: [] }));
  assert.ok(drift.some((event) => event.kind === 'diagnostic' && event.payload.code === 'harness.session-toolset-drift'));
  assert.equal(starts, 1);
  await backend.dispose();
});

test('Harness auth, logout, tool result, cancellation and unsupported capability methods conform directly', async () => {
  let configured = false; let cleared = 0; let disposed = 0; const cancellations = []; const toolResults = [];
  const transport = fakeHarnessTransport();
  transport.configured = async () => configured;
  transport.submitToolResult = async (toolCallId, result) => { toolResults.push({ toolCallId, result }); };
  transport.cancel = async (sessionId) => { cancellations.push(sessionId); };
  transport.dispose = async () => { disposed += 1; };
  const backend = new HarnessApiKeyBackend({ transport, clearApiKey: async () => { configured = false; cleared += 1; } });
  assert.equal((await backend.status()).state, 'auth-required');
  assert.equal(await backend.authenticate(), null);
  configured = true;
  assert.equal((await backend.status()).state, 'ready');
  await backend.submitToolResult(asStableId('call:direct'), { ok: true });
  assert.deepEqual(toolResults, [{ toolCallId: 'call:direct', result: { ok: true } }]);
  await backend.cancelTurn(asStableId('thread:direct'), asStableId('turn:ignored-by-pinned-harness'));
  assert.deepEqual(cancellations, ['thread:direct']);
  await assert.rejects(backend.answerQuestion(asStableId('question:none'), {}), (error) => error.code === 'agent.question-unavailable');
  await assert.rejects(backend.resolveBackendApproval(asStableId('approval:none'), 'reject'), (error) => error.code === 'agent.approval-unavailable');
  assert.throws(() => backend.resumeTurn(asStableId('thread:none'), asStableId('turn:none')), (error) => error.code === 'agent.resume-missing');
  await backend.logout(); assert.equal(cleared, 1); assert.equal((await backend.status()).state, 'auth-required');
  await backend.dispose(); await backend.dispose(); assert.equal(disposed, 1);
  await assert.rejects(backend.answerQuestion(asStableId('question:none'), {}), (error) => error.code === 'agent.backend-disposed');
});

test('both backends bound provider event payloads and terminate oversized streams', async () => {
  const harnessTransport = fakeHarnessTransport();
  harnessTransport.start = async function* () {
    yield { type: 'turn-start', sessionId: 'thread:oversized', turnId: 'turn:oversized' };
    yield { type: 'text-delta', sessionId: 'thread:oversized', turnId: 'turn:oversized', text: 'x'.repeat(1024 * 1024 + 1) };
  };
  const harness = new HarnessApiKeyBackend({ transport: harnessTransport, clearApiKey: async () => {} });
  const harnessEvents = await collect(harness.startTurn(harnessInput));
  assert.ok(harnessEvents.some((event) => event.kind === 'diagnostic' && event.payload.code === 'agent.event-too-large'));
  assert.equal(harnessEvents.at(-1).payload.status, 'failed');
  await harness.dispose();

  const transport = new FakeCodexTransport({ oversizedFrame: true });
  const codex = new CodexAppServerBackend({ transport, isolatedCwd: 'D:\\isolated-ai-studio' });
  const codexEvents = await collect(codex.startTurn(input));
  assert.ok(codexEvents.some((event) => event.kind === 'diagnostic' && event.payload.code === 'codex.frame-too-large'));
  assert.equal(codexEvents.at(-1).payload.status, 'interrupted');
  await codex.dispose();
});

test('Codex model catalog fails closed on pinned schema drift', async () => {
  const backend = new CodexAppServerBackend({ transport: new FakeCodexTransport({ malformedCatalog: true }), isolatedCwd: 'D:\\isolated-ai-studio' });
  await assert.rejects(backend.modelCatalog(), (error) => error.code === 'codex.model-catalog-schema-drift');
  await backend.dispose();
});

test('Codex keeps user questions separate and denies every built-in effect at the wire boundary', async () => {
  const transport = new FakeCodexTransport({ question: true, builtinApproval: true }); const backend = new CodexAppServerBackend({ transport, isolatedCwd: 'D:\\isolated-ai-studio' });
  const pending = collect(backend.startTurn(input));
  await transport.waitForQuestion(); await new Promise((resolve) => setImmediate(resolve)); await backend.answerQuestion(asStableId('question:1'), { choice: { answers: ['safe'] } });
  const events = await pending;
  assert.ok(events.some((item) => item.kind === 'question'));
  assert.ok(events.some((item) => item.kind === 'approval' && item.payload.domain === 'codex-builtin' && item.payload.decision === 'reject'));
  assert.ok(events.some((item) => item.kind === 'diagnostic' && item.payload.code === 'codex.builtin-effect-denied'));
  assert.ok(transport.responses.some((item) => item.id === 'approval:rpc' && item.result.decision === 'decline'));
  await assert.rejects(backend.resolveBackendApproval(asStableId('approval:1'), 'allow'), (error) => error.code === 'codex.builtin-effect-denied');
  await backend.dispose();
});

test('auth state, browser handoff, logout, rate limit and cancel use the pinned protocol', async () => {
  const transport = new FakeCodexTransport({ authRequired: true }); const backend = new CodexAppServerBackend({ transport, isolatedCwd: 'D:\\isolated-ai-studio' });
  assert.equal((await backend.status()).state, 'auth-required');
  const handoff = await backend.authenticate(); assert.deepEqual(handoff, { id: asStableId('login:1'), kind: 'browser', url: 'https://example.invalid/login' });
  await backend.logout();
  const turn = collect(backend.startTurn(input)); await transport.waitForStarted();
  await backend.cancelTurn(asStableId('thread:1'), asStableId('turn:1')); await turn;
  assert.ok(transport.requests.some((item) => item.method === 'turn/interrupt'));
  await assert.rejects(backend.submitToolResult(asStableId('call:1'), { late: true }), (error) => error.code === 'agent.tool-result-unavailable');
  await backend.dispose();

  const deviceTransport = new FakeCodexTransport(); const device = new CodexAppServerBackend({ transport: deviceTransport, loginMode: 'device-code', isolatedCwd: 'D:\\isolated-ai-studio' });
  assert.deepEqual(await device.authenticate(), { id: asStableId('login:device'), kind: 'device-code', url: 'https://example.invalid/device', userCode: 'ABCD-EFGH' });
  await device.dispose();

  const malformedRates = new CodexAppServerBackend({ transport: new FakeCodexTransport({ malformedRateLimits: true }), isolatedCwd: 'D:\\isolated-ai-studio' });
  const malformedStatus = await malformedRates.status();
  assert.equal(malformedStatus.state, 'error');
  assert.equal(malformedStatus.diagnostic.code, 'codex.rate-limits-malformed');
  await malformedRates.dispose();
});

test('Codex normalizes 401 and 429 request failures to terminal auth/rate-limit diagnostics', async () => {
  for (const [status, code] of [[401, 'agent.auth-required'], [429, 'agent.rate-limited']]) {
    const transport = new FakeCodexTransport({ threadStartError: status }); const backend = new CodexAppServerBackend({ transport, isolatedCwd: 'D:\\isolated-ai-studio' });
    const events = await collect(backend.startTurn(input)); assert.equal(events.at(-1).payload.status, 'failed'); assert.ok(events.some((item) => item.kind === 'diagnostic' && item.payload.code === code)); await backend.dispose();
  }
});

test('Codex 5xx and unresponsive RPCs become retryable terminal failures', async () => {
  const unavailable = new CodexAppServerBackend({ transport: new FakeCodexTransport({ threadStartError: 503 }), isolatedCwd: 'D:\\isolated-ai-studio' });
  const unavailableEvents = await collect(unavailable.startTurn(input));
  const unavailableDiagnostic = unavailableEvents.find((event) => event.kind === 'diagnostic');
  assert.equal(unavailableDiagnostic.payload.code, 'codex.rpc-error');
  assert.equal(unavailableDiagnostic.payload.retryable, true);
  await unavailable.dispose();

  const transport = new FakeCodexTransport({ threadStartNoResponse: true });
  const timedOut = new CodexAppServerBackend({ transport, isolatedCwd: 'D:\\isolated-ai-studio', requestTimeoutMs: 20 });
  const timeoutEvents = await collect(timedOut.startTurn(input));
  const timeoutDiagnostic = timeoutEvents.find((event) => event.kind === 'diagnostic');
  assert.equal(timeoutDiagnostic.payload.code, 'codex.request-timeout');
  assert.equal(timeoutDiagnostic.payload.retryable, true);
  assert.equal(timeoutEvents.at(-1).payload.status, 'failed');
  await timedOut.dispose();
});

test('malformed JSON and process exit become terminal interrupted events; env drops credential variables', async () => {
  const malformed = new FakeCodexTransport({ malformedAfterStart: true, dirtyCwd: true }); const backend = new CodexAppServerBackend({ transport: malformed });
  const events = await collect(backend.startTurn(input)); assert.equal(events.at(-1).kind, 'completed'); assert.equal(events.at(-1).payload.status, 'interrupted'); assert.ok(events.some((item) => item.payload.code === 'codex.malformed-json'));
  const ownedCwd = malformed.requests.find((item) => item.method === 'thread/start').params.cwd; await backend.dispose(); await assert.rejects(stat(ownedCwd), (error) => error.code === 'ENOENT');
  const env = sanitizedCodexEnvironment({ PATH: 'ok', CODEX_HOME: 'ok', OPENAI_API_KEY: 'SECRET_CANARY', DEEPSEEK_API_KEY: 'SECRET_CANARY', RANDOM_SECRET: 'SECRET_CANARY' });
  assert.deepEqual(env, { PATH: 'ok', CODEX_HOME: 'ok' }); assert.doesNotMatch(JSON.stringify(env), /SECRET_CANARY/);
});

test('Codex disposal cleans its temporary cwd even when transport shutdown fails', async () => {
  const transport = new FakeCodexTransport({ disposeError: true }); const backend = new CodexAppServerBackend({ transport });
  const turn = collect(backend.startTurn(input)); await transport.waitForStarted();
  const ownedCwd = transport.requests.find((item) => item.method === 'thread/start').params.cwd;
  await assert.rejects(backend.dispose(), (error) => error instanceof AggregateError && /disposal failed/u.test(error.message));
  assert.equal((await turn).at(-1).payload.status, 'interrupted');
  await assert.rejects(stat(ownedCwd), (error) => error.code === 'ENOENT');
  await backend.dispose();
});

test('malformed terminal/usage notifications and duplicate tool ids fail closed and release pending RPCs', async () => {
  for (const [options, code] of [
    [{ malformedUsage: true }, 'codex.usage-malformed'],
    [{ malformedTerminal: true }, 'codex.turn-completed-malformed'],
    [{ duplicateTool: true }, 'codex.tool-call-duplicate'],
  ]) {
    const transport = new FakeCodexTransport(options);
    const backend = new CodexAppServerBackend({ transport, isolatedCwd: 'D:\\isolated-ai-studio' });
    const events = await collect(backend.startTurn(input));
    assert.equal(events.at(-1).payload.status, 'failed');
    assert.ok(events.some((item) => item.kind === 'diagnostic' && item.payload.code === code), JSON.stringify(events));
    await assert.rejects(backend.submitToolResult(asStableId('call:1'), { late: true }), (error) => error.code === 'agent.tool-result-unavailable');
    await backend.dispose();
  }
});

test('child crash terminates the turn and a fresh pinned backend restarts cleanly', async () => {
  const crashedTransport = new FakeCodexTransport({ crashAfterStart: true }); const crashed = new CodexAppServerBackend({ transport: crashedTransport, isolatedCwd: 'D:\\isolated-ai-studio' });
  const crashedEvents = await collect(crashed.startTurn(input)); assert.equal(crashedEvents.at(-1).payload.status, 'interrupted'); assert.ok(crashedEvents.some((item) => item.payload.code === 'codex.process-exited')); await crashed.dispose();
  const restartedTransport = new FakeCodexTransport(); const restarted = new CodexAppServerBackend({ transport: restartedTransport, isolatedCwd: 'D:\\isolated-ai-studio' });
  const pending = collect(restarted.startTurn(input)); await restartedTransport.waitForTool(); await new Promise((resolve) => setImmediate(resolve)); await restarted.submitToolResult(asStableId('call:1'), { ok: true });
  assert.equal((await pending).at(-1).payload.status, 'completed'); await restarted.dispose();
});

test('Electron main launches the pinned Codex JS entry in Node mode without widening the env allowlist', async () => {
  const source = await readFile(new URL('../src/codex-backend.ts', import.meta.url), 'utf8');
  assert.match(source, /process\.versions\.electron/);
  assert.match(source, /env\.ELECTRON_RUN_AS_NODE = '1'/);
  assert.doesNotMatch(source, /ELECTRON_RUN_AS_NODE.*process\.env/);
});

test('the opt-in DeepSeek real smoke uses the current versioned turn configuration', async () => {
  const source = await readFile(new URL('./deepseek-real.smoke.mjs', import.meta.url), 'utf8');
  assert.match(source, /schemaVersion:\s*2/);
  assert.match(source, /reasoningEffort:\s*'high'/);
  assert.match(source, /taskId:\s*'task:g07-deepseek-real'/);
  assert.doesNotMatch(source, /startTurn\(\{\s*prompt:/);
});

test('the opt-in Codex real smoke covers auth, text, dynamic tool, question and cancel with current config', async () => {
  const source = await readFile(new URL('./codex-real.smoke.mjs', import.meta.url), 'utf8');
  for (const evidence of ['HAIYUE_STUDIO_ALLOW_REAL_CODEX_SMOKE', 'schemaVersion: 2', 'G07_CODEX_OK', 'G07_TOOL_NONCE_OK', 'CHOICE_OK', 'cancelOnStart']) assert.match(source, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
});

function fakeHarnessTransport() {
  return { upstream: { tag: 'dsh-v0.1.0-rc.7', commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca' }, configured: async () => true,
    modelCatalog: () => [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'fixture', maxTokens: 384_000 }],
    async *start() { yield { type: 'turn-start', sessionId: 'thread:1', turnId: 'turn:1' }; yield { type: 'text-delta', sessionId: 'thread:1', turnId: 'turn:1', text: 'done' }; yield { type: 'tool-request', sessionId: 'thread:1', turnId: 'turn:1', toolCallId: 'call:1', toolId: 'studio.entity.create', arguments: { name: 'Cube' } }; yield { type: 'usage', sessionId: 'thread:1', turnId: 'turn:1', inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }; yield { type: 'turn-end', sessionId: 'thread:1', turnId: 'turn:1', status: 'completed', finishReason: 'stop' }; },
    submitToolResult: async () => {}, cancel: async () => {}, dispose: async () => {}, };
}

class FakeCodexTransport {
  constructor(options = {}) { this.options = options; this.queue = new AsyncQueue(); this.lines = this.queue; this.requests = []; this.responses = []; this.exited = new Promise((resolve) => { this.resolveExit = resolve; }); this.toolPromise = new Promise((resolve) => { this.toolResolve = resolve; }); this.questionPromise = new Promise((resolve) => { this.questionResolve = resolve; }); this.startedPromise = new Promise((resolve) => { this.startedResolve = resolve; }); }
  async write(line) {
    const frame = JSON.parse(line); if (!frame.method) { this.responses.push(frame); if (frame.id === 'tool:rpc') this.finish(); if (frame.id === 'question:rpc') this.afterQuestion(); return; }
    if (!('id' in frame)) return; this.requests.push(frame);
    if (frame.method === 'initialize') this.result(frame.id, { userAgent: 'fixture', codexHome: 'D:\\fixture', platformFamily: 'windows', platformOs: 'windows' });
    else if (frame.method === 'account/read') this.result(frame.id, { account: this.options.authRequired ? null : { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true });
    else if (frame.method === 'account/rateLimits/read') this.result(frame.id, this.options.malformedRateLimits ? { rateLimits: { primary: { usedPercent: 'invalid' } }, rateLimitsByLimitId: null } : { rateLimits: { limitId: 'codex', limitName: 'Codex', primary: { usedPercent: 12, resetsAt: 1_800_000_000 }, secondary: null, credits: null, individualLimit: null, spendControlReached: null, planType: 'plus', rateLimitReachedType: null }, rateLimitsByLimitId: null, rateLimitResetCredits: null });
    else if (frame.method === 'account/login/start') this.result(frame.id, frame.params.type === 'chatgptDeviceCode' ? { type: 'chatgptDeviceCode', loginId: 'login:device', verificationUrl: 'https://example.invalid/device', userCode: 'ABCD-EFGH' } : { type: 'chatgpt', loginId: 'login:1', authUrl: 'https://example.invalid/login' });
    else if (frame.method === 'account/logout') this.result(frame.id, {});
    else if (frame.method === 'model/list') this.result(frame.id, this.options.malformedCatalog ? { data: [{ model: 'drifted' }] } : { data: [{ id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'fixture', hidden: false, isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'low' }, { reasoningEffort: 'medium', description: 'medium' }, { reasoningEffort: 'high', description: 'high' }, { reasoningEffort: 'xhigh', description: 'xhigh' }] }], nextCursor: null });
    else if (frame.method === 'thread/start') { if (this.options.threadStartError) this.error(frame.id, this.options.threadStartError, `HTTP ${this.options.threadStartError}`); else if (!this.options.threadStartNoResponse) { if (this.options.dirtyCwd) { const nested = path.join(frame.params.cwd, 'nested'); await mkdir(nested, { recursive: true }); await writeFile(path.join(nested, 'owned.txt'), 'fixture'); } this.toolWireName = frame.params.dynamicTools[0]?.name; this.result(frame.id, { thread: { id: 'thread:1' } }); } }
    else if (frame.method === 'turn/start') { this.result(frame.id, { turn: { id: 'turn:1', status: 'inProgress' } }); setImmediate(() => this.started()); }
    else if (frame.method === 'turn/interrupt') { this.result(frame.id, {}); this.notify('turn/completed', { threadId: 'thread:1', turn: { id: 'turn:1', status: 'interrupted', error: null } }); }
  }
  result(id, result) { this.queue.push(JSON.stringify({ id, result })); }
  error(id, code, message) { this.queue.push(JSON.stringify({ id, error: { code, message } })); }
  notify(method, params) { this.queue.push(JSON.stringify({ method, params })); }
  started() {
    this.notify('item/agentMessage/delta', { threadId: 'thread:1', turnId: 'turn:1', itemId: 'message:1', delta: 'done' });
    if (this.options.crashAfterStart) { this.queue.close(); this.resolveExit({ code: 9, signal: null }); return; }
    if (this.options.malformedAfterStart) { this.queue.push('{malformed'); return; }
    if (this.options.oversizedFrame) { this.notify('item/agentMessage/delta', { threadId: 'thread:1', turnId: 'turn:1', itemId: 'message:oversized', delta: 'x'.repeat(2 * 1024 * 1024 + 1) }); return; }
    if (this.options.malformedUsage) { this.notify('thread/tokenUsage/updated', { threadId: 'thread:1', turnId: 'turn:1', tokenUsage: null }); return; }
    if (this.options.malformedTerminal) { this.notify('turn/completed', { threadId: 'thread:1', turn: { id: 'turn:1' } }); return; }
    if (this.options.question) { this.queue.push(JSON.stringify({ id: 'question:rpc', method: 'item/tool/requestUserInput', params: { threadId: 'thread:1', turnId: 'turn:1', itemId: 'question:1', questions: [{ id: 'choice', header: 'Choice', question: 'Continue?', isOther: false, isSecret: false, options: null }], isBlocking: true, autoResolutionMs: null } })); this.questionResolve?.(); }
    else this.tool();
    if (this.options.duplicateTool) this.tool();
    if (this.options.builtinApproval && !this.options.question) this.queue.push(JSON.stringify({ id: 'approval:rpc', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread:1', turnId: 'turn:1', itemId: 'command:1' } }));
    this.startedResolve?.();
  }
  afterQuestion() { if (this.options.builtinApproval) this.queue.push(JSON.stringify({ id: 'approval:rpc', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread:1', turnId: 'turn:1', itemId: 'command:1' } })); setImmediate(() => this.finish()); }
  tool() { this.queue.push(JSON.stringify({ id: 'tool:rpc', method: 'item/tool/call', params: { threadId: 'thread:1', turnId: 'turn:1', callId: 'call:1', namespace: null, tool: this.toolWireName, arguments: { name: 'Cube' } } })); this.toolResolve?.(); }
  finish() { this.notify('thread/tokenUsage/updated', { threadId: 'thread:1', turnId: 'turn:1', tokenUsage: { total: { inputTokens: 3, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 5 }, last: { inputTokens: 3, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 5 }, modelContextWindow: 100 } }); this.notify('turn/completed', { threadId: 'thread:1', turn: { id: 'turn:1', status: 'completed', error: null } }); }
  waitForTool() { return this.toolPromise; } waitForQuestion() { return this.questionPromise; } waitForStarted() { return this.startedPromise; }
  async dispose() { this.queue.close(); this.resolveExit({ code: 0, signal: null }); if (this.options.disposeError) throw new Error('fixture transport shutdown failure'); }
}
class ReuseCodexTransport {
  constructor() { this.queue = new AsyncQueue(); this.lines = this.queue; this.requests = []; this.turn = 0; this.exited = new Promise((resolve) => { this.resolveExit = resolve; }); }
  async write(line) {
    const frame = JSON.parse(line); if (!frame.method || !('id' in frame)) return; this.requests.push(frame);
    if (frame.method === 'initialize') this.result(frame.id, { userAgent: 'fixture', codexHome: 'D:\\fixture', platformFamily: 'windows', platformOs: 'windows' });
    else if (frame.method === 'account/read') this.result(frame.id, { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true });
    else if (frame.method === 'account/rateLimits/read') this.result(frame.id, { rateLimits: null, rateLimitsByLimitId: null });
    else if (frame.method === 'model/list') this.result(frame.id, { data: [{ id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'fixture', hidden: false, isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'high' }] }], nextCursor: null });
    else if (frame.method === 'thread/start') this.result(frame.id, { thread: { id: 'thread:reuse' } });
    else if (frame.method === 'turn/start') { this.turn += 1; const turnId = `turn:reuse:${this.turn}`; this.result(frame.id, { turn: { id: turnId, status: 'inProgress' } }); setImmediate(() => this.queue.push(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread:reuse', turn: { id: turnId, status: 'completed', error: null } } }))); }
  }
  result(id, result) { this.queue.push(JSON.stringify({ id, result })); }
  async dispose() { this.queue.close(); this.resolveExit({ code: 0, signal: null }); }
}
class AsyncQueue { constructor() { this.values = []; this.waiters = []; this.done = false; } push(value) { const waiter = this.waiters.shift(); waiter ? waiter({ done: false, value }) : this.values.push(value); } close() { this.done = true; for (const waiter of this.waiters.splice(0)) waiter({ done: true }); } async *[Symbol.asyncIterator]() { while (true) { if (this.values.length) { yield this.values.shift(); continue; } if (this.done) return; const next = await new Promise((resolve) => this.waiters.push(resolve)); if (next.done) return; yield next.value; } } }
async function collect(stream) { const values = []; for await (const item of stream) values.push(item); return values; }
function semanticProjection(events) { return events.map((event) => ({ kind: event.kind, status: event.payload.status, finishReason: event.payload.finishReason, delta: event.payload.delta, toolId: event.payload.toolId, arguments: event.payload.arguments, inputTokens: event.payload.inputTokens, outputTokens: event.payload.outputTokens, cachedInputTokens: event.payload.cachedInputTokens, cacheWriteTokens: event.payload.cacheWriteTokens, reasoningTokens: event.payload.reasoningTokens })); }
async function assertGeneratedClientSchema(frames) { const schema = JSON.parse(await readFile(new URL('../../../docs/upstream/codex/app-server-schema-0.148.0/ClientRequest.json', import.meta.url), 'utf8')); const validate = new Ajv({ strict: false, formats: { int64: true, uint64: true, uint32: true, uint16: true, uint: true } }).compile(schema); for (const frame of frames) assert.equal(validate(frame), true, `${frame.method}: ${JSON.stringify(validate.errors)}`); }
