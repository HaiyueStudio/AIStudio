import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineStudioPlugin } from '@haiyue/ai-studio-contracts';
import { createHarnessStudioRoot } from '@haiyue/ai-studio-harness-bridge';
import { OperationLog, operationLogServiceToken } from '@haiyue/ai-studio-operation-log';
import { agentRuntimeServiceToken } from '@haiyue/ai-studio-agent-runtime';
import { createPocAgentGameAuthoringPlugins, POC_COMMON_PLUGIN_IDS, POC_EDITOR_PROFILES, selectPocEditorProfile } from '../dist/profiles/agent-game-authoring.js';

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

test('product Harness profile loads sessions under the Studio root and rolls back failed replay', async (t) => {
  const log = await OperationLog.open({ rootDirectory: await mkdtemp(path.join(tmpdir(), 'studio-profile-owner-')), appVersion: 'test' });
  const root = createHarnessStudioRoot();
  t.after(async () => { try { await root.dispose(); } finally { await log.close(); } });
  let runtime;
  const fixturePlugin = (id, required, provides, activate) => defineStudioPlugin({
    manifest: { schemaVersion: 1, id, version: '1.0.0', apiVersion: '1.0', required, optional: [], provides, contributions: [], activationPolicy: 'required' },
    validateConfig: (value) => value, activate,
  });
  const operationLog = fixturePlugin('fixture.operation-log', [], [{ id: 'studio.operation-log', version: '1.0.0' }], (context) => {
    context.services.provide(operationLogServiceToken, { log });
  });
  const observer = fixturePlugin('fixture.runtime-observer', [{ id: 'studio.agent-runtime', version: '1.0.0' }], [], (context) => {
    runtime = context.services.get(agentRuntimeServiceToken);
  });
  const agent = createPocAgentGameAuthoringPlugins({ backend: 'harness-api-key', preview: {}, resolveDeepSeekApiKey: async () => null, clearDeepSeekApiKey: async () => {} })
    .find((plugin) => plugin.manifest.id === 'studio.agent-runtime.plugin');
  const catalog = [operationLog, agent, observer];
  const profile = { schemaVersion: 1, id: 'profile:harness-owner', bundles: [{ id: 'bundle:harness-owner', rows: catalog.map((plugin, index) => ({ id: `row:owner-${index}`, pluginId: plugin.manifest.id, enabled: true, config: {} })) }], patches: [] };
  await root.activate(profile, catalog);
  assert.ok(root.snapshot().resources.fibers > catalog.length, 'upstream plugins belong to the same registry');
  const backend = runtime.registry.get('backend:harness-api-key');
  assert.equal((await backend.status()).state, 'auth-required');
  const session = await backend.open({ studioSessionId: 'session:owner-fixture', model: 'deepseek-v4-flash', tools: [], surfaceGeneration: 1, surfaceDigest: `sha256:${'a'.repeat(64)}`, lastConfirmedOpId: 'op:owner-fixture' });
  assert.equal((await backend.inspect(session.remoteSessionId)).state, 'available');
  await root.replace({ ...profile, bundles: [] }, []);
  await assert.rejects(backend.status(), /disposed/);
  assert.equal(root.snapshot().resources.fibers, 0);

  const fault = t.mock.method(log, 'status', () => { throw new Error('profile-replay-fault'); });
  await assert.rejects(root.replace(profile, catalog), /profile-replay-fault/);
  assert.deepEqual(root.snapshot().resources, { services: 0, contributions: 0, listeners: 0, effects: 0, fibers: 0 });
  fault.mock.restore();
  await root.replace(profile, catalog);
  await root.dispose();
  assert.equal(root.snapshot().resources.fibers, 0);
});
