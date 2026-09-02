import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KnowledgeRetrievalRuntime } from '@haiyue/ai-studio-agent-runtime';
import { ComponentRegistry } from '@haiyue/ai-studio-editor-plugins';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { StudioKnowledgeSourceLoader } from '../../apps/ai-studio/dist/knowledge-source-loader.js';
import { evaluateG10Retrieval, readG10Corpus } from '../src/m13-g10-retrieval-eval.mjs';

test('seven-game exact-only A/B keeps success while hybrid retrieval cuts schema and input tokens', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g10-eval-'));
  const log = await OperationLog.open({ rootDirectory: root, appVersion: 'g10-eval', flushPolicy: 'always' });
  try {
    const registry = new ComponentRegistry();
    const workspace = { componentRegistry: registry, gameSnapshot: () => { throw new Error('No project is open in the engine-only corpus.'); } };
    const knowledge = new KnowledgeRetrievalRuntime(log);
    await new StudioKnowledgeSourceLoader(knowledge, workspace).initialize();
    const result = await evaluateG10Retrieval({ corpus: await readG10Corpus(), knowledge });
    assert.equal(result.cases.length, 7);
    assert.equal(result.summary.exactToolSuccessRate, 1);
    assert.equal(result.summary.hybridToolSuccessRate, 1);
    assert.equal(result.summary.groundedCitationRate, 1);
    assert.ok(result.summary.hybridRecallAt8 >= result.summary.exactRecallAt8);
    assert.ok(result.summary.schemaByteReduction >= 0.25);
    assert.ok(result.summary.inputTokenReduction >= 0.20);
    assert.equal(result.defaultEnabled, true);
    knowledge.dispose();
  } finally {
    await log.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
