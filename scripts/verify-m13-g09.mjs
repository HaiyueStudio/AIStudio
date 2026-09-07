import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const binding = 'm13-g09-2026-09-02';
const evidence = JSON.parse(await read('docs/evidence/m13-g09-browser-evidence.json'));
assert.equal(evidence.binding, binding);
assert.equal(evidence.status, 'browser-candidate');
assert.ok(Object.values(evidence.checks).every(Boolean));
assert.ok(evidence.performanceMs.productRender < 1_500);
assert.ok(evidence.performanceMs.tool1000Projection < 1_500);
assert.ok(evidence.performanceMs.tool1000OverviewLayout < 100);
assert.equal(evidence.largeGraph.toolNodes, 1_000);
assert.ok(evidence.largeGraph.overviewVisibleNodesLessThan <= 100);
assert.equal(evidence.electron.status, 'formal-passed');
assert.equal(evidence.electron.security.rendererSandbox, true);
assert.equal(evidence.electron.security.contextIsolation, true);
assert.equal(evidence.electron.security.nodeIntegration, false);
assert.equal(evidence.electron.security.webSecurity, true);

const screenshotPath = path.join(root, evidence.screenshot.path);
const screenshot = await readFile(screenshotPath);
assert.equal((await stat(screenshotPath)).size, evidence.screenshot.byteLength);
assert.equal(createHash('sha256').update(screenshot).digest('hex'), evidence.screenshot.sha256);
assert.deepEqual([...screenshot.subarray(0, 3)], [0xff, 0xd8, 0xff]);

const electronScreenshotPath = path.join(root, evidence.electron.screenshot.path);
const electronScreenshot = await readFile(electronScreenshotPath);
assert.equal((await stat(electronScreenshotPath)).size, evidence.electron.screenshot.byteLength);
assert.equal(createHash('sha256').update(electronScreenshot).digest('hex'), evidence.electron.screenshot.sha256);
assert.deepEqual([...electronScreenshot.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

const graph = await read('packages/studio-shell/src/conversation/execution-graph.ts');
for (const phrase of ['parallel-with', 'validated-by', 'compacted-into', 'resumed-from', 'graph.sequence-gap', 'graph.reference-missing', 'sha256Digest']) assert.match(graph, new RegExp(phrase.replaceAll('.', '\\.'), 'u'));
const layout = await read('packages/studio-shell/src/conversation/execution-layout.ts');
for (const phrase of ['costUnknown', 'maxCompletedToolsPerBatch', 'preserveConnectingNodes', 'calculateLayers']) assert.match(layout, new RegExp(phrase, 'u'));
const panel = await read('packages/studio-shell/src/panels/chat/index.ts');
for (const phrase of ['conversation/request-compaction', '完整记录', '成本未知', '使用层级列表浏览全部执行步骤', 'prefers-reduced-motion']) assert.match(`${panel}\n${await read('apps/ai-studio/renderer/styles.css')}`, new RegExp(phrase.replaceAll('/', '\\/'), 'u'));
const host = await read('packages/agent-orchestration/src/conversation-host.ts');
for (const phrase of ['captureSessionContextFrame', 'resumeOrRunManualCompaction', 'manual-compaction-finished', 'projectExecutionGraph']) assert.match(host, new RegExp(phrase, 'u'));

const graphTests = await read('packages/studio-shell/test/execution-graph.test.mjs');
for (const phrase of ['deterministic graph', 'overlapping tool intervals', 'outcome-unknown', '1000-tool graph']) assert.match(graphTests, new RegExp(phrase, 'iu'));
const integration = await read('apps/ai-studio/test/execution-graph-context-ui.test.mjs');
for (const phrase of ['without deleting Transcript', 'main-process restart', 'survive restart']) assert.match(integration, new RegExp(phrase, 'iu'));
const electron = await read('apps/ai-studio/test/execution-graph-electron.test.mjs');
for (const phrase of ['real Electron', 'keyboard', 'idempotent', 'screenshot']) assert.match(electron, new RegExp(phrase, 'iu'));

for (const document of ['docs/architecture/m13-execution-graph-ui.md', 'docs/evidence/m13-g09-verification.md']) assert.match(await read(document), new RegExp(binding, 'u'));
const packageJson = JSON.parse(await read('package.json'));
assert.match(packageJson.scripts['m13:g09:check'], /execution-graph-context-ui\.test\.mjs/u);
assert.match(packageJson.scripts['m13:g09:check'], /execution-graph-electron\.test\.mjs/u);
assert.match(packageJson.scripts['m13:g09:check'], /verify-m13-g09\.mjs/u);

console.log(`[m13-g09] browser=${evidence.status} screenshot=${evidence.screenshot.sha256.slice(0, 12)} renderMs=${evidence.performanceMs.productRender} projection1000Ms=${evidence.performanceMs.tool1000Projection} layout1000Ms=${evidence.performanceMs.tool1000OverviewLayout} electron=${evidence.electron.status} binding=${binding}`);
