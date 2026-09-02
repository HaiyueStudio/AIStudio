import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const readJson = async (relative) => JSON.parse(await read(relative));
const implementationBinding = 'm13-g05-2026-09-01';
const contractBinding = 'm13-g01-2026-09-01';

const contractIndex = await readJson('config/contracts/m13-contract-index.json');
assert.equal(contractIndex.bindingId, contractBinding);
assert.equal(contractIndex.contracts.find((entry) => entry.name === 'SceneDiffV1')?.owner, 'g05-scene-diff-context-router');

const scene = await read('packages/editor-plugins/src/project/scene-context.ts');
const workspace = await read('packages/editor-plugins/src/history/workspace.ts');
const definitions = await read('packages/game-authoring-tools/src/definitions.ts');
const toolRuntime = await read('packages/game-authoring-tools/src/runtime.ts');
const router = await read('packages/agent-runtime/src/context/router.ts');
const contextRuntime = await read('packages/agent-runtime/src/context/runtime.ts');
const prompt = await read('packages/agent-runtime/src/prompt-context.ts');
const app = await read('apps/ai-studio/src/main.ts');
const sceneTests = await read('packages/editor-plugins/test/g05-scene-context.test.mjs');
const routerTests = await read('packages/agent-runtime/test/g05-context-router.test.mjs');
const toolTests = await read('packages/game-authoring-tools/test/runtime.test.mjs');
const appTest = await read('apps/ai-studio/test/scene-diff-context-integration.test.mjs');

for (const phrase of ['DEFAULT_RETAINED_DELTAS = 2_048', 'MAX_LIMIT = 1_000', 'scene.history-pruned', 'scene.revision-future', 'scene.revision-gap', 'scene.cursor-stale', 'scene.cursor-invalid', 'const replayed = applyOperations', 'digestValue(replayed', 'safeSnapshotDigest', 'targetSnapshotDigest', 'provenanceOpIds']) {
  assert.match(scene, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), `Scene invariant missing ${phrase}`);
}
for (const phrase of ['queryScene(input', 'diffScene(input', 'sceneContext.record', 'mutationProvenanceOpIds', "kind: 'document/command-requested'", 'history/${kind}-requested']) {
  assert.match(workspace, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), `Workspace ownership missing ${phrase}`);
}

assert.match(definitions, /definition\('scene\.query'.*'observe'.*64 \* 1024\)/u);
assert.match(definitions, /definition\('scene\.diff'.*'observe'.*64 \* 1024\)/u);
assert.match(toolRuntime, /case 'scene\.query': return options\.workspace\.queryScene/u);
assert.match(toolRuntime, /case 'scene\.diff': return options\.workspace\.diffScene/u);
const snapshotCase = toolRuntime.slice(toolRuntime.indexOf("case 'project.snapshot':"), toolRuntime.indexOf("case 'scene.query':"));
for (const forbidden of ['gameSnapshot', 'scriptsSnapshot', 'settings:', 'camera:', 'entities:']) assert.doesNotMatch(snapshotCase, new RegExp(forbidden, 'u'), `project.snapshot still exposes ${forbidden}`);

for (const phrase of ["['diagnostics', this.sources.diagnostics, 'diagnostics-delta']", "['evidence', this.sources.evidence, 'evidence-delta']", "['playTrace', this.sources.playTrace, 'evidence-delta']", 'snapshot-recovery', 'fullSceneTransmissions', 'fullSceneRetransmissionReduction', 'context.delta-cursor-invalid']) {
  assert.match(router, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), `Router invariant missing ${phrase}`);
}
assert.match(contextRuntime, /createRouter\(sources: ContextRouterSources\)/u);
assert.doesNotMatch(router, /@deepseek|@openai|cordis|dsh-agent/iu, 'provider package leaked into Context Router');
assert.match(prompt, /project\.exact\.query/u);
assert.match(prompt, /input\.project\.exact\.diff/u);
assert.match(prompt, /snapshot-recovery/u);
assert.match(app, /exact: Object\.freeze/u);
assert.match(app, /workspace\.queryScene/u);
assert.match(app, /workspace\.diffScene/u);

for (const phrase of ['0/1/1000 entity and 200 script', 'asset, camera and render changes retain provenance', 'tampered', 'scene.revision-gap', 'transaction:g05-divergent']) assert.match(sceneTests, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'));
for (const phrase of ['fixed precedence', '80% retransmission gate', 'snapshot recovery', 'sparse-event loss']) assert.match(routerTests, new RegExp(phrase, 'iu'));
assert.match(toolTests, /scene\.query and scene\.diff expose paged exact context/u);
assert.match(appTest, /desktop composition sends one bounded Scene baseline and exact revision deltas without script text/u);

for (const document of ['docs/architecture/m13-scene-context-router.md', 'docs/evidence/m13-g05-verification.md']) {
  const body = await read(document);
  assert.match(body, new RegExp(implementationBinding, 'u'));
  assert.match(body, new RegExp(contractBinding, 'u'));
}

console.log(`[m13-g05] editorScenarios=3 routerScenarios=4 toolIntegration=1 appIntegration=1 retransmissionReduction=100% binding=${implementationBinding}`);
