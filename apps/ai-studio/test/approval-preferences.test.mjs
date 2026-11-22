import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApprovalPreferences } from '../dist/approval-preferences.js';
import { parseAgentApprovalPreferences } from '@haiyue/ai-studio-contracts';

test('device approval preference defaults to auto review and remembers an explicit stricter choice', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-approval-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'approvals.json');
  const preferences = new ApprovalPreferences(file); await preferences.initialize();
  assert.equal(preferences.snapshot().mode, 'auto-review');
  await preferences.configure({ schemaVersion: 1, mode: 'ask' }); await preferences.dispose();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { schemaVersion: 1, mode: 'ask' });
  const restarted = new ApprovalPreferences(file); await restarted.initialize();
  assert.equal(restarted.snapshot().mode, 'ask'); await restarted.dispose();
  assert.throws(() => restarted.configure({ schemaVersion: 1, mode: 'auto-review' }), /disposed/);
});

test('corrupt, unknown-version and secret-bearing preferences fail to explicit approval', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-approval-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'approvals.json');
  for (const text of ['{broken', '{"schemaVersion":2,"mode":"auto-review"}', '{"schemaVersion":1,"mode":"auto-review","apiKey":"fixture"}']) {
    await writeFile(file, text); const preferences = new ApprovalPreferences(file); await preferences.initialize();
    assert.equal(preferences.snapshot().mode, 'ask'); await preferences.dispose();
  }
  for (const mode of ['allow-everything', { toString: () => 'auto-review' }, null]) {
    assert.throws(() => parseAgentApprovalPreferences({ schemaVersion: 1, mode }), /Invalid/);
  }
});
