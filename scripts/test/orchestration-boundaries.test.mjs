import assert from 'node:assert/strict';
import test from 'node:test';
import { orchestrationBoundaryViolations as check } from '../orchestration-boundaries.mjs';

test('orchestration allows public service ports and local policies, but rejects platform and implementation imports', () => {
  const file = 'packages/agent-orchestration/src/host.ts';
  for (const target of ['@haiyue/ai-studio-agent-runtime', '@haiyue/ai-studio-shell/conversation', './plan-policy.js']) assert.deepEqual(check(file, `import { value } from '${target}';`), []);
  for (const target of ['electron', 'node:fs/promises', '@haiyue/ai-studio-editor-plugins', '@haiyue/ai-studio-agent-backends', '@haiyue/ai-studio-shell', '../../../apps/ai-studio/src/main.js']) {
    for (const statement of [`import '${target}';`, `export * from '${target}';`, `await import('${target}');`, `require('${target}');`]) assert.ok(check(file, statement).length > 0, statement);
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
