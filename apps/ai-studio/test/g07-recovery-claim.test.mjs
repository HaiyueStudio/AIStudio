import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecoveryClaimStore } from '../dist/session-orchestrator/index.js';

test('a live process fences recovery and a new process takes over its orphaned claim after exit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g07-claim-'));
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'recovery-claim-child.mjs');
  let child;
  try {
    child = fork(fixture, [root], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const owner = await message(child, 'acquired'); assert.ok(owner.pid > 0);
    const contender = new RecoveryClaimStore(root);
    assert.equal(await contender.acquire('session:g07-cross-process', 'claim:parent:contended'), null);
    const exited = new Promise((resolve) => child.once('exit', resolve)); child.kill(); await exited; child = null;
    const takeover = await contender.acquire('session:g07-cross-process', 'claim:parent:takeover');
    assert.ok(takeover); assert.equal(takeover.ownerPid, process.pid); await takeover.release();
    const repeated = await contender.acquire('session:g07-cross-process', 'claim:parent:repeated'); assert.ok(repeated); await repeated.release();
  } finally { child?.kill(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

function message(child, type) { return new Promise((resolve, reject) => { const onExit = (code) => reject(new Error(`Claim child exited before ${type}: ${code}`)); child.once('exit', onExit); child.on('message', (value) => { if (value?.type !== type) return; child.off('exit', onExit); resolve(value); }); }); }
