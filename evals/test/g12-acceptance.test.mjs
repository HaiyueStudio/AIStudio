import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { deepClone } from '../src/canonical.mjs';
import { G12_BACKENDS, G12_GENRES, G12_REQUIRED_GATES, G12_SEMANTIC_REPLAY_ACTIONS, assertG12Acceptance, evaluateG12Acceptance } from '../src/index.mjs';

const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const revision = (character) => character.repeat(40);
const id = (kind, suffix) => `g12.${kind}:${suffix}`;

function formalManifest() {
  const revisions = {
    aistudio: { revision: revision('a'), clean: true, reviewed: true },
    engine: { revision: revision('b'), clean: true, reviewed: true },
    milestones: { revision: revision('c'), clean: true, reviewed: true },
  };
  const artifact = (name) => ({ id: id('artifact', name), path: `evals/evidence/g12/${name}.json`, digest: digest(name), revisions: { aistudio: revisions.aistudio.revision, engine: revisions.engine.revision, milestones: revisions.milestones.revision } });
  const backendTask = (backend, genre, index) => ({
    genre, mode: 'cold-create', status: 'pass', terminal: 'complete', budgetStatus: 'within',
    artifactId: id('artifact', `task-${backend}-${index}`),
    projectId: id('project', `${backend}-${index}`), conversationId: id('conversation', `${backend}-${index}`), model: id('model', backend),
    configDigest: digest(`config:${backend}:${genre}`), promptArtifactDigest: digest(`prompt:${backend}:${genre}`), toolCatalogDigest: digest(`tools:${backend}`), componentRegistryDigest: digest('components'), inputReplayDigest: digest(`replay:${genre}`), evaluatorResultDigest: digest(`evaluate:${backend}:${genre}`),
    usageRecordIds: [id('usage', `${backend}-${index}`)], costRecordIds: [id('cost', `${backend}-${index}`)], cacheRecordIds: [id('cache', `${backend}-${index}`)], stateEvidenceIds: [id('state', `${backend}-${index}`)], screenshotEvidenceIds: [id('screenshot', `${backend}-${index}`)],
    firstPass: index < 6, repairIterations: index < 6 ? 0 : 1, acceptancePassed: 4, acceptanceRequired: 4,
  });
  const gates = Object.fromEntries(G12_REQUIRED_GATES.map((name) => [name, { status: 'pass', artifactId: id('artifact', name), resultDigest: digest(`gate:${name}`) }]));
  gates.ownerTeardown.residualOwners = 0;
  gates.appCloseTeardown.residualOwners = 0;
  gates.secretScan.findings = 0;
  gates.artifactIntegrity.tamperedAccepted = 0;
  gates.promptIsolation.genrePatchCount = 0;
  Object.assign(gates.budgetStop, { falseComplete: 0, partialArtifactsPreserved: true, continuationRequiresUser: true });
  Object.assign(gates.soak, { durationMinutes: 30, cleanupResidual: 0 });
  const seededTasks = Array.from({ length: 15 }, (_, index) => ({ failureSeedId: id('seed', String(index)), genre: G12_GENRES[index % G12_GENRES.length], status: 'pass', repairIterations: 1, beforeEvidenceId: id('before', String(index)), afterEvidenceId: id('after', String(index)), evaluatorResultDigest: digest(`seed:${index}`) }));
  return {
    schemaVersion: 1, goalId: 'g12-cross-genre-integration-acceptance', evidenceClass: 'formal',
    suite: { id: 'm12.game-agent-evaluation', version: '1.0.0', digest: digest('suite') }, revisions,
    protocolPins: { harness: { package: 'deepseek-harness', version: '0.1.0-rc.7', digest: digest('harness') }, codex: { package: 'codex-app-server', version: '0.148.0', digest: digest('codex') } },
    artifacts: ['fake', 'electron', 'harness', 'codex', 'repair', 'review', ...G12_REQUIRED_GATES, ...G12_BACKENDS.flatMap((backend) => G12_GENRES.map((_genre, index) => `task-${backend}-${index}`))].map(artifact),
    matrix: {
      fake: { artifactId: id('artifact', 'fake'), runner: 'deterministic-reference', reportDigest: digest('fake'), total: 7, passed: 7, failed: 0, genres: [...G12_GENRES], blankControlPassed: 0, deterministicRepeat: true },
      electronWebgpu: { artifactId: id('artifact', 'electron'), runtime: 'electron-webgpu', realWebgpu: true, sandboxedIframe: true, cleanupResidual: 0, replayProgramVersion: '1.0.0', semanticDriverIds: [...G12_SEMANTIC_REPLAY_ACTIONS], reportDigest: digest('electron'), results: G12_GENRES.map((genre) => ({ genre, status: 'pass', stateEvidenceId: id('state', genre), screenshotEvidenceId: id('screenshot', genre), evaluatorResultDigest: digest(`electron:${genre}`), pngHeaderOnly: false })) },
      backends: G12_BACKENDS.map((backend) => ({ artifactId: id('artifact', backend), kind: backend, backendInstanceId: id('backend', backend), protocolVersion: id('protocol', backend), reportDigest: digest(`backend:${backend}`), tasks: G12_GENRES.map((genre, index) => backendTask(backend, genre, index)) })),
      seededRepair: { artifactId: id('artifact', 'repair'), total: seededTasks.length, repaired: seededTasks.length, correctlyBlocked: 0, falseComplete: 0, reportDigest: digest('repair'), tasks: seededTasks },
    },
    gates,
    decision: { status: 'GO', reviewId: id('review', 'formal'), reviewArtifactId: id('artifact', 'review'), reviewedAt: '2026-08-29T12:00:00.000Z' },
  };
}

test('formal G12 manifest requires all seven genres, both independent backends, repairs and lifecycle gates', () => {
  const manifest = formalManifest();
  assert.deepEqual(assertG12Acceptance(manifest), { schemaVersion: 1, goalId: 'g12-cross-genre-integration-acceptance', status: 'GO', diagnostics: [] });
});

test('G12 is fail-closed for dirty revisions, shared projects, missing evidence, low first-pass rate and genre prompt patches', () => {
  const manifest = formalManifest();
  manifest.revisions.engine.clean = false;
  manifest.matrix.backends[1].tasks[0].projectId = manifest.matrix.backends[0].tasks[0].projectId;
  manifest.matrix.backends[0].tasks[0].screenshotEvidenceIds = [];
  manifest.matrix.backends[0].tasks[5].firstPass = false;
  manifest.matrix.backends[0].tasks[5].repairIterations = 1;
  manifest.gates.promptIsolation.genrePatchCount = 1;
  const result = evaluateG12Acceptance(manifest);
  assert.equal(result.status, 'NO-GO');
  for (const code of ['g12.revision-dirty:engine', 'g12.project-not-independent:codex:snake', 'g12.backend-task-links-invalid:harness:snake:screenshotEvidenceIds', 'g12.backend-first-pass-below-six:harness', 'g12.genre-prompt-patch']) assert.ok(result.diagnostics.includes(code), code);
});

test('test fixtures and cross-revision evidence cannot be promoted into formal acceptance', () => {
  const manifest = formalManifest();
  manifest.artifacts[0].path = 'evals/fixtures/fake-formal.json';
  manifest.artifacts[1].revisions.aistudio = revision('d');
  manifest.evidenceClass = 'synthetic';
  const result = evaluateG12Acceptance(manifest);
  assert.equal(result.status, 'NO-GO');
  assert.ok(result.diagnostics.some((entry) => entry.startsWith('g12.artifact-path-invalid')));
  assert.ok(result.diagnostics.some((entry) => entry.startsWith('g12.artifact-revision-mismatch')));
  assert.ok(result.diagnostics.includes('g12.evidence-class-invalid'));
});

test('formal decision cannot hide failed seeded repair or budget-stop semantics', () => {
  const manifest = deepClone(formalManifest());
  manifest.matrix.seededRepair.tasks[0].afterEvidenceId = manifest.matrix.seededRepair.tasks[0].beforeEvidenceId;
  manifest.matrix.seededRepair.falseComplete = 1;
  manifest.gates.budgetStop.partialArtifactsPreserved = false;
  const result = evaluateG12Acceptance(manifest);
  assert.equal(result.status, 'NO-GO');
  assert.ok(result.diagnostics.includes('g12.seeded-repair-invalid'));
  assert.ok(result.diagnostics.some((entry) => entry.startsWith('g12.seeded-repair-task-invalid')));
  assert.ok(result.diagnostics.includes('g12.budget-stop-invalid'));
});
