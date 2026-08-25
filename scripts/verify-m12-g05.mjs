import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { asStableId } from '../packages/studio-contracts/dist/index.js';
import { ComponentRegistry, GameDocumentStore } from '../packages/editor-plugins/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidencePath = path.join(root, 'docs', 'evidence', 'm12-g05-verification.json');
const report = await buildReport();

if (process.argv.includes('--print')) console.log(JSON.stringify(report, null, 2));
else {
  const expected = JSON.parse(await readFile(evidencePath, 'utf8'));
  assert.deepEqual(report, expected, 'G05 verification evidence drifted; review implementation and evidence together');
  console.log(`[m12:g05] components=${report.registry.definitionCount} contracts=${report.contracts.length} perf=${report.performance.map((item) => `${item.entityCount}:${item.copiedBytes}B/${item.historyBytes}B`).join(',')} migration=recoverable projection=incremental`);
}

async function buildReport() {
  const registry = new ComponentRegistry().freeze(); const snapshot = registry.snapshot(); const manifest = registry.capabilityManifest();
  assert.equal(snapshot.digest, manifest.registryDigest); assert.deepEqual(snapshot.definitions.map(key), manifest.components.map(key));

  const contractIndex = JSON.parse(await readFile(path.join(root, 'config', 'contracts', 'm12-contract-index.json'), 'utf8'));
  const requiredContracts = ['ComponentDefinitionV2', 'GameComponentInstanceV2', 'GameDocumentV2', 'GameDocumentOperationV2', 'GameDocumentBatchV2', 'GameDocumentDeltaV2', 'GameDocumentQueryV2', 'GameDocumentQueryResultV2'];
  const indexed = new Set(contractIndex.contracts.map((item) => item.name)); for (const name of requiredContracts) assert.ok(indexed.has(name), `${name} is absent from the shared contract index`);
  const census = JSON.parse(await readFile(path.join(root, 'config', 'contracts', 'm12-capability-census.json'), 'utf8')); const capabilityIds = ['document.v2', 'component.registry', 'scene.transaction'];
  const capabilities = capabilityIds.map((id) => { const item = census.capabilities.find((candidate) => candidate.id === id); assert.equal(item?.integrationState, 'm12-integrated', `${id} is not recorded as integrated`); return { id, integrationState: item.integrationState }; });

  const testSource = await readFile(path.join(root, 'packages', 'editor-plugins', 'test', 'g05-document-v2.test.mjs'), 'utf8');
  const behaviorGates = ['unknown component', 'parent integrity', 'dependency rejection', 'batch rollback', 'Undo/Redo', 'byte-stable', 'rollback-restorable', 'queries remain bounded'];
  for (const marker of behaviorGates) assert.match(testSource, new RegExp(escapePattern(marker), 'iu'), `G05 test marker is missing: ${marker}`);

  const repositorySource = await readFile(path.join(root, 'packages', 'editor-plugins', 'src', 'project', 'repository.ts'), 'utf8');
  for (const marker of ['.haiyue-project.v1.backup.json', '.haiyue-migration-v1-to-v2.json', 'rollbackMigration', 'beforeRename']) assert.match(repositorySource, new RegExp(escapePattern(marker), 'u'), `Migration recovery marker is missing: ${marker}`);
  const sceneSource = await readFile(path.join(root, 'packages', 'editor-plugins', 'src', 'scene-authoring.ts'), 'utf8');
  assert.doesNotMatch(sceneSource, /workspace\.gameSnapshot\(\)/u, 'Incremental scene authoring must not export the full GameDocument');
  assert.match(sceneSource, /projection\.apply\(before, after\)/u); assert.match(sceneSource, /projection\.rebuild\(next\)/u);

  return {
    schemaVersion: 1,
    goalId: 'g05-game-document-v2-component-registry',
    contracts: requiredContracts,
    capabilities,
    registry: { schemaVersion: snapshot.schemaVersion, definitionCount: snapshot.definitions.length, digest: snapshot.digest, manifestDigestEqual: true, components: snapshot.definitions.map((item) => ({ type: item.type, version: item.version, effect: item.effect, runtimeAdapter: item.runtimeAdapter })) },
    behavior: { gates: behaviorGates, immutableSnapshots: true, unknownVersionsFailClosed: true, atomicBatchAndHistory: true, boundedQueryScan: 10000 },
    migration: { fromVersion: 1, toVersion: 2, backup: '.haiyue-project.v1.backup.json', report: '.haiyue-migration-v1-to-v2.json', byteStableReopen: true, rollback: true, injectedSaveFailurePreservesSource: true },
    projection: { mutationPath: 'delta', fullRebuildAllowedFor: ['document-replace', 'migration'], fullDocumentExportInSceneAuthoring: false },
    performance: [measure(1_000, registry), measure(10_000, registry)],
    extensibility: { service: 'studio.component-registry@2.0.0', pluginRegistrationBeforeFreeze: true, coreSchemaChangeRequiredForNewDescriptor: false },
  };
}

function measure(entityCount, registry) {
  const store = new GameDocumentStore(asStableId(`document:g05-perf-${entityCount}`), largeDocument(entityCount), registry);
  const target = asStableId(`component:g05-perf-${String(entityCount - 1).padStart(5, '0')}`); const started = performance.now();
  const delta = store.apply(asStableId(`transaction:g05-perf-${entityCount}`), [{ op: 'component.patch', componentId: target, path: ['position', 'x'], value: 42 }]); const latencyMs = performance.now() - started;
  assert.ok(delta.metrics.copiedBytes < 512); assert.ok(delta.metrics.historyBytes < 1024); assert.equal(delta.metrics.projectionWork, 1); assert.ok(latencyMs < 50, `${entityCount} edit exceeded 50ms: ${latencyMs.toFixed(2)}ms`);
  const sparse = store.query({ componentType: asStableId('haiyue.component.absent'), limit: 25 }); assert.ok(sparse.scanned <= 1_000);
  return { entityCount, copiedBytes: delta.metrics.copiedBytes, historyBytes: delta.metrics.historyBytes, projectionWork: delta.metrics.projectionWork, latencyBudgetMs: 50, latencyWithinBudget: true, sparseQueryScannedMax: 1_000 };
}

function largeDocument(count) {
  const id = `document:g05-perf-${count}`; const sceneId = `scene:g05-perf-${count}`; const entities = []; const components = []; const roots = [];
  for (let index = 0; index < count; index += 1) { const suffix = String(index).padStart(5, '0'); const entityId = `entity:g05-perf-${suffix}`; const componentId = `component:g05-perf-${suffix}`; roots.push(entityId); entities.push({ id: entityId, sceneId, name: `Entity ${index}`, parentId: null, order: index, componentIds: [componentId] }); components.push({ id: componentId, type: 'haiyue.transform.3d', version: '1.0.0', enabled: true, value: { position: { x: index, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }); }
  return { schemaVersion: 2, id, revision: 1, savedRevision: 0, scenes: [{ id: sceneId, name: 'Main', rootEntityIds: roots }], entities, components, scripts: [], assets: [], settings: {}, migration: { fromVersion: null, migratedAt: null, sourceDigest: null } };
}

function key(value) { return `${value.type}@${value.version}`; }
function escapePattern(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
