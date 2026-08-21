import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentPreviewBroker } from '../dist/agent-preview-broker.js';
import { StudioConversationHost } from '../dist/conversation-host.js';

const backendId = 'backend:test-agent';
const sessionId = 'session:test-agent';
const turnId = 'turn:test-agent';
const toolCallId = 'tool-call:test-agent';
const approvalId = 'approval:test-agent';

test('G10 conversation host runs typed tools through scoped approval and replay', async () => {
  let submitted;
  let startedInput;
  let openedHandoff;
  let releaseTool;
  const toolReleased = new Promise((resolve) => { releaseTool = resolve; });
  const backend = {
    descriptor: { id: backendId, kind: 'harness-api-key', protocolVersion: 'fixture', capabilities: {} },
    async status() { return { state: 'ready', authMode: 'api-key', rateLimits: [] }; },
    async authenticate() { return { id: 'login:test-agent', kind: 'browser', url: 'https://example.invalid/login' }; }, async logout() {}, async cancelTurn() {}, async dispose() {},
    async submitToolResult(_id, result) { submitted = result; releaseTool(); },
    async answerQuestion() {}, async resolveBackendApproval() {},
  };
  const runtime = {
    registry: { descriptors: () => [backend.descriptor], get: () => backend },
    turns: {
      async *start(_backendId, input) {
        startedInput = input;
        yield event('status', { status: 'running' });
        yield event('tool-request', { toolCallId, toolId: 'entity.create', arguments: { baseRevision: 1, kind: 'cube', name: 'Player' } });
        await toolReleased;
        yield event('conversation-node', { nodeKind: 'text', status: 'streaming', delta: 'Created the Player cube.' });
        yield event('completed', { status: 'completed' });
      },
      async *resume() {}, async cancel() {},
    },
  };
  let decision;
  const tools = {
    definitions: () => [{ id: 'entity.create', description: 'Create entity', effect: 'reversible-edit', risk: 'medium', inputSchema: {} }],
    async prepare() { return { id: 'preparation:test-agent', callId: toolCallId, sessionId, turnId, toolId: 'entity.create', toolVersion: '1.0.0', effect: 'reversible-edit', risk: 'medium', documentId: 'document:test', baseRevision: 1, argumentsDigest: digest('a'), previewDigest: digest('b'), preview: { title: 'Create', target: 'Scene', summary: 'Create Player cube', diff: '+ Player' }, status: 'approval-required', approvalId, expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    approval() { return { schemaVersion: 1, approvalId, preparationId: 'preparation:test-agent', toolCallId, toolId: 'entity.create', toolVersion: '1.0.0', effect: 'reversible-edit', risk: 'medium', argumentsDigest: digest('a'), previewDigest: digest('b'), documentId: 'document:test', baseRevision: 1, target: 'Scene', expiresAt: new Date(Date.now() + 60_000).toISOString(), decision: 'pending' }; },
    async decide(_id, value) { decision = value; return { ...this.approval(), decision: value }; },
    async execute() { return { schemaVersion: 1, callId: toolCallId, toolId: 'entity.create', status: 'completed', value: { entityId: 'entity:player' }, documentId: 'document:test', beforeRevision: 1, afterRevision: 2, historyLabel: 'Create Cube/Empty' }; },
  };
  const logEvents = [];
  const host = new StudioConversationHost({
    runtime, tools, operationLog: { async append(value) { logEvents.push(value); } },
    isProjectOpen: () => true,
    async openLoginHandoff(id, handoff) { openedHandoff = { id, handoff }; },
  });
  await host.initialize();
  const observedBusy = [];
  const subscription = host.subscribe(() => observedBusy.push(host.replay().busy));
  assert.equal(host.replay().backendId, backendId);
  await host.dispatch({ type: 'backend/authenticate', backendId });
  assert.deepEqual(openedHandoff, { id: backendId, handoff: { id: 'login:test-agent', kind: 'browser', url: 'https://example.invalid/login' } });
  await host.dispatch({ type: 'conversation/send', backendId, prompt: 'Create a Player cube' });
  await waitFor(() => nodes(host).some((node) => node.kind === 'approval' && node.status === 'pending'));
  await host.dispatch({ type: 'conversation/resolve-approval', approvalId, decision: 'allow-always' });
  await waitFor(() => host.replay().busy === false);
  assert.equal(decision, 'allow-always');
  assert.match(startedInput.prompt, /"open":true/);
  assert.match(startedInput.prompt, /A project is open\. Do not claim that no AIStudio project is open\./);
  assert.match(startedInput.prompt, /Use entity\.create for every authoring-scene object/);
  assert.match(startedInput.prompt, /create at least one kind="cube" entity before proposing scripts/);
  assert.match(startedInput.prompt, /Do not retry preview\.start unchanged/);
  assert.match(startedInput.prompt, /User request:\nCreate a Player cube$/);
  assert.equal(submitted.status, 'completed');
  assert.ok(nodes(host).some((node) => node.kind === 'approval' && node.status === 'completed'));
  const approvalNode = nodes(host).find((node) => node.kind === 'approval');
  assert.equal(approvalNode.content.argsDigest, `sha256:${'a'.repeat(64)}`);
  assert.equal(approvalNode.content.previewDigest, `sha256:${'b'.repeat(64)}`);
  assert.ok(nodes(host).some((node) => node.kind === 'tool-result' && node.status === 'completed'));
  assert.ok(nodes(host).some((node) => node.kind === 'text' && node.content.text.includes('Player cube')));
  assert.ok(nodes(host).some((node) => node.kind === 'completion' && node.content.terminalStatus === 'completed'));
  assert.ok(observedBusy.includes(true));
  assert.equal(observedBusy.at(-1), false);
  assert.ok(logEvents.some((item) => item.kind === 'conversation/intent' && item.payload.promptDigest && !JSON.stringify(item).includes('Create a Player cube')));
  await assert.rejects(host.dispatch({ type: 'conversation/resolve-approval', approvalId, decision: 'allow-always' }), /stale|already resolved/);
  subscription.dispose();
  await host.dispose();
  await host.dispose();
});

test('G10 conversation host gives project-missing turns recovery instructions that work across independent turns', async () => {
  let startedInput;
  const backend = {
    descriptor: { id: backendId, kind: 'harness-api-key', protocolVersion: 'fixture', capabilities: {} },
    async status() { return { state: 'ready', authMode: 'api-key', rateLimits: [] }; },
    async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {},
    async submitToolResult() {}, async answerQuestion() {}, async resolveBackendApproval() {},
  };
  const runtime = {
    registry: { descriptors: () => [backend.descriptor], get: () => backend },
    turns: {
      async *start(_backendId, input) { startedInput = input; yield event('completed', { status: 'completed' }); },
      async *resume() {}, async cancel() {},
    },
  };
  const tools = { definitions: () => [{ id: 'project.snapshot', description: 'Read project', effect: 'observe', risk: 'low', inputSchema: {} }] };
  const host = new StudioConversationHost({ runtime, tools, operationLog: { async append() {} }, isProjectOpen: () => false });
  await host.initialize();
  await host.dispatch({ type: 'conversation/send', backendId, prompt: '创建一个游戏' });
  await waitFor(() => host.replay().busy === false);
  assert.match(startedInput.prompt, /"open":false/);
  assert.match(startedInput.prompt, /resend the complete request/);
  assert.match(startedInput.prompt, /do not tell them to reply only with "continue"/);
  assert.match(startedInput.tools.find((tool) => tool.id === 'project.snapshot').description, /before deciding whether a Studio project is open/);
  await host.dispose();
});

test('G10 renderer preview broker uses one pending command and rejects stale acknowledgements', async () => {
  const broker = new AgentPreviewBroker();
  const plan = { id: 'preview-plan:test', scriptId: 'script:test', entityId: 'entity:test', documentRevision: 1, textRevision: 1, digest: 'digest:test', capabilities: ['read'], risk: 'trusted-project', diagnostics: [], emittedText: 'return;' };
  const scene = { schemaVersion: 1, revision: 1, documentId: 'document:test', entities: [{ id: 'entity:test', name: 'Player', kind: 'cube', parentId: null, order: 0, transform: { position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }] };
  const started = broker.start(scene, plan);
  const command = broker.command().command;
  assert.equal(command.kind, 'start');
  assert.equal(command.scene.entities[0].kind, 'cube');
  broker.resolve(command.id, { instanceId: 'preview:test', state: 'playing', entityId: 'entity:test', position: { x: 0, y: 0, z: 0 }, disposableCount: 0, errors: [] });
  assert.equal((await started).state, 'playing');
  assert.throws(() => broker.resolve(command.id, { instanceId: null, state: 'stopped', entityId: null, position: null, disposableCount: 0, errors: [] }), /missing, stale/);
  const stopped = broker.stop();
  const stopCommand = broker.command().command;
  broker.resolve(stopCommand.id, { instanceId: null, state: 'stopped', entityId: null, position: null, disposableCount: 0, errors: [] });
  assert.equal((await stopped).state, 'stopped');
  broker.dispose(); broker.dispose();
});

function event(kind, payload) { return { schemaVersion: 1, backendId, sessionId, turnId, kind, payload }; }
function digest(character) { return character.repeat(64); }
function nodes(host) { return host.replay().events.map((entry) => entry.node); }
async function waitFor(predicate) { for (let index = 0; index < 100; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error('Timed out waiting for fixture state.'); }
