import test from 'node:test';
import assert from 'node:assert/strict';
import { isModelRequestContextV1, isModelRequestPreparationV1 } from '../dist/index.js';
const valid = { schemaVersion: 1, sessionId: 'session:one', turnId: 'turn:one', model: 'model', epoch: 0, maxInputTokens: null, reservedOutputTokens: 8192, requestBytes: 1024, previousUsage: null, tools: [], messages: [{ id: 'message:one', role: 'user', text: 'hello', toolCallIds: [], resultFor: null }] };
test('request context contract accepts valid/unknown capacity and rejects malformed, unknown-version and secret-bearing envelopes', () => {
  assert.equal(isModelRequestContextV1(valid), true);
  for (const bad of [{ ...valid, schemaVersion: 2 }, { ...valid, maxInputTokens: -1 }, { ...valid, apiKey: 'fixture-secret' }, { ...valid, previousUsage: { inputTokens: 3, requestBytes: 0 } }, { ...valid, messages: [...valid.messages, ...valid.messages] }, { ...valid, messages: [{ ...valid.messages[0], credentialPath: '/secret' }] }]) assert.equal(isModelRequestContextV1(bad), false);
  assert.equal(isModelRequestPreparationV1({ id: 'prepared:one', replacement: { throughMessageId: 'message:one', summary: 'retained facts' } }), true);
  for (const bad of [{ id: 'prepared:one', apiKey: 'fixture-secret' }, { id: 'prepared:one', replacement: { throughMessageId: 'message:one', summary: '', approve: true } }]) assert.equal(isModelRequestPreparationV1(bad), false);
});
