import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertOracleIsolation,
  createAgentVisibleInput,
  loadEvaluationAssets,
} from '../src/index.mjs';

const assets = await loadEvaluationAssets();
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('agent projection contains only request fields and production prompts do not leak hidden oracle data', async () => {
  const productionTexts = await readProductionTexts([
    path.join(repositoryRoot, 'apps', 'ai-studio', 'src'),
    path.join(repositoryRoot, 'packages', 'agent-backends', 'src'),
    path.join(repositoryRoot, 'packages', 'agent-runtime', 'src'),
    path.join(repositoryRoot, 'packages', 'game-authoring-tools', 'src'),
    path.join(repositoryRoot, 'packages', 'harness-bridge', 'src'),
    path.join(repositoryRoot, 'packages', 'studio-shell', 'src'),
  ]);
  for (const testCase of assets.suite.cases) {
    const oracleCase = assets.oracle.cases.find((entry) => entry.caseId === testCase.id);
    for (const variantId of ['canonical', ...testCase.requestVariants.map((entry) => entry.id)]) {
      const agentInput = createAgentVisibleInput(testCase, variantId);
      assert.deepEqual(Object.keys(agentInput).sort(), ['constraints', 'request', 'schemaVersion']);
      assertOracleIsolation({ testCase, oracleCase, agentInput, productionTexts });
    }
  }
});

test('isolation guard rejects a hidden replay or acceptance string in production model text', () => {
  const testCase = assets.suite.cases[0];
  const oracleCase = assets.oracle.cases[0];
  assert.throws(
    () => assertOracleIsolation({
      testCase,
      oracleCase,
      agentInput: createAgentVisibleInput(testCase),
      productionTexts: [testCase.acceptance.functional[0].assertion],
    }),
    (error) => error.code === 'eval.oracle-production-leak',
  );
});

async function readProductionTexts(roots) {
  const texts = [];
  for (const root of roots) await walk(root, texts);
  return texts;
}

async function walk(directory, texts) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target, texts);
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) texts.push(await readFile(target, 'utf8'));
  }
}
