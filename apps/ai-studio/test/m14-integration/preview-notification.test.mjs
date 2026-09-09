import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentPreviewBroker } from '../../dist/agent-preview-broker.js';

test('preview commands wake their existing renderer poll owner and dispose the subscription', async () => {
  const broker = new AgentPreviewBroker(); let notified = 0;
  const subscription = broker.subscribePending(() => { notified++; assert.equal(broker.command().pending, true); });
  const controller = new AbortController(), request = broker.inspect(controller.signal);
  assert.equal(notified, 1); controller.abort(); await assert.rejects(request);
  subscription.dispose(); subscription.dispose();
  const next = broker.inspect(); assert.equal(notified, 1); broker.dispose(); await assert.rejects(next);
  assert.throws(() => broker.subscribePending(() => {})); broker.dispose();
});

test('an already cancelled preview request rejects without leaving a pending promise or wakeup', async () => {
  const broker = new AgentPreviewBroker(); let notified = 0; broker.subscribePending(() => notified++);
  await assert.rejects(broker.inspect(AbortSignal.abort()));
  assert.equal(notified, 0); assert.deepEqual(broker.command(), { pending: false }); broker.dispose();
});
