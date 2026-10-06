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

test('push-only refresh is idle after success, coalesces events, and retries only failures', async()=>{
 const tasks=new Map();let id=0,calls=0,fail=false;const errors=[];
 const scheduler=new AgentPollScheduler({intervalMs:null,poll:async()=>{calls++;if(fail)throw new Error('temporary');},onError:e=>errors.push(e),schedule:(run,delay)=>{tasks.set(++id,{run,delay});return id;},cancel:key=>tasks.delete(key)});
 const flush=async()=>{const [key,task]=tasks.entries().next().value;tasks.delete(key);task.run();await new Promise(setImmediate);};
 scheduler.start();await flush();assert.equal(calls,1);assert.equal(tasks.size,0,'no successful idle polling timer');
 scheduler.trigger();scheduler.trigger();assert.equal(tasks.size,1);fail=true;await flush();assert.equal([...tasks.values()][0].delay,1000);await flush();assert.equal([...tasks.values()][0].delay,2000);
 fail=false;scheduler.trigger();await flush();assert.equal(tasks.size,0);assert.equal(errors.length,2);scheduler.stop();scheduler.trigger();assert.equal(tasks.size,0);
});
