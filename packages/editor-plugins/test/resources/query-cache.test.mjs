import assert from 'node:assert/strict';
import test from 'node:test';
import { resourceFixture, execute } from './fixture.mjs';
import { ProjectResourceCatalog } from '../../dist/assets/resources/index.js';

test('resource category queries reuse exact-version rows and references; refresh and project edits invalidate', async t => {
  const f = await resourceFixture(); t.after(f.close);
  let reads = 0, validations = 0;
  const catalog = new ProjectResourceCatalog({ ...f.ports,
    dependencies: async signal => { reads++; return f.ports.dependencies(signal); },
    validateEntry: value => { validations++; return f.ports.validateEntry(value); },
  }, { reuseQueries: true }); t.after(() => catalog.dispose());
  const start = performance.now();
  const first = await catalog.query({ category: 'Geometry', limit: 25 });
  const coldMs = performance.now() - start, initial = validations;
  const warm = performance.now();
  for (const category of ['Texture', 'Material', 'Script', 'Model', 'Geometry']) await catalog.query({ category, limit: 25 });
  assert.equal(reads, 1); assert.equal(validations, initial);
  t.diagnostic(JSON.stringify({ coldMs, fiveWarmQueriesMs: performance.now() - warm, referenceQueries: reads }));
  await catalog.refresh(); assert.equal(reads, 2); assert.ok(validations > initial);
  await execute(f, 'entity.create', { baseRevision: f.workspace.snapshot().document.revision, kind: 'cube', name: 'New geometry' });
  const changed = await catalog.query({ category: 'Geometry' });
  assert.equal(reads, 3); assert.notEqual(changed.binding.digest, first.binding.digest);
  await f.workspace.newProject(null, 'Cache isolation');
  const empty = await catalog.query({ projectOnly: true });
  assert.equal(reads, 4); assert.equal(empty.total, 0);
});

test('failed reference reads retry instead of poisoning the cache', async t => {
  const f = await resourceFixture(); t.after(f.close); let reads = 0;
  const catalog = new ProjectResourceCatalog({ ...f.ports, dependencies: signal => {
    if (++reads === 1) throw Error('temporary failure'); return f.ports.dependencies(signal);
  } }, { reuseQueries: true }); t.after(() => catalog.dispose());
  await catalog.query(); await catalog.query(); await catalog.query(); assert.equal(reads, 2);
});
