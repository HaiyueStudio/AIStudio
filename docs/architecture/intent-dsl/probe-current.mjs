// Read-only local probe. Uses existing dist; build provenance is reported, not assumed fresh.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ToolCatalogRuntime } from '../../../packages/game-authoring-tools/dist/catalog/runtime.js';
import { GAME_AUTHORING_TOOL_DEFINITIONS } from '../../../packages/game-authoring-tools/dist/definitions.js';
import { TaskAccountingRegistry, UsageLedgerStore, M12_DEFAULT_PRICING_CATALOG } from '@haiyue/ai-studio-agent-runtime';
import { DEFAULT_TASK_BUDGET } from '../../../packages/agent-orchestration/dist/budget-policy.js';

const catalog = new ToolCatalogRuntime(GAME_AUTHORING_TOOL_DEFINITIONS, () => []);
const selection = [
  '不要创建任何实体，只检查按钮颜色',
  '解释一下什么是相机',
  '把选中的按钮改成红色，保持其他对象不变',
].map((request) => {
  const s = catalog.selectDefinitions(request);
  return { request, toolCount: s.selectedIds.length, schemaBytes: s.selectedSchemaBytes, selectedIds: s.selectedIds };
});
function setup(limit = 10000) {
  const usage = new UsageLedgerStore();
  const account = new TaskAccountingRegistry(usage).open({
    taskId: 'task:audit', pricingCatalog: M12_DEFAULT_PRICING_CATALOG,
    budget: { ...DEFAULT_TASK_BUDGET, limits: { ...DEFAULT_TASK_BUDGET.limits, inputTokens: limit } },
  });
  return { usage, account };
}
function record(f, id, tokens, ms, final = true) {
  const ledger = f.usage.open({ taskId: 'task:audit', sessionId: `session:${id}`, turnId: `turn:${id}`, providerRequestDigest: null, startedAtMs: 0 });
  ledger.reconcile({ eventId: `event:${id}`, sequence: 1, mode: 'cumulative', inputTokens: tokens, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, observedAtMs: ms });
  if (final) ledger.markTerminal('stop', ms);
  f.account.bindTurn(`turn:${id}`, { provider: 'deepseek', model: 'deepseek-v4-flash', billingMode: 'api' });
}
const time = setup();
for (const id of ['parent', 'child-a', 'child-b']) record(time, id, 0, 100);
const budget = setup(200);
const reservationsAccepted = [budget.account.reserveWork('child:a', { inputTokens: 100 }), budget.account.reserveWork('child:b', { inputTokens: 100 })];
record(budget, 'child-a', 50, 10, false);
const files = [
  'packages/game-authoring-tools/src/catalog/runtime.ts', 'packages/game-authoring-tools/dist/catalog/runtime.js',
  'packages/game-authoring-tools/src/definitions.ts', 'packages/game-authoring-tools/dist/definitions.js',
  'packages/agent-runtime/src/accounting.ts', 'packages/agent-runtime/dist/accounting.js',
  'packages/agent-runtime/src/budget.ts', 'packages/agent-runtime/dist/budget.js',
  'packages/agent-runtime/src/usage-ledger.ts', 'packages/agent-runtime/dist/usage-ledger.js',
  'packages/agent-orchestration/src/budget-policy.ts', 'packages/agent-orchestration/dist/budget-policy.js',
];
const sha256 = (file) => createHash('sha256').update(readFileSync(new URL(`../../../${file}`, import.meta.url))).digest('hex');
console.log(JSON.stringify({
  limitations: 'Existing dist, local tools-only catalog (no components); bytes are serialized tool schemas, not provider tokens or full HTTP bytes. No model/network calls. Hashes identify inputs, not a proof that source and dist correspond.',
  provenance: Object.fromEntries(files.map((file) => [file, sha256(file)])),
  selection,
  overlappingIntervals: { intervalsMs: [[0, 100], [0, 100], [0, 100]], unionMs: 100, reportedWallTimeMs: time.account.snapshot().consumption.wallTimeMs },
  reservation: { limit: 200, reservationsAccepted, reportedUsage: 50, remainingCommitmentExpected: 150, reservedWork: budget.account.reservedWork(), nextTurnDecision: budget.account.beginTurn() },
}, null, 2));
