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

test('approval cards expose a validated project-session Allow always action', () => {
  const model = presentChatPanel(new ConversationProjector().reset(snapshot([projection(1, approvalNode('pending'), 'replay')])), Date.parse('2026-08-19T00:00:00.000Z'));
  const card = model.cards[0];
  const always = card.actions.find((action) => action.id === 'approval-allow-always');
  assert.deepEqual(always.intent, { type: 'conversation/resolve-approval', approvalId: 'approval:fixture', decision: 'allow-always' });
  assert.match(card.body, /current project session/);
  assert.deepEqual(validateConversationIntent(always.intent), always.intent);
});

test('expired approvals are inert and IPC-spoofed intents fail closed', () => {
  const projector = new ConversationProjector();
  projector.reset(snapshot([projection(1, approvalNode('pending'), 'replay')]));
  const card = presentChatPanel(projector.snapshot(), Date.parse('2026-08-19T00:10:00.000Z')).cards[0];
  assert.ok(card.actions.every((action) => !action.enabled));
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
  return node('node:approval', 'approval', 'pending', { approvalId: 'approval:fixture', toolCallId: 'toolcall:fixture', toolId: 'script.apply', toolVersion: '1.0.0', target: 'script:player', effect: 'trusted-code', risk: 'high', argumentsSummary: 'Write player controller', previewDiff: '+ move cube', baseRevision: 4, argsDigest: digestA, previewDigest: digestB, expiresAt: '2026-08-19T00:05:00.000Z', decision });
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
