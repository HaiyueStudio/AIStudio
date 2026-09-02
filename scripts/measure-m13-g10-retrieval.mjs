import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeRetrievalRuntime } from '@haiyue/ai-studio-agent-runtime';
import { ComponentRegistry } from '@haiyue/ai-studio-editor-plugins';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { StudioKnowledgeSourceLoader } from '../apps/ai-studio/dist/knowledge-source-loader.js';
import { evaluateG10Retrieval, readG10Corpus } from '../evals/src/m13-g10-retrieval-eval.mjs';

const binding = 'm13-g10-2026-09-02';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'haiyue-m13-g10-measure-'));
const log = await OperationLog.open({ rootDirectory: temporary, appVersion: binding, flushPolicy: 'always' });
try {
  const registry = new ComponentRegistry();
  const workspace = { componentRegistry: registry, gameSnapshot: () => { throw new Error('No project is open in the engine-only A/B corpus.'); } };
  const knowledge = new KnowledgeRetrievalRuntime(log);
  await new StudioKnowledgeSourceLoader(knowledge, workspace).initialize();
  const result = await evaluateG10Retrieval({ corpus: await readG10Corpus(), knowledge });
  const evidence = Object.freeze({ binding, status: result.defaultEnabled ? 'default-enabled' : 'opt-in', ...result, index: knowledge.snapshot() });
  if (process.argv.includes('--check')) {
    assert.equal(evidence.cases.length, 7);
    assert.equal(evidence.summary.exactToolSuccessRate, 1);
    assert.equal(evidence.summary.hybridToolSuccessRate, 1);
    assert.equal(evidence.summary.groundedCitationRate, 1);
    assert.ok(evidence.summary.hybridRecallAt8 >= evidence.summary.exactRecallAt8);
    assert.ok(evidence.summary.schemaByteReduction >= 0.25);
    assert.ok(evidence.summary.inputTokenReduction >= 0.20);
    assert.equal(evidence.defaultEnabled, true);
  }
  const target = path.join(root, 'docs', 'evidence', 'm13-g10-retrieval-ab.json');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`[m13-g10] cases=${evidence.summary.cases} tools=${evidence.summary.hybridToolSuccessRate.toFixed(3)} recall=${evidence.summary.hybridRecallAt8.toFixed(3)} grounded=${evidence.summary.groundedCitationRate.toFixed(3)} schemaReduction=${evidence.summary.schemaByteReduction.toFixed(3)} inputReduction=${evidence.summary.inputTokenReduction.toFixed(3)} status=${evidence.status}`);
  knowledge.dispose();
} finally {
  await log.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
