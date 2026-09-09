import assert from 'node:assert/strict';
import test from 'node:test';
import { orchestrationBoundaryViolations as check } from '../orchestration-boundaries.mjs';

test('orchestration allows public service ports and local policies, but rejects platform and implementation imports', () => {
  const file = 'packages/agent-orchestration/src/host.ts';
  for (const target of ['@haiyue/ai-studio-agent-runtime', '@haiyue/ai-studio-shell/conversation', '@haiyue/ai-studio-shell/advanced/model', '@haiyue/ai-studio-shell/resources/model', './plan-policy.js']) assert.deepEqual(check(file, `import { value } from '${target}';`), []);
  for (const target of ['electron', 'node:fs/promises', '@haiyue/ai-studio-editor-plugins', '@haiyue/ai-studio-agent-backends', '@haiyue/ai-studio-shell', '@haiyue/ai-studio-shell/advanced', '@haiyue/ai-studio-shell/resources', '../../../apps/ai-studio/src/main.js']) {
    for (const statement of [`import '${target}';`, `export * from '${target}';`, `await import('${target}');`, `require('${target}');`]) assert.ok(check(file, statement).length > 0, statement);
  }
});

test('headless editor read models cannot pull panels into orchestration', () => {
  for (const module of ['advanced', 'resources']) {
    const file = `packages/studio-shell/src/panels/${module}/model.ts`;
    assert.ok(check(file, "export * from './panel.js';").length > 0);
    assert.ok(check(file, "import 'electron';").length > 0);
    assert.deepEqual(check(file, "import type { JsonObject } from '@haiyue/ai-studio-contracts';"), []);
  }
});

test('reverse imports and production dependencies cannot recreate the application layer cycle', () => {
  for (const module of ['agent-runtime', 'game-authoring-tools', 'studio-shell']) {
    assert.ok(check(`packages/${module}/src/index.ts`, "import type { StudioConversationHost } from '@haiyue/ai-studio-agent-orchestration';").length > 0);
    assert.ok(check(`packages/${module}/package.json`, JSON.stringify({ dependencies: { '@haiyue/ai-studio-agent-orchestration': '0.0.0' } })).length > 0);
  }
  assert.ok(check('packages/agent-orchestration/package.json', JSON.stringify({ dependencies: { electron: '43.5.1' } })).length > 0);
  assert.ok(check('packages/studio-shell/src/conversation/index.ts', "export * from '../panels/chat/index.js';").length > 0);
  assert.deepEqual(check('apps/ai-studio/src/main.ts', "import { StudioConversationHost } from '@haiyue/ai-studio-agent-orchestration';"), []);
});
