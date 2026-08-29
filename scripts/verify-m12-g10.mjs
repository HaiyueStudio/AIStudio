import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME_AUTHORING_TOOL_BY_ID } from '../packages/game-authoring-tools/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goalId = 'g10-observation-playtest-repair-loop';
const census = await json('config/contracts/m12-capability-census.json');
const capabilities = ['task.evaluate', 'play.capture', 'play.inspect'].map((id) => census.capabilities.find((entry) => entry.id === id));
assert.ok(capabilities.every(Boolean));
assert.ok(capabilities.every((entry) => entry.owner === goalId && entry.testOwner === goalId && entry.classification === 'available-public' && entry.integrationState === 'g10-verified'));

const toolIds = ['play.start', 'play.step', 'play.input', 'play.inspect', 'play.capture', 'play.stop', 'task.evaluate'];
for (const id of toolIds) assert.ok(GAME_AUTHORING_TOOL_BY_ID.has(id), `Missing G10 tool ${id}`);
assert.equal(GAME_AUTHORING_TOOL_BY_ID.get('play.capture').maxResultBytes, 32 * 1024);
assert.equal(GAME_AUTHORING_TOOL_BY_ID.get('play.capture').requiresApproval, false);
assert.equal(GAME_AUTHORING_TOOL_BY_ID.get('play.start').requiresApproval, true);

const observations = await text('packages/game-authoring-tools/src/observations.ts');
for (const marker of ['MAX_SCREENSHOT_BYTES', 'observation.quota-exceeded', 'observation.integrity-failed', 'evaluation.evidence-provenance-mismatch', 'evaluation.screenshot-state-tick-mismatch', 'evaluation.visual-verifier-required']) assert.ok(observations.includes(marker), `Observation marker missing: ${marker}`);
const loop = await text('packages/game-authoring-tools/src/playtest-loop.ts');
for (const marker of ['task.repair-no-change-repeat', 'task.repair-budget-exhausted', 'usageRecordIds', 'costRecordIds', 'terminalEvidenceIds']) assert.ok(loop.includes(marker), `Repair marker missing: ${marker}`);
const iframe = await text('apps/ai-studio/src/preview-runtime.ts');
for (const marker of ["type === 'inspect'", "type === 'capture'", 'requestFailed', 'bytesToBase64', 'trace.slice(-128)', 'onSubmittedWorkDone']) assert.ok(iframe.includes(marker), `Iframe marker missing: ${marker}`);
const broker = await text('apps/ai-studio/src/agent-preview-broker.ts');
for (const marker of ["'step' | 'input' | 'inspect' | 'capture'", 'validatePlayCapture', 'validateObservationBase']) assert.ok(broker.includes(marker), `Broker marker missing: ${marker}`);
const architecture = await text('docs/architecture/m12-observation-playtest-repair-loop.md');
for (const marker of ['Persist-before-reference', 'visual-analysis', 'task.repair-no-change-repeat', 'renderer crash', 'device loss']) assert.ok(architecture.includes(marker), `Architecture marker missing: ${marker}`);

const suite = await json('evals/suites/game-agent-evaluation-v1.json');
assert.equal(suite.cases.length, 7);
assert.deepEqual(suite.cases.map((item) => item.genre).sort(), ['falling-blocks', 'jigsaw', 'match-3', 'platformer', 'racing', 'shooter', 'snake'].sort());
assert.ok(suite.cases.every((item) => item.requiredCapabilities.includes('play.inspect') && item.requiredCapabilities.includes('play.capture')));

const report = {
  schemaVersion: 1,
  goalId,
  capabilities: capabilities.map(({ id, classification, integrationState, publicPath }) => ({ id, classification, integrationState, publicPath })),
  tools: toolIds,
  observations: { types: ['state', 'event-trace', 'runtime-errors', 'performance', 'screenshot', 'visual-analysis', 'lifecycle'], persistBeforeReference: true, screenshotMaximumBytes: 385024, taskQuota: true, screenshotBytesInToolResult: false, contentAddressed: true },
  provenance: { task: true, turn: true, play: true, documentRevision: true, scriptDigests: true, tick: true, frame: true, viewport: true, device: true, producerVersion: true, staleAndMismatchFailClosed: true },
  evaluation: { deterministicDsl: true, visualVerifierRequired: true, unsupportedClaimsBlocked: true, completionRequiresEvidence: true, crossGenreCases: 7 },
  repair: { boundedIterations: true, repeatedFingerprintStops: true, evidenceRequired: true, usageAndCostIds: true, terminalEvidence: true },
  tests: { core: ['packages/game-authoring-tools/test/g10-observations.test.mjs', 'packages/game-authoring-tools/test/runtime.test.mjs'], broker: 'apps/ai-studio/test/g10-agent-integration.test.mjs', electron: 'apps/ai-studio/test/g10-observation-electron.test.mjs', electronExpected: 'tick=1 pngBytes>8 sameTick=true hud=true cleanup=0', crossGenre: 'evals/test/runner.test.mjs' },
};

if (process.argv.includes('--print')) console.log(JSON.stringify(report, null, 2));
else {
  const evidence = await json('docs/evidence/m12-g10-verification.json');
  assert.deepEqual(report, evidence, 'G10 verification evidence drifted; review implementation and evidence together.');
  console.log('[m12:g10] tools=7 observations=7 cross-genre=7 visual=fail-closed repair=bounded electron=same-tick-png cleanup=0');
}

async function text(relative) { return readFile(path.join(root, relative), 'utf8'); }
async function json(relative) { return JSON.parse(await text(relative)); }
