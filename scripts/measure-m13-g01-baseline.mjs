import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), 'utf8'));
const byteLength = (value) => Buffer.byteLength(JSON.stringify(value));
const sourceMetric = async (relative) => {
  const text = await readFile(path.join(root, relative), 'utf8');
  return { path: relative, bytes: (await stat(path.join(root, relative))).size, lines: text.split(/\r?\n/u).length - 1 };
};

const observedRuns = {
  snake: 'evals/evidence/g12/runs/2a6b4009194a/codex/snake/g12-codex-snake-09358219-3d87-4f9d-a2b0-c7a2a80c5bcd/partial-evidence.json',
  racing: 'evals/evidence/g12/runs/2a6b4009194a/harness/racing/g12-harness-racing-b8ef8708-9b07-4423-b9c2-af88fd2d582e/partial-evidence.json'
};

function syntheticDocument(entityCount = 1000, scriptCount = 200) {
  return {
    schemaVersion: 2,
    id: 'document:m13-large-baseline',
    revision: 1,
    entities: Array.from({ length: entityCount }, (_, index) => ({
      id: `entity:${String(index).padStart(4, '0')}`,
      parentId: index === 0 ? null : `entity:${String(Math.floor((index - 1) / 4)).padStart(4, '0')}`,
      name: `Entity ${index}`,
      componentIds: [`component:transform:${String(index).padStart(4, '0')}`]
    })),
    scripts: Array.from({ length: scriptCount }, (_, index) => ({
      id: `script:${String(index).padStart(4, '0')}`,
      entityId: `entity:${String(index).padStart(4, '0')}`,
      sourcePath: `scripts/game-${String(index).padStart(4, '0')}.ts`,
      digest: `sha256:${index.toString(16).padStart(64, '0')}`
    }))
  };
}

function observedCase(genre, suiteCase, run, sourcePath) {
  const accounting = run.accounting;
  return {
    genre,
    caseId: suiteCase.id,
    measurement: 'observed-preflight-failure',
    backend: run.backend,
    terminal: run.terminal,
    errorCode: run.error?.code ?? null,
    sourcePath,
    modelTurns: accounting?.consumption?.turns ?? null,
    tokens: accounting ? {
      input: accounting.usage.inputTokens,
      cachedInput: accounting.usage.cachedInputTokens,
      cacheWrite: accounting.usage.cacheWriteTokens,
      output: accounting.usage.outputTokens,
      reasoning: accounting.usage.reasoningTokens
    } : null,
    cache: run.cache ?? null,
    cost: accounting?.cost ? {
      status: accounting.cost.status,
      currency: accounting.cost.currency,
      amountMicros: accounting.cost.amountMicros,
      final: accounting.cost.final
    } : { status: 'unknown', currency: null, amountMicros: null, final: false },
    toolCalls: accounting?.consumption?.toolCalls ?? null,
    wallTimeMs: accounting?.consumption?.wallTimeMs ?? null,
    preservedProject: run.preservedProject?.saved === true,
    screenshotCaptured: Boolean(run.preview?.screenshot),
    evaluatorStatus: run.evaluator?.status ?? 'not-run'
  };
}

export async function buildBaseline() {
  const binding = await readJson('config/contracts/m13-evidence-binding.json');
  const suite = await readJson('evals/suites/game-agent-evaluation-v1.json');
  const promptComparison = await readJson('evals/evidence/m12-g04-prompt-comparison.json');
  const large = syntheticDocument();
  const changed = structuredClone(large);
  changed.revision = 2;
  changed.entities[999].name = 'Entity 999 changed';
  const delta = { schemaVersion: 1, documentId: large.id, fromRevision: 1, toRevision: 2, changedEntities: [{ entityId: changed.entities[999].id, paths: ['name'] }] };
  const observed = new Map();
  for (const [genre, sourcePath] of Object.entries(observedRuns)) observed.set(genre, observedCase(genre, suite.cases.find((entry) => entry.genre === genre), await readJson(sourcePath), sourcePath));
  const genres = suite.cases.map((entry) => observed.get(entry.genre) ?? ({
    genre: entry.genre,
    caseId: entry.id,
    measurement: 'unavailable',
    backend: null,
    terminal: 'unknown',
    errorCode: null,
    sourcePath: null,
    modelTurns: null,
    tokens: { input: null, cachedInput: null, cacheWrite: null, output: null, reasoning: null },
    cache: null,
    cost: { status: 'unknown', currency: null, amountMicros: null, final: false },
    toolCalls: null,
    wallTimeMs: null,
    preservedProject: null,
    screenshotCaptured: null,
    evaluatorStatus: 'not-run'
  }));
  return {
    schemaVersion: 1,
    bindingId: binding.bindingId,
    baselineId: 'm13-g01-old-architecture-v1',
    source: {
      reviewedRevision: binding.reviewedRevision,
      productionModifiedByRunner: false,
      providerRequestIssued: false,
      unknownValuesRemainNull: true
    },
    architecture: {
      conversationHost: await sourceMetric('apps/ai-studio/src/conversation-host.ts'),
      promptContext: await sourceMetric('packages/agent-runtime/src/prompt-context.ts'),
      toolDefinitions: await sourceMetric('packages/game-authoring-tools/src/definitions.ts'),
      contextByteLimit: 98304,
      summaryItemLimit: 12,
      serialToolDispatch: { maxConcurrency: 1, evidence: ['apps/ai-studio/src/conversation-host.ts:385', 'apps/ai-studio/src/conversation-host.ts:413'] }
    },
    genres,
    largeProject: {
      entityCount: large.entities.length,
      scriptCount: large.scripts.length,
      fullSnapshotBytes: byteLength(large),
      oneEntityChangedSnapshotBytes: byteLength(changed),
      oneEntityDiffBytes: byteLength(delta),
      diffToSnapshotRatio: Number((byteLength(delta) / byteLength(changed)).toFixed(6))
    },
    contextGrowth: {
      coldPromptBytes: promptComparison.experiment.cold.promptBytes,
      warmPromptBytes: promptComparison.experiment.warm.promptBytes,
      deltaPromptBytes: promptComparison.experiment.delta.promptBytes,
      stablePrefixBytes: promptComparison.candidate.stablePrefixBytes,
      providerHitEvidence: 'unavailable',
      restartContextDigestEqual: promptComparison.experiment.restart.equal,
      providerSessionRestored: promptComparison.experiment.restart.providerSessionRestored
    },
    recovery: [
      { scenario: 'automatic-compaction', result: 'unsupported', evidence: 'packages/agent-runtime/src/prompt-context.ts:90' },
      { scenario: 'manual-compaction', result: 'unsupported', evidence: 'packages/agent-runtime/src/prompt-context.ts' },
      { scenario: 'parallel-tool-batch', result: 'unsupported', evidence: 'apps/ai-studio/src/conversation-host.ts:413' },
      { scenario: 'unknown-tool-outcome', result: 'partial', evidence: 'apps/ai-studio/src/conversation-host.ts' },
      { scenario: 'long-approval', result: 'partial', evidence: 'apps/ai-studio/src/conversation-host.ts' },
      { scenario: 'renderer-reload', result: 'context-only', evidence: 'evals/evidence/m12-g04-prompt-comparison.json' },
      { scenario: 'backend-reconnect', result: 'unsupported', evidence: 'evals/evidence/m12-g04-prompt-comparison.json' }
    ],
    interpretation: {
      passClaimed: false,
      oldFormalMatrixComplete: false,
      knownGenreMeasurements: genres.filter((entry) => entry.measurement !== 'unavailable').length,
      requiredGenreCount: genres.length,
      gate: 'baseline-only-not-acceptance'
    }
  };
}

async function main() {
  const baseline = await buildBaseline();
  if (process.argv.includes('--check')) {
    const checkedIn = await readJson('docs/evidence/m13-g01-baseline.json');
    assert.deepEqual(checkedIn, baseline, 'checked-in M13 G01 baseline drifted; regenerate and review the evidence');
    console.log(`[m13-g01-baseline] checked genres=${baseline.genres.length} entities=${baseline.largeProject.entityCount} scripts=${baseline.largeProject.scriptCount}`);
    return;
  }
  process.stdout.write(`${JSON.stringify(baseline, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
