import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentPreviewOwnership } from '../dist/agent-preview-ownership.js';
import { AgentPreviewBroker } from '../dist/agent-preview-broker.js';
const task = (status = 'running', overrides = {}) => ({ taskId: 'task:a', status, phase: 'playing', backendId: 'backend:a', sessionId: 'session:a', turnId: 'turn:a', ...overrides });
const claimed = () => { const owner = new AgentPreviewOwnership(); owner.update('project:a', [task()]); owner.claim('project:a'); return owner; };

test('Agent preview follows active provider turns but releases at human handoff', () => {
  const owner = claimed();
  owner.update('project:a', [task('running', { turnId: 'turn:b' })]);
  assert.equal(owner.shouldClose, false); assert.equal(owner.task.turnId, 'turn:b');
  owner.update('project:a', [task('waiting-user', { turnId: 'turn:b' })]);
  assert.equal(owner.shouldClose, true); assert.equal(owner.task.status, 'waiting-user');
  owner.release(); assert.equal(owner.shouldClose, false);
  // Resolving approval does not implicitly reopen the preview; a fresh start claims it.
  owner.update('project:a', [task('running', { turnId: 'turn:c' })]);
  assert.equal(owner.active, false); owner.claim('project:a');
  assert.equal(owner.shouldClose, false); assert.equal(owner.task.turnId, 'turn:c');
});
for (const phase of ['planning', 'playing', 'evaluating', 'repairing']) test(`human handoff closes Agent preview during ${phase}`, () => {
  const owner = claimed(); owner.update('project:a', [task('waiting-user', { phase })]);
  assert.equal(owner.shouldClose, true);
});
for (const status of ['completed', 'failed', 'cancelled', 'blocked']) test(`Agent preview closes on ${status}, even if another task runs`, () => {
  const owner = claimed(); owner.update('project:a', [task(status), task('running', { taskId: 'task:b' })]);
  assert.equal(owner.shouldClose, true);
});
test('project changes and lost tasks release preview; stale tasks cannot close manual preview', () => {
  const owner = claimed(); owner.update('project:b', [task()]); assert.equal(owner.shouldClose, true); assert.equal(owner.task, undefined);
  owner.release(); assert.equal(owner.shouldClose, false);
  owner.update('project:a', [task()]); owner.claim('project:a'); owner.update('project:a', []); assert.equal(owner.shouldClose, true);
  owner.release(); owner.update('project:a', [task('failed')]); assert.equal(owner.shouldClose, false);
  assert.throws(() => owner.claim('project:a'), /active task/);
  owner.update('project:b', [task()]); assert.throws(() => owner.claim('project:a'), /active task/);
});
test('renderer cleanup clears the broker only for the matching preview instance', async () => {
  const broker = new AgentPreviewBroker();
  const running = broker.start({}, {});
  broker.resolve(broker.command().command.id, { instanceId: 'preview:new', state: 'playing', scriptSetDigest: null, scriptCount: 0, scripts: [], entityId: null, position: null, disposableCount: 0, errors: [] });
  await running;
  broker.observeStopped('preview:old'); assert.equal(broker.snapshot().state, 'playing');
  broker.observeStopped(undefined); assert.equal(broker.snapshot().state, 'playing');
  broker.observeStopped('preview:new'); assert.equal(broker.snapshot().state, 'stopped');
  broker.observeStopped('preview:new'); assert.equal(broker.snapshot().instanceId, null);
  broker.dispose();
});

for (const phase of ['evaluating', 'repairing']) test(`testing preview closes when the task advances to ${phase}`, () => {
  const owner = claimed(); owner.update('project:a', [task('running', { phase })]); assert.equal(owner.shouldClose, true);
});
