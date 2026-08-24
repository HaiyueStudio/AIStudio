import { deepFreeze } from './canonical.mjs';

export function evaluateCase({ testCase, oracleCase, evidenceManifest }) {
  const acceptanceById = new Map(flattenAcceptance(testCase).map((acceptance) => [acceptance.id, acceptance]));
  const artifactsByType = groupByType(evidenceManifest.artifacts);
  const acceptanceResults = oracleCase.rules.map((rule) => evaluateRule(rule, acceptanceById.get(rule.acceptanceId), artifactsByType));
  const status = acceptanceResults.every((result) => result.status === 'pass') ? 'pass' : 'fail';
  return deepFreeze({
    schemaVersion: 1,
    caseId: testCase.id,
    status,
    acceptanceResults,
    passed: acceptanceResults.filter((result) => result.status === 'pass').length,
    failed: acceptanceResults.filter((result) => result.status === 'fail').length,
  });
}

export function flattenAcceptance(testCase) {
  return [...testCase.acceptance.functional, ...testCase.acceptance.visual, ...testCase.acceptance.robustness];
}

function evaluateRule(rule, acceptance, artifactsByType) {
  if (!acceptance) throw new Error(`Oracle references unknown acceptance ${rule.acceptanceId}.`);
  const evidenceIds = new Set();
  const diagnostics = [];
  for (const evidenceType of acceptance.evidence) {
    if (!(artifactsByType.get(evidenceType)?.length > 0)) diagnostics.push(`oracle.evidence-missing:${evidenceType}`);
  }
  for (const condition of rule.conditions) {
    const candidates = artifactsByType.get(condition.evidenceType) ?? [];
    const artifact = [...candidates].reverse().find((entry) => Object.hasOwn(entry.signals, condition.signal));
    if (!artifact) {
      diagnostics.push(`oracle.signal-missing:${condition.evidenceType}:${condition.signal}`);
      continue;
    }
    evidenceIds.add(artifact.id);
    const actual = artifact.signals[condition.signal];
    if (!compare(actual, condition.operator, condition.expected)) {
      diagnostics.push(`oracle.condition-failed:${condition.evidenceType}:${condition.signal}:${condition.operator}`);
    }
  }
  return deepFreeze({
    acceptanceId: rule.acceptanceId,
    status: diagnostics.length === 0 ? 'pass' : 'fail',
    evidenceIds: [...evidenceIds].sort(),
    diagnosticCodes: diagnostics,
  });
}

function compare(actual, operator, expected) {
  if (operator === 'equals') return Object.is(actual, expected);
  if (operator === 'gte') return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
  if (operator === 'lte') return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
  throw new Error(`Unknown oracle operator ${operator}.`);
}

function groupByType(artifacts) {
  const result = new Map();
  for (const artifact of [...artifacts].sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id))) {
    const bucket = result.get(artifact.type) ?? [];
    bucket.push(artifact);
    result.set(artifact.type, bucket);
  }
  return result;
}
