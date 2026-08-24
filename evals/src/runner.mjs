import { contentDigest, deepClone, deepFreeze } from './canonical.mjs';
import { EvidenceCollector } from './evidence.mjs';
import { evaluateCase } from './oracle.mjs';
import { createAgentVisibleInput, assertOracleIsolation } from './prompt-isolation.mjs';
import { loadEvaluationAssets } from './suite-loader.mjs';

const MODES = new Set(['cold-create', 'warm-repair', 'seeded-defect']);

export class EvaluationRunner {
  constructor({ assets, adapterFactory, productionTexts = [] }) {
    if (!assets?.suite || !assets?.oracle) throw new EvaluationRunnerError('eval.assets-missing', 'Validated evaluation assets are required.');
    if (typeof adapterFactory !== 'function') throw new EvaluationRunnerError('eval.adapter-factory-missing', 'An adapter factory is required.');
    this.assets = assets;
    this.adapterFactory = adapterFactory;
    this.productionTexts = [...productionTexts];
    this.caseById = new Map(assets.suite.cases.map((entry) => [entry.id, entry]));
    this.oracleByCaseId = new Map(assets.oracle.cases.map((entry) => [entry.caseId, entry]));
  }

  enumerate({ modes = ['cold-create', 'warm-repair', 'seeded-defect'], includeVariants = true } = {}) {
    for (const mode of modes) assertMode(mode);
    const tasks = [];
    for (const testCase of this.assets.suite.cases) {
      const variants = includeVariants ? ['canonical', ...testCase.requestVariants.map((entry) => entry.id)] : ['canonical'];
      for (const mode of modes) {
        if (mode === 'seeded-defect') {
          for (const failureSeed of testCase.failureSeeds) {
            tasks.push(makeTask(testCase.id, 'canonical', mode, failureSeed.id));
          }
        } else {
          for (const variantId of variants) tasks.push(makeTask(testCase.id, variantId, mode));
        }
      }
    }
    return deepFreeze(tasks);
  }

  async runCase({ caseId, variantId = 'canonical', mode = 'cold-create', failureSeedId = null }) {
    assertMode(mode);
    const testCase = this.caseById.get(caseId);
    if (!testCase) throw new EvaluationRunnerError('eval.case-unknown', `Unknown evaluation case ${caseId}.`);
    validateFailureSeed(testCase, mode, failureSeedId);
    const oracleCase = this.oracleByCaseId.get(caseId);
    const runContext = makeRunContext(this.assets.suite, { caseId, variantId, mode, failureSeedId });
    const agentInput = createAgentVisibleInput(testCase, variantId);
    const isolation = assertOracleIsolation({ testCase, oracleCase, agentInput, productionTexts: this.productionTexts });
    const project = createBlankProject(runContext);
    const replay = normalizeReplay(testCase.inputReplay);
    const adapter = await this.adapterFactory({ testCase, mode, runContext });
    assertAdapter(adapter);

    try {
      const reset = await adapter.resetProject(project);
      const agent = await adapter.executeAgent({ agentInput, runContext, budgets: this.assets.suite.sharedBudgets });
      validateAgentBudget(agent, this.assets.suite.sharedBudgets);
      const replayResult = await adapter.executeReplay({ replay, failureSeedId, runContext });
      const rawObservations = await adapter.collectEvidence({ runContext });
      if (!Array.isArray(rawObservations)) throw new EvaluationRunnerError('eval.adapter-evidence-invalid', 'Adapter evidence must be an array.');

      const collector = new EvidenceCollector({
        runId: runContext.runId,
        caseId,
        projectDigest: project.documentDigest,
        seed: runContext.seed,
        viewport: this.assets.suite.sharedEnvironment.viewport,
        maxObservationBytes: this.assets.suite.sharedBudgets.maxObservationBytes,
      });
      collector.collectAll(rawObservations);
      const evidenceManifest = collector.manifest();
      const evaluation = evaluateCase({ testCase, oracleCase, evidenceManifest });
      return deepFreeze({
        schemaVersion: 1,
        runId: runContext.runId,
        caseId,
        genre: testCase.genre,
        variantId,
        mode,
        ...(failureSeedId ? { failureSeedId } : {}),
        seed: runContext.seed,
        requestDigest: contentDigest(agentInput),
        blankProjectDigest: project.documentDigest,
        status: evaluation.status,
        acceptanceResults: evaluation.acceptanceResults,
        evidenceManifestDigest: evidenceManifest.digest,
        evidenceCount: evidenceManifest.artifacts.length,
        observationBytes: evidenceManifest.totalBytes,
        execution: normalizeExecution({ reset, agent, replayResult, isolation }),
        accounting: normalizeAccounting({ runContext, agent }),
      });
    } finally {
      await adapter.dispose?.();
    }
  }

  async runSuite({ tasks = this.enumerate({ modes: ['cold-create'], includeVariants: false }) } = {}) {
    const runs = [];
    for (const task of tasks) runs.push(await this.runCase(task));
    const passed = runs.filter((entry) => entry.status === 'pass').length;
    const report = {
      schemaVersion: 1,
      suiteId: this.assets.suite.suiteId,
      suiteVersion: this.assets.suite.version,
      suiteDigest: contentDigest(this.assets.suite),
      runnerVersion: '1.0.0',
      summary: { total: runs.length, passed, failed: runs.length - passed },
      runs,
    };
    return deepFreeze(report);
  }
}

export async function createEvaluationRunner(options) {
  const assets = options?.assets ?? await loadEvaluationAssets(options?.paths);
  return new EvaluationRunner({ ...options, assets });
}

export function createBlankProject(runContext) {
  const document = {
    schemaVersion: 2,
    id: `eval.project.${runContext.runKey}`,
    revision: 0,
    savedRevision: 0,
    scenes: [{ id: `eval.scene.${runContext.runKey}`, name: 'Blank evaluation scene', rootEntityIds: [] }],
    entities: [],
    components: [],
    scripts: [],
    assets: [],
    settings: { evaluationSeed: runContext.seed, simulationHz: runContext.simulationHz },
    migration: { fromVersion: null, migratedAt: null, sourceDigest: null },
  };
  return deepFreeze({ templateId: 'blank-game-document-v2', document, documentDigest: contentDigest(document) });
}

export function normalizeReplay(inputReplay) {
  const steps = inputReplay.steps.map((step, ordinal) => {
    const explicit = /^tick:(\d+)$/.exec(step.at);
    const trigger = /^after:(.+)$/.exec(step.at);
    return deepFreeze({
      ordinal,
      id: step.id,
      schedule: explicit
        ? { kind: 'tick', tick: Number(explicit[1]) }
        : { kind: 'trigger', trigger: trigger?.[1] ?? step.at },
      action: step.action,
      ...(step.control ? { control: step.control } : {}),
      ...(step.from ? { from: [...step.from] } : {}),
      ...(step.to ? { to: [...step.to] } : {}),
      ...(step.parameters ? { parameters: deepClone(step.parameters) } : {}),
      ...(step.durationTicks !== undefined ? { durationTicks: step.durationTicks } : {}),
    });
  });
  return deepFreeze({ driver: inputReplay.driver, clock: 'fixed-tick', steps });
}

function makeRunContext(suite, task) {
  const digest = contentDigest({ suiteId: suite.suiteId, suiteVersion: suite.version, ...task });
  const runKey = digest.slice(7, 23);
  const derived = Number.parseInt(digest.slice(7, 15), 16) >>> 0;
  return deepFreeze({
    ...task,
    runId: `eval-run:${runKey}`,
    runKey,
    seed: (suite.sharedEnvironment.seed ^ derived) >>> 0,
    simulationHz: suite.sharedEnvironment.simulationHz,
  });
}

function makeTask(caseId, variantId, mode, failureSeedId) {
  return { caseId, variantId, mode, ...(failureSeedId ? { failureSeedId } : {}) };
}

function validateFailureSeed(testCase, mode, failureSeedId) {
  if (mode === 'seeded-defect') {
    if (!failureSeedId) throw new EvaluationRunnerError('eval.failure-seed-required', 'Seeded-defect mode requires a failure seed.');
    if (!testCase.failureSeeds.some((entry) => entry.id === failureSeedId)) throw new EvaluationRunnerError('eval.failure-seed-unknown', `Unknown failure seed ${failureSeedId}.`);
  } else if (failureSeedId) throw new EvaluationRunnerError('eval.failure-seed-mode-invalid', 'Failure seeds are only valid in seeded-defect mode.');
}

function validateAgentBudget(agent, budgets) {
  if (!agent || !Number.isSafeInteger(agent.turns) || !Number.isSafeInteger(agent.toolCalls) || agent.turns < 0 || agent.toolCalls < 0) {
    throw new EvaluationRunnerError('eval.adapter-agent-result-invalid', 'Adapter Agent result must expose non-negative turn and tool-call counts.');
  }
  if (agent.turns > budgets.maxAgentTurns) throw new EvaluationRunnerError('eval.agent-turn-budget-exceeded', 'Agent turn budget exceeded.');
  if (agent.toolCalls > budgets.maxToolCalls) throw new EvaluationRunnerError('eval.tool-call-budget-exceeded', 'Tool-call budget exceeded.');
}

function normalizeExecution({ reset, agent, replayResult, isolation }) {
  return {
    resetRevision: reset?.revision ?? 0,
    terminal: String(agent.terminal),
    turns: agent.turns,
    toolCalls: agent.toolCalls,
    replaySteps: replayResult?.stepsExecuted ?? 0,
    isolationChecks: isolation.checkedStrings,
  };
}

function normalizeAccounting({ runContext, agent }) {
  const supplied = agent.accounting;
  if (supplied) return supplied;
  const taskId = `eval-task:${runContext.runKey}`;
  const turns = Array.from({ length: agent.turns }, (_, index) => {
    const turnId = `eval-turn:${runContext.runKey}:${index + 1}`;
    return { turnId, usageRecordIds: [`eval-usage:${runContext.runKey}:${index + 1}`], finishReason: 'stop' };
  });
  const fallbackTurn = turns[0]?.turnId ?? `eval-turn:${runContext.runKey}:none`;
  const tools = Array.from({ length: agent.toolCalls }, (_, index) => ({ toolCallId: `eval-tool:${runContext.runKey}:${index + 1}`, turnId: turns[index % Math.max(1, turns.length)]?.turnId ?? fallbackTurn, usageRecordIds: [`eval-tool-usage:${runContext.runKey}:${index + 1}`] }));
  const usageRecordIds = [...turns.flatMap((entry) => entry.usageRecordIds), ...tools.flatMap((entry) => entry.usageRecordIds)];
  return { taskId, budgetId: `eval-budget:${runContext.runKey}`, budgetStatus: 'within', usageRecordIds, costRecordIds: usageRecordIds.map((_, index) => `eval-cost:${runContext.runKey}:${index + 1}`), turns, tools };
}

function assertMode(mode) { if (!MODES.has(mode)) throw new EvaluationRunnerError('eval.mode-invalid', `Unknown evaluation mode ${mode}.`); }
function assertAdapter(adapter) {
  for (const method of ['resetProject', 'executeAgent', 'executeReplay', 'collectEvidence']) {
    if (typeof adapter?.[method] !== 'function') throw new EvaluationRunnerError('eval.adapter-invalid', `Adapter is missing ${method}().`);
  }
}

export class EvaluationRunnerError extends Error {
  constructor(code, message) { super(message); this.name = 'EvaluationRunnerError'; this.code = code; }
}
