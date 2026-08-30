import { deepFreeze } from './canonical.mjs';
import { G12_SEMANTIC_DRIVER_IDS } from './g12-semantic-drivers.mjs';

export const G12_GENRES = deepFreeze(['snake', 'match-3', 'falling-blocks', 'jigsaw', 'platformer', 'racing', 'shooter']);
export const G12_BACKENDS = deepFreeze(['harness', 'codex']);
export const G12_REQUIRED_GATES = deepFreeze([
  'migrationRollback',
  'saveReopen',
  'undoRedo',
  'playRestart',
  'rendererReload',
  'backendReconnect',
  'appCloseTeardown',
  'secretScan',
  'artifactIntegrity',
  'cacheProvenance',
  'budgetStop',
  'ownerTeardown',
  'packagingSmoke',
  'soak',
  'promptIsolation',
]);

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/u;
const SAFE_ARTIFACT_PATH = /^(?![A-Za-z]:)(?![/\\])(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[A-Za-z0-9._/\\-]+$/u;

export function evaluateG12Acceptance(manifest) {
  const diagnostics = [];
  const fail = (code, detail) => diagnostics.push(detail ? `${code}:${detail}` : code);

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return deepFreeze({ schemaVersion: 1, goalId: 'g12-cross-genre-integration-acceptance', status: 'NO-GO', diagnostics: ['g12.manifest-invalid'] });
  }
  if (manifest.schemaVersion !== 1) fail('g12.schema-version-invalid');
  if (manifest.goalId !== 'g12-cross-genre-integration-acceptance') fail('g12.goal-id-invalid');
  if (manifest.evidenceClass !== 'formal') fail('g12.evidence-class-invalid');

  validateSuite(manifest.suite, fail);
  const revisionBindings = validateRevisions(manifest.revisions, fail);
  validateProtocolPins(manifest.protocolPins, fail);
  const artifactIds = validateArtifacts(manifest.artifacts, revisionBindings, fail);
  validateFake(manifest.matrix?.fake, artifactIds, fail);
  validateElectron(manifest.matrix?.electronWebgpu, artifactIds, fail);
  validateBackends(manifest.matrix?.backends, artifactIds, fail);
  validateSeededRepair(manifest.matrix?.seededRepair, artifactIds, fail);
  validateGates(manifest.gates, artifactIds, fail);
  validateDecision(manifest.decision, artifactIds, fail);

  return deepFreeze({
    schemaVersion: 1,
    goalId: 'g12-cross-genre-integration-acceptance',
    status: diagnostics.length === 0 ? 'GO' : 'NO-GO',
    diagnostics: [...new Set(diagnostics)].sort(),
  });
}

export function assertG12Acceptance(manifest) {
  const result = evaluateG12Acceptance(manifest);
  if (result.status !== 'GO') throw new G12AcceptanceError('g12.acceptance-no-go', result.diagnostics);
  return result;
}

function validateSuite(suite, fail) {
  if (!suite || suite.id !== 'm12.game-agent-evaluation' || typeof suite.version !== 'string' || !DIGEST.test(suite.digest ?? '')) {
    fail('g12.suite-invalid');
  }
}

function validateRevisions(revisions, fail) {
  const bindings = {};
  for (const repository of ['aistudio', 'engine', 'milestones']) {
    const entry = revisions?.[repository];
    if (!entry || !REVISION.test(entry.revision ?? '')) fail('g12.revision-invalid', repository);
    if (entry?.clean !== true) fail('g12.revision-dirty', repository);
    if (entry?.reviewed !== true) fail('g12.revision-unreviewed', repository);
    bindings[repository] = entry?.revision;
  }
  return bindings;
}

function validateProtocolPins(pins, fail) {
  for (const backend of G12_BACKENDS) {
    const entry = pins?.[backend];
    if (!entry || !STABLE_ID.test(entry.package ?? '') || typeof entry.version !== 'string' || entry.version.length < 1 || !DIGEST.test(entry.digest ?? '')) {
      fail('g12.protocol-pin-invalid', backend);
    }
  }
}

function validateArtifacts(artifacts, revisions, fail) {
  const ids = new Set();
  if (!Array.isArray(artifacts) || artifacts.length < 6) {
    fail('g12.artifacts-incomplete');
    return ids;
  }
  const paths = new Set();
  for (const artifact of artifacts) {
    if (!STABLE_ID.test(artifact?.id ?? '') || ids.has(artifact.id)) fail('g12.artifact-id-invalid', artifact?.id ?? 'missing');
    else ids.add(artifact.id);
    if (!SAFE_ARTIFACT_PATH.test(artifact?.path ?? '') || /(?:^|[/\\])fixtures?(?:[/\\]|$)/iu.test(artifact.path ?? '') || paths.has(artifact.path)) fail('g12.artifact-path-invalid', artifact?.path ?? 'missing');
    else paths.add(artifact.path);
    if (!DIGEST.test(artifact?.digest ?? '')) fail('g12.artifact-digest-invalid', artifact?.id ?? 'missing');
    for (const repository of ['aistudio', 'engine', 'milestones']) {
      if (artifact?.revisions?.[repository] !== revisions[repository]) fail('g12.artifact-revision-mismatch', `${artifact?.id ?? 'missing'}:${repository}`);
    }
  }
  return ids;
}

function validateFake(fake, artifactIds, fail) {
  if (!fake || fake.runner !== 'deterministic-reference' || !DIGEST.test(fake.reportDigest ?? '') || fake.total !== 7 || fake.passed !== 7 || fake.failed !== 0) {
    fail('g12.fake-suite-invalid');
  }
  validateArtifactReference(fake?.artifactId, artifactIds, 'fake', fail);
  validateExactGenres(fake?.genres, 'g12.fake-genres-invalid', fail);
  if (fake?.blankControlPassed !== 0 || fake?.deterministicRepeat !== true) fail('g12.fake-controls-invalid');
}

function validateElectron(electron, artifactIds, fail) {
  if (!electron || electron.runtime !== 'electron-webgpu' || electron.realWebgpu !== true || electron.sandboxedIframe !== true || electron.cleanupResidual !== 0 || !DIGEST.test(electron.reportDigest ?? '') || electron.replayProgramVersion !== '1.0.0') {
    fail('g12.electron-suite-invalid');
  }
  validateArtifactReference(electron?.artifactId, artifactIds, 'electron', fail);
  if (!Array.isArray(electron?.semanticDriverIds) || [...electron.semanticDriverIds].sort().join('|') !== G12_SEMANTIC_DRIVER_IDS.join('|')) fail('g12.semantic-driver-coverage-invalid');
  const results = electron?.results;
  if (!Array.isArray(results) || results.length !== G12_GENRES.length) {
    fail('g12.electron-results-incomplete');
    return;
  }
  validateExactGenres(results.map((entry) => entry.genre), 'g12.electron-genres-invalid', fail);
  for (const entry of results) {
    if (entry.status !== 'pass' || !STABLE_ID.test(entry.stateEvidenceId ?? '') || !STABLE_ID.test(entry.screenshotEvidenceId ?? '') || !DIGEST.test(entry.evaluatorResultDigest ?? '') || entry.pngHeaderOnly === true) {
      fail('g12.electron-result-invalid', entry.genre ?? 'unknown');
    }
  }
}

function validateBackends(backends, artifactIds, fail) {
  if (!Array.isArray(backends) || backends.length !== G12_BACKENDS.length) {
    fail('g12.backends-incomplete');
    return;
  }
  const backendIds = new Set();
  const projectIds = new Set();
  const conversationIds = new Set();
  for (const backend of backends) {
    if (!G12_BACKENDS.includes(backend?.kind) || backendIds.has(backend.kind)) fail('g12.backend-kind-invalid', backend?.kind ?? 'missing');
    else backendIds.add(backend.kind);
    if (!STABLE_ID.test(backend?.backendInstanceId ?? '') || !STABLE_ID.test(backend?.protocolVersion ?? '') || !DIGEST.test(backend?.reportDigest ?? '')) fail('g12.backend-provenance-invalid', backend?.kind ?? 'unknown');
    validateArtifactReference(backend?.artifactId, artifactIds, `backend:${backend?.kind ?? 'unknown'}`, fail);
    if (!Array.isArray(backend?.tasks) || backend.tasks.length !== G12_GENRES.length) {
      fail('g12.backend-tasks-incomplete', backend?.kind ?? 'unknown');
      continue;
    }
    validateExactGenres(backend.tasks.map((entry) => entry.genre), `g12.backend-genres-invalid:${backend.kind}`, fail);
    let firstPass = 0;
    for (const task of backend.tasks) {
      if (task.firstPass === true) firstPass++;
      validateBackendTask(task, backend.kind, projectIds, conversationIds, artifactIds, fail);
    }
    if (firstPass < 6) fail('g12.backend-first-pass-below-six', backend.kind);
  }
  for (const required of G12_BACKENDS) if (!backendIds.has(required)) fail('g12.backend-missing', required);
}

function validateBackendTask(task, backend, projectIds, conversationIds, artifactIds, fail) {
  const genre = task?.genre ?? 'unknown';
  const prefix = `${backend}:${genre}`;
  if (!G12_GENRES.includes(genre) || task.mode !== 'cold-create' || task.status !== 'pass' || task.terminal !== 'complete' || task.budgetStatus !== 'within') fail('g12.backend-task-result-invalid', prefix);
  validateArtifactReference(task?.artifactId, artifactIds, `task:${prefix}`, fail);
  if (!STABLE_ID.test(task?.projectId ?? '') || projectIds.has(task.projectId)) fail('g12.project-not-independent', prefix);
  else projectIds.add(task.projectId);
  if (!STABLE_ID.test(task?.conversationId ?? '') || conversationIds.has(task.conversationId)) fail('g12.conversation-not-independent', prefix);
  else conversationIds.add(task.conversationId);
  if (!STABLE_ID.test(task?.model ?? '') || !DIGEST.test(task?.configDigest ?? '') || !DIGEST.test(task?.promptArtifactDigest ?? '') || !DIGEST.test(task?.toolCatalogDigest ?? '') || !DIGEST.test(task?.componentRegistryDigest ?? '') || !DIGEST.test(task?.inputReplayDigest ?? '') || !DIGEST.test(task?.evaluatorResultDigest ?? '')) fail('g12.backend-task-provenance-invalid', prefix);
  for (const field of ['usageRecordIds', 'costRecordIds', 'cacheRecordIds', 'stateEvidenceIds', 'screenshotEvidenceIds']) {
    if (!Array.isArray(task?.[field]) || task[field].length < 1 || task[field].some((id) => !STABLE_ID.test(id))) fail('g12.backend-task-links-invalid', `${prefix}:${field}`);
  }
  if (!Number.isSafeInteger(task?.repairIterations) || task.repairIterations < 0 || task.repairIterations > 2 || (task.firstPass === true && task.repairIterations !== 0) || (task.firstPass !== true && task.repairIterations < 1)) fail('g12.backend-task-repair-invalid', prefix);
  if (!Number.isSafeInteger(task?.acceptancePassed) || !Number.isSafeInteger(task?.acceptanceRequired) || task.acceptanceRequired < 1 || task.acceptancePassed !== task.acceptanceRequired) fail('g12.backend-task-acceptance-invalid', prefix);
}

function validateSeededRepair(repair, artifactIds, fail) {
  if (!repair || !Number.isSafeInteger(repair.total) || repair.total < 14 || repair.repaired !== repair.total || repair.correctlyBlocked !== 0 || repair.falseComplete !== 0 || !DIGEST.test(repair.reportDigest ?? '')) {
    fail('g12.seeded-repair-invalid');
  }
  validateArtifactReference(repair?.artifactId, artifactIds, 'seeded-repair', fail);
  if (!Array.isArray(repair?.tasks) || repair.tasks.length !== repair.total) {
    fail('g12.seeded-repair-tasks-incomplete');
    return;
  }
  const ids = new Set();
  for (const task of repair.tasks) {
    if (!STABLE_ID.test(task?.failureSeedId ?? '') || ids.has(task.failureSeedId)) fail('g12.seeded-repair-id-invalid', task?.failureSeedId ?? 'missing');
    else ids.add(task.failureSeedId);
    if (!G12_GENRES.includes(task?.genre) || task.status !== 'pass' || !Number.isSafeInteger(task.repairIterations) || task.repairIterations < 1 || task.repairIterations > 2 || !STABLE_ID.test(task.beforeEvidenceId ?? '') || !STABLE_ID.test(task.afterEvidenceId ?? '') || task.beforeEvidenceId === task.afterEvidenceId || !DIGEST.test(task.evaluatorResultDigest ?? '')) fail('g12.seeded-repair-task-invalid', task?.failureSeedId ?? 'missing');
  }
}

function validateGates(gates, artifactIds, fail) {
  for (const name of G12_REQUIRED_GATES) {
    const gate = gates?.[name];
    if (!gate || gate.status !== 'pass' || !STABLE_ID.test(gate.artifactId ?? '') || !DIGEST.test(gate.resultDigest ?? '')) fail('g12.gate-failed', name);
    else validateArtifactReference(gate.artifactId, artifactIds, `gate:${name}`, fail);
  }
  if (gates?.ownerTeardown?.residualOwners !== 0 || gates?.appCloseTeardown?.residualOwners !== 0) fail('g12.owner-residual');
  if (gates?.secretScan?.findings !== 0) fail('g12.secret-findings');
  if (gates?.artifactIntegrity?.tamperedAccepted !== 0) fail('g12.artifact-tamper-accepted');
  if (gates?.promptIsolation?.genrePatchCount !== 0) fail('g12.genre-prompt-patch');
  if (gates?.budgetStop?.falseComplete !== 0 || gates?.budgetStop?.partialArtifactsPreserved !== true || gates?.budgetStop?.continuationRequiresUser !== true) fail('g12.budget-stop-invalid');
  if (gates?.soak?.durationMinutes < 30 || gates?.soak?.cleanupResidual !== 0) fail('g12.soak-invalid');
}

function validateDecision(decision, artifactIds, fail) {
  if (!decision || decision.status !== 'GO' || !STABLE_ID.test(decision.reviewId ?? '') || typeof decision.reviewedAt !== 'string' || Number.isNaN(Date.parse(decision.reviewedAt))) fail('g12.decision-invalid');
  validateArtifactReference(decision?.reviewArtifactId, artifactIds, 'go-no-go-review', fail);
}

function validateExactGenres(genres, code, fail) {
  if (!Array.isArray(genres) || genres.length !== G12_GENRES.length || [...genres].sort().join('|') !== [...G12_GENRES].sort().join('|')) fail(code);
}

function validateArtifactReference(artifactId, artifactIds, context, fail) {
  if (!STABLE_ID.test(artifactId ?? '') || !artifactIds.has(artifactId)) fail('g12.artifact-reference-missing', context);
}

export class G12AcceptanceError extends Error {
  constructor(code, diagnostics) {
    super(`G12 acceptance is NO-GO:\n${diagnostics.join('\n')}`);
    this.name = 'G12AcceptanceError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}
