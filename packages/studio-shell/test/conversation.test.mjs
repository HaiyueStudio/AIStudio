import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatComposerKeyboardController,
  chatFeedIsNearLatest,
  ConversationController,
  ConversationProjector,
  normalizeConversationNode,
  presentChatPanel,
  renderChatPanel,
  validateConversationIntent,
} from '../dist/index.js';

const backendId = 'backend:fixture';
const sessionId = 'session:fixture';
const turnId = 'turn:fixture';
const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;

test('live and replay use the same projector and stale read models cannot regress terminal nodes', () => {
  const events = [
    projection(1, node('node:text', 'text', 'streaming', { text: 'Hello' }), 'replay'),
    projection(2, node('node:text', 'text', 'completed', { text: 'Hello world' }), 'replay'),
    projection(3, node('node:done', 'completion', 'completed', { terminalStatus: 'completed', summary: 'Done' }), 'replay'),
  ];
  const replay = new ConversationProjector();
  const replayed = replay.reset(snapshot(events));
  const live = new ConversationProjector();
  live.reset(snapshot([]));
  for (const event of events) live.apply({ ...event, source: 'live' });
  assert.deepEqual(live.snapshot().nodes, replayed.nodes);
  live.apply(projection(2, node('node:text', 'text', 'streaming', { text: 'stale' }), 'live'));
  live.apply(projection(4, node('node:text', 'text', 'streaming', { text: 'regression' }), 'live'));
  assert.equal(live.snapshot().nodes.find((item) => item.id === 'node:text').content.text, 'Hello world');
  live.applyState({ type: 'conversation/state', revision: 1, connection: 'connected', busy: true, backendId, backends: snapshot([]).backends });
  live.applyState({ type: 'conversation/state', revision: 0, connection: 'disconnected', busy: false, backendId: null, backends: [] });
  assert.equal(live.snapshot().busy, true);
});

test('unknown, oversized and injection-shaped nodes get bounded safe presentation fallbacks', () => {
  const unknown = normalizeConversationNode(node('node:future', 'provider-private-html', 'pending', { html: '<script>globalThis.pwned=true</script>', accessToken: 'never' }));
  assert.equal(unknown.knownKind, null);
  assert.deepEqual(Object.keys(unknown.content).sort(), ['originalKind', 'summary']);
  const oversized = normalizeConversationNode(node('node:large', 'text', 'completed', { text: 'x'.repeat(20_000) }));
  assert.equal(oversized.payloadTruncated, true);
  assert.doesNotMatch(JSON.stringify(oversized.content), /x{100}/);

  const model = presentChatPanel(new ConversationProjector().reset(snapshot([projection(1, node('node:html', 'text', 'completed', { text: '<img src=x onerror=alert(1)>' }), 'replay')])));
  const fake = fakeDom();
  assert.doesNotThrow(() => renderChatPanel(fake.root, model, () => assert.fail('No action expected.')));
  assert.match(fake.text(), /<img src=x onerror=alert\(1\)>/);
  assert.equal(fake.innerHtmlWrites, 0);
});

test('controller blocks ambiguous sends, keeps plan acceptance separate, and makes approval one-shot', async () => {
  const port = fakeConversationPort();
  const controller = new ConversationController(port, () => Date.parse('2026-08-19T00:00:00.000Z'));
  await controller.mount();
  await controller.send('  Build a cube  ');
  assert.deepEqual(port.intents.at(-1), { type: 'conversation/send', backendId, prompt: 'Build a cube' });

  port.emit({ type: 'conversation/event', event: projection(1, node('node:question', 'question', 'pending', { prompt: 'Choose size', options: [{ id: 'option:small', label: 'Small' }] }), 'live') });
  await assert.rejects(controller.send('continue'), /pending question/);
  await controller.answerQuestion('node:question', { optionIds: ['option:small'] });
  await assert.rejects(controller.answerQuestion('node:question', { optionIds: ['option:small'] }), /already being resolved/);

  port.emit({ type: 'conversation/event', event: projection(2, node('node:question', 'question', 'completed', { prompt: 'Choose size', options: [] }), 'live') });
  port.emit({ type: 'conversation/event', event: projection(3, node('node:plan', 'plan', 'pending', { title: 'Plan', items: [{ id: 'plan:create', label: 'Create cube', status: 'pending' }] }), 'live') });
  await controller.acceptPlan('node:plan', ['plan:create']);
  assert.equal(port.intents.at(-1).type, 'conversation/accept-plan');
  assert.ok(!('approvalId' in port.intents.at(-1)));

  port.emit({ type: 'conversation/event', event: projection(4, approvalNode('pending'), 'live') });
  await controller.resolveApproval('node:approval', 'allow-once');
  assert.deepEqual(port.intents.at(-1), { type: 'conversation/resolve-approval', approvalId: 'approval:fixture', decision: 'allow-once' });
  await assert.rejects(controller.resolveApproval('node:approval', 'allow-once'), /already being resolved/);
  controller.dispose();
  assert.equal(port.disposed, 1);
});

test('auth handoff carries backend identity only and IME Enter never sends prematurely', async () => {
  const port = fakeConversationPort();
  const controller = new ConversationController(port);
  await controller.mount();
  await controller.authenticate(backendId);
  assert.deepEqual(port.intents.at(-1), { type: 'backend/authenticate', backendId });
  assert.doesNotMatch(JSON.stringify(port.intents), /key|token|secret/i);
  await controller.selectBackend(backendId);
  assert.deepEqual(port.intents.at(-1), { type: 'backend/select', backendId });
  const keyboard = new ChatComposerKeyboardController();
  let prevented = 0;
  keyboard.compositionStart();
  assert.equal(keyboard.handleKeyDown({ key: 'Enter', isComposing: true, preventDefault() { prevented += 1; } }), 'none');
  keyboard.compositionEnd();
  assert.equal(keyboard.handleKeyDown({ key: 'Enter', preventDefault() { prevented += 1; } }), 'send');
  assert.equal(keyboard.handleKeyDown({ key: 'Enter', shiftKey: true, preventDefault() { prevented += 1; } }), 'none');
  assert.equal(prevented, 1);
  controller.dispose();
});

test('chat feed follows new content only while the reader is near the latest message', () => {
  assert.equal(chatFeedIsNearLatest({ scrollTop: 700, clientHeight: 300, scrollHeight: 1_000 }), true);
  assert.equal(chatFeedIsNearLatest({ scrollTop: 680, clientHeight: 300, scrollHeight: 1_000 }), true);
  assert.equal(chatFeedIsNearLatest({ scrollTop: 500, clientHeight: 300, scrollHeight: 1_000 }), false);
});

test('model controls and task cost card expose effective settings, cache savings and unknown explanations safely', () => {
  const value = snapshot([]);
  value.backends = [{ ...value.backends[0], state: 'ready', models: [{ id: 'fixture-model', label: 'Fixture model', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', maxOutputTokens: 8192, isDefault: true }], selectedModel: 'fixture-model', selectedReasoningEffort: 'high', outputTokenLimit: 4096 }];
  value.taskAccounting = { taskId: 'task:fixture', budgetStatus: 'within', budget: { schemaVersion: 2, id: 'budget:fixture', enforcement: 'hard', limits: { inputTokens: 1000, outputTokens: 100, estimatedCostMicros: 10000, wallTimeMs: 60000, turns: 3, toolCalls: 10, repairIterations: 2, observationBytes: 10000 } }, usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningTokens: 5, toolInputBytes: 10, toolOutputBytes: 20, wallTimeMs: 1000, contextCache: { localArtifactHits: 4, localArtifactMisses: 1, deltaReuseBytes: 2048, providerCacheEligibleBytes: 4096, providerReportedHitTokens: null } }, cost: { status: 'estimated', amountMicros: 42, currency: 'USD', cacheSavingMicros: 7, explanation: 'catalog', final: false } };
  const model = presentChatPanel(new ConversationProjector().reset(value)); const fake = fakeDom(); renderChatPanel(fake.root, model, () => {});
  assert.match(fake.text(), /Model, reasoning and task budget/); assert.match(fake.text(), /Task cost · current estimate/); assert.match(fake.text(), /cache saved/); assert.match(fake.text(), /Context cache: local 4 hit \/ 1 miss/); assert.match(fake.text(), /provider hit unknown/);
  const unknown = new ConversationProjector().reset({ ...value, taskAccounting: { ...value.taskAccounting, cost: { status: 'unknown', amountMicros: null, currency: null, cacheSavingMicros: null, explanation: 'Subscription limits are not API billing amounts.', final: true } } });
  assert.match(presentChatPanel(unknown).taskAccounting.cost.explanation, /Subscription limits/);
  assert.throws(() => validateConversationIntent({ type: 'agent/configure', backendId, model: 'fixture-model', reasoningEffort: 'high', outputTokenLimit: 4096, budget: value.taskAccounting.budget, apiKey: 'CANARY' }), /unknown fields/i);
});

test('user messages are projected as conversation input rather than assistant output', () => {
  const model = presentChatPanel(new ConversationProjector().reset(snapshot([
    projection(1, node('node:user', 'text', 'completed', { text: '创建一个小游戏', role: 'user' }), 'replay'),
    projection(2, node('node:progress', 'progress', 'pending', { label: '正在分析需求', message: 'Agent 正在读取项目上下文并规划下一步。' }), 'replay'),
  ])));
  assert.equal(model.cards[0].title, '你');
  assert.equal(model.cards[0].body, '创建一个小游戏');
  assert.equal(model.cards[1].status, 'pending');
});

test('pending implementation plans put an explicit approval action before the detailed item list', () => {
  const model = presentChatPanel(new ConversationProjector().reset(snapshot([
    projection(1, node('node:plan-visible', 'plan', 'pending', {
      title: 'Snake plan', summary: 'Use one controller and instanced body rendering.',
      items: [{ id: 'plan:controller', label: 'Create controller', details: 'Own movement and instance data.', status: 'pending' }],
    }), 'replay'),
  ])));
  assert.equal(model.cards[0].title, '待批准 · Snake plan');
  const fake = fakeDom();
  renderChatPanel(fake.root, model, () => {});
  const text = fake.text();
  assert.ok(text.indexOf('批准并执行') < text.indexOf('Create controller'));
});
test('tool results show a readable step and keep raw structured output collapsed', () => {
  const model = presentChatPanel(new ConversationProjector().reset(snapshot([
    projection(1, node('node:tool', 'tool-result', 'completed', { toolCallId: 'toolcall:fixture', toolId: 'entity.create', summary: '已创建“Player”', details: '{"entity":{"name":"Player"}}', resultStatus: 'completed' }), 'replay'),
  ])));
  assert.equal(model.cards[0].title, '完成 · 创建物体');
  assert.equal(model.cards[0].body, '已创建“Player”');
  assert.deepEqual(model.cards[0].details, { summary: '查看工具返回数据', body: '{"entity":{"name":"Player"}}' });
});

test('approval cards expose a validated project-session Allow always action', () => {
  const model = presentChatPanel(new ConversationProjector().reset(snapshot([projection(1, approvalNode('pending'), 'replay')])), Date.parse('2026-08-19T00:00:00.000Z'));
  const card = model.cards[0];
  const always = card.actions.find((action) => action.id === 'approval-allow-always');
  assert.deepEqual(always.intent, { type: 'conversation/resolve-approval', approvalId: 'approval:fixture', decision: 'allow-always' });
  assert.match(card.body, /current project session/);
  assert.deepEqual(validateConversationIntent(always.intent), always.intent);
});

test('approval cards remain actionable regardless of elapsed wall-clock time while IPC-spoofed intents fail closed', () => {
  const projector = new ConversationProjector();
  projector.reset(snapshot([projection(1, approvalNode('pending'), 'replay')]));
  const card = presentChatPanel(projector.snapshot(), Date.parse('2026-08-19T00:10:00.000Z')).cards[0];
  assert.equal(card.actions.find((action) => action.id === 'approval-allow').enabled, true);
  assert.match(card.actions.find((action) => action.id === 'approval-allow').label, /Allow once/);
  assert.match(card.body, /no time limit/i);
  assert.throws(() => validateConversationIntent({ type: 'conversation/resolve-approval', approvalId: 'approval:fixture', decision: 'allow', apiKey: 'CANARY' }), /unknown fields|invalid/i);
  assert.throws(() => validateConversationIntent({ type: 'logs/export-bug-bundle', query: { limit: 201, traverseCorrelation: true } }), /budget/i);
  assert.throws(() => validateConversationIntent({ type: 'backend/authenticate', backendId, token: 'CANARY' }), /unknown fields/i);
});

function snapshot(events) {
  return { revision: 0, connection: 'connected', busy: false, backendId, backends: [{ id: backendId, label: 'Fixture', kind: 'harness-api-key', state: 'auth-required', authMode: 'api-key', rateLimits: [] }], events };
}
function projection(sequence, value, source) { return { schemaVersion: 1, sequence, source, node: value }; }
function node(id, kind, status, content) { return { schemaVersion: 1, id, kind, status, createdAt: `2026-08-19T00:00:${String(Number(id.length % 50)).padStart(2, '0')}.000Z`, provenance: { backendId, sessionId, turnId }, content }; }
function approvalNode(decision) {
  return node('node:approval', 'approval', 'pending', { approvalId: 'approval:fixture', toolCallId: 'toolcall:fixture', toolId: 'script.apply', toolVersion: '1.0.0', target: 'script:player', effect: 'trusted-code', risk: 'high', argumentsSummary: 'Write player controller', previewDiff: '+ move cube', baseRevision: 4, argsDigest: digestA, previewDigest: digestB, decision });
}
function fakeConversationPort() {
  let listener;
  return {
    intents: [], disposed: 0,
    async replay() { return snapshot([]); },
    subscribe(value) { listener = value; return { dispose: () => { this.disposed += 1; listener = undefined; } }; },
    async dispatch(intent, signal) { assert.equal(signal.aborted, false); this.intents.push(intent); },
    emit(event) { listener?.(event); },
  };
}
function fakeDom() {
  let innerHtmlWrites = 0;
  class FakeNode {
    constructor(ownerDocument, tag = 'fragment') { this.ownerDocument = ownerDocument; this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this._text = ''; }
    append(...values) { this.children.push(...values); }
    replaceChildren(...values) { this.children = [...values]; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener() {}
    set textContent(value) { this._text = String(value); }
    get textContent() { return this._text; }
    set innerHTML(_) { innerHtmlWrites += 1; throw new Error('innerHTML is forbidden'); }
  }
  const document = { createElement: (tag) => new FakeNode(document, tag), createDocumentFragment: () => new FakeNode(document) };
  const root = new FakeNode(document, 'root');
  const flatten = (value) => `${value._text}${value.children.map(flatten).join('')}`;
  return { root, text: () => flatten(root), get innerHtmlWrites() { return innerHtmlWrites; } };
}
