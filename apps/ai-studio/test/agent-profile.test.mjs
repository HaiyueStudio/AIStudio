import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { POC_COMMON_PLUGIN_IDS, POC_EDITOR_PROFILES, selectPocEditorProfile } from '../dist/profiles/agent-game-authoring.js';

test('G10 profile composes common tools with exactly one selected backend and no embedded credentials', async () => {
  const source = await readFile(new URL('../src/profiles/agent-game-authoring.ts', import.meta.url), 'utf8');
  assert.match(source, /createGameAuthoringToolsPlugin/);
  assert.match(source, /createAgentRuntimePlugin/);
  assert.match(source, /HarnessApiKeyBackend/);
  assert.match(source, /CodexAppServerBackend/);
  assert.match(source, /createPinnedHarnessAgentTransport/);
  assert.match(source, /options\.backend === 'codex-app-server'/);
  assert.match(source, /return Object\.freeze\(\[new CodexAppServerBackend/);
  assert.match(source, /return Object\.freeze\(\[new HarnessApiKeyBackend/);
  assert.doesNotMatch(source, /process\.env|["']~?\/?\.codex[\\/]|apiKey\s*:/);
  assert.doesNotMatch(source, /shell|filesystem|network|child_process/);
  assert.deepEqual(Object.keys(POC_EDITOR_PROFILES), ['poc-editor-harness', 'poc-editor-codex']);
  assert.deepEqual(POC_EDITOR_PROFILES['poc-editor-harness'], { id: 'poc-editor-harness', backend: 'harness-api-key', auth: 'api-key' });
  assert.deepEqual(POC_EDITOR_PROFILES['poc-editor-codex'], { id: 'poc-editor-codex', backend: 'codex-app-server', auth: 'chatgpt' });
  assert.equal(selectPocEditorProfile('unknown').id, 'poc-editor-codex');
  assert.equal(POC_COMMON_PLUGIN_IDS.length, 13);
  assert.equal(new Set(POC_COMMON_PLUGIN_IDS).size, POC_COMMON_PLUGIN_IDS.length);
});
