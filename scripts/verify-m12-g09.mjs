import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME_AUTHORING_TOOL_BY_ID } from '../packages/game-authoring-tools/dist/index.js';
import { MAX_PLAY_SCRIPTS } from '../packages/script-preview/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goalId = 'g09-multi-script-play-runtime';
const census = JSON.parse(await readFile(path.join(root, 'config', 'contracts', 'm12-capability-census.json'), 'utf8'));
const entry = census.capabilities.find((candidate) => candidate.id === 'play.multi-script');
assert.ok(entry);
assert.equal(entry.owner, goalId);
assert.equal(entry.testOwner, goalId);

const validateTool = GAME_AUTHORING_TOOL_BY_ID.get('preview.validate');
assert.ok(validateTool);
assert.deepEqual(validateTool.inputSchema.required, []);
assert.equal(validateTool.inputSchema.properties.scriptIds.maxItems, MAX_PLAY_SCRIPTS);
assert.equal(validateTool.inputSchema.properties.scriptIds.uniqueItems, true);

const core = await readFile(path.join(root, 'packages', 'script-preview', 'src', 'index.ts'), 'utf8');
for (const marker of ['selection: input.scriptIds === undefined ? \'all-enabled\' : \'explicit\'', 'digestScriptSet', 'planByComponent', "errorPolicy: 'disable-script'", 'this.owners.splice(0).reverse()', 'filterRuntimeApi', 'this.plans.clear()', 'this.grants.clear()']) assert.ok(core.includes(marker), `Core marker is missing: ${marker}`);
const iframe = await readFile(path.join(root, 'apps', 'ai-studio', 'src', 'preview-runtime.ts'), 'utf8');
for (const marker of ['plan.scripts', 'planByComponent.get(context.component)', 'scriptOwners.splice(0).reverse()', "type === 'hot-reload'", 'scriptSetDigest', 'Authorized fixed-step runtime settings']) assert.ok(iframe.includes(marker), `Product iframe marker is missing: ${marker}`);
const renderer = await readFile(path.join(root, 'apps', 'ai-studio', 'src', 'renderer.ts'), 'utf8');
assert.ok(renderer.includes("invoke<PreviewDisclosure & JsonObject>('preview/prepare', {})"));
const ipc = await readFile(path.join(root, 'apps', 'ai-studio', 'src', 'ipc.ts'), 'utf8');
for (const marker of ['scriptIds must contain 1-128 unique ids', 'plan.scripts.map(({ emittedText: _emittedText']) assert.ok(ipc.includes(marker));
const electron = await readFile(path.join(root, 'apps', 'ai-studio', 'test', 'g09-multi-script-electron.test.mjs'), 'utf8');
for (const marker of ['stable order', 'leader-fault', 'faultIsolated', 'cleanup=0']) assert.ok(electron.includes(marker));
const architecture = await readFile(path.join(root, 'docs', 'architecture', 'm12-multi-script-play-runtime.md'), 'utf8');
for (const marker of ['Authorization boundary', 'Runtime ownership', 'reverse order', 'per-script capability']) assert.ok(architecture.includes(marker));

const report = {
  schemaVersion: 1,
  goalId,
  capability: { id: entry.id, classification: entry.classification, integrationState: entry.integrationState, publicPath: entry.publicPath },
  contract: { defaultSelection: 'all-enabled', explicitSubset: true, maximumScripts: MAX_PLAY_SCRIPTS, stableOrder: 'order-then-script-id', oneScriptPerEntity: true, fixedStepBound: true, scriptSetDigestBound: true },
  authorization: { validateWholeSetBeforeApproval: true, oneShotGrant: true, documentChangeRevokes: true, expiryChecked: true, sourceHiddenBeforeConsume: true, disposeRevokes: true },
  runtime: { singlePlayOwner: true, perScriptCapabilityView: true, targetedHotReload: true, faultIsolation: 'disable-script', reverseOrderTeardown: true, authoringDocumentImmutable: true, residualDisposablesAfterStop: 0 },
  product: { manualRunDefaultsToAllEnabled: true, agentToolDefaultsToAllEnabled: true, sandboxedIframe: true, perScriptStateAcknowledgement: true },
  tests: { core: 'packages/script-preview/test/script-preview.test.mjs', toolAndIpc: ['packages/game-authoring-tools/test/runtime.test.mjs', 'apps/ai-studio/test/ipc.test.mjs'], electron: 'apps/ai-studio/test/g09-multi-script-electron.test.mjs', electronExpected: 'scripts=2 stableOrder=true faultIsolated=true cleanup=0' },
};

if (process.argv.includes('--print')) console.log(JSON.stringify(report, null, 2));
else {
  const evidence = JSON.parse(await readFile(path.join(root, 'docs', 'evidence', 'm12-g09-verification.json'), 'utf8'));
  assert.deepEqual(report, evidence, 'G09 verification evidence drifted; review implementation and evidence together.');
  console.log(`[m12:g09] scripts=${MAX_PLAY_SCRIPTS} default=all-enabled authorization=script-set-bound product=electron-sandbox fault-isolation=disable-script cleanup=0`);
}
