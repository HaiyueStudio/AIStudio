import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioConversationHost } from '../dist/index.js';

test('reconnect refreshes the catalog and unavailable preferred models never silently switch', async t => {
  const id = 'backend:codex-app-server';
  const model = (id, isDefault = false) => ({ id, label: id, description: id, reasoningEfforts: ['low', 'max'], defaultReasoningEffort: 'low', maxOutputTokens: 128000, isDefault });
  const sol = model('gpt-6.2-sol', true), astra = model('gpt-6.2-astra');
  let models = [sol, astra], refreshes = 0;
  const catalog = () => ({ schemaVersion: 1, backendId: id, protocolVersion: '0.171.0', source: 'provider', models });
  const backend = { descriptor: { id, kind: 'codex-app-server', protocolVersion: '0.171.0', capabilities: {} },
    status: async () => ({ state: 'ready', authMode: 'chatgpt', rateLimits: [] }), modelCatalog: async () => catalog(),
    refreshModelCatalog: async () => { refreshes += 1; return catalog(); } };
  const host = new StudioConversationHost({ operationLog: { append: async () => {} }, tools: {},
    runtime: { registry: { descriptors: () => [backend.descriptor], get: () => backend }, context: { prompts: { profile: { id: 'prompt:models', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` } } } } });
  t.after(() => host.dispose());
  await host.dispatch({ type: 'conversation/reconnect' });
  assert.equal(refreshes, 1); assert.equal(host.replay().backends[0].selectedModel, sol.id);
  await host.dispatch({ type: 'agent/configure', backendId: id, model: astra.id, reasoningEffort: 'max', outputTokenLimit: 8192, budget: host.settings().budget });
  assert.equal(host.replay().backends[0].selectedReasoningEffort, 'max');
  assert.equal(refreshes, 1, 'local settings do not trigger another network fetch');
  models = [sol]; await host.dispatch({ type: 'conversation/reconnect' });
  assert.equal(host.replay().backends[0].state, 'unavailable');
  assert.equal(host.replay().backends[0].diagnostic.code, 'agent.model-unavailable');
  assert.equal(host.replay().backends[0].selectedModel, null);
  assert.equal(host.settings().selections[0].model, astra.id, 'retain the preference so recovery can restore it');
  models = [sol, astra]; await host.dispatch({ type: 'conversation/reconnect' });
  assert.equal(host.replay().backends[0].state, 'ready'); assert.equal(host.replay().backends[0].selectedModel, astra.id);
});
