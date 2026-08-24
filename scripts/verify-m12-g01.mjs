import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), 'utf8'));
const readText = async (relative) => readFile(path.join(root, relative), 'utf8');

const binding = await readJson('config/contracts/m12-evidence-binding.json');
const contractIndex = await readJson('config/contracts/m12-contract-index.json');
const capabilitySchema = await readJson('config/contracts/schemas/m12-capability-id.schema.json');
const census = await readJson('config/contracts/m12-capability-census.json');
const baseline = await readJson('docs/evidence/m12-g01-baseline.json');
const m06Expected = await readJson('docs/evidence/g10-expected-manifest.json');
const packageLock = await readJson('package-lock.json');
const typeOwner = await readText(contractIndex.typescriptOwner);

for (const artifact of binding.g01Artifacts) await access(path.join(root, artifact));
for (const input of binding.immutableInputs) await access(path.join(root, input.path));
for (const artifact of [contractIndex, census, baseline]) {
  assert.equal(artifact.bindingId, binding.bindingId, 'G01 artifacts must share one binding id');
}

const contractNames = new Set();
const contractSchemaIds = new Set();
for (const contract of contractIndex.contracts) {
  assert.ok(contract.owner, `${contract.name} has no owner`);
  assert.ok(contract.consumers.length > 0, `${contract.name} has no consumer`);
  assert.ok(!contractNames.has(contract.name), `duplicate contract name ${contract.name}`);
  assert.ok(!contractSchemaIds.has(contract.schemaId), `duplicate schema id ${contract.schemaId}`);
  contractNames.add(contract.name);
  contractSchemaIds.add(contract.schemaId);
  const schema = await readJson(contract.schemaPath);
  assert.equal(schema.$id, contract.schemaId, `${contract.name} schema id drift`);
  assert.match(typeOwner, new RegExp(`export (?:interface|type) ${contract.name}\\b`), `${contract.name} missing from TypeScript owner`);
}

const capabilityIds = capabilitySchema.enum;
assert.ok(Array.isArray(capabilityIds) && capabilityIds.length > 0, 'capability enum is empty');
const censusIds = census.capabilities.map((entry) => entry.id);
assert.equal(new Set(censusIds).size, censusIds.length, 'capability census ids must be unique');
assert.deepEqual([...censusIds].sort(), [...capabilityIds].sort(), 'capability census must cover the full v2 capability registry');

const allowedClassifications = new Set(census.classifications);
const importCache = new Map();
for (const capability of census.capabilities) {
  assert.ok(capability.owner, `${capability.id} missing owner`);
  assert.ok(capability.testOwner, `${capability.id} missing test owner`);
  assert.ok(allowedClassifications.has(capability.classification), `${capability.id} has unknown classification`);
  assert.ok(capability.lifecycle?.ownership && capability.lifecycle?.teardown, `${capability.id} missing lifecycle`);
  assert.ok(capability.serialization?.status, `${capability.id} missing serialization status`);
  assert.ok(capability.toolExposure?.m06 && capability.toolExposure?.m12Owner, `${capability.id} missing tool exposure`);
  assert.ok(Array.isArray(capability.evidence) && capability.evidence.length > 0, `${capability.id} missing evidence`);
  if (capability.classification === 'available-public') {
    assert.ok(capability.publicPath && capability.version, `${capability.id} public classification needs path/version`);
    if (capability.publicPath.startsWith('@haiyue/engine') || capability.publicPath.startsWith('@haiyue/editor-')) {
      let publicModule = importCache.get(capability.publicPath);
      if (!publicModule) {
        publicModule = await import(capability.publicPath);
        importCache.set(capability.publicPath, publicModule);
      }
      for (const symbol of capability.publicSymbols) {
        assert.ok(symbol in publicModule, `${capability.id} missing public runtime symbol ${capability.publicPath}#${symbol}`);
      }
    } else if (capability.publicPath.startsWith('@haiyue/extensions/')) {
      assert.ok(capability.evidence.some((entry) => entry.startsWith('Engine@07524b6:')), `${capability.id} extension export lacks bound repository evidence`);
    }
  }
}

const installedEngine = packageLock.packages['node_modules/@haiyue/engine'];
assert.equal(installedEngine.version, census.sources.engineInstalled.version);
assert.equal(installedEngine.integrity, census.sources.engineInstalled.integrity);
assert.equal(baseline.source.reviewedCommit, m06Expected.baseCommit, 'baseline must bind the reviewed M06 evidence revision');

const m06Definitions = execFileSync('git', ['show', `${baseline.source.reviewedCommit}:${baseline.source.toolDefinitionPath}`], { cwd: root, encoding: 'utf8' });
const reviewedToolIds = [...m06Definitions.matchAll(/definition\('([^']+)'/g)].map((match) => match[1]);
assert.deepEqual(reviewedToolIds, baseline.source.productionToolIds, 'M06 production tool inventory drift');

const requiredGenres = ['snake', 'match-3', 'falling-blocks', 'jigsaw', 'platformer', 'racing', 'shooter'];
assert.deepEqual([...baseline.cases.map((entry) => entry.genre)].sort(), [...requiredGenres].sort(), 'baseline must cover exactly seven genres');
assert.equal(baseline.methodology.providerRequestIssued, false);
assert.equal(baseline.source.productionPromptModified, false);
assert.equal(baseline.source.productionToolsModified, false);

const censusById = new Map(census.capabilities.map((entry) => [entry.id, entry]));
for (const testCase of baseline.cases) {
  assert.equal(testCase.terminal, 'blocked', `${testCase.id} cannot claim pass without acceptance evidence`);
  assert.equal(testCase.mutationCount, 0, `${testCase.id} preflight must not mutate`);
  assert.equal(testCase.preview.started, false, `${testCase.id} preflight must not start preview`);
  assert.equal(testCase.toolCalls, 0, `${testCase.id} preflight must not call tools`);
  assert.equal(testCase.wallLatencyMs, 0, `${testCase.id} preflight latency semantics drift`);
  assert.ok(Object.values(testCase.usage).every((value) => value === null), `${testCase.id} unissued provider usage must be null`);
  assert.deepEqual(testCase.cost, { status: 'unknown', currency: null, amountMicros: null }, `${testCase.id} cost must remain unknown`);
  assert.ok(testCase.errors.length > 0 && testCase.evidenceGaps.length > 0, `${testCase.id} must preserve failure evidence gaps`);
  assert.ok(testCase.capabilityGaps.length > 0, `${testCase.id} needs capability gaps`);
  for (const capabilityId of testCase.requiredCapabilities) assert.ok(censusById.has(capabilityId), `${testCase.id} references unknown capability ${capabilityId}`);
  for (const capabilityId of testCase.capabilityGaps) {
    assert.ok(testCase.requiredCapabilities.includes(capabilityId), `${testCase.id} gap ${capabilityId} is not required`);
    assert.notEqual(censusById.get(capabilityId).integrationState, 'm06-integrated', `${testCase.id} incorrectly marks integrated capability ${capabilityId} as missing`);
  }
}

const boundDocs = [
  'docs/adr/0002-m12-v2-contract-ownership.md',
  'docs/architecture/m12-contract-index.md',
  'docs/architecture/m12-capability-census.md',
  'docs/security/m12-threat-model-increment.md',
  'docs/evidence/m12-g01-baseline.md',
  'docs/evidence/m12-g01-verification.md'
];
for (const document of boundDocs) assert.match(await readText(document), new RegExp(binding.bindingId), `${document} missing binding id`);

const threatModel = await readText('docs/security/m12-threat-model-increment.md');
for (let index = 1; index <= 10; index += 1) {
  assert.match(threatModel, new RegExp(`M12-T${String(index).padStart(2, '0')}\\b`), `missing M12 threat ${index}`);
}

console.log(`[m12-g01] contracts=${contractIndex.contracts.length} capabilities=${census.capabilities.length} genres=${baseline.cases.length} binding=${binding.bindingId}`);
