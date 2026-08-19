import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = path.join(root, 'config', 'contracts', 'schemas');
const casesPath = path.join(root, 'config', 'contracts', 'fixtures', 'contract-cases.json');
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

const cases = JSON.parse(await readFile(casesPath, 'utf8'));
for (const fixture of cases.valid) {
  const validate = ajv.getSchema(fixture.schemaId);
  assert.ok(validate, `missing schema ${fixture.schemaId}`);
  assert.equal(validate(fixture.value), true, `${fixture.schemaId}: ${ajv.errorsText(validate.errors)}`);
  assert.equal(findForbiddenSecretKey(fixture.value), null, `${fixture.schemaId} contains a forbidden secret key`);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.value)), fixture.value, `${fixture.schemaId} does not round-trip`);
}

for (const fixture of cases.invalid) {
  const validate = ajv.getSchema(fixture.schemaId);
  assert.ok(validate, `missing schema ${fixture.schemaId}`);
  const schemaValid = validate(fixture.value);
  if (fixture.invalidReason === 'forbidden-secret-key') {
    assert.ok(findForbiddenSecretKey(fixture.value), `${fixture.name} did not expose a forbidden key`);
  } else {
    assert.equal(schemaValid, false, `${fixture.name} unexpectedly passed schema validation`);
  }
}

console.log(`[contracts] schemas=${ajv.schemas ? Object.keys(ajv.schemas).length : 'loaded'} valid=${cases.valid.length} invalid=${cases.invalid.length}`);
