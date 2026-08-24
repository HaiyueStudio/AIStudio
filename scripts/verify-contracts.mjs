import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = path.join(root, 'config', 'contracts', 'schemas');
const fixtureDir = path.join(root, 'config', 'contracts', 'fixtures');
const ajv = new Ajv({ allErrors: true, strict: true });

for (const name of (await readdir(schemaDir)).filter((entry) => entry.endsWith('.schema.json')).sort()) {
  ajv.addSchema(JSON.parse(await readFile(path.join(schemaDir, name), 'utf8')));
}

const forbiddenSecretKeys = /^(api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|password|client[-_]?secret)$/i;
function findForbiddenSecretKey(value, currentPath = '$') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenSecretKey(value[index], `${currentPath}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenSecretKeys.test(key)) return `${currentPath}.${key}`;
    const found = findForbiddenSecretKey(child, `${currentPath}.${key}`);
    if (found) return found;
  }
  return null;
}

const fixtureFiles = (await readdir(fixtureDir)).filter((entry) => entry.endsWith('contract-cases.json')).sort();
const caseSets = await Promise.all(fixtureFiles.map(async (name) => JSON.parse(await readFile(path.join(fixtureDir, name), 'utf8'))));
const validFixtures = caseSets.flatMap((cases) => cases.valid ?? []);
const invalidFixtures = caseSets.flatMap((cases) => cases.invalid ?? []);

function materializeFixture(fixture) {
  if (fixture.fixtureFactory === undefined) return fixture.value;
  if (fixture.fixtureFactory === 'oversized-task-request') {
    return { ...fixture.value, request: 'x'.repeat(32_769) };
  }
  throw new Error(`unknown fixture factory ${fixture.fixtureFactory}`);
}

for (const fixture of validFixtures) {
  const validate = ajv.getSchema(fixture.schemaId);
  assert.ok(validate, `missing schema ${fixture.schemaId}`);
  const value = materializeFixture(fixture);
  assert.equal(validate(value), true, `${fixture.schemaId}: ${ajv.errorsText(validate.errors)}`);
  assert.equal(findForbiddenSecretKey(value), null, `${fixture.schemaId} contains a forbidden secret key`);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${fixture.schemaId} does not round-trip`);
}

for (const fixture of invalidFixtures) {
  const validate = ajv.getSchema(fixture.schemaId);
  assert.ok(validate, `missing schema ${fixture.schemaId}`);
  const value = materializeFixture(fixture);
  const schemaValid = validate(value);
  if (fixture.invalidReason === 'forbidden-secret-key') {
    assert.ok(findForbiddenSecretKey(value), `${fixture.name} did not expose a forbidden key`);
  } else {
    assert.equal(schemaValid, false, `${fixture.name} unexpectedly passed schema validation`);
  }
}

console.log(`[contracts] schemas=${ajv.schemas ? Object.keys(ajv.schemas).length : 'loaded'} fixtureFiles=${fixtureFiles.length} valid=${validFixtures.length} invalid=${invalidFixtures.length}`);
