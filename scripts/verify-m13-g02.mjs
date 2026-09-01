import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const readJson = async (relative) => JSON.parse(await read(relative));
const implementationBinding = 'm13-g02-2026-09-01';
const contractBinding = 'm13-g01-2026-09-01';

const contractIndex = await readJson('config/contracts/m13-contract-index.json');
assert.equal(contractIndex.bindingId, contractBinding);
for (const name of ['AgentSessionV1', 'SessionOpV1', 'ModelSurfaceV1']) assert.equal(contractIndex.contracts.find((entry) => entry.name === name)?.owner, 'g02-durable-session-surface-replay', `${name} owner drift`);

const runtime = await read('packages/agent-runtime/src/session/runtime.ts');
const projection = await read('packages/agent-runtime/src/session/projection.ts');
const validation = await read('packages/agent-runtime/src/session/validation.ts');
const rootEntry = await read('packages/agent-runtime/src/index.ts');
const operationTypes = await read('packages/operation-log/src/types.ts');
const packageTests = await read('packages/agent-runtime/test/g02-session.test.mjs');
const appTest = await read('apps/ai-studio/test/g02-session-reload.test.mjs');

for (const method of ['create', 'open', 'replay', 'append', 'appendMessage', 'replaceSurface', 'bindBackend', 'checkpoint', 'fork', 'flush', 'dispose']) assert.match(runtime, new RegExp(`(?:async )?${method}\\(`, 'u'), `missing Session API ${method}`);
assert.match(rootEntry, /readonly sessions: DurableSessionRuntime/u);
assert.match(rootEntry, /AgentSessionError, DurableSessionRuntime, sessionPayloadDigest/u);
assert.match(operationTypes, /readonly retainedFromSequence: number/u);
assert.match(runtime, /this\.state = 'disposing'/u);
assert.match(runtime, /retryAllowed: false/u);
assert.doesNotMatch(`${runtime}\n${projection}\n${validation}`, /@deepseek|@openai|codex|dsh-agent/iu, 'provider types leaked into Session runtime');

for (const phrase of ['complete append-origin Transcript', 'retained SessionOp prefix', 'fork preserves parent Transcript', 'outcome-unknown', 'approval barrier survives reload', 'unknown Studio Session events fail closed', 'partial journal tail', 'corrupt fork seed', 'disposed handles', 'already-started append']) assert.match(packageTests, new RegExp(phrase, 'iu'), `G02 package test missing ${phrase}`);
assert.match(appTest, /stale renderer read models/u);
assert.match(appTest, /afterProcessReload/u);

for (const document of ['docs/architecture/m13-session-runtime.md', 'docs/evidence/m13-g02-verification.md']) {
  const body = await read(document);
  assert.match(body, new RegExp(implementationBinding, 'u'));
  assert.match(body, new RegExp(contractBinding, 'u'));
}

const forbiddenRetry = /tool\.started[\s\S]{0,1200}(?:resumeTurn|startTurn)\(/u;
assert.doesNotMatch(runtime, forbiddenRetry, 'Session recovery must not invoke provider/tool execution');

console.log(`[m13-g02] api=11 packageScenarios=10 appReload=1 binding=${implementationBinding}`);
