import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const readJson = async (relative) => JSON.parse(await read(relative));
const implementationBinding = 'm13-g03-2026-09-01';
const contractBinding = 'm13-g01-2026-09-01';

const contractIndex = await readJson('config/contracts/m13-contract-index.json');
assert.equal(contractIndex.bindingId, contractBinding);
assert.equal(contractIndex.contracts.find((entry) => entry.name === 'ContextFrameV1')?.owner, 'g03-model-aware-context-compaction');
for (const name of ['ContextPressureV1', 'CompactionRecordV1']) assert.ok(contractIndex.nestedTypes.includes(name), `${name} contract missing`);

const pressure = await read('packages/agent-runtime/src/context/pressure.ts');
const frame = await read('packages/agent-runtime/src/context/frame.ts');
const compaction = await read('packages/agent-runtime/src/compaction/runtime.ts');
const rootEntry = await read('packages/agent-runtime/src/index.ts');
const packageTests = await read('packages/agent-runtime/test/g03-context-compaction.test.mjs');
const appTest = await read('apps/ai-studio/test/g03-context-compaction-reload.test.mjs');

for (const value of ['0.65', '0.75', '0.8', '0.92']) assert.match(pressure, new RegExp(value.replace('.', '\\.'), 'u'), `missing pressure boundary ${value}`);
for (const phase of ['compaction.requested', 'compaction.started', 'compaction.summary-created', 'compaction.completed', 'compaction.failed']) assert.match(compaction, new RegExp(phase.replace('.', '\\.'), 'u'), `missing durable phase ${phase}`);
for (const phrase of ['deferred-open-boundary', 'context.compaction-overlap', 'targetSurfaceGeneration', 'pinnedFactDigests', 'context.compaction-summary-invalid', 'Promise.allSettled']) assert.match(compaction, new RegExp(phrase.replace('.', '\\.'), 'u'), `missing compaction invariant ${phrase}`);
assert.match(frame, /context\.emergency-request-blocked/u);
assert.match(frame, /this\.compactions\.compact/u);
assert.match(frame, /surfaceGeneration: snapshot\.surface\.generation/u);
assert.match(rootEntry, /readonly modelContexts: ModelContextRuntime/u);
assert.match(rootEntry, /await modelContexts\.dispose/u);
assert.doesNotMatch(`${pressure}\n${frame}\n${compaction}`, /@deepseek|@openai|codex|dsh-agent/iu, 'provider types leaked into G03 runtime');

for (const phrase of ['79% does not auto compact', 'manual compaction', 'open approval/tool boundaries', 'cancellation and invalid summaries', 'restart recovery', 'exact Surface generation', 'unknown model capacity', 'compact repeatedly', 'overlap is rejected']) assert.match(packageTests, new RegExp(phrase, 'iu'), `G03 package test missing ${phrase}`);
assert.match(packageTests, /ContextFrame capture must invoke automatic compaction at 80%/u);
assert.match(appTest, /main process reload rebuilds completed compaction/u);
assert.match(appTest, /reopenedFrames\.assertReadable/u);

for (const document of ['docs/architecture/m13-context-compaction.md', 'docs/evidence/m13-g03-verification.md']) {
  const body = await read(document);
  assert.match(body, new RegExp(implementationBinding, 'u'));
  assert.match(body, new RegExp(contractBinding, 'u'));
}

console.log(`[m13-g03] boundaries=4 packageScenarios=10 appReload=1 binding=${implementationBinding}`);
