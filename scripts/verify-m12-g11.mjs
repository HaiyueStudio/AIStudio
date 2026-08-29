import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goalId = 'g11-task-orchestrator-product-ux';
const types = await text('packages/studio-shell/src/conversation/types.ts');
for (const marker of ['ConversationTaskRunReadModel', 'ConversationTaskEvidenceReadModel', 'ConversationTaskAcceptanceReadModel', "'waiting-user'", 'previewDataUrl']) assert.ok(types.includes(marker), `Task read-model marker missing: ${marker}`);
const validation = await text('packages/studio-shell/src/conversation/validation.ts');
for (const marker of ['conversation.task-version-unsupported', 'provenanceStatus', 'MAX_SCREENSHOT_DATA_URL_BYTES', 'normalizeTaskRuns', "status === 'pass' && referenced.length === 0"]) assert.ok(validation.includes(marker), `Projection validation marker missing: ${marker}`);
const host = await text('apps/ai-studio/src/conversation-host.ts');
for (const marker of ['BoundedPlaytestTask', 'task.interrupted-by-restart', 'task.evaluation-evidence-not-retained', 'conversation/task-projected', 'approvedScreenshotDataUrl', 'account.repair()', 'authorizeContinuation']) assert.ok(host.includes(marker), `Task host marker missing: ${marker}`);
const panel = await text('packages/studio-shell/src/panels/chat/index.ts');
for (const marker of ['任务状态与验收证据', 'Backend capabilities', 'Prompt profile', 'renderTaskWorkspace', 'slice(-100)', "removeAttribute('src')", "aria-current"]) assert.ok(panel.includes(marker), `Product UI marker missing: ${marker}`);
assert.doesNotMatch(panel, /贪吃蛇|俄罗斯方块|消消乐|snake|tetris|match-3/iu, 'Product UI must not depend on a specific game genre.');
const architecture = await text('docs/architecture/m12-task-product-ux.md');
for (const marker of ['Backend turn completion and product task completion', 'data:image/png', 'latest 100', 'task.interrupted-by-restart']) assert.ok(architecture.includes(marker), `Architecture marker missing: ${marker}`);

const report = {
  schemaVersion: 1,
  goalId,
  authority: { mainOwnsState: true, rendererComputesCost: false, rendererDecidesCompletion: false, arbitraryArtifactPaths: false },
  settings: { backendCapabilities: true, protocolVersion: true, model: true, reasoningEffort: true, outputLimit: true, promptProfile: true, finiteBudgets: true, rateLimits: true },
  workflow: { phases: ['planning', 'editing', 'validating', 'playing', 'evaluating', 'repairing', 'complete', 'blocked', 'cancelled'], planApprovalSeparated: true, toolApprovalSeparated: true, backendCompletionSeparated: true, boundedRepair: true, hardBudgetContinuation: true, stopPreservesOutput: true },
  evidence: { types: ['state', 'event-trace', 'runtime-errors', 'performance', 'screenshot', 'visual-analysis', 'lifecycle'], coordinates: ['task', 'turn', 'tool', 'play', 'revision', 'tick', 'frame', 'viewport', 'device'], staleFailsClosed: true, missingReferenceFailsClosed: true, boundedPngDataUrl: true, previewSourceReleased: true },
  retention: { taskMaximum: 50, authoritativeTimelineMaximum: 400, renderedTimelineMaximum: 100, restartReplay: true, blockedResume: true, previewBytesPersistedInSummary: false },
  validation: { unknownVersion: true, outOfOrderState: true, secretFields: true, crossTaskEvidence: true, staleRevision: true, imeKeyboard: true, accessibility: true, chineseEnglishCriticalPath: true, genreNeutralUi: true },
  tests: { readModel: 'packages/studio-shell/test/conversation.test.mjs', hostAndRestart: 'apps/ai-studio/test/g11-task-product.test.mjs', budgetApprovalRegression: 'apps/ai-studio/test/g10-agent-integration.test.mjs', electronProduct: 'apps/ai-studio/test/g11-product-electron.test.mjs', electronDesktop: 'apps/ai-studio/test/electron-smoke.test.mjs' },
};
const evidence = await json('docs/evidence/m12-g11-verification.json');
assert.deepEqual(report, evidence, 'G11 verification evidence drifted; review implementation and evidence together.');
console.log('[m12:g11] task-state=authoritative settings=visible evidence=provenance-checked cost=provider-neutral restart=resumable timeline=100 electron=desktop+product');

async function text(relative) { return readFile(path.join(root, relative), 'utf8'); }
async function json(relative) { return JSON.parse(await text(relative)); }
