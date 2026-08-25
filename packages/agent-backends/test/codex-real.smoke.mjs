import assert from 'node:assert/strict';
import { asStableId } from '@haiyue/ai-studio-contracts';
import { CodexAppServerBackend } from '../dist/index.js';

if (process.env.HAIYUE_STUDIO_ALLOW_REAL_CODEX_SMOKE !== '1') {
  throw new Error('Real Codex smoke requires explicit HAIYUE_STUDIO_ALLOW_REAL_CODEX_SMOKE=1 authorization.');
}

const backend = new CodexAppServerBackend();
const summaries = [];
try {
  const status = await backend.status();
  assert.equal(status.state, 'ready', JSON.stringify(status.diagnostic));
  assert.equal(status.authMode, 'chatgpt');
  const catalog = await backend.modelCatalog();
  const model = catalog.models.find((item) => item.isDefault) ?? catalog.models[0];
  assert.ok(model);
  const smokeEffort = model.reasoningEfforts.includes('low') ? 'low' : model.defaultReasoningEffort;

  const text = await run('text', 'Reply exactly G07_CODEX_OK with no other text. Do not call any tool.', []);
  assert.equal(text.terminal, 'completed');
  assert.equal(text.text.trim(), 'G07_CODEX_OK');

  const tool = await run('tool', 'Call the studio.nonce tool exactly once. After receiving its result, reply exactly G07_TOOL_NONCE_OK with no other text.', [{
    id: asStableId('studio.nonce'), description: 'Returns a fixed G07 nonce.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }], async (event) => {
    assert.equal(event.payload.toolId, 'studio.nonce');
    await backend.submitToolResult(asStableId(event.payload.toolCallId), { nonce: 'G07_NONCE_20260825' });
  });
  assert.equal(tool.terminal, 'completed');
  assert.equal(tool.text.trim(), 'G07_TOOL_NONCE_OK');
  assert.equal(tool.toolCalls, 1);

  const question = await run('question', 'Use request_user_input exactly once to ask a single-choice question with id choice and option safe. After the answer, reply exactly CHOICE_OK with no other text.', [], undefined, async (event) => {
    await backend.answerQuestion(asStableId(event.payload.nodeId), { choice: { answers: ['safe'] } });
  });
  assert.equal(question.terminal, 'completed');
  assert.equal(question.text.trim(), 'CHOICE_OK');
  assert.equal(question.questions, 1);

  const cancelled = await run('cancel', 'Think carefully for a long time before replying. Do not call tools.', [], undefined, undefined, true);
  assert.equal(cancelled.terminal, 'cancelled');

  console.log(JSON.stringify({ backend: 'codex-app-server', authMode: status.authMode, model: model.id, reasoningEffort: smokeEffort, rateLimitBuckets: status.rateLimits.length, summaries }));

  async function run(name, prompt, tools, onTool, onQuestion, cancelOnStart = false) {
    console.error(JSON.stringify({ smoke: 'g07-codex', stage: name, state: 'starting' }));
    const controller = new AbortController();
    const timeoutMs = name === 'tool' || name === 'question' ? 300_000 : 180_000;
    const timeout = setTimeout(() => controller.abort(new Error(`G07 Codex ${name} turn exceeded ${timeoutMs / 1_000} seconds.`)), timeoutMs);
    const config = Object.freeze({
      schemaVersion: 2, backendId: backend.descriptor.id, model: model.id, reasoningEffort: smokeEffort,
      outputTokenLimit: Math.min(8_192, model.maxOutputTokens), taskBudgetId: asStableId(`budget:g07-codex-${name}`),
      promptProfile: Object.freeze({ id: asStableId('prompt:g07-codex-real'), version: '2.0.0', digest: `sha256:${'b'.repeat(64)}` }),
      requestedCapabilities: Object.freeze(['agent.model-config', 'agent.usage', 'agent.cache', 'agent.context']),
    });
    let text = ''; let terminal; let toolCalls = 0; let questions = 0;
    try {
      for await (const event of backend.startTurn({ taskId: asStableId(`task:g07-codex-${name}`), config, prompt, contextArtifactIds: [], tools }, controller.signal)) {
        if (event.kind === 'status' && cancelOnStart) await backend.cancelTurn(event.sessionId, event.turnId);
        if (event.kind === 'conversation-node' && typeof event.payload.delta === 'string') text += event.payload.delta;
        if (event.kind === 'tool-request') { toolCalls += 1; if (!onTool) throw new Error(`Unexpected tool request: ${event.payload.toolId}`); await onTool(event); }
        if (event.kind === 'question') { questions += 1; if (!onQuestion) throw new Error('Unexpected Codex question.'); await onQuestion(event); }
        if (event.kind === 'completed') terminal = event.payload.status;
      }
    } finally {
      clearTimeout(timeout);
    }
    const summary = Object.freeze({ name, terminal, toolCalls, questions }); summaries.push(summary);
    console.error(JSON.stringify({ smoke: 'g07-codex', stage: name, state: 'finished', terminal, toolCalls, questions }));
    return Object.freeze({ ...summary, text });
  }
} finally {
  await backend.dispose();
}
