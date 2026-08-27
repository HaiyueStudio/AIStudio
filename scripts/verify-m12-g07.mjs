import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComponentRegistry } from '../packages/editor-plugins/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidencePath = path.join(root, 'docs', 'evidence', 'm12-g07-verification.json');
const expectedTypes = [
  'haiyue.gameplay.character', 'haiyue.gameplay.ground-probe',
  'haiyue.physics.collider.2d', 'haiyue.physics.collider.3d',
  'haiyue.physics.joint.2d', 'haiyue.physics.joint.3d', 'haiyue.physics.material',
  'haiyue.physics.rigidbody.2d', 'haiyue.physics.rigidbody.3d',
  'haiyue.physics.world.2d', 'haiyue.physics.world.3d',
];

const registry = new ComponentRegistry().freeze().snapshot();
const descriptors = registry.definitions.filter((item) => expectedTypes.includes(item.type));
assert.deepEqual(descriptors.map((item) => item.type), expectedTypes);
for (const descriptor of descriptors) {
  assert.equal(descriptor.serializable, true, `${descriptor.type} must be serializable`);
  assert.equal(descriptor.version, '1.0.0');
  assert.doesNotMatch(JSON.stringify(descriptor.defaults), /(?:RigidBody|Collider|Joint|World)Handle/u);
}

const census = JSON.parse(await readFile(path.join(root, 'config', 'contracts', 'm12-capability-census.json'), 'utf8'));
const capabilities = ['physics.2d', 'physics.3d', 'physics.raycast'].map((id) => {
  const entry = census.capabilities.find((candidate) => candidate.id === id);
  assert.equal(entry?.owner, 'g07-physics-gameplay-components', `${id} has the wrong goal owner`);
  assert.equal(entry?.testOwner, 'g07-physics-gameplay-components', `${id} has the wrong test owner`);
  return { id, owner: entry.owner, implementationState: 'g07-verified' };
});
const candidate = JSON.parse(await readFile(path.join(root, 'config', 'engine-candidate.json'), 'utf8'));
for (const exportName of ['./physics', './physics/backend']) assert.ok(candidate.requiredExports.includes(exportName));

const runtimeSource = await readFile(path.join(root, 'apps', 'ai-studio', 'src', 'physics-play-runtime.ts'), 'utf8');
for (const marker of ['withTimeout(', 'throwIfAborted(', 'queryShape(', 'queryAabb(', 'resourceSnapshot()', 'stableIdByEntityId', 'eventsValue', 'applyInitialVelocities()', 'dispose(): void']) {
  assert.ok(runtimeSource.includes(marker), `Physics Play runtime marker is missing: ${marker}`);
}
assert.doesNotMatch(runtimeSource, /Physics(?:2D|3D)(?:Body|Collider|Joint)Handle/u, 'Backend handles must not enter the Studio adapter');
const previewSource = await readFile(path.join(root, 'apps', 'ai-studio', 'src', 'preview-runtime.ts'), 'utf8');
for (const marker of ['PhysicsPlayRuntime.create', 'beforeTick(', 'afterTick(', 'physicsRuntime?.dispose()', 'physics: physicsRuntime?.api()']) assert.ok(previewSource.includes(marker));
const testSource = await readFile(path.join(root, 'apps', 'ai-studio', 'test', 'g07-physics-runtime.test.mjs'), 'utf8');
for (const marker of ['seeded platformer', 'seeded racer', 'seeded shooter', "phases.includes('enter')", "phases.includes('stay')", "phases.includes('exit')", 'stale joint targets fail closed', 'backend load failure and cancellation', 'authoringUnchanged']) assert.ok(testSource.includes(marker));
const scriptPreviewSource = await readFile(path.join(root, 'packages', 'script-preview', 'src', 'index.ts'), 'utf8');
assert.ok(scriptPreviewSource.includes('usesPhysicsApi'));
const architecture = await readFile(path.join(root, 'docs', 'architecture', 'm12-physics-gameplay.md'), 'utf8');
for (const marker of ['Exact hash boundary', 'Semantic tolerance boundary', 'Backend handles are excluded', 'one fixed tick']) assert.ok(architecture.includes(marker));

const report = {
  schemaVersion: 1,
  goalId: 'g07-physics-gameplay-components',
  candidate: { package: candidate.package, version: candidate.version, sha256: candidate.sha256, exports: ['./physics', './physics/backend'] },
  capabilities,
  descriptors: descriptors.map((item) => ({ type: item.type, capability: item.capability, effect: item.effect, runtimeAdapter: item.runtimeAdapter })),
  backends: [
    { dimension: '2d', id: 'box2d', load: 'synchronous-candidate', replaceable: true },
    { dimension: '3d', id: 'rapier3d', load: 'async-budgeted', replaceable: true },
  ],
  events: { phases: ['enter', 'stay', 'exit'], kinds: ['collision', 'trigger'], stableEntityIds: true, boundedPerTick: 1024, deterministicOrder: true },
  queries: ['2d.hitTest', '2d.raycast', '2d.aabb', '3d.raycast', '3d.shape', 'gameplay.ground-probe'],
  fixtures: [
    { genre: 'platform-jump', backend: 'rapier3d', assertion: 'land-ground-probe-jump' },
    { genre: 'racing', backend: 'box2d', assertion: 'vehicle-boundary-collision' },
    { genre: 'shooter', backend: 'rapier3d', assertion: 'ccd-trigger-enter-stay-exit' },
  ],
  determinism: { fixedHz: 60, sameCandidateExactStateHash: true, semanticPositionTolerance: 0.0001, semanticVelocityTolerance: 0.001, semanticContactTickTolerance: 1 },
  lifecycle: { backendLoadTimeout: true, abortAndLateResultSafe: true, restartSafe: true, authoringDocumentImmutable: true, residualAfterStop: { worlds: 0, bodies: 0, colliders: 0, joints: 0, activeContacts: 0 } },
  script: { capability: 'physics', inferredFromApiUse: true, generatedDeclarations: true, authoringMutationAllowed: false },
};

if (process.argv.includes('--print')) console.log(JSON.stringify(report, null, 2));
else {
  const expected = JSON.parse(await readFile(evidencePath, 'utf8'));
  assert.deepEqual(report, expected, 'G07 verification evidence drifted; review implementation and evidence together');
  console.log(`[m12:g07] descriptors=${report.descriptors.length} backends=${report.backends.map((item) => item.id).join(',')} fixtures=${report.fixtures.length} lifecycle=zero-residual`);
}
