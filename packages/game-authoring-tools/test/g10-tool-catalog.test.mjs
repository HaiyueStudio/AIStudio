import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_COMPONENT_DEFINITIONS } from '@haiyue/ai-studio-editor-plugins';
import { GAME_AUTHORING_TOOL_DEFINITIONS, MODEL_CORE_TOOL_IDS, ToolCatalogRuntime } from '../dist/index.js';

test('registry-owned hybrid catalog finds semantic capabilities across Chinese and English queries', () => {
  const catalog = new ToolCatalogRuntime(GAME_AUTHORING_TOOL_DEFINITIONS, () => BUILTIN_COMPONENT_DEFINITIONS);
  const camera = catalog.search('修改镜头视角，让相机正交俯视并跟随目标', { limit: 12, includeSchemas: true });
  assert.ok(camera.some((entry) => entry.id === 'camera.author' && entry.capabilityGroup === 'camera' && entry.inputSchema));
  assert.ok(camera.some((entry) => entry.kind === 'component' && entry.nextTool === 'component.describe'));
  const physics = catalog.search('fixed body collision raycast 重力碰撞射线检测', { limit: 12 });
  assert.ok(physics.some((entry) => entry.id === 'play.physics-query' && entry.capabilityGroup === 'physics'));
  assert.ok(physics.every((entry) => /registry-owned hybrid match/u.test(entry.reason)));
});

test('task-aware schema expansion keeps stable core tools and materially reduces fixed schema bytes', () => {
  const catalog = new ToolCatalogRuntime(GAME_AUTHORING_TOOL_DEFINITIONS, () => BUILTIN_COMPONENT_DEFINITIONS);
  const cases = [
    'Create grid entities, keyboard input, gameplay state, HUD score, camera framing, screenshot and evaluator evidence.',
    'Create falling blocks with transform layout, input, collision rules, preview validation and captured evidence.',
    'Create a platform level with physics body, gravity, grounded jump input, following camera and validation.',
    'Create racing controls with vehicle physics, camera follow, HUD, particles and fixed replay evidence.',
    'Create shooting input with projectile pool, raycast collision, health HUD, camera and evaluator evidence.',
    'Create touch drag interaction with pointer input, transform snapping, gameplay state and screenshot evidence.',
    'Create match interactions with pointer input, gameplay trigger, score HUD, particles and evaluator evidence.',
  ];
  for (const request of cases) {
    const selected = catalog.selectDefinitions(request);
    for (const core of MODEL_CORE_TOOL_IDS) assert.ok(selected.selectedIds.includes(core));
    assert.ok(selected.definitions.length <= 18);
    assert.ok(selected.omittedCount > 0);
    assert.ok(selected.selectedSchemaBytes < selected.fixedSchemaBytes * 0.8, `${request} should reduce schema bytes by at least 20%`);
  }
  const expanded = catalog.selectDefinitions('Inspect the current project.', ['camera.author', 'component.configure']);
  assert.ok(expanded.selectedIds.includes('camera.author'));
  assert.ok(expanded.selectedIds.includes('component.configure'));
  assert.deepEqual(expanded.expandedIds, ['camera.author', 'component.configure']);
});
