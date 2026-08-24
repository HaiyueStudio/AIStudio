import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { deepFreeze } from './canonical.mjs';
import { flattenAcceptance } from './oracle.mjs';

const evalRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(evalRoot, '..');

export const DEFAULT_EVALUATION_PATHS = deepFreeze({
  suite: path.join(evalRoot, 'suites', 'game-agent-evaluation-v1.json'),
  suiteSchema: path.join(evalRoot, 'suites', 'game-agent-evaluation-v1.schema.json'),
  oracle: path.join(evalRoot, 'suites', 'game-agent-evaluation-v1.oracle.json'),
  referenceEvidence: path.join(evalRoot, 'fixtures', 'reference-evidence-v1.json'),
  capabilitySchema: path.join(repositoryRoot, 'config', 'contracts', 'schemas', 'm12-capability-id.schema.json'),
});

export async function loadEvaluationAssets(paths = DEFAULT_EVALUATION_PATHS) {
  const [suite, schema, oracle, referenceEvidence, capabilitySchema] = await Promise.all([
    readJson(paths.suite), readJson(paths.suiteSchema), readJson(paths.oracle), readJson(paths.referenceEvidence), readJson(paths.capabilitySchema),
  ]);
  validateEvaluationSuiteSchema({ suite, schema });
  verifySuiteRelationships({ suite, oracle, referenceEvidence, capabilityIds: capabilitySchema.enum });
  return deepFreeze({ suite, schema, oracle, referenceEvidence, capabilityIds: [...capabilitySchema.enum] });
}

export function validateEvaluationSuiteSchema({ suite, schema }) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(suite)) throw new EvaluationSuiteError('eval.suite-schema-invalid', ajv.errorsText(validate.errors));
  return true;
}

export function verifySuiteRelationships({ suite, oracle, referenceEvidence, capabilityIds }) {
  const requiredGenres = ['snake', 'match-3', 'falling-blocks', 'jigsaw', 'platformer', 'racing', 'shooter'];
  assertUnique(suite.cases.map((entry) => entry.id), 'case id');
  assertSameSet(suite.cases.map((entry) => entry.genre), requiredGenres, 'genre coverage');
  if (suite.oracleVisibility !== 'runner-only' || oracle.visibility !== 'runner-only') fail('eval.oracle-visibility-invalid', 'Oracle must be runner-only.');
  if (oracle.suiteId !== suite.suiteId || oracle.suiteVersion !== suite.version) fail('eval.oracle-version-drift', 'Oracle suite identity drift.');
  if (referenceEvidence.suiteId !== suite.suiteId || referenceEvidence.suiteVersion !== suite.version) fail('eval.fixture-version-drift', 'Reference fixture suite identity drift.');

  const capabilitySet = new Set(capabilityIds);
  const oracleByCase = indexUnique(oracle.cases, 'caseId', 'oracle case');
  const fixtureByCase = indexUnique(referenceEvidence.cases, 'caseId', 'reference fixture case');
  assertSameSet([...oracleByCase.keys()], suite.cases.map((entry) => entry.id), 'oracle cases');
  assertSameSet([...fixtureByCase.keys()], suite.cases.map((entry) => entry.id), 'reference fixture cases');

  const globalAcceptanceIds = [];
  for (const testCase of suite.cases) {
    if (testCase.requestVariants.length < 2) fail('eval.variant-count-invalid', `${testCase.id} needs at least two variants.`);
    assertUnique(testCase.requestVariants.map((entry) => entry.id), `${testCase.id} variant id`);
    for (const capabilityId of testCase.requiredCapabilities) {
      if (!capabilitySet.has(capabilityId)) fail('eval.capability-unknown', `${testCase.id} references unknown capability ${capabilityId}.`);
    }
    verifyReplay(testCase);
    const acceptances = flattenAcceptance(testCase);
    const acceptanceIds = acceptances.map((entry) => entry.id);
    globalAcceptanceIds.push(...acceptanceIds);
    assertUnique(acceptanceIds, `${testCase.id} acceptance id`);
    for (const acceptance of testCase.acceptance.visual) {
      if (!acceptance.evidence.includes('screenshot') || !acceptance.evidence.some((type) => type === 'state' || type === 'event-trace')) {
        fail('eval.visual-corroboration-missing', `${acceptance.id} needs screenshot plus state/event evidence.`);
      }
    }
    const failureIds = testCase.failureSeeds.map((entry) => entry.id);
    assertUnique(failureIds, `${testCase.id} failure seed id`);
    for (const seed of testCase.failureSeeds) {
      for (const acceptanceId of seed.expectedFailedAcceptanceIds) {
        if (!acceptanceIds.includes(acceptanceId)) fail('eval.failure-seed-acceptance-unknown', `${seed.id} references ${acceptanceId}.`);
      }
    }

    const oracleCase = oracleByCase.get(testCase.id);
    assertSameSet(oracleCase.rules.map((entry) => entry.acceptanceId), acceptanceIds, `${testCase.id} oracle rules`);
    const acceptanceById = new Map(acceptances.map((entry) => [entry.id, entry]));
    for (const rule of oracleCase.rules) {
      if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) fail('eval.oracle-rule-empty', `${rule.acceptanceId} has no conditions.`);
      const declaredEvidence = new Set(acceptanceById.get(rule.acceptanceId).evidence);
      for (const condition of rule.conditions) {
        if (!declaredEvidence.has(condition.evidenceType)) fail('eval.oracle-evidence-undeclared', `${rule.acceptanceId} uses undeclared evidence ${condition.evidenceType}.`);
        if (!['equals', 'gte', 'lte'].includes(condition.operator)) fail('eval.oracle-operator-invalid', `${rule.acceptanceId} has invalid operator.`);
      }
    }

    const fixtureCase = fixtureByCase.get(testCase.id);
    const observationsByType = indexUnique(fixtureCase.observations, 'type', `${testCase.id} observation type`);
    for (const rule of oracleCase.rules) {
      for (const condition of rule.conditions) {
        if (!Object.hasOwn(observationsByType.get(condition.evidenceType)?.signals ?? {}, condition.signal)) {
          fail('eval.reference-signal-missing', `${testCase.id} lacks ${condition.evidenceType}:${condition.signal}.`);
        }
      }
    }
    assertSameSet(fixtureCase.failureSeeds.map((entry) => entry.id), failureIds, `${testCase.id} fixture failure seeds`);
  }
  assertUnique(globalAcceptanceIds, 'global acceptance id');
}

function verifyReplay(testCase) {
  assertUnique(testCase.inputReplay.steps.map((entry) => entry.id), `${testCase.id} replay step id`);
  let lastTick = -1;
  for (const step of testCase.inputReplay.steps) {
    const explicit = /^tick:(\d+)$/.exec(step.at);
    if (explicit) {
      const tick = Number(explicit[1]);
      if (!Number.isSafeInteger(tick) || tick < lastTick) fail('eval.replay-tick-order-invalid', `${testCase.id} replay ticks are not monotonic.`);
      lastTick = tick;
    }
    if (step.durationTicks !== undefined && (!Number.isSafeInteger(step.durationTicks) || step.durationTicks < 0 || step.durationTicks > 100000)) {
      fail('eval.replay-duration-invalid', `${testCase.id} replay duration is invalid.`);
    }
    if (testCase.inputReplay.driver === 'fixed' && step.action.startsWith('oracle-')) fail('eval.fixed-replay-oracle-action', `${testCase.id} fixed replay contains oracle action.`);
  }
}

async function readJson(target) { return JSON.parse(await readFile(target, 'utf8')); }
function indexUnique(entries, key, label) { assertUnique(entries.map((entry) => entry[key]), label); return new Map(entries.map((entry) => [entry[key], entry])); }
function assertUnique(values, label) { if (new Set(values).size !== values.length) fail('eval.id-duplicate', `${label} must be unique.`); }
function assertSameSet(actual, expected, label) {
  const left = [...new Set(actual)].sort(); const right = [...new Set(expected)].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) fail('eval.set-mismatch', `${label} mismatch: ${left.join(',')} != ${right.join(',')}.`);
}
function fail(code, message) { throw new EvaluationSuiteError(code, message); }

export class EvaluationSuiteError extends Error {
  constructor(code, message) { super(message); this.name = 'EvaluationSuiteError'; this.code = code; }
}
