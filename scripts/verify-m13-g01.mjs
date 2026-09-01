import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { buildBaseline } from './measure-m13-g01-baseline.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.dirname(root);
const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), 'utf8'));
const readText = async (relative) => readFile(path.join(root, relative), 'utf8');

const binding = await readJson('config/contracts/m13-evidence-binding.json');
const index = await readJson('config/contracts/m13-contract-index.json');
const fixtures = await readJson('config/contracts/fixtures/m13-contract-cases.json');
const baseline = await readJson('docs/evidence/m13-g01-baseline.json');
const typeOwner = await readText(index.typescriptOwner);

assert.equal(index.bindingId, binding.bindingId);
assert.equal(baseline.bindingId, binding.bindingId);
for (const artifact of binding.g01Artifacts) await access(path.join(root, artifact));
for (const input of binding.immutableInputs) await access(path.join(root, input.path));
await access(path.join(workspace, 'milestones/docs/for-ai/adr/0083-agent-session-surface-and-batch-ownership.md'));

const ajv = new Ajv({ allErrors: true, strict: true });
for (const contract of index.contracts) {
  const schema = await readJson(contract.schemaPath);
  if (!ajv.getSchema('haiyue://contracts/m13-common/v1')) ajv.addSchema(await readJson('config/contracts/schemas/m13-common.schema.json'));
  ajv.addSchema(schema);
}

const names = new Set();
const schemaIds = new Set();
assert.equal(index.contracts.length, 8, 'M13 G01 freezes exactly eight top-level envelopes');
for (const contract of index.contracts) {
  assert.ok(contract.owner && contract.consumers.length > 0, `${contract.name} needs one owner and consumers`);
  assert.ok(!names.has(contract.name), `duplicate contract ${contract.name}`);
  assert.ok(!schemaIds.has(contract.schemaId), `duplicate schema id ${contract.schemaId}`);
  names.add(contract.name); schemaIds.add(contract.schemaId);
  assert.match(typeOwner, new RegExp(`export (?:interface|type) ${contract.name}\\b`, 'u'), `${contract.name} missing from TypeScript owner`);
  assert.ok(ajv.getSchema(contract.schemaId), `${contract.schemaId} is not registered`);
}
for (const nested of index.nestedTypes) assert.match(typeOwner, new RegExp(`export (?:interface|type) ${nested}\\b`, 'u'), `${nested} missing from TypeScript owner`);
assert.doesNotMatch(typeOwner, /@deepseek|@openai|codex|dsh-agent/iu, 'provider types leaked into M13 contracts');

const validBySchema = new Map(fixtures.valid.map((fixture) => [fixture.schemaId, fixture.value]));
assert.deepEqual([...validBySchema.keys()].sort(), [...schemaIds].sort(), 'valid fixtures must cover every indexed schema');
for (const [schemaId, value] of validBySchema) {
  const validate = ajv.getSchema(schemaId);
  const unknownVersion = structuredClone(value); unknownVersion.schemaVersion = 999;
  assert.equal(validate(unknownVersion), false, `${schemaId} accepted an unknown version`);
  const unknownField = { ...structuredClone(value), providerPrivateState: {} };
  assert.equal(validate(unknownField), false, `${schemaId} accepted an unknown field`);
}

function validateDag(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) return { ok: false, diagnostic: 'tool-batch.cycle' };
  const state = new Map();
  const visit = (id) => {
    if (!byId.has(id)) return false;
    if (state.get(id) === 1) return false;
    if (state.get(id) === 2) return true;
    state.set(id, 1);
    for (const dependency of byId.get(id).dependsOn ?? []) if (!visit(dependency)) return false;
    state.set(id, 2); return true;
  };
  return nodes.every((node) => visit(node.id)) ? { ok: true } : { ok: false, diagnostic: 'tool-batch.cycle' };
}

function validateSurface(value) {
  const ids = new Set(value.nodes.map((node) => node.id));
  if (ids.size !== value.nodes.length) return { ok: false, diagnostic: 'surface.source-missing' };
  if (value.lastOperation?.op !== 'replace') return { ok: true };
  const replacement = value.nodes.find((node) => node.messageArtifactId === value.lastOperation.replacementArtifactId);
  if (!replacement) return { ok: false, diagnostic: 'surface.replace-range-invalid' };
  const expected = [...value.lastOperation.sourceOpIds].sort();
  const actual = [...replacement.replacedSourceOpIds].sort();
  return JSON.stringify(expected) === JSON.stringify(actual) ? { ok: true } : { ok: false, diagnostic: 'surface.replace-range-invalid' };
}

function validateGraph(value) {
  const ids = new Set(value.nodes.map((node) => node.id));
  if (ids.size !== value.nodes.length || value.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to)) || value.criticalPathNodeIds.some((id) => !ids.has(id))) return { ok: false, diagnostic: 'execution-graph.orphan-edge' };
  return { ok: true };
}

function validateSemanticFixture(fixture) {
  if (fixture.validator === 'tool-batch') return validateDag(fixture.value.nodes);
  if (fixture.validator === 'tool-effect') return fixture.value.effects.includes('unknown') && fixture.value.executionClass !== 'unknown-exclusive' ? { ok: false, diagnostic: 'tool-batch.concurrency-unknown' } : { ok: true };
  if (fixture.validator === 'surface-digest') return fixture.expectedDigest === fixture.actualDigest ? { ok: true } : { ok: false, diagnostic: 'context.compaction-summary-invalid' };
  if (fixture.validator === 'surface-replace') {
    const start = fixture.beforeNodeIds.indexOf(fixture.operation.startNodeId);
    const end = fixture.beforeNodeIds.indexOf(fixture.operation.endNodeId);
    if (start < 0 || end < start) return { ok: false, diagnostic: 'surface.replace-range-invalid' };
    const complete = fixture.beforeNodeIds.slice(start, end + 1).flatMap((id) => fixture.sourceOpsByNode[id] ?? []).sort();
    return JSON.stringify(complete) === JSON.stringify([...fixture.operation.sourceOpIds].sort()) ? { ok: true } : { ok: false, diagnostic: 'surface.replace-range-invalid' };
  }
  if (fixture.validator === 'execution-graph') return validateGraph(fixture.value);
  if (fixture.validator === 'scene-diff') return fixture.value.toRevision >= fixture.value.fromRevision ? { ok: true } : { ok: false, diagnostic: 'scene-diff.revision-gap' };
  if (fixture.validator === 'knowledge-hit') return fixture.value.chunk.end > fixture.value.chunk.start ? { ok: true } : { ok: false, diagnostic: 'knowledge.source-untrusted' };
  throw new Error(`unknown semantic validator ${fixture.validator}`);
}

assert.equal(validateDag(validBySchema.get('haiyue://contracts/tool-batch-request/v1').nodes).ok, true);
assert.equal(validateSurface(validBySchema.get('haiyue://contracts/model-surface/v1')).ok, true);
assert.equal(validateGraph(validBySchema.get('haiyue://contracts/execution-graph/v1')).ok, true);
const validDiff = validBySchema.get('haiyue://contracts/scene-diff/v1');
assert.ok(validDiff.toRevision >= validDiff.fromRevision);
assert.ok(validDiff.cameraChanges && validDiff.renderChanges, 'SceneDiff must expose camera and render changes');
const validKnowledge = validBySchema.get('haiyue://contracts/knowledge-hit/v1');
assert.ok(validKnowledge.chunk.end > validKnowledge.chunk.start);
const validSession = validBySchema.get('haiyue://contracts/agent-session/v1');
assert.equal(validSession.checkpoint.sessionId, validSession.id);
const pressure = validBySchema.get('haiyue://contracts/context-frame/v1').pressure;
const computedRatio = pressure.usedInputTokens / (pressure.maxInputTokens - pressure.reservedOutputTokens - pressure.reservedSafetyTokens);
assert.ok(Math.abs(computedRatio - pressure.ratio) < 0.01, 'context pressure ratio is inconsistent');

for (const fixture of fixtures.semanticInvalid) {
  const result = validateSemanticFixture(fixture);
  assert.equal(result.ok, false, `${fixture.name} unexpectedly passed semantic validation`);
  assert.equal(result.diagnostic, fixture.diagnostic, `${fixture.name} diagnostic drift`);
}

assert.deepEqual(await buildBaseline(), baseline, 'repeatable baseline drift');
const requiredGenres = ['snake', 'match-3', 'falling-blocks', 'jigsaw', 'platformer', 'racing', 'shooter'];
assert.deepEqual(baseline.genres.map((entry) => entry.genre), requiredGenres);
for (const entry of baseline.genres) {
  for (const key of ['modelTurns', 'tokens', 'cache', 'cost', 'toolCalls', 'wallTimeMs', 'screenshotCaptured', 'evaluatorStatus']) assert.ok(key in entry, `${entry.genre} missing ${key}`);
  if (entry.measurement === 'unavailable') assert.ok(entry.modelTurns === null && entry.toolCalls === null && entry.wallTimeMs === null, `${entry.genre} unknown metrics must remain null`);
}
assert.equal(baseline.largeProject.entityCount, 1000);
assert.equal(baseline.largeProject.scriptCount, 200);
assert.equal(baseline.source.providerRequestIssued, false);
assert.equal(baseline.interpretation.passClaimed, false);
assert.equal(new Set(baseline.recovery.map((entry) => entry.scenario)).size, 7);

const boundDocs = [
  'docs/architecture/m13-contract-index.md',
  'docs/architecture/m13-session-surface-failure-model.md',
  'docs/evidence/m13-g01-baseline.md',
  'docs/evidence/m13-g01-verification.md'
];
for (const document of boundDocs) assert.match(await readText(document), new RegExp(binding.bindingId, 'u'), `${document} missing binding id`);
const adr = await readFile(path.join(workspace, 'milestones/docs/for-ai/adr/0083-agent-session-surface-and-batch-ownership.md'), 'utf8');
assert.match(adr, new RegExp(binding.bindingId, 'u'));
for (const term of ['renderer reload', 'Backend reconnect', 'long approval', 'unknown-tool-outcome', 'automatic compaction', 'parallel-tool-batch']) {
  assert.match(await readText('docs/architecture/m13-session-surface-failure-model.md'), new RegExp(term, 'iu'), `failure model missing ${term}`);
}

console.log(`[m13-g01] contracts=${index.contracts.length} semanticInvalid=${fixtures.semanticInvalid.length} genres=${baseline.genres.length} binding=${binding.bindingId}`);
