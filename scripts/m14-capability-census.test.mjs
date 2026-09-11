import assert from 'node:assert/strict';
import test from 'node:test';
import { readJson, recordValidator, validateAdmission, validateScope, checkReport, localPath, collectPackages, collectRegistries, inputBinding, digest, scopeFile, sourcesFile } from './m14-capability-census.mjs';
import { writeFile, unlink } from 'node:fs/promises';

const fixtures = await readJson('config/contracts/fixtures/m14-capability-contract-cases.json');
const validate = await recordValidator();
for (const fixture of fixtures.valid) test(`contract accepts ${fixture.name}`, () => assert.equal(validate(fixture.value), true, JSON.stringify(validate.errors)));
for (const fixture of fixtures.invalid) test(`contract rejects ${fixture.name}`, () => assert.equal(validate(fixture.value), false));

test('local regression cannot promote a capability to product or adapter acceptance', () => {
  const record = structuredClone(fixtures.valid[0].value);
  const report = { checks: [{ id: 'local', kind: 'local-check', capabilityIds: ['document.v2'], exitCode: 0 }] };
  record.stage = 'adapter-ready';
  record.acceptance.adapterCheckIds = ['local'];
  assert.throws(() => validateAdmission(record, report), /unproven adapter/);
  record.stage = 'product-integrated';
  record.acceptance.adapterCheckIds = [];
  record.acceptance.productCheckIds = ['local'];
  assert.throws(() => validateAdmission(record, report), /unproven product/);
});

test('wrong-source, failed, skipped, empty and stale verification reports are rejected', () => {
  const checks = [{ id: 'unit', files: ['unit.test.mjs'] }];
  const binding = { digest: digest('current') };
  const valid = { schemaVersion: 1, inputDigest: binding.digest, checks: [{ id: 'unit', kind: 'local-check', args: ['--test', '--test-concurrency=1', '--test-reporter=tap', 'unit.test.mjs'], exitCode: 0, passed: 1, failed: 0, skipped: 0, cancelled: 0, durationMs: 1, outputDigest: digest('ok') }] };
  checkReport(valid, binding, checks);
  for (const edit of [r => r.inputDigest = digest('old'), r => r.checks[0].args.pop(), r => r.checks[0].passed = 0, r => r.checks[0].failed = 1, r => r.checks[0].skipped = 1, r => r.checks[0].cancelled = 1, r => r.checks[0].exitCode = 1, r => r.checks[0].kind = 'product-acceptance', r => r.checks = []]) {
    const bad = structuredClone(valid); edit(bad);
    assert.throws(() => checkReport(bad, binding, checks));
  }
});

test('installed registry exports match source ids and all candidate export targets resolve', async () => {
  const [packages, registry, sources] = await Promise.all([collectPackages(), collectRegistries(), readJson(sourcesFile)]);
  assert.equal(new Set(packages.map(p => p.name)).size, packages.length);
  assert.equal(new Set(registry.components.map(c => c.type)).size, registry.components.length);
  assert.equal(new Set(registry.tools.map(t => t.id)).size, registry.tools.length);
  assert.ok(!registry.tools.some(t => t.id === 'studio.tool.invoke'), 'transport must not inflate business-tool count');
  const ids = (await readJson('config/contracts/schemas/m12-capability-id.schema.json')).enum;
  assert.deepEqual(sources.groups.flatMap(g => g.capabilityIds).sort(), [...ids].sort());
  assert.ok(registry.components.every(c => ids.includes(c.capabilityId)));
});

test('first-release rejects third blockers, new domains, absent adapters, missing budgets and fake pure-declarative coverage', async () => {
  const scope = await readJson(scopeFile);
  const registry = await collectRegistries();
  const census = { records: (await readJson('config/contracts/schemas/m12-capability-id.schema.json')).enum.map(capabilityId => ({ capabilityId })), registry };
  validateScope(scope, census);
  const component = registry.components.find(c => c.runtimeAdapter);
  const item = { capabilityId: component.capabilityId, adapterId: component.runtimeAdapter, source: component.source, gap: 'fixture gap', owner: 'g08', verificationEntry: 'fixture.test.mjs', deferredReason: 'fixture reason', maxInstances: 1, maxRuntimeMs: 100 };
  const one = structuredClone(scope); one.g08.selected = [item]; validateScope(one, census);
  for (const edit of [s => s.g08.selected = [item, item, item], s => s.g08.selected = [{ ...item, capabilityId: 'navigation.pathfinding' }], s => s.g08.selected = [{ ...item, adapterId: 'adapter.absent' }], s => s.g08.selected = [{ ...item, maxRuntimeMs: 0 }], s => s.corpus.find(c => c.kind === 'pure-declarative').maxScripts = 1, s => s.capabilityIds.push('game.save')]) {
    const bad = structuredClone(scope); edit(bad);
    assert.throws(() => validateScope(bad, census));
  }
});

test('evidence paths cannot escape the repository', () => {
  for (const p of ['../outside', 'D:/outside', '/outside', 'packages/../../outside', 'packages\\outside']) assert.throws(() => localPath(p));
});

test('replay support fixtures participate in the complete verification input binding', async () => {
  const filename = localPath(`evals/fixtures/m14-binding-${crypto.randomUUID()}.json`);
  const packages = await collectPackages(), before = await inputBinding(packages);
  try {
    await writeFile(filename, '{"replaySupport":1}', { flag: 'wx' });
    const added = await inputBinding(packages); assert.equal(added.fileCount, before.fileCount + 1); assert.notEqual(added.digest, before.digest);
    await writeFile(filename, '{"replaySupport":2}');
    assert.notEqual((await inputBinding(packages)).digest, added.digest);
  } finally { await unlink(filename); }
  assert.equal((await inputBinding(packages)).digest, before.digest);
});
