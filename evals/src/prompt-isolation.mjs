import { canonicalStringify, deepFreeze } from './canonical.mjs';

export function createAgentVisibleInput(testCase, variantId = 'canonical') {
  const request = variantId === 'canonical'
    ? testCase.request
    : testCase.requestVariants.find((variant) => variant.id === variantId)?.request;
  if (!request) throw new EvaluationIsolationError('eval.variant-unknown', `Unknown request variant ${variantId}.`);
  return deepFreeze({ schemaVersion: 1, request, constraints: [...testCase.agentVisibleConstraints] });
}

export function assertOracleIsolation({ testCase, oracleCase, agentInput, productionTexts = [] }) {
  const visible = canonicalStringify(agentInput);
  const forbidden = hiddenOracleStrings(testCase, oracleCase);
  for (const secret of forbidden) {
    if (visible.includes(secret)) throw new EvaluationIsolationError('eval.oracle-visible', `Agent-visible input contains hidden oracle string ${secret}.`);
    for (const productionText of productionTexts) {
      if (String(productionText).includes(secret)) throw new EvaluationIsolationError('eval.oracle-production-leak', `Production model text contains hidden oracle string ${secret}.`);
    }
  }
  assertExactAgentKeys(agentInput);
  return Object.freeze({ checkedStrings: forbidden.length, productionTextCount: productionTexts.length });
}

export function hiddenOracleStrings(testCase, oracleCase) {
  const values = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.length >= 12) values.add(value);
    else if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === 'object') Object.values(value).forEach(add);
  };
  add(testCase.inputReplay);
  add(testCase.acceptance);
  add(testCase.failureSeeds);
  add(oracleCase);
  return Object.freeze([...values].sort());
}

function assertExactAgentKeys(input) {
  const keys = Object.keys(input).sort();
  const expected = ['constraints', 'request', 'schemaVersion'];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new EvaluationIsolationError('eval.agent-projection-invalid', `Agent input keys must be ${expected.join(', ')}.`);
  }
}

export class EvaluationIsolationError extends Error {
  constructor(code, message) { super(message); this.name = 'EvaluationIsolationError'; this.code = code; }
}
