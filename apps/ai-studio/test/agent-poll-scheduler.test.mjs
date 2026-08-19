import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentPollScheduler } from '../dist/agent-poll-scheduler.js';

test('Agent polling coalesces push hints and never overlaps requests', async () => {
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const releases = [];
  const scheduler = new AgentPollScheduler({
    intervalMs: 60_000,
    async poll() {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
    },
    onError(cause) { throw cause; },
  });

  scheduler.start();
  await waitFor(() => calls === 1);
  scheduler.trigger(); scheduler.trigger(); scheduler.trigger();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  releases.shift()();
  await waitFor(() => calls === 2);
  assert.equal(maximumActive, 1);
  releases.shift()();
  scheduler.stop();
});

test('Agent polling recovers after a failed request', async () => {
  let calls = 0;
  const errors = [];
  const scheduler = new AgentPollScheduler({
    intervalMs: 1,
    async poll() { calls += 1; if (calls === 1) throw new Error('transient replay failure'); },
    onError(cause) { errors.push(cause); },
  });
  scheduler.start();
  await waitFor(() => calls >= 2);
  scheduler.stop();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /transient replay failure/);
});

async function waitFor(predicate) {
  for (let index = 0; index < 100; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for Agent poll scheduler state.');
}
