import assert from 'node:assert/strict';
import { createPinnedHarnessAgentTransport } from '@haiyue/ai-studio-harness-bridge/agent';
import { HarnessApiKeyBackend } from '../dist/index.js';

if (process.env.HAIYUE_STUDIO_ALLOW_REAL_DEEPSEEK_SMOKE !== '1') {
  throw new Error('Real DeepSeek smoke requires explicit HAIYUE_STUDIO_ALLOW_REAL_DEEPSEEK_SMOKE=1 authorization.');
}
const secret = process.env.HAIYUE_STUDIO_DEEPSEEK_SECRET;
delete process.env.HAIYUE_STUDIO_DEEPSEEK_SECRET;
if (!secret) throw new Error('The declared HAIYUE_STUDIO_DEEPSEEK_SECRET test credential is unavailable.');

const transport = await createPinnedHarnessAgentTransport({ resolveApiKey: async () => secret });
const backend = new HarnessApiKeyBackend({ transport, clearApiKey: async () => {} });
const config = Object.freeze({
  schemaVersion: 2,
  backendId: 'backend:harness-api-key',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  outputTokenLimit: 8_192,
  taskBudgetId: 'budget:g07-deepseek-real',
  promptProfile: Object.freeze({ id: 'prompt:g07-deepseek-real', version: '2.0.0', digest: `sha256:${'a'.repeat(64)}` }),
  requestedCapabilities: Object.freeze(['agent.model-config', 'agent.usage', 'agent.cache', 'agent.context']),
});
const kinds = [];
let text = '';
let terminal;
try {
  assert.equal((await backend.status()).state, 'ready');
  for await (const event of backend.startTurn({ taskId: 'task:g07-deepseek-real', config, prompt: 'Reply exactly G07_DEEPSEEK_OK.', contextArtifactIds: [], tools: [] })) {
    kinds.push(event.kind);
    if (event.kind === 'conversation-node' && typeof event.payload.delta === 'string') text += event.payload.delta;
    if (event.kind === 'completed') terminal = event.payload.status;
  }
  assert.equal(text.trim(), 'G07_DEEPSEEK_OK');
  assert.equal(terminal, 'completed');
  console.log(JSON.stringify({ backend: 'harness-api-key', configured: true, kinds, terminal, credentialPersisted: false }));
} finally {
  await backend.dispose();
}
