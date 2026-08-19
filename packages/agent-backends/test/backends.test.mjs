import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import Ajv from 'ajv';
import { asStableId } from '@haiyue/ai-studio-contracts';
import { CODEX_DISABLED_FEATURES, CODEX_ENABLED_FEATURES, CodexAppServerBackend, HarnessApiKeyBackend, sanitizedCodexEnvironment } from '../dist/index.js';

const input = { prompt: 'Create a cube', contextArtifactIds: [], tools: [{ id: asStableId('studio.entity.create'), description: 'Create entity', inputSchema: { type: 'object' } }] };

test('Harness and Codex normalize equivalent multi-step turns to the same semantic event kinds', async () => {
  const harness = new HarnessApiKeyBackend({ transport: fakeHarnessTransport(), clearApiKey: async () => {} });
  const codexTransport = new FakeCodexTransport(); const codex = new CodexAppServerBackend({ transport: codexTransport, isolatedCwd: 'D:\\isolated-ai-studio' });
  const harnessEvents = await collect(harness.startTurn(input));
  const codexEventsPromise = collect(codex.startTurn(input));
  await codexTransport.waitForTool(); await new Promise((resolve) => setImmediate(resolve)); await codex.submitToolResult(asStableId('call:1'), { entityId: 'cube' });
  const codexEvents = await codexEventsPromise;
  assert.deepEqual(harnessEvents.map((item) => item.kind), ['status', 'conversation-node', 'tool-request', 'usage', 'completed']);
  assert.deepEqual(codexEvents.map((item) => item.kind), ['status', 'conversation-node', 'tool-request', 'usage', 'completed']);
  assert.deepEqual(semanticProjection(codexEvents), semanticProjection(harnessEvents));
  const threadStart = codexTransport.requests.find((item) => item.method === 'thread/start');
  assert.equal(threadStart.params.sandbox, 'read-only'); assert.equal(threadStart.params.approvalPolicy, 'never'); assert.deepEqual(threadStart.params.runtimeWorkspaceRoots, []); assert.deepEqual(threadStart.params.environments, []);
  assert.match(threadStart.params.dynamicTools[0].name, /^studio_0_[A-Za-z0-9_-]+$/); assert.doesNotMatch(threadStart.params.dynamicTools[0].name, /\./);
  assert.equal(codexEvents.find((item) => item.kind === 'tool-request').payload.toolId, 'studio.entity.create');
  assert.deepEqual(threadStart.params.input, undefined);
  assert.ok(['shell_tool', 'unified_exec', 'browser_use', 'apps', 'plugins', 'view_image'].every((feature) => CODEX_DISABLED_FEATURES.includes(feature)));
  assert.deepEqual(CODEX_ENABLED_FEATURES, ['default_mode_request_user_input']);
  await assertGeneratedClientSchema(codexTransport.requests);
  assert.deepEqual((await collect(harness.resumeTurn(asStableId('thread:1'), asStableId('turn:1')))).map((item) => item.kind), harnessEvents.map((item) => item.kind));
  assert.deepEqual((await collect(codex.resumeTurn(asStableId('thread:1'), asStableId('turn:1')))).map((item) => item.kind), codexEvents.map((item) => item.kind));
  await harness.dispose(); await codex.dispose();
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
  await backend.dispose();

  const deviceTransport = new FakeCodexTransport(); const device = new CodexAppServerBackend({ transport: deviceTransport, loginMode: 'device-code', isolatedCwd: 'D:\\isolated-ai-studio' });
  assert.deepEqual(await device.authenticate(), { id: asStableId('login:device'), kind: 'device-code', url: 'https://example.invalid/device', userCode: 'ABCD-EFGH' });
  await device.dispose();
});

test('Codex normalizes 401 and 429 request failures to terminal auth/rate-limit diagnostics', async () => {
  for (const [status, code] of [[401, 'agent.auth-required'], [429, 'agent.rate-limited']]) {
    const transport = new FakeCodexTransport({ threadStartError: status }); const backend = new CodexAppServerBackend({ transport, isolatedCwd: 'D:\\isolated-ai-studio' });
    const events = await collect(backend.startTurn(input)); assert.equal(events.at(-1).payload.status, 'failed'); assert.ok(events.some((item) => item.kind === 'diagnostic' && item.payload.code === code)); await backend.dispose();
  }
});

test('malformed JSON and process exit become terminal interrupted events; env drops credential variables', async () => {
  const malformed = new FakeCodexTransport({ malformedAfterStart: true }); const backend = new CodexAppServerBackend({ transport: malformed });
  const events = await collect(backend.startTurn(input)); assert.equal(events.at(-1).kind, 'completed'); assert.equal(events.at(-1).payload.status, 'interrupted'); assert.ok(events.some((item) => item.payload.code === 'codex.malformed-json'));
  const ownedCwd = malformed.requests.find((item) => item.method === 'thread/start').params.cwd; await backend.dispose(); await assert.rejects(stat(ownedCwd), (error) => error.code === 'ENOENT');
  const env = sanitizedCodexEnvironment({ PATH: 'ok', CODEX_HOME: 'ok', OPENAI_API_KEY: 'SECRET_CANARY', DEEPSEEK_API_KEY: 'SECRET_CANARY', RANDOM_SECRET: 'SECRET_CANARY' });
  assert.deepEqual(env, { PATH: 'ok', CODEX_HOME: 'ok' }); assert.doesNotMatch(JSON.stringify(env), /SECRET_CANARY/);
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

function fakeHarnessTransport() {
  return { upstream: { tag: 'dsh-v0.1.0-rc.7', commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca' }, configured: async () => true,
    async *start() { yield { type: 'turn-start', sessionId: 'thread:1', turnId: 'turn:1' }; yield { type: 'text-delta', sessionId: 'thread:1', turnId: 'turn:1', text: 'done' }; yield { type: 'tool-request', sessionId: 'thread:1', turnId: 'turn:1', toolCallId: 'call:1', toolId: 'studio.entity.create', arguments: { name: 'Cube' } }; yield { type: 'usage', sessionId: 'thread:1', turnId: 'turn:1', inputTokens: 3, outputTokens: 2 }; yield { type: 'turn-end', sessionId: 'thread:1', turnId: 'turn:1', status: 'completed' }; },
    submitToolResult: async () => {}, cancel: async () => {}, dispose: async () => {}, };
}

class FakeCodexTransport {
  constructor(options = {}) { this.options = options; this.queue = new AsyncQueue(); this.lines = this.queue; this.requests = []; this.responses = []; this.exited = new Promise((resolve) => { this.resolveExit = resolve; }); this.toolPromise = new Promise((resolve) => { this.toolResolve = resolve; }); this.questionPromise = new Promise((resolve) => { this.questionResolve = resolve; }); this.startedPromise = new Promise((resolve) => { this.startedResolve = resolve; }); }
  async write(line) {
    const frame = JSON.parse(line); if (!frame.method) { this.responses.push(frame); if (frame.id === 'tool:rpc') this.finish(); if (frame.id === 'question:rpc') this.afterQuestion(); return; }
    if (!('id' in frame)) return; this.requests.push(frame);
    if (frame.method === 'initialize') this.result(frame.id, { userAgent: 'fixture', codexHome: 'D:\\fixture', platformFamily: 'windows', platformOs: 'windows' });
    else if (frame.method === 'account/read') this.result(frame.id, { account: this.options.authRequired ? null : { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true });
    else if (frame.method === 'account/rateLimits/read') this.result(frame.id, { rateLimits: { limitId: 'codex', limitName: 'Codex', primary: { usedPercent: 12, resetsAt: 1_800_000_000 }, secondary: null, credits: null, individualLimit: null, spendControlReached: null, planType: 'plus', rateLimitReachedType: null }, rateLimitsByLimitId: null, rateLimitResetCredits: null });
    else if (frame.method === 'account/login/start') this.result(frame.id, frame.params.type === 'chatgptDeviceCode' ? { type: 'chatgptDeviceCode', loginId: 'login:device', verificationUrl: 'https://example.invalid/device', userCode: 'ABCD-EFGH' } : { type: 'chatgpt', loginId: 'login:1', authUrl: 'https://example.invalid/login' });
    else if (frame.method === 'account/logout') this.result(frame.id, {});
    else if (frame.method === 'thread/start') { if (this.options.threadStartError) this.error(frame.id, this.options.threadStartError, `HTTP ${this.options.threadStartError}`); else { this.toolWireName = frame.params.dynamicTools[0]?.name; this.result(frame.id, { thread: { id: 'thread:1' } }); } }
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
    if (this.options.question) { this.queue.push(JSON.stringify({ id: 'question:rpc', method: 'item/tool/requestUserInput', params: { threadId: 'thread:1', turnId: 'turn:1', itemId: 'question:1', questions: [{ id: 'choice', header: 'Choice', question: 'Continue?', isOther: false, isSecret: false, options: null }], isBlocking: true, autoResolutionMs: null } })); this.questionResolve?.(); }
    else this.tool();
    if (this.options.builtinApproval && !this.options.question) this.queue.push(JSON.stringify({ id: 'approval:rpc', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread:1', turnId: 'turn:1', itemId: 'command:1' } }));
    this.startedResolve?.();
  }
  afterQuestion() { if (this.options.builtinApproval) this.queue.push(JSON.stringify({ id: 'approval:rpc', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread:1', turnId: 'turn:1', itemId: 'command:1' } })); setImmediate(() => this.finish()); }
  tool() { this.queue.push(JSON.stringify({ id: 'tool:rpc', method: 'item/tool/call', params: { threadId: 'thread:1', turnId: 'turn:1', callId: 'call:1', namespace: null, tool: this.toolWireName, arguments: { name: 'Cube' } } })); this.toolResolve?.(); }
  finish() { this.notify('thread/tokenUsage/updated', { threadId: 'thread:1', turnId: 'turn:1', tokenUsage: { total: { inputTokens: 3, outputTokens: 2 }, last: { inputTokens: 3, outputTokens: 2 }, modelContextWindow: 100 } }); this.notify('turn/completed', { threadId: 'thread:1', turn: { id: 'turn:1', status: 'completed', error: null } }); }
  waitForTool() { return this.toolPromise; } waitForQuestion() { return this.questionPromise; } waitForStarted() { return this.startedPromise; }
  async dispose() { this.queue.close(); this.resolveExit({ code: 0, signal: null }); }
}
class AsyncQueue { constructor() { this.values = []; this.waiters = []; this.done = false; } push(value) { const waiter = this.waiters.shift(); waiter ? waiter({ done: false, value }) : this.values.push(value); } close() { this.done = true; for (const waiter of this.waiters.splice(0)) waiter({ done: true }); } async *[Symbol.asyncIterator]() { while (true) { if (this.values.length) { yield this.values.shift(); continue; } if (this.done) return; const next = await new Promise((resolve) => this.waiters.push(resolve)); if (next.done) return; yield next.value; } } }
async function collect(stream) { const values = []; for await (const item of stream) values.push(item); return values; }
function semanticProjection(events) { return events.map((event) => ({ kind: event.kind, status: event.payload.status, delta: event.payload.delta, toolId: event.payload.toolId, arguments: event.payload.arguments, inputTokens: event.payload.inputTokens, outputTokens: event.payload.outputTokens })); }
async function assertGeneratedClientSchema(frames) { const schema = JSON.parse(await readFile(new URL('../../../docs/upstream/codex/app-server-schema-0.148.0/ClientRequest.json', import.meta.url), 'utf8')); const validate = new Ajv({ strict: false, formats: { int64: true, uint64: true, uint32: true, uint16: true, uint: true } }).compile(schema); for (const frame of frames) assert.equal(validate(frame), true, `${frame.method}: ${JSON.stringify(validate.errors)}`); }
