import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { asStableId } from '@haiyue/ai-studio-contracts';
import {
  PricingEngine,
  M12_DEFAULT_PRICING_CATALOG,
  TaskAccountingRegistry,
  TaskBudgetController,
  UsageLedger,
  UsageLedgerStore,
  negotiateAgentTurnConfig,
  validatePricingCatalog,
} from '../dist/index.js';

const digest = `sha256:${'a'.repeat(64)}`;
const baseConfig = Object.freeze({
  schemaVersion: 2,
  backendId: asStableId('backend:fixture'),
  model: 'fixture-large',
  reasoningEffort: 'medium',
  outputTokenLimit: 8_000,
  taskBudgetId: asStableId('budget:fixture'),
  promptProfile: Object.freeze({ id: asStableId('prompt:fixture'), version: '2.0.0', digest }),
  requestedCapabilities: Object.freeze(['agent.model-config', 'agent.usage']),
});

test('model negotiation accepts exact values, reports explicit degradation, and rejects unsupported values', () => {
  const policy = {
    backendId: asStableId('backend:fixture'), protocolVersion: 'fixture-v1', supportedCapabilities: ['agent.model-config', 'agent.usage'],
    catalog: Object.freeze({ schemaVersion: 1, backendId: asStableId('backend:fixture'), protocolVersion: 'fixture-v1', source: 'provider', models: Object.freeze([
      Object.freeze({ id: 'fixture-large', label: 'Fixture Large', description: 'fixture', reasoningEfforts: Object.freeze(['off', 'low', 'high']), defaultReasoningEffort: 'high', maxOutputTokens: 4_000, isDefault: true }),
    ]) }),
    effortFallbacks: { medium: 'high' },
  };
  const degraded = negotiateAgentTurnConfig(baseConfig, policy);
  assert.equal(degraded.status, 'degraded');
  assert.deepEqual(degraded.effective, { model: 'fixture-large', reasoningEffort: 'high', outputTokenLimit: 4_000, capabilities: ['agent.model-config', 'agent.usage'] });
  assert.deepEqual(degraded.diagnostics.map((entry) => entry.code), ['backend.reasoning-degraded', 'backend.output-limit-capped']);
  assert.equal(negotiateAgentTurnConfig({ ...baseConfig, reasoningEffort: 'xhigh' }, policy).status, 'rejected');
  assert.equal(negotiateAgentTurnConfig({ ...baseConfig, model: 'missing' }, policy).diagnostics[0].code, 'backend.model-unsupported');
  assert.equal(negotiateAgentTurnConfig({ ...baseConfig, requestedCapabilities: ['shell.arbitrary'] }, policy).status, 'rejected');
});

test('usage ledger deduplicates and reorders deltas, then accepts late reconciliation without reviving execution', () => {
  const ledger = new UsageLedger({ taskId: asStableId('task:fixture'), sessionId: asStableId('session:fixture'), turnId: asStableId('turn:fixture'), providerRequestDigest: digest, startedAtMs: 1_000 });
  ledger.reconcile({ eventId: 'usage:2', sequence: 2, mode: 'delta', inputTokens: 20, cachedInputTokens: 5, outputTokens: 2, observedAtMs: 1_020 });
  ledger.reconcile({ eventId: 'usage:1', sequence: 1, mode: 'delta', inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, observedAtMs: 1_010 });
  ledger.reconcile({ eventId: 'usage:1', sequence: 1, mode: 'delta', inputTokens: 999, observedAtMs: 1_030 });
  const terminal = ledger.markTerminal('stop', 1_040);
  assert.equal(terminal.record.inputTokens, 30);
  assert.equal(terminal.record.cachedInputTokens, 5);
  assert.equal(terminal.outOfOrderEvents, 1);
  assert.equal(terminal.duplicateEvents, 1);
  const late = ledger.reconcile({ eventId: 'usage:3-late', sequence: 3, mode: 'delta', outputTokens: 4, observedAtMs: 1_050, final: true });
  assert.equal(late.record.outputTokens, 7);
  assert.equal(late.executionState, 'terminal');
  assert.equal(late.record.final, true);
  assert.equal(late.lateReconciliations, 1);
  assert.equal(ledger.records().length, 4);
});

test('tool payload records retain tool-call provenance in the auditable ledger', () => {
  const ledger = new UsageLedger({ taskId: asStableId('task:tool'), sessionId: asStableId('session:tool'), turnId: asStableId('turn:tool'), providerRequestDigest: null, startedAtMs: 0 });
  ledger.reconcile({ eventId: 'tool:input', sequence: 1, mode: 'delta', toolCallId: asStableId('tool-call:one'), toolInputBytes: 12, observedAtMs: 1 });
  ledger.reconcile({ eventId: 'tool:output', sequence: 2, mode: 'delta', toolCallId: asStableId('tool-call:one'), toolOutputBytes: 20, observedAtMs: 2 });
  assert.deepEqual(ledger.records().map((record) => record.toolCallId), ['tool-call:one', 'tool-call:one']);
  assert.equal(ledger.snapshot().record.toolOutputBytes, 20);
});

test('final cumulative reconciliation replaces provisional totals deterministically', () => {
  const ledger = new UsageLedger({ taskId: asStableId('task:cumulative'), sessionId: asStableId('session:cumulative'), turnId: asStableId('turn:cumulative'), providerRequestDigest: null, startedAtMs: 0 });
  ledger.reconcile({ eventId: 'snapshot:1', sequence: 1, mode: 'cumulative', inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, reasoningTokens: 4, observedAtMs: 10 });
  const final = ledger.reconcile({ eventId: 'snapshot:2', sequence: 2, mode: 'cumulative', inputTokens: 95, cachedInputTokens: 25, outputTokens: 12, reasoningTokens: 5, observedAtMs: 20, final: true });
  assert.deepEqual([final.record.inputTokens, final.record.cachedInputTokens, final.record.outputTokens, final.record.reasoningTokens], [95, 25, 12, 5]);
});

test('pricing handles cache discounts, rounding, subscription separation and unknown models', async () => {
  const raw = JSON.parse(await readFile(new URL('../../../config/pricing/m12-pricing-catalog-v1.json', import.meta.url), 'utf8'));
  const engine = new PricingEngine(validatePricingCatalog(raw));
  const usage = Object.freeze({ schemaVersion: 2, id: asStableId('usage:pricing'), taskId: asStableId('task:pricing'), sessionId: asStableId('session:pricing'), turnId: asStableId('turn:pricing'), inputTokens: 1_000_000, cachedInputTokens: 400_000, cacheWriteTokens: 0, outputTokens: 100_000, reasoningTokens: 50_000, toolInputBytes: 0, toolOutputBytes: 0, wallTimeMs: 1_000, providerRequestDigest: null, final: true });
  const estimated = engine.estimate({ provider: 'deepseek', model: 'deepseek-v4-flash', usage, billingMode: 'api' });
  assert.equal(estimated.record.status, 'estimated');
  assert.equal(estimated.record.amountMicros, 113_120);
  assert.equal(estimated.cacheSavingMicros, 54_880);
  assert.equal(engine.estimate({ provider: 'deepseek', model: 'missing', usage, billingMode: 'api' }).record.status, 'unknown');
  const subscription = engine.estimate({ provider: 'openai', model: 'gpt-5.6-sol', usage, billingMode: 'subscription' });
  assert.equal(subscription.record.amountMicros, null);
  assert.match(subscription.explanation, /Subscription limits/);
  assert.equal(engine.estimate({ provider: 'openai', model: 'gpt-5.6-sol', usage, billingMode: 'api', actualAmountMicros: 42 }).record.status, 'actual');
});

test('packaged pricing catalog cannot drift from the reviewed JSON source', async () => {
  const raw = JSON.parse(await readFile(new URL('../../../config/pricing/m12-pricing-catalog-v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(M12_DEFAULT_PRICING_CATALOG, raw);
});

test('task accounting aggregates turns, cache savings and a final cost without confusing subscription limits', () => {
  const store = new UsageLedgerStore(); const registry = new TaskAccountingRegistry(store);
  const account = registry.open({ taskId: asStableId('task:account'), budget: { ...budget('hard'), id: asStableId('budget:account'), limits: { ...budget('hard').limits, turns: 3, toolCalls: 3, inputTokens: 1_000_000, outputTokens: 1_000_000, estimatedCostMicros: 1_000_000 } }, pricingCatalog: M12_DEFAULT_PRICING_CATALOG });
  assert.equal(account.beginTurn().allowed, true);
  const ledger = store.open({ taskId: asStableId('task:account'), sessionId: asStableId('session:account'), turnId: asStableId('turn:account'), providerRequestDigest: null, startedAtMs: 0 });
  account.bindTurn(asStableId('turn:account'), { provider: 'deepseek', model: 'deepseek-v4-flash', billingMode: 'api' });
  ledger.reconcile({ eventId: 'usage:account', sequence: 1, mode: 'cumulative', inputTokens: 1_000, cachedInputTokens: 400, cacheWriteTokens: 100, outputTokens: 200, reasoningTokens: 10, observedAtMs: 20, final: true });
  ledger.markTerminal('stop', 20);
  const snapshot = account.reconcile();
  assert.equal(snapshot.usage.inputTokens, 1_000);
  assert.equal(snapshot.cost.status, 'estimated');
  assert.equal(snapshot.cost.final, true);
  assert.equal(snapshot.cost.recordIds.length, 1);
  assert.equal(account.costRecords().length, 2);
  assert.deepEqual(new Set(account.costRecords().map((record) => record.status)), new Set(['unknown', 'estimated']));
  assert.ok(snapshot.cost.cacheSavingMicros >= 0);
  const subscription = registry.open({ taskId: asStableId('task:subscription'), budget: { ...budget('observe'), id: asStableId('budget:subscription') }, pricingCatalog: M12_DEFAULT_PRICING_CATALOG });
  const other = store.open({ taskId: asStableId('task:subscription'), sessionId: asStableId('session:subscription'), turnId: asStableId('turn:subscription'), providerRequestDigest: null, startedAtMs: 0 });
  subscription.bindTurn(asStableId('turn:subscription'), { provider: 'openai', model: 'gpt-5.6-sol', billingMode: 'subscription' });
  other.reconcile({ eventId: 'usage:subscription', sequence: 1, mode: 'cumulative', inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 0, observedAtMs: 1, final: true });
  assert.equal(subscription.reconcile().cost.amountMicros, null);
  assert.match(subscription.snapshot().cost.explanation, /Subscription limits/);
});

test('hard budget blocks before the next effect and late reconciliation cannot unlatch it', () => {
  const hard = new TaskBudgetController(budget('hard'));
  assert.equal(hard.commit({ turns: 1, toolCalls: 1 }).allowed, true);
  const denied = hard.preflight({ toolCalls: 1 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.status, 'hard-exceeded');
  hard.reconcileUsage(usageRecord({ inputTokens: 1, outputTokens: 1 }), 1);
  assert.equal(hard.state().allowed, false);
  assert.equal(hard.state().hardStopLatched, true);

  const soft = new TaskBudgetController(budget('soft'));
  soft.commit({ toolCalls: 1 });
  const warning = soft.preflight({ toolCalls: 1 });
  assert.equal(warning.allowed, true);
  assert.equal(warning.status, 'soft-exceeded');
  assert.ok(warning.warning);
});

test('hard wall-time expiry latches the task before later effects', () => {
  const registry = new TaskAccountingRegistry(new UsageLedgerStore());
  const account = registry.open({ taskId: asStableId('task:wall-expiry'), budget: { ...budget('hard'), id: asStableId('budget:wall-expiry'), limits: { ...budget('hard').limits, wallTimeMs: 1, turns: 2, toolCalls: 2 } }, pricingCatalog: M12_DEFAULT_PRICING_CATALOG });
  account.beginTurn(); const expired = account.expireWallTime(); assert.equal(expired.allowed, false); assert.equal(expired.status, 'hard-exceeded'); assert.equal(account.preflightTool(asStableId('tool-call:after-expiry')).allowed, false);
});

function budget(enforcement) {
  return Object.freeze({ schemaVersion: 2, id: asStableId(`budget:${enforcement}`), limits: Object.freeze({ inputTokens: 100, outputTokens: 100, estimatedCostMicros: 100, wallTimeMs: 10_000, turns: 1, toolCalls: 1, repairIterations: 1, observationBytes: 1_024 }), enforcement });
}
function usageRecord(overrides) {
  return Object.freeze({ schemaVersion: 2, id: asStableId('usage:budget'), taskId: asStableId('task:budget'), sessionId: asStableId('session:budget'), turnId: asStableId('turn:budget'), inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, toolInputBytes: 0, toolOutputBytes: 0, wallTimeMs: 1, providerRequestDigest: null, final: true, ...overrides });
}
