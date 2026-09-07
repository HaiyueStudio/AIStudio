import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const readJson = async (relative) => JSON.parse(await read(relative));
const implementationBinding = 'm13-g06-2026-09-01';
const contractBinding = 'm13-g01-2026-09-01';

const index = await readJson('config/contracts/m13-contract-index.json');
assert.equal(index.bindingId, contractBinding);
assert.equal(index.contracts.find((entry) => entry.name === 'ToolBatchRequestV1')?.owner, 'g06-multi-tool-batch-scheduler');

const types = await read('packages/game-authoring-tools/src/types.ts');
const definitions = await read('packages/game-authoring-tools/src/definitions.ts');
const classifier = await read('packages/game-authoring-tools/src/scheduler/classify.ts');
const normalizer = await read('packages/game-authoring-tools/src/scheduler/normalize.ts');
const scheduler = await read('packages/game-authoring-tools/src/scheduler/scheduler.ts');
const rolling = await read('packages/game-authoring-tools/src/scheduler/rolling.ts');
const host = await read('packages/agent-orchestration/src/conversation-host.ts');
const prompt = await read('packages/agent-runtime/src/prompt-context.ts');
const accounting = await read('packages/agent-runtime/src/accounting.ts');
const schedulerTest = await read('packages/game-authoring-tools/test/tool-batch-scheduler.test.mjs');
const appTest = await read('apps/ai-studio/test/tool-batch-conversation.test.mjs');
const measurement = await read('scripts/measure-m13-g06-batch.mjs');

assert.match(types, /readonly concurrencySafe: boolean/u);
for (const id of ['scene.query', 'scene.diff', 'diagnostics.query', 'asset.search', 'task.evaluate']) assert.match(definitions, new RegExp(`'${id.replace('.', '\\.')}'`, 'u'));
assert.match(definitions, /concurrencySafe: PARALLEL_SAFE_TOOL_IDS\.has\(id\)/u);
for (const phrase of ["'parallel-read'", "'runtime-barrier'", "'trusted-code-barrier'", "'approval-barrier'", "'unknown-exclusive'", "['unknown']"]) assert.match(classifier, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
assert.doesNotMatch(classifier, /@deepseek|@openai|codex|harness/iu);

for (const phrase of ['validateEffectiveDag', 'tool-batch.cycle', 'tool-batch.dependency-missing', 'maxConcurrency', 'maxResultBytes']) assert.match(normalizer, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
for (const phrase of ['Promise.race(running)', 'canDispatch', 'stop-batch', 'tool-batch.node-timeout', 'tool-batch.result-limit', 'onNodeCommitted', 'completionOrdinal', 'resultDigest']) assert.match(scheduler, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
for (const phrase of ['class RollingToolBatchScheduler', 'tool-batch.dependency-forward', 'maxConcurrency', 'canDispatch']) assert.match(rolling, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));

assert.match(host, /event\.kind === 'tool-request'/u);
assert.match(host, /this\.enqueueTool\(batch, event, signal\)/u);
assert.doesNotMatch(host, /tool-request'\) \{ await this\.executeTool/u);
for (const phrase of ['tool-batch.planned', 'tool-batch.started', 'tool-batch.completed', 'tool.started', 'tool.completed', 'usageRecordId', 'costRecordId', "costAttribution: 'turn-shared'", 'commitTail']) assert.match(host, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
assert.match(prompt, /Plan → Tool batch → Check/u);
assert.match(prompt, /at most 64 nodes, concurrency 4, 60 seconds, 1 MiB model-facing output and 3 repair rounds/u);
assert.match(accounting, /latestCostRecord\(turnId: StableId\)/u);
assert.match(host, /account\.latestCostRecord\(context\.event\.turnId\)/u);

for (const phrase of ['wall time follows the slowest body', 'exclusive barriers', 'cycle validation', 'out of order', 'transitive dependents', 'stop-batch', 'external cancellation', 'node timeout', 'output limit']) assert.match(schedulerTest, new RegExp(phrase, 'iu'));
for (const phrase of ['overlaps safe bodies', 'exclusive barrier', 'commits in provider order', 'tool.completed', 'usageRecordId', 'costRecordId']) assert.match(appTest, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'));
for (const phrase of ['modelCalls: 3', 'modelCalls: 1', 'toolWaitMs', 'wallTimeMs', 'maxConcurrencyObserved', 'serialWallTimeMs * 0.7']) assert.match(measurement, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));

for (const document of ['docs/architecture/m13-tool-batch-scheduler.md', 'docs/evidence/m13-g06-verification.md']) {
  const body = await read(document); assert.match(body, new RegExp(implementationBinding, 'u')); assert.match(body, new RegExp(contractBinding, 'u'));
}

console.log(`[m13-g06] schedulerScenarios=10 appIntegration=1 serialControl=1 singleToolRegression=9 binding=${implementationBinding}`);
