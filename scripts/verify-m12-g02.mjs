import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  EvaluationRunner,
  canonicalStringify,
  contentDigest,
  createBlankFixtureAdapter,
  createReferenceFixtureAdapter,
  encodeEvaluationReport,
  loadEvaluationAssets,
} from '../evals/src/index.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = await loadEvaluationAssets();
const manifest = await readJson(path.join(repositoryRoot, 'evals', 'manifest.json'));

assert.equal(manifest.suiteId, assets.suite.suiteId);
assert.equal(manifest.suiteVersion, assets.suite.version);
for (const entry of manifest.artifacts) {
  const value = await readJson(path.join(repositoryRoot, entry.path));
  assert.equal(contentDigest(value), entry.digest, `${entry.path} digest drift`);
}

const referenceRunner = new EvaluationRunner({
  assets,
  adapterFactory: () => createReferenceFixtureAdapter(assets.referenceEvidence),
});
const blankRunner = new EvaluationRunner({ assets, adapterFactory: () => createBlankFixtureAdapter() });
const reference = await referenceRunner.runSuite();
const referenceAgain = await referenceRunner.runSuite();
const blank = await blankRunner.runSuite();
assert.deepEqual(reference.summary, { total: 7, passed: 7, failed: 0 });
assert.deepEqual(blank.summary, { total: 7, passed: 0, failed: 7 });
assert.equal(encodeEvaluationReport(reference), encodeEvaluationReport(referenceAgain));

for (const task of referenceRunner.enumerate({ modes: ['seeded-defect'], includeVariants: false })) {
  const result = await referenceRunner.runCase(task);
  const testCase = assets.suite.cases.find((entry) => entry.id === task.caseId);
  const failureSeed = testCase.failureSeeds.find((entry) => entry.id === task.failureSeedId);
  const failed = result.acceptanceResults.filter((entry) => entry.status === 'fail').map((entry) => entry.acceptanceId).sort();
  assert.deepEqual(failed, [...failureSeed.expectedFailedAcceptanceIds].sort(), task.failureSeedId);
}

const reportSchema = await readJson(path.join(repositoryRoot, 'evals', 'schemas', 'evaluation-report-v1.schema.json'));
const validateReport = new Ajv2020({ allErrors: true, strict: true }).compile(reportSchema);
assert.equal(validateReport(reference), true, validateReport.errors?.map((entry) => entry.message).join('; '));

const result = {
  suiteId: assets.suite.suiteId,
  suiteVersion: assets.suite.version,
  caseCount: assets.suite.cases.length,
  taskCount: referenceRunner.enumerate().length,
  acceptanceCount: assets.oracle.cases.reduce((total, entry) => total + entry.rules.length, 0),
  seededDefectCount: referenceRunner.enumerate({ modes: ['seeded-defect'], includeVariants: false }).length,
  reference: reference.summary,
  blank: blank.summary,
  deterministicReportDigest: contentDigest(JSON.parse(encodeEvaluationReport(reference))),
};
console.log(`[m12:g02] ${canonicalStringify(result)}`);

async function readJson(target) { return JSON.parse(await readFile(target, 'utf8')); }
