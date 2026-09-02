import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const readJson = async (relative) => JSON.parse(await read(relative));
const binding = 'm13-g08-2026-09-01';
const genres = ['snake', 'match-3', 'tetris', 'jigsaw', 'platformer', 'racing', 'shooter'];

const census = await readJson('docs/architecture/m13-g08-capability-census.json');
assert.equal(census.binding, binding);
assert.equal(new Set(census.capabilities.map((entry) => entry.id)).size, census.capabilities.length);
for (const entry of census.capabilities) {
  assert.ok(entry.engine && entry.effect && entry.evidence && entry.owner && entry.priority && entry.targetGoal, `Incomplete census row ${entry.id}`);
  assert.ok(census.statuses.includes(entry.status), `Unknown status ${entry.status}`);
  if (entry.targetGoal === 'M13 G08') assert.ok(entry.status === 'implemented' || entry.status === 'available', `Open G08 gap ${entry.id}: ${entry.status}`);
}
assert.deepEqual(census.capabilities.filter((entry) => entry.status === 'gap' || entry.status === 'partial').map((entry) => entry.id), []);
assert.deepEqual(census.capabilities.filter((entry) => entry.status === 'handoff').map((entry) => entry.id), ['advanced-authoring']);
for (const required of ['scene-delta', 'semantic-transaction', 'hierarchy-spatial', 'prefab-history', 'camera-authoring', 'tool-component-discovery', 'incremental-script-context', 'asset-dependency-graph', 'input-actions', 'physics-components', 'physics-query', 'visual-effects', 'audio', 'declarative-gameplay', 'declarative-hud', 'runtime-assertions']) assert.ok(census.capabilities.some((entry) => entry.id === required), `Missing census domain ${required}`);

const fixture = await readJson('packages/game-authoring-tools/test/fixtures/g08-seven-game-semantic-cases.json');
assert.equal(fixture.schemaVersion, 1);
assert.deepEqual(fixture.cases.map((entry) => entry.id), genres);
const forbidden = /(?:^|[._-])(snake|match3|match-3|tetris|jigsaw|platformer|racing|shooter)(?:$|[._-])/iu;
for (const entry of fixture.cases) {
  for (const tool of ['component.configure', 'play.input', 'play.inspect', 'play.capture', 'task.evaluate']) assert.ok(entry.toolIds.includes(tool), `${entry.id} lacks ${tool}`);
  for (const component of ['haiyue.gameplay.state', 'haiyue.gameplay.rules', 'haiyue.ui.hud']) assert.ok(entry.componentTypes.includes(component), `${entry.id} lacks ${component}`);
  assert.ok(entry.capabilities.length >= 6);
}
const definitions = await read('packages/game-authoring-tools/src/definitions.ts');
for (const id of ['scene.get-many', 'tool.search', 'history.query', 'prefab.manage', 'camera.author', 'transform.batch', 'component.configure', 'play.physics-query', 'play.inspect', 'play.capture', 'task.evaluate']) assert.match(definitions, new RegExp(`definition\\('${id.replaceAll('.', '\\.')}'`, 'u'));
for (const match of definitions.matchAll(/definition\('([^']+)'/gu)) assert.doesNotMatch(match[1], forbidden, `Genre-specific production tool ${match[1]}`);

const components = await read('packages/editor-plugins/src/render/components.ts');
for (const type of ['haiyue.gameplay.state', 'haiyue.gameplay.timers', 'haiyue.gameplay.pool', 'haiyue.gameplay.rules', 'haiyue.ui.hud', 'haiyue.audio.listener']) assert.match(components, new RegExp(type.replaceAll('.', '\\.'), 'u'));
const runtimeTests = await read('packages/game-authoring-tools/test/runtime.test.mjs');
for (const phrase of ['camera.author creates, switches, frames, orbits, follows', 'recoverable hierarchy operations clone, reparent and restore', 'prefab.manage captures, instantiates and removes', 'history.query stays bounded and source-redacted', 'schema fuzz rejects', 'revision drift fail closed', 'play.capture', 'task.evaluate']) assert.match(runtimeTests, new RegExp(phrase.replaceAll('.', '\\.'), 'iu'));
const declarativeTests = `${await read('apps/ai-studio/test/declarative-play-components.test.mjs')}\n${await read('apps/ai-studio/test/g08-declarative-play-electron.test.mjs')}`;
for (const phrase of ['declarative gameplay, timer, HUD and listener', 'fails closed on ambiguous HUD and audio ownership', 'current-revision screenshot']) assert.match(declarativeTests, new RegExp(phrase, 'iu'));
const physicsTests = await read('apps/ai-studio/test/g07-physics-runtime.test.mjs');
for (const phrase of ['seeded platformer', 'seeded racer', 'seeded shooter', 'raycast', 'overlap']) assert.match(physicsTests, new RegExp(phrase, 'iu'));
const effectsTests = await read('apps/ai-studio/test/g08-render-effects-runtime.test.mjs');
for (const phrase of ['audio unlock listeners', '2D and 3D particle owners', 'post-process ordering', 'seven genres share one component registry']) assert.match(effectsTests, new RegExp(phrase, 'iu'));

for (const document of ['docs/architecture/m13-g08-capability-census.md', 'docs/evidence/m13-g08-verification.md']) assert.match(await read(document), new RegExp(binding, 'u'));
const packageJson = await readJson('package.json');
assert.match(packageJson.scripts['m13:g08:check'], /g08-declarative-play-electron\.test\.mjs/u);
assert.match(packageJson.scripts['m13:g08:check'], /verify-m13-g08\.mjs/u);

console.log(`[m13-g08] capabilities=${census.capabilities.length} implemented=${census.capabilities.filter((entry) => entry.status === 'implemented').length} available=${census.capabilities.filter((entry) => entry.status === 'available').length} handoff=${census.capabilities.filter((entry) => entry.status === 'handoff').length} genres=${fixture.cases.length} binding=${binding}`);
