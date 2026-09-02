import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const binding = 'm13-g10-2026-09-02';
const evidence = JSON.parse(await read('docs/evidence/m13-g10-retrieval-ab.json'));
assert.equal(evidence.binding, binding);
assert.equal(evidence.status, 'default-enabled');
assert.equal(evidence.cases.length, 7);
assert.equal(evidence.summary.exactToolSuccessRate, 1);
assert.equal(evidence.summary.hybridToolSuccessRate, 1);
assert.equal(evidence.summary.groundedCitationRate, 1);
assert.ok(evidence.summary.hybridRecallAt8 >= evidence.summary.exactRecallAt8);
assert.ok(evidence.summary.schemaByteReduction >= 0.25);
assert.ok(evidence.summary.inputTokenReduction >= 0.20);
assert.ok(evidence.index.sourceCount > 5);

const retrieval = await read('packages/agent-runtime/src/retrieval/runtime.ts');
for (const phrase of ['knowledge/index-source-tombstoned', 'permission-filtered', 'conflicting-sources', 'query-scan-budget-exceeded', 'provenance=authorized']) assert.match(retrieval, new RegExp(phrase.replaceAll('/', '\\/'), 'u'));
const router = await read('packages/agent-runtime/src/context/router.ts');
for (const phrase of ['context.knowledge-hit-stale', 'context.knowledge-hit-permission', 'context.knowledge-hit-version', 'context.knowledge-hit-citation']) assert.match(router, new RegExp(phrase.replaceAll('.', '\\.'), 'u'));
const loader = await read('apps/ai-studio/src/knowledge-source-loader.ts');
for (const phrase of ['CONTROLLED_ASSET_CATALOG_SETTING_KEY', 'Script text and binary asset bodies are never indexed', 'project-closed', 'content-hash index']) assert.match(loader, new RegExp(phrase, 'u'));
const host = await read('apps/ai-studio/src/conversation-host.ts');
assert.match(host, /fallback: 'exact-context'/u);
assert.match(host, /selectDefinitions\?\.\(request\)/u);
const corpus = JSON.parse(await read('evals/suites/m13-g10-seven-game-retrieval.json'));
assert.deepEqual(corpus.cases.map((entry) => entry.id), ['snake', 'match-three', 'tetris', 'sliding-puzzle', 'platform-jump', 'racing', 'shooting']);
for (const document of ['docs/architecture/m13-grounded-rag-tool-discovery.md', 'docs/evidence/m13-g10-verification.md']) assert.match(await read(document), new RegExp(binding, 'u'));
const packageJson = JSON.parse(await read('package.json'));
for (const phrase of ['g10-knowledge-source-loader.test.mjs', 'm13-g10-retrieval.test.mjs', 'measure-m13-g10-retrieval.mjs --check', 'verify-m13-g10.mjs']) assert.match(packageJson.scripts['m13:g10:check'], new RegExp(phrase.replaceAll('.', '\\.'), 'u'));

console.log(`[m13-g10] status=${evidence.status} cases=${evidence.cases.length} recall=${evidence.summary.hybridRecallAt8.toFixed(3)} schemaReduction=${evidence.summary.schemaByteReduction.toFixed(3)} inputReduction=${evidence.summary.inputTokenReduction.toFixed(3)} binding=${binding}`);
