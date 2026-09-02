import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BUILTIN_COMPONENT_DEFINITIONS } from '@haiyue/ai-studio-editor-plugins';
import { GAME_AUTHORING_TOOL_DEFINITIONS } from '../dist/index.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/g08-seven-game-semantic-cases.json', import.meta.url), 'utf8'));

test('seven game cases consume only registered genre-neutral tools and component capabilities', () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(fixture.cases.map((item) => item.id), ['snake', 'match-3', 'tetris', 'jigsaw', 'platformer', 'racing', 'shooter']);
  const tools = new Set(GAME_AUTHORING_TOOL_DEFINITIONS.map((item) => item.id));
  const components = new Set(BUILTIN_COMPONENT_DEFINITIONS.map((item) => item.type));
  for (const item of fixture.cases) {
    assert.ok(item.toolIds.length >= 8, `${item.id} must exercise a composed semantic tool path`);
    assert.ok(item.capabilities.length >= 6, `${item.id} must name observable capability needs`);
    for (const required of ['component.configure', 'play.input', 'play.inspect', 'play.capture', 'task.evaluate']) assert.ok(item.toolIds.includes(required), `${item.id} must close authoring → input → state → screenshot → evaluator`);
    for (const required of ['haiyue.gameplay.state', 'haiyue.gameplay.rules', 'haiyue.ui.hud']) assert.ok(item.componentTypes.includes(required), `${item.id} must use the shared declarative gameplay/HUD surface`);
    for (const toolId of item.toolIds) assert.ok(tools.has(toolId), `${item.id} references missing tool ${toolId}`);
    for (const type of item.componentTypes) assert.ok(components.has(type), `${item.id} references missing component ${type}`);
  }
  const allTools = new Set(fixture.cases.flatMap((item) => item.toolIds));
  for (const required of ['history.query', 'prefab.manage', 'camera.author', 'play.physics-query']) assert.ok(allTools.has(required), `seven-game matrix must cover ${required}`);
  const allComponents = new Set(fixture.cases.flatMap((item) => item.componentTypes));
  for (const required of ['haiyue.gameplay.timers', 'haiyue.gameplay.pool', 'haiyue.audio.listener']) assert.ok(allComponents.has(required), `seven-game matrix must cover ${required}`);
  const forbidden = /(?:^|[._-])(snake|match3|match-3|tetris|jigsaw|platformer|racing|shooter)(?:$|[._-])/iu;
  assert.ok(GAME_AUTHORING_TOOL_DEFINITIONS.every((item) => !forbidden.test(item.id)), 'production tool ids must remain genre-neutral');
});

test('high-value semantic tools retain bounded schemas, explicit effects and safe result budgets', () => {
  const expected = ['scene.get-many', 'tool.search', 'asset.dependencies', 'script.symbols', 'script.patch', 'history.query', 'entity.hierarchy', 'prefab.manage', 'transform.batch', 'camera.author', 'component.configure', 'play.physics-query'];
  const byId = new Map(GAME_AUTHORING_TOOL_DEFINITIONS.map((item) => [item.id, item]));
  for (const id of expected) {
    const definition = byId.get(id); assert.ok(definition, `missing ${id}`);
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.ok(definition.maxResultBytes <= 65_536);
    assert.ok(definition.timeoutMs <= 20_000);
  }
  for (const id of ['scene.get-many', 'tool.search', 'asset.dependencies', 'script.symbols', 'history.query']) assert.equal(byId.get(id).concurrencySafe, true);
  for (const id of ['entity.hierarchy', 'prefab.manage', 'transform.batch', 'camera.author']) {
    assert.equal(byId.get(id).effect, 'reversible-edit'); assert.equal(byId.get(id).requiresApproval, true);
  }
});
