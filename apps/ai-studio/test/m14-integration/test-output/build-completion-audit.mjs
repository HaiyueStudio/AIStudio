// Read-only product audit plus derived evidence output. Does not grant final
// product acceptance, run online tasks, or rewrite the G01 census/history.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { canonical, digest, collectPackages, inputBinding, localPath, fileDigest, readJson, reference, generateCensus, censusFile, reportFile, scopeFile, layers, recordValidator, validateAdmission } from '../../../../../scripts/m14-capability-census.mjs';
import { scanGeneratedEvidence } from '../secret-scan.mjs';
import { playRuntimeConfigFromScene } from '@haiyue/ai-studio-script-preview';

const base = 'apps/ai-studio/test/m14-integration/test-output';
const current = await inputBinding(await collectPackages());
const accepted = await readJson(`${base}/local-acceptance.json`);
assert.equal(accepted.inputBinding.digest, current.digest, 'Rebuild the current local evidence first.');
assert.equal(accepted.rootCheck.exitCode, 0);
for (const entry of accepted.evidence) assert.equal(await fileDigest(entry.path), `sha256:${entry.sha256}`, entry.path);
const capReport = await readJson(reportFile);
const census = await generateCensus(capReport);
assert.equal(canonical(census), canonical(await readJson(censusFile)));
const rootLog = await readFile(localPath(accepted.rootCheck.log), 'utf8');
const checked = new Map();
async function ref(file, locator = '', kind = 'local-check') {
  const result = await reference(file, kind, locator);
  checked.set(`${file}#${locator}`, result);
  return result;
}
const source = (file, locator = '') => ref(file, locator, 'source');
const rootCheck = text => {
  assert.ok(rootLog.includes(text), `Missing root-check result: ${text}`);
  return ref(accepted.rootCheck.log, text);
};

const collected = await readJson(`${base}/collected-tests.json`);
const inventory = await readJson('scripts/m14-integration-tests.json');
async function testFiles(directory) {
  const result = [];
  for (const entry of await readdir(localPath(directory), { withFileTypes: true })) {
    if (entry.name === 'test-output') continue;
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await testFiles(name));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) result.push(name);
  }
  return result;
}
const actualFiles = [...new Set([...inventory.extraFiles, ...(await Promise.all(inventory.directories.map(testFiles))).flat()])].sort();
assert.deepEqual(actualFiles, inventory.files);
assert.deepEqual(collected.results.map(r => r.file), actualFiles);
assert.equal(collected.inputDigest, current.digest);
assert.equal(collected.collectedFiles, actualFiles.length);
assert.equal(collected.executedFiles, actualFiles.length);
for (const entry of collected.results) {
  assert.equal(entry.exitCode, 0); assert.ok(entry.passed > 0);
  const log = await readFile(localPath(`${base}/${entry.log}`), 'utf8');
  for (const [label, key] of [['tests', 'tests'], ['pass', 'passed'], ['fail', 'failed'], ['skipped', 'skipped'], ['cancelled', 'cancelled']]) {
    assert.equal(Number(log.match(new RegExp(`^# ${label} (\\d+)$`, 'm'))?.[1]), entry[key], `${entry.file}: ${key}`);
  }
  for (const key of ['failed', 'skipped', 'cancelled']) assert.equal(entry[key], 0);
  await ref(`${base}/${entry.log}`, entry.file);
}
async function integration(file) {
  const entry = collected.results.find(r => r.file === file); assert.ok(entry, `Uncollected test: ${file}`);
  return [await source(file), await ref(`${base}/collected-tests.json`, file), await ref(`${base}/${entry.log}`, file)];
}
const requirements = [];
async function requirement(id, text, coverage, refs, limitations = []) {
  requirements.push({ id, requirement: text, status: 'verified', coverage, evidence: (await Promise.all(refs)).flat(), limitations });
}

const latest = await readJson(`${base}/completion-adapter-latest.json`);
assert.equal(latest.inputBinding.digest, current.digest);
for (const item of [latest.check, latest.runner]) assert.equal(await fileDigest(item.path), item.sha256);
const adapterCheck = await readJson(latest.check.path);
assert.equal(adapterCheck.inputDigest, current.digest);
assert.equal(adapterCheck.exitCode, 0); assert.equal(adapterCheck.passed, 2);
for (const item of [adapterCheck.log, ...adapterCheck.evidence]) assert.equal(await fileDigest(item.path), item.sha256);
const adapterEvidence = [];
for (const kind of ['zero-script', 'mixed']) {
  const item = adapterCheck.evidence.find(e => e.path.endsWith(`/${kind}.json`)); assert.ok(item);
  const report = await readJson(item.path);
  assert.equal(report.status, 'passed'); assert.equal(report.scriptCount, kind === 'mixed' ? 1 : 0);
  assert.equal(report.rounds.length, 2); assert.equal(report.projectUnchanged, true); assert.equal(report.historyUnchanged, true);
  assert.deepEqual(report.events.errors, []);
  for (const round of report.rounds) {
    assert.equal(round.baseline.value.tick, 0);
    assert.equal(round.stepped.value.tick, 10); assert.equal(round.afterResize.value.tick, 20);
    assert.equal(round.cleanup.disposableCount, 0);
    assert.ok(round.capture.bluePixels > 100 && round.capture.whitePixels > 30);
    const pngPath = path.posix.join(path.posix.dirname(item.path), round.capture.file);
    const png = await readFile(localPath(pngPath));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 480); assert.equal(png.readUInt32BE(20), 320);
    assert.equal(png.length, round.capture.byteLength);
    adapterEvidence.push(await ref(pngPath, `${kind}: blue model and white HUD at tick 20`, 'adapter-acceptance'));
  }
  for (const cleanup of [report.cancelled, report.cleanup, report.captureStopped.cleanup]) assert.equal(cleanup.disposableCount, 0);
  assert.match(report.captureStopped.rejected.message, /stopped or restarted/);
  adapterEvidence.push(await ref(item.path, kind, 'adapter-acceptance'));
}
await ref(latest.check.path, adapterCheck.id, 'adapter-acceptance');

await requirement('shared-entry-and-packages', 'Versioned public exports, reviewed candidates, lockfile, app mount and IPC are integrated.', 'Eight installed public package surfaces match candidate bytes, lock integrity, runtime/declaration exports and installed content; actual production window mounts the advanced panel.', [source('config/upstream/editor-candidates.json'), source('config/upstream/ui-candidate.json'), source('package-lock.json'), integration('scripts/test/editor-candidate-surface.test.mjs'), integration('apps/ai-studio/test/m14-integration/product-electron.test.mjs')]);
await requirement('formal-test-collection', 'Owned nested test directories are collected and executed with explicit counts.', `${actualFiles.length} reviewed files / ${collected.results.reduce((n, r) => n + r.passed, 0)} passing cases; every raw TAP count agrees, with no failures, skips or cancellations.`, [source('scripts/m14-integration-tests.json'), ref(`${base}/collected-tests.json`)]);
await requirement('contract-and-owner-boundaries', 'One envelope, one lifecycle root; application composition, orchestration and persistence keep their owners.', 'Current contract/schema and import-boundary checks pass; rollback, project replacement, cancellation and lifecycle teardown are exercised.', [rootCheck('[boundaries] headless orchestration, single Harness bridge'), integration('scripts/test/orchestration-boundaries.test.mjs'), integration('packages/harness-bridge/test/bridge.test.mjs'), integration('packages/agent-orchestration/test/editor-project.test.mjs'), integration('packages/operation-log/test/project-agent-history.test.mjs')]);

const replays = await readJson('apps/ai-studio/test/m14-integration/gameplay-replays.json');
assert.equal(Object.keys(replays.cases).length, 7);
const gameplayRefs = [];
for (const genre of Object.keys(replays.cases)) {
  const report = await readJson(`${base}/gameplay/${genre}.json`);
  assert.equal(report.genre, genre); assert.equal(report.documentUnchanged, true); assert.equal(report.rounds.length, 2);
  const originalProject = path.resolve(report.provenance.source);
  assert.ok(originalProject.startsWith(path.resolve(localPath('package.json'), '../..') + path.sep));
  assert.equal(path.basename(originalProject), '.haiyue-project.json');
  const originalBytes = await readFile(originalProject);
  assert.equal(digest(originalBytes), `sha256:${report.provenance.sha256}`, `${genre}: preserved project source changed`);
  const originalDocument = JSON.parse(originalBytes.toString('utf8')).document;
  const components = new Map(originalDocument.components.map(c => [c.id, c]));
  const expectedRuntime = playRuntimeConfigFromScene({ entities: originalDocument.entities.map(e => ({ components: e.componentIds.map(id => components.get(id)) })) });
  assert.deepEqual(report.replay, replays.cases[genre]);
  assert.deepEqual(report.rounds[0].replay.observations, report.rounds[1].replay.observations);
  const signals = [...(replays.namedFlows[genre] ?? []), ...(replays.stateFlows?.[genre] ?? []).map(f => f.name)];
  assert.ok(signals.length >= 2);
  for (const round of report.rounds) {
    assert.equal(round.started.started.seed, expectedRuntime.seed); assert.equal(round.started.started.tickRateHz, expectedRuntime.tickRateHz);
    assert.equal(round.cleanup.disposableCount, 0);
    for (const signal of signals) {
      const flow = round.flows.find(f => f.signal === signal); assert.ok(flow, `${genre}: ${signal}`);
      assert.equal(flow.location.target.nodeId, flow.nodeId);
      assert.deepEqual(flow.location.target.source, flow.source);
      assert.equal(flow.location.sourceBindingDigest, round.capture.sourceBindingDigest);
      assert.equal(flow.location.target.manifestDigest, round.capture.manifestDigest);
    }
  }
  gameplayRefs.push(await ref(`${base}/gameplay/${genre}.json`, signals.join(', ')));
}
await requirement('seven-games-and-three-sources', 'Seven fixed seed/replay games, two located flows each, pure script/declarative/mixed sources.', 'All seven games repeat the complete sampled state; exact source, manifest and binding references agree. Fresh zero-script and mixed device runs preserve Document/History and stop all resources.', [source('apps/ai-studio/test/m14-integration/gameplay-replays.json'), integration('apps/ai-studio/test/m14-integration/gameplay-device.test.mjs'), ...gameplayRefs, ...adapterEvidence], ['These are the frozen G09 input flows, not historical M12 whole-game acceptance. Trace truncation remains recorded.']);
await requirement('structure-digest-and-invalidation', 'Full input digest is deterministic and invalidates on structural changes; language/runtime observations do not rewrite structure.', 'Tests vary enabled/configured components, dependencies, registry, adapter version/digest and analyzer version, while keeping explanations and runtime overlays separate.', [rootCheck('canonical full input is deterministic; components, dependencies, registry, adapter and config invalidate it'), rootCheck('worker analysis, bounded queries, independent explanations and source locations use the same contracts'), source('packages/script-preview/test/behavior-analysis.test.mjs'), source('packages/script-preview/test/behavior-service.test.mjs')]);
await requirement('provenance-and-navigation', 'Static structure, explanation, trace and unknown remain distinct; source/configuration/adapter/record navigation binds exact versions.', 'Current worker, runtime, behavior-project, read-only UI and product-window checks cover forged/stale source rejection and current versus historical overlays.', [rootCheck('original script locations cannot reuse stale or forged ranges'), ref(reportFile, 'behavior-project-flow, behavior-panel-window, behavior-product-window'), source('packages/agent-orchestration/test/behavior-project.test.mjs'), source('packages/script-preview/test/behavior-runtime.test.mjs')]);

const author = await readJson(`${base}/product/author/author.json`), restart = await readJson(`${base}/product/restart/restart.json`);
assert.equal(author.productionEntry, 'apps/ai-studio/dist/main.js');
assert.equal(author.entityId, restart.entityId); assert.equal(author.assetId, restart.assetId);
assert.ok(author.approvals.length >= 3);
const productScreenshots = [];
// The test parent retains a fixed subset of images. Collect every image declared
// by this run's author report, including new captures, before its temp directory
// is removed. Bind the source to the current collected TAP and exact author bytes.
const productCase = collected.results.find(r => r.file === 'apps/ai-studio/test/m14-integration/product-electron.test.mjs');
const productLog = await readFile(localPath(`${base}/${productCase.log}`), 'utf8');
const productDirectory = path.resolve(productLog.match(/^# M14 integrated product evidence: (.+)$/m)[1].trim().replaceAll('\\\\', '\\'));
assert.equal(path.dirname(productDirectory), path.resolve(tmpdir()));
assert.match(path.basename(productDirectory), /^haiyue-m14-integrated-product-[a-zA-Z0-9]+$/);
assert.equal(digest(await readFile(path.join(productDirectory, 'author.json'))), await fileDigest(`${base}/product/author/author.json`));
for (const filename of author.screenshots) {
  assert.equal(path.posix.basename(filename), filename);
  assert.ok(filename.endsWith('.png'));
  const file = `${base}/product/author/${filename}`, png = await readFile(path.join(productDirectory, filename));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.byteLength > 1000);
  await writeFile(localPath(file), png);
  productScreenshots.push(await ref(file, 'current production window'));
}
for (const text of ['public rename exact approval and shared undo/redo', 'native pointer Gizmo commits once through transform.batch', 'real accessibility tree', 'controlled import UI retains asset identity']) assert.ok(author.checks.includes(text), text);
assert.ok(author.checks.includes('resource panel fits its container at desktop and narrow widths'));
assert.ok(author.resourceLayout.desktop.viewportWidth > 650 && author.resourceLayout.desktop.panelWidth < 650);
assert.ok(author.resourceLayout.narrow.viewportWidth < author.resourceLayout.desktop.viewportWidth);
for (const measured of Object.values(author.resourceLayout)) {
  assert.ok(measured.panelWidth > 0 && measured.scrollWidth <= measured.panelWidth + 1);
  assert.equal(measured.controlsVisible, true);
}
await requirement('resource-identities-and-workflow', 'Four resource identities expose provenance, dependencies, legal actions and unknown states without reissuing assetId or importing lights.', 'Schema and catalog tests cover all four kinds; real product creates from a template and imports through the controlled UI, then retains the same asset and entity on restart.', [rootCheck('four resource identities reject mixed references, illegal operations and inappropriate unused semantics'), integration('packages/editor-plugins/test/resources/catalog.test.mjs'), integration('packages/editor-plugins/test/resources/workflows.test.mjs'), ref(`${base}/product/author/author.json`), ref(`${base}/product/restart/restart.json`)], ['Persisted preset creation is not implemented; those entries explicitly remain unavailable, as allowed by the frozen contract.']);
await requirement('advanced-editor-and-history', 'Public advanced editing refines the same selection, document and History chain.', 'Production IPC and original tools handle rename, explicit rejection, shared Undo/Redo and one native Gizmo gesture as one transform transaction. Public adapter lifecycle checks cover project changes and read-only Play.', [integration('apps/ai-studio/test/m14-integration/product-electron.test.mjs'), integration('packages/studio-shell/test/advanced-editor/adapter.test.mjs'), integration('packages/studio-shell/test/advanced-editor/lifecycle.test.mjs'), ref(`${base}/product/author/author.json`), ...productScreenshots]);
const budget = await readJson('apps/ai-studio/test/m14-integration/performance-budget.json'), large = await readJson(`${base}/product/large/large.json`);
assert.deepEqual(large.budget, budget); assert.deepEqual(large.machine, budget.machine);
assert.equal(large.entityCount, budget.entities); assert.equal(large.scriptCount, budget.scripts);
for (const [key, limit] of [['open', budget.maxOpenMs], ['advancedMount', budget.maxInteractionMs], ['filterAndSelect', budget.maxInteractionMs], ['resourceQuery', budget.maxResourceQueryMs]]) assert.ok(Number.isFinite(large.timings[key]) && large.timings[key] < limit, key);
assert.ok(large.finalHeapBytes < budget.maxRendererHeapBytes);
assert.ok(large.finalHeapBytes - large.initialHeapBytes < budget.maxRendererHeapGrowthBytesAfterFiveMounts);
assert.ok(large.metrics.length > 0);
for (const metric of large.metrics) assert.ok(metric.type === 'Tab' && metric.sandboxed && metric.memory.workingSetSize < budget.maxRendererWorkingSetKiB);
await requirement('scale-and-accessibility', '1000 entities / 200 scripts meet frozen machine, interaction and memory budgets; keyboard/AX/layout migration remain usable.', 'Retained measurements match the frozen budget; product assertions verify bounded visible rows, projection bytes, narrow layout and AX tree. Layout migration and fallback tests passed in the root check.', [source('apps/ai-studio/test/m14-integration/performance-budget.json'), ref(`${base}/product/large/large.json`), ref(`${base}/product/author/author.json`, 'real accessibility tree'), rootCheck('workspace migration preserves classic split settings and keeps new ratios separate'), rootCheck('unknown versions, corrupt, oversized and unavailable storage retain a usable workspace')], ['The scale test covers document, queries and editor interaction, not 200 simultaneously running scripts or 1000 rendered meshes.']);
await requirement('device-recovery-and-records', 'Real Electron/WebGPU loss/recovery, restart and project record switching are verified.', 'The production smoke destroys the actual GPUDevice and waits for recovery; script runtime and reload paths complete. Dedicated persistent-journal and project-controller tests cover project history ownership.', [rootCheck('real Electron loads a sandboxed renderer through the typed preload and closes cleanly'), source('apps/ai-studio/src/renderer.ts', 'exerciseDeviceLoss: GPUDevice.destroy(), device.lost, waitForRecovery'), source('apps/ai-studio/test/electron-smoke.test.mjs'), integration('apps/ai-studio/test/project-history-electron.test.mjs'), integration('packages/agent-orchestration/test/project-conversation.test.mjs'), integration('packages/operation-log/test/project-agent-history.test.mjs')], ['Controlled GPUDevice destruction exercises real device loss; it does not claim a physical GPU unplug test. Manual product edits do not fabricate Agent records.']);
await requirement('revision-approval-history-discovery', 'Exact revision, one-shot approvals, shared History, search-to-invocation and initialization rollback remain enforced.', 'Current runtime/tool tests reject missing/stale bindings and preserve atomic History, while both production backend adapters with deterministic transports exercise discovered tools and continuation.', [rootCheck('every revision-bound tool publishes a required version and rejects omission at its input boundary'), integration('apps/ai-studio/test/tool-discovery-invocation.test.mjs'), integration('apps/ai-studio/test/tool-contract-continuation.test.mjs'), integration('apps/ai-studio/test/tool-batch-lifecycle.test.mjs'), integration('packages/harness-bridge/test/bridge.test.mjs')], ['Deterministic backend transports are local regression evidence and do not satisfy online backend acceptance.']);
const scan = await scanGeneratedEvidence(localPath(base), []);
assert.equal(scan.passed, true);
await writeFile(localPath(`${base}/completion-audit-secret-scan.json`), JSON.stringify({ ...scan, inputDigest: current.digest }, null, 2) + '\n');
await requirement('secret-scan', 'Generated projects, logs, artifacts, renderer projections and generated crash dumps are scanned.', 'The production scan and binary/UTF-16 scanner tests pass. A fresh scan includes the newly captured device evidence and diagnostics.', [ref(`${base}/product/secret-scan.json`), integration('apps/ai-studio/test/m14-integration/secret-scan.test.mjs'), ref(`${base}/completion-audit-secret-scan.json`)], ['No real credential store was read. With no supplied credential, this supplementary pass checks patterns; it does not claim checking an unknown live secret value. Zero crash dumps means none were generated.']);

let onlineExists = false;
try { await access(localPath(`${base}/live/checks.json`)); onlineExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
requirements.push({ id: 'real-dual-backend', requirement: 'Both real online backends complete the same general-tool task on this frozen input.', status: onlineExists ? 'requires-review' : 'missing', coverage: onlineExists ? 'Online output exists and requires a separate current-input, call/result/approval and journal audit.' : 'No live/checks.json exists. The prepared runner has not provided real online completion evidence.', evidence: [await source('apps/ai-studio/test/m14-integration/live-backends.mjs')], blocker: 'Explicit data-send authorization for DeepSeek API and OpenAI via Codex App Server remains required; account availability does not authorize transmission.' });

const scope = await readJson(scopeFile), validate = await recordValidator(), records = [];
for (const selected of scope.g08.selected) {
  assert.ok(adapterCheck.capabilityIds.includes(selected.capabilityId));
  const record = structuredClone(census.records.find(r => r.capabilityId === selected.capabilityId)); assert.ok(record);
  record.stage = 'adapter-ready';
  record.acceptance = { adapterCheckIds: [adapterCheck.id], productCheckIds: [] };
  const extra = {
    upstream: [await source('config/engine-candidate.json'), await ref(`${base}/collected-tests.json`, 'current locked package/device checks')],
    document: [await ref(latest.check.path, 'round-trip + Document/History unchanged', 'adapter-acceptance')],
    runtime: adapterEvidence,
    tool: [await ref(reportFile, 'observations, tools'), ...await integration('apps/ai-studio/test/tool-discovery-invocation.test.mjs')],
    ui: [await ref(reportFile, 'behavior-product-window'), await ref(`${base}/product/author/author.json`)],
    verification: [await ref(latest.check.path, adapterCheck.id, 'adapter-acceptance'), await ref(`${base}/local-acceptance.json`), await ref(`${base}/collected-tests.json`)],
  };
  for (const layer of layers) {
    record.layers[layer].references.push(...extra[layer]);
    record.layers[layer].explanation += ' G09 current evidence references are linked here; this audit grants no product acceptance while the online requirement remains unverified.';
  }
  record.limitations.push('Current G09 linkage is limited to the frozen adapter.ui.hud screenshot blocker. It does not certify all play.capture features or other capabilities. Real dual-backend acceptance and final G09 review remain pending.');
  assert.ok(validate(record), JSON.stringify(validate.errors));
  validateAdmission(record, { checks: [adapterCheck] });
  for (const layer of layers) for (const item of record.layers[layer].references) assert.equal(await fileDigest(item.path), item.sha256);
  records.push(record);
}
requirements.push({ id: 'six-layer-final-admission', requirement: 'Link G08 adapter-ready through all six current layers before final product-integrated admission.', status: 'incomplete', coverage: `${records.length} frozen G08 blocker has current six-layer associations and a re-executed adapter acceptance check; no product acceptance is granted.`, evidence: [await source(scopeFile), await ref(latest.check.path, adapterCheck.id, 'adapter-acceptance')], remaining: ['Complete real-dual-backend on the same input, review all results, then record the explicit G09 product acceptance.'] });
assert.equal((await inputBinding(await collectPackages())).digest, current.digest, 'Inputs changed during audit.');
const goalPath = path.resolve(localPath('package.json'), '../../milestones/milestones/m14-ai-native-intent-graph-editor/goals/g09-ai-native-editor-integration-acceptance.md');
// Ensure the named original goal is present; this report cannot replace its scope.
const objectiveSha256 = digest(await readFile(goalPath));
const report = { schemaVersion: 1, owner: 'g09-ai-native-editor-integration-acceptance', purpose: 'current-completion-audit-not-final-product-acceptance', auditedAt: new Date().toISOString(), inputBinding: current, objectiveSource: goalPath, objectiveSha256, status: 'incomplete', productIntegrated: false, requirements, checks: [adapterCheck], records, evidence: [...checked.values()], auditBuilder: await reference(`${base}/build-completion-audit.mjs`), preservedHistory: ['G01 census remains implementation-present and is not rewritten by this audit.', 'G08 independent acceptance remains historical; current adapter evidence is recorded separately.', 'M12 G12 and M13 G11 statuses are not changed.'] };
await writeFile(localPath(`${base}/completion-audit.json`), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, verifiedRequirements: requirements.filter(r => r.status === 'verified').length, remaining: requirements.filter(r => r.status !== 'verified').map(r => r.id), adapterReady: records.map(r => r.capabilityId), productIntegrated: false, referencedEvidence: checked.size }));
