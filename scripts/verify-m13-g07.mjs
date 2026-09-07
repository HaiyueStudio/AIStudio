import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const readJson = async (relative) => JSON.parse(await read(relative));
const binding = 'm13-g07-2026-09-01';
const contractBinding = 'm13-g01-2026-09-01';

const matrix = await readJson('docs/evidence/m13-g07-recovery-matrix.json');
assert.equal(matrix.bindingId, binding);
assert.equal(matrix.contractBindingId, contractBinding);
assert.ok(Array.isArray(matrix.cases));
assert.equal(new Set(matrix.cases.map((entry) => entry.id)).size, matrix.cases.length);
assert.ok(matrix.cases.length >= 36);

const counts = Object.fromEntries(['transaction', 'crash', 'idempotency', 'lock', 'recovery', 'barrier', 'artifact', 'metrics'].map((kind) => [kind, matrix.cases.filter((entry) => entry.class === kind).length]));
assert.ok(counts.transaction >= 7);
assert.ok(counts.crash >= 8);
assert.ok(counts.idempotency >= 3);
assert.ok(counts.lock >= 6);
assert.ok(counts.recovery >= 2);
assert.ok(counts.barrier >= 8);
assert.ok(counts.artifact >= 1);
assert.ok(counts.metrics >= 1);
for (const entry of matrix.cases) {
  assert.match(entry.id, /^[a-z0-9][a-z0-9-]+$/u);
  assert.ok(entry.expected.length >= 8);
  assert.ok((await read(entry.evidence)).length > 0, `Missing executable evidence ${entry.evidence}`);
}

const transactionTest = await read('packages/game-authoring-tools/test/transactions.test.mjs');
for (const phrase of ['7 members', '100-member boundary', 'disjoint entity transactions prepare concurrently', 'between prepare and commit', 'stale base is rejected during prepare', 'before History write', 'committed-no-ack', 'fail during prepare']) assert.match(transactionTest, new RegExp(phrase, 'iu'));
const workspaceTest = await read('packages/editor-plugins/test/project-workspace.test.mjs');
for (const phrase of ['one revision and History entry', 'undo and redo retain the authoritative receipt', 'missing and corrupt transaction receipt', 'after History write as ambiguous', 'receipt written before acknowledgement', 'transaction:other']) assert.match(workspaceTest, new RegExp(phrase, 'iu'));
const recoveryTest = await read('packages/agent-runtime/test/g07-recovery.test.mjs');
for (const phrase of ['committed-no-ack', 'crashed before tool.started', 'crashed before commit', 'receipt discovery by member', 'not-committed mutation', 'ambiguous mutation', 'two recovery hosts', 'after document acknowledgement but before tool completion']) assert.match(recoveryTest, new RegExp(phrase, 'iu'));
const lockTest = await read('packages/game-authoring-tools/test/effect-locks.test.mjs');
for (const phrase of ['serialize conflicts fairly', 'global lock conflicts', 'cancelled wait', 'cross-batch and cross-turn', 'trusted-code-barrier', 'runtime-barrier']) assert.match(lockTest, new RegExp(phrase, 'iu'));
const appTests = `${await read('apps/ai-studio/test/tool-batch-conversation.test.mjs')}\n${await read('apps/ai-studio/test/g07-barrier-restart.test.mjs')}\n${await read('apps/ai-studio/test/g07-recovery-claim.test.mjs')}\n${await read('apps/ai-studio/test/g07-evidence-retention.test.mjs')}\n${await read('apps/ai-studio/test/g10-agent-integration.test.mjs')}`;
for (const phrase of ['one durable transaction receipt', 'remains actionable after process restart', 'real Electron process restart', 'releases the provider call', 'cancels the old provider turn', 'live process fences recovery', 'preserves transaction, state, screenshot, evaluator and cost after restart', 'pauses hard wall time']) assert.match(appTests, new RegExp(phrase, 'iu'));
const backendTests = await read('packages/agent-backends/test/backends.test.mjs');
for (const phrase of ['Harness auth, logout, tool result, cancellation', 'rate limit and cancel use the pinned protocol']) assert.match(backendTests, new RegExp(phrase, 'iu'));

const workspace = await read('packages/editor-plugins/src/history/workspace.ts');
for (const phrase of ['executeTransaction', 'project-scene-diff/2', 'findTransactionReceiptByIdempotencyKey', 'document/transaction-receipt-written', 'reconcileTransactionMember', 'transaction-idempotency-conflict']) assert.match(workspace, new RegExp(phrase, 'u'));
const coordinator = await read('packages/game-authoring-tools/src/transactions.ts');
for (const phrase of ['SceneTransactionCoordinator', 'idempotencyKey', 'operationDigest', 'outcome-unknown', 'prepareLatencyMs', 'reconcileLatencyMs', 'duplicatesPrevented']) assert.match(coordinator, new RegExp(phrase, 'u'));
const recovery = await read('packages/agent-runtime/src/session/recovery.ts');
for (const phrase of ['recoveryTails', 'retry-not-started', 'hasCommittedProjection', 'synthesized-completion', 'manual-barrier', 'discoverMutation']) assert.match(recovery, new RegExp(phrase, 'u'));
const host = await read('packages/agent-orchestration/src/conversation-host.ts');
for (const phrase of ['executeTransaction', 'approval.requested', 'question.requested', 'recoverableBarrierNode', 'queuedPrompts']) assert.match(host, new RegExp(phrase, 'u'));

for (const document of ['docs/architecture/m13-transactions-effect-locks-recovery.md', 'docs/evidence/m13-g07-verification.md']) {
  const body = await read(document);
  assert.match(body, new RegExp(binding, 'u'));
  assert.match(body, new RegExp(contractBinding, 'u'));
}
assert.deepEqual(matrix.pendingProductProof, []);

console.log(`[m13-g07] cases=${matrix.cases.length} transaction=${counts.transaction} crash=${counts.crash} lock=${counts.lock} recovery=${counts.recovery} barrier=${counts.barrier} artifact=${counts.artifact} metrics=${counts.metrics} pendingProductProof=${matrix.pendingProductProof.length} binding=${binding}`);
