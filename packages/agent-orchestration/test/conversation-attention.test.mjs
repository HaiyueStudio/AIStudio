import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationAttentionTracker } from '../dist/index.js';
const stamp = '2026-09-09T00:00:00.000Z';
const provenance = { backendId: 'backend:test', sessionId: 'session:test', turnId: 'turn:test' };
const node = (id, kind, status = 'pending', content = {}) => ({ schemaVersion: 1, sequence: id, source: 'replay', node: { schemaVersion: 1, id: `node:${kind}`, kind, status, createdAt: stamp, provenance, content } });
const task = status => ({ schemaVersion: 1, revision: 1, taskId: 'task:test', title: 'Private project text', status, phase: status === 'completed' ? 'complete' : 'planning', startedAt: stamp, updatedAt: stamp, ...provenance, model: { id: 'model', reasoningEffort: 'low', outputTokenLimit: 1000 }, promptProfile: { id: 'prompt:test', version: '1', digest: `sha256:${'a'.repeat(64)}` }, documentRevision: 1, repairIteration: 0, repairLimit: 2, terminalDiagnostic: null, acceptance: [], evidence: [], timeline: [] });
const snapshot = (events = [], taskRuns = []) => ({ revision: 1, busy: false, events, taskRuns });
const update = (tracker, events = [], tasks = [], now) => tracker.update('project:test', 'document:test', snapshot(events, tasks), now);
const approval = expiresAt => ({ approvalId: 'approval:test', toolCallId: 'call:test', toolId: 'script.apply', toolVersion: '1.0.0', target: 'script:test', effect: 'trusted-code', risk: 'high', argumentsSummary: 'Private tool parameters', previewDiff: 'private source', baseRevision: 1, argsDigest: `sha256:${'a'.repeat(64)}`, previewDigest: `sha256:${'b'.repeat(64)}`, scope: 'operation', decision: 'pending', ...(expiresAt ? { expiresAt } : {}) });

test('historical hydration is silent and a new pending approval notifies once without payload text', () => {
  const tracker = new ConversationAttentionTracker();
  assert.deepEqual(update(tracker, [node(1, 'question', 'pending', { prompt: 'Old question', options: [] })], [task('completed')]), []);
  const events = [node(1, 'question', 'pending', { prompt: 'Old question', options: [] }), node(2, 'approval', 'pending', approval())];
  const changes = update(tracker, events, [task('completed')]);
  assert.equal(changes.length, 1); assert.equal(changes[0].notice.kind, 'approval');
  assert.equal(changes[0].notice.nodeId, 'node:approval'); assert.doesNotMatch(JSON.stringify(changes), /Private|private|previewDiff|argumentsSummary/);
  assert.deepEqual(update(tracker, events, [task('completed')]), []);
  assert.equal(update(tracker, [...events, node(3, 'approval', 'completed', { ...approval(), decision: 'allow-once' })], [task('completed')])[0].type, 'withdraw');
});
test('completed model turns, busy=false, single tool errors and manual cancellations are not task completion', () => {
  const tracker = new ConversationAttentionTracker(); update(tracker, [], [task('running')]);
  assert.deepEqual(update(tracker, [node(1, 'completion', 'completed'), node(2, 'tool-result', 'failed')], [task('running')]), []);
  assert.deepEqual(update(tracker, [], [task('cancelled')]), []);
});
for (const status of ['completed', 'blocked', 'failed']) test(`task ${status} notifies on its transition and a retry can notify again`, () => {
  const tracker = new ConversationAttentionTracker(); update(tracker, [], [task('running')]);
  assert.equal(update(tracker, [], [task(status)])[0].notice.kind, status);
  assert.deepEqual(update(tracker, [], [task(status)]), []);
  assert.equal(update(tracker, [], [task('running')])[0].type, 'withdraw');
  assert.equal(update(tracker, [], [task(status)])[0].type, 'show');
});
test('questions and plans notify, resolved and expired approvals withdraw, reset suppresses old records', () => {
  const tracker = new ConversationAttentionTracker(); update(tracker);
  assert.equal(update(tracker, [node(1, 'question', 'pending', { prompt: 'Question', options: [] })])[0].notice.kind, 'question');
  assert.equal(update(tracker, [node(2, 'plan', 'pending', { items: [] })]).find(x => x.type === 'show').notice.kind, 'plan');
  const expiry = Date.parse(stamp) + 1000, events = [node(3, 'approval', 'pending', approval(new Date(expiry).toISOString()))];
  assert.equal(update(tracker, events, [], expiry - 1).find(x => x.type === 'show').notice.kind, 'approval');
  assert.equal(update(tracker, events, [], expiry).find(x => x.type === 'withdraw').id.endsWith('node:approval'), true);
  tracker.reset(); assert.deepEqual(update(tracker, events, [task('completed')], expiry - 1), []);
});
