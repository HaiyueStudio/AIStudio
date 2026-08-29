import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatComposerKeyboardController,
  chatFeedIsNearLatest,
  ConversationController,
  ConversationProjector,
  normalizeConversationNode,
  normalizeTaskRun,
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

test('composer keeps an editable focused draft while sending is temporarily blocked', () => {
  const value = snapshot([]);
  value.busy = true;
  const model = presentChatPanel(new ConversationProjector().reset(value));
  assert.equal(model.composer.canSend, false);
  const fake = fakeDom();
  renderChatPanel(fake.root, model, () => assert.fail('No send expected while blocked.'));
  const firstInput = fake.find('.chat-composer textarea');
  const firstSend = fake.findButton('Send');
  assert.notEqual(firstInput.disabled, true);
  assert.equal(firstSend.disabled, true);
  firstInput.value = '继续完善俄罗斯方块';
  firstInput.focus();
  firstInput.setSelectionRange(2, 6, 'forward');

  renderChatPanel(fake.root, model, () => assert.fail('No send expected while blocked.'));
  const nextInput = fake.find('.chat-composer textarea');
  assert.equal(nextInput.value, '继续完善俄罗斯方块');
  assert.equal(fake.document.activeElement, nextInput);
  assert.deepEqual([nextInput.selectionStart, nextInput.selectionEnd, nextInput.selectionDirection], [2, 6, 'forward']);
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

test('task workspace validates provenance, exposes acceptance evidence and bounds long timelines without leaking secret fields', () => {
  const value = snapshot([]);
  value.taskRuns = [taskRun({
    apiKey: 'sk-TaskProjectionCanary123456',
    evidence: [taskEvidence({ id: 'artifact:sha256:current', documentRevision: 7, previewDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }), taskEvidence({ id: 'artifact:sha256:stale', documentRevision: 6 }), taskEvidence({ id: 'artifact:sha256:foreign', taskId: 'task:foreign' })],
    acceptance: [{ id: 'acceptance:visible', label: 'Score changes', assertion: 'evidence state signal score gte 1', category: 'functional', required: true, visibility: 'agent', status: 'pass', evidenceIds: ['artifact:sha256:current'], diagnostic: null }],
    timeline: Array.from({ length: 150 }, (_, index) => taskTimeline(index)),
  })];
  const snapshotValue = new ConversationProjector().reset(value);
  assert.equal(snapshotValue.taskRuns.length, 1);
  assert.equal(snapshotValue.taskRuns[0].evidence.find((item) => item.id === 'artifact:sha256:current').provenanceStatus, 'current');
  assert.equal(snapshotValue.taskRuns[0].evidence.find((item) => item.id === 'artifact:sha256:stale').provenanceStatus, 'stale');
  assert.equal(snapshotValue.taskRuns[0].evidence.find((item) => item.id === 'artifact:sha256:foreign').provenanceStatus, 'invalid');
  assert.doesNotMatch(JSON.stringify(snapshotValue.taskRuns), /TaskProjectionCanary/);
  const fake = fakeDom(); renderChatPanel(fake.root, presentChatPanel(snapshotValue), () => {});
  assert.match(fake.text(), /任务状态与验收证据/); assert.match(fake.text(), /验收标准 1\/1 通过/); assert.match(fake.text(), /较早的 50 项已折叠/); assert.doesNotMatch(fake.text(), /timeline 0(?:\D|$)/);
});

test('unknown task versions and pass claims without retained evidence fail closed', () => {
  assert.throws(() => normalizeTaskRun({ ...taskRun(), schemaVersion: 2 }), /version/i);
  const value = snapshot([]); value.taskRuns = [{ ...taskRun(), schemaVersion: 99 }, taskRun({ acceptance: [{ id: 'acceptance:missing', label: 'Missing evidence', assertion: 'evidence state', category: 'functional', required: true, visibility: 'agent', status: 'pass', evidenceIds: ['artifact:sha256:not-present'], diagnostic: null }] })];
  const runs = new ConversationProjector().reset(value).taskRuns;
  assert.equal(runs.length, 1); assert.equal(runs[0].acceptance[0].status, 'blocked'); assert.deepEqual(runs[0].acceptance[0].evidenceIds, []);
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
  const model = presentChatPanel(new ConversationProjector().reset(snapshot([projection(1, approvalNode('pending', { toolId: 'entity.rename', target: 'entity:player', effect: 'reversible-edit', risk: 'medium' }), 'replay')])), Date.parse('2026-08-19T00:00:00.000Z'));
  const card = model.cards[0];
  const always = card.actions.find((action) => action.id === 'approval-allow-always');
  assert.deepEqual(always.intent, { type: 'conversation/resolve-approval', approvalId: 'approval:fixture', decision: 'allow-always' });
  assert.match(card.body, /current project session/);
  assert.deepEqual(validateConversationIntent(always.intent), always.intent);
});

test('trusted-code and runtime-start approvals expose one-shot decisions only', () => {
  for (const effect of ['trusted-code', 'runtime-start']) {
    const card = presentChatPanel(new ConversationProjector().reset(snapshot([projection(1, approvalNode('pending', { effect }), 'replay')]))).cards[0];
    assert.equal(card.actions.some((action) => action.id === 'approval-allow-always'), false);
    assert.ok(card.actions.some((action) => action.id === 'approval-allow'));
    assert.match(card.body, /exact one-shot approval/i);
  }
});

test('approval cards remain actionable regardless of elapsed wall-clock time while IPC-spoofed intents fail closed', () => {
  const projector = new ConversationProjector();
  projector.reset(snapshot([projection(1, approvalNode('pending'), 'replay')]));
  const card = presentChatPanel(projector.snapshot(), Date.parse('2026-08-19T00:10:00.000Z')).cards[0];
  assert.equal(card.actions.find((action) => action.id === 'approval-allow').enabled, true);
  assert.match(card.actions.find((action) => action.id === 'approval-allow').label, /Allow once/);
  assert.match(card.body, /no wall-clock expiry/i);
  assert.throws(() => validateConversationIntent({ type: 'conversation/resolve-approval', approvalId: 'approval:fixture', decision: 'allow', apiKey: 'CANARY' }), /unknown fields|invalid/i);
  assert.throws(() => validateConversationIntent({ type: 'logs/export-bug-bundle', query: { limit: 201, traverseCorrelation: true } }), /budget/i);
  assert.throws(() => validateConversationIntent({ type: 'backend/authenticate', backendId, token: 'CANARY' }), /unknown fields/i);
});

test('expired approval read models are visible but cannot block the composer or dispatch another decision', async () => {
  const expiresAt = '2026-08-19T00:01:00.000Z';
  const projector = new ConversationProjector();
  projector.reset(snapshot([projection(1, approvalNode('pending', { expiresAt, scope: 'operation' }), 'replay')]));
  const now = Date.parse('2026-08-19T00:02:00.000Z');
  const snapshotAtExpiry = projector.snapshot(now);
  assert.equal(snapshotAtExpiry.pendingInteraction, null);
  const card = presentChatPanel(snapshotAtExpiry, now).cards[0];
  assert.ok(card.actions.every((action) => action.enabled === false));
  assert.match(card.body, /decision: expired/i);
  const port = fakeConversationPort(); const controller = new ConversationController(port, () => now); await controller.mount();
  port.emit({ type: 'conversation/event', event: projection(1, approvalNode('pending', { expiresAt, scope: 'operation' }), 'live') });
  await assert.rejects(controller.resolveApproval('node:approval', 'allow-once'), /no longer pending/);
  controller.dispose();
});

test('a cancelled plan no longer blocks the composer after its turn terminates', () => {
  const projector = new ConversationProjector();
  const pending = node('node:cancelled-plan', 'plan', 'pending', { title: 'Plan', items: [{ id: 'plan:create', label: 'Create cube', status: 'pending' }] });
  projector.reset(snapshot([projection(1, pending, 'replay')]));
  assert.match(projector.snapshot().composerBlockedReason, /Review the implementation plan/);
  projector.apply(projection(2, { ...pending, status: 'cancelled', content: { ...pending.content, decision: 'cancelled' } }, 'live'));
  assert.equal(projector.snapshot().pendingInteraction, null);
  assert.equal(projector.snapshot().composerBlockedReason, null);
});

function snapshot(events) {
  return { revision: 0, connection: 'connected', busy: false, backendId, backends: [{ id: backendId, label: 'Fixture', kind: 'harness-api-key', state: 'auth-required', authMode: 'api-key', rateLimits: [] }], events };
}
function projection(sequence, value, source) { return { schemaVersion: 1, sequence, source, node: value }; }
function node(id, kind, status, content) { return { schemaVersion: 1, id, kind, status, createdAt: `2026-08-19T00:00:${String(Number(id.length % 50)).padStart(2, '0')}.000Z`, provenance: { backendId, sessionId, turnId }, content }; }
function approvalNode(decision, extra = {}) {
  return node('node:approval', 'approval', 'pending', { approvalId: 'approval:fixture', toolCallId: 'toolcall:fixture', toolId: 'script.apply', toolVersion: '1.0.0', target: 'script:player', effect: 'trusted-code', risk: 'high', argumentsSummary: 'Write player controller', previewDiff: '+ move cube', baseRevision: 4, argsDigest: digestA, previewDigest: digestB, scope: 'operation', decision, ...extra });
}
function taskRun(extra = {}) {
  return { schemaVersion: 1, revision: 4, taskId: 'task:fixture', title: 'Cross-genre fixture', requestSummary: 'Build and verify a neutral game.', status: 'completed', phase: 'complete', startedAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:01:00.000Z', backendId, sessionId, turnId,
    model: { id: 'fixture-model', reasoningEffort: 'high', outputTokenLimit: 4096 }, promptProfile: { id: 'prompt:general-game-authoring', version: '2.0.0', digest: digestA }, documentRevision: 7, repairIteration: 1, repairLimit: 3, acceptance: [], evidence: [], timeline: [taskTimeline(149)], terminalDiagnostic: null, resumable: false, ...extra };
}
function taskEvidence(extra = {}) { return { id: 'artifact:sha256:evidence', type: 'screenshot', taskId: 'task:fixture', turnId, playId: 'play:fixture', documentRevision: 7, tick: 42, frame: 42, viewport: { width: 393, height: 852 }, device: 'phone', capturedAt: '2026-08-19T00:00:42.000Z', byteLength: 128, redacted: false, producerVersion: 'fixture/1', provenanceStatus: 'current', ...extra }; }
function taskTimeline(index) { return { id: `timeline:${index}`, at: `2026-08-19T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`, phase: index === 149 ? 'complete' : 'editing', status: index === 149 ? 'complete' : 'active', title: `timeline ${index}`, detail: 'bounded task update', turnId, toolCallId: null, playId: null, tick: null }; }
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
    constructor(ownerDocument, tag = 'fragment') { this.ownerDocument = ownerDocument; this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this._text = ''; this.value = ''; this.selectionStart = 0; this.selectionEnd = 0; this.selectionDirection = 'none'; this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; }
    append(...values) { this.children.push(...values); }
    replaceChildren(...values) { this.children = [...values]; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener() {}
    focus() { this.ownerDocument.activeElement = this; }
    setSelectionRange(start, end, direction = 'none') { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
    querySelector(selector) { return find(this, selector); }
    set textContent(value) { this._text = String(value); }
    get textContent() { return this._text; }
    set innerHTML(_) { innerHtmlWrites += 1; throw new Error('innerHTML is forbidden'); }
  }
  const matches = (value, selector) => {
    if (selector === '.chat-feed') return value.className === 'chat-feed';
    if (selector === '.chat-composer textarea') return value.tagName === 'textarea' && value.parent?.className === 'chat-composer';
    return value.tagName === selector;
  };
  const find = (value, selector) => {
    if (matches(value, selector)) return value;
    for (const child of value.children) { child.parent = value; const match = find(child, selector); if (match) return match; }
    return null;
  };
  const document = { activeElement: null, createElement: (tag) => new FakeNode(document, tag), createDocumentFragment: () => new FakeNode(document) };
  const root = new FakeNode(document, 'root');
  const flatten = (value) => `${value._text}${value.children.map(flatten).join('')}`;
  return { root, document, find: (selector) => find(root, selector), findButton: (label) => findAll(root, 'button').find((value) => value.textContent === label), text: () => flatten(root), get innerHtmlWrites() { return innerHtmlWrites; } };

  function findAll(value, tag) {
    return [value, ...value.children.flatMap((child) => findAll(child, tag))].filter((item) => item.tagName === tag);
  }
}
