import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { EngineDocumentationStore, ToolCatalogRuntime, GAME_AUTHORING_TOOL_DEFINITIONS } from '../dist/index.js';
import { ComponentRegistry } from '@haiyue/ai-studio-editor-plugins';
import { ScriptValidationWorker } from '@haiyue/ai-studio-script-preview';
import { CartesianTransform3D, Entity } from '@haiyue/engine';
import { behaviorFixture as openBehaviorToolsFixture, execute } from './behavior-fixture.mjs';

const raw = JSON.parse(await readFile(new URL('../dist/engine-docs/bundle.json', import.meta.url), 'utf8'));
const docs = new EngineDocumentationStore(raw, raw.binding);
const hash = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
function search(query, surface) { return docs.search({ query, ...(surface ? { surface } : {}) }); }
function read(entry, extra = {}) { return docs.read({ id: entry.id, bundleDigest: docs.bundle.digest, ...extra }); }

test('Chinese intent and exact symbols discover callable APIs without loading native documentation', () => {
  for (const [query, match] of [
    ['棋盘 点击 命中', /interactions|命中点|input-actions|pointer|input/i],
    ['圆角 立方体', /geometry|rounded|圆角|entity.create/i],
    ['相机 轨道', /camera|Camera|相机/],
    ['预制体 组合', /prefab|组合/],
    ['纹理', /asset|纹理/i],
    ['旋转自身', /旋转|rotation|transform/i],
  ]) {
    const result = search(query);
    assert.ok(result.matches.some(entry => match.test(entry.title)), query);
    assert.ok(result.matches.every(entry => entry.surface !== 'engine-native'));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
  }
  assert.equal(search('api.input.interactions').matches[0].title, 'api.input.interactions');
  const native = search('createRoundedBox3D', 'engine-native').matches[0];
  assert.equal(native.title, 'createRoundedBox3D');
  assert.match(read(native).blocks.join('\n'), /createRoundedBox3D/);
  assert.ok(docs.bundle.entries.some(entry => entry.title === 'OrbitControl' && entry.surface === 'engine-native'));
  assert.ok(docs.bundle.entries.some(entry => entry.title === 'Entity.getComponent' && entry.surface === 'studio-script'));
  assert.equal(search('zzzz892349qzxv').matches.length, 0);
});

test('runtime contracts preserve coordinate semantics, prerequisites and complete type links', () => {
  const pointer = read(search('api.input.pointerEvents').matches[0]);
  assert.match(pointer.blocks.join('\n'), /canvas|canvas-normalized|world/i);
  assert.ok(pointer.related.some(entry => /HaiyueStudioPointerEvent|input|Keyboard/.test(entry.title)));
  const interactions = read(search('api.input.interactions').matches[0]);
  assert.match(interactions.blocks.join('\n'), /point: readonly number\[\]/);
  assert.ok(interactions.related.some(entry => /pointer|命中点/.test(entry.title)));
  assert.ok(docs.bundle.entries.filter(entry => entry.surface === 'engine-native').length > 1000, 'resolve all declaration barrel exports, not just directly declared symbols');
  assert.ok(docs.bundle.entries.every(entry => !entry.title.includes('.#') && !entry.blocks.some(block => /\bprivate\s+\w+/.test(block) && entry.source.startsWith('declaration:'))));
});

test('version and digest validation reject stale, tampered and unknown references', () => {
  assert.throws(() => new EngineDocumentationStore(raw, { ...raw.binding, engineIntegrity: 'different' }), { code: 'engine.docs.version-mismatch' });
  assert.throws(() => new EngineDocumentationStore({ ...raw, digest: 'sha256:bad' }), { code: 'engine.docs.digest-mismatch' });
  const altered = { ...raw, entries: [{ ...raw.entries[0], blocks: ['wrong'] }, ...raw.entries.slice(1)] };
  assert.throws(() => new EngineDocumentationStore(altered), { code: 'engine.docs.entry-invalid' });
  assert.throws(() => docs.read({ id: raw.entries[0].id, bundleDigest: 'stale' }), { code: 'engine.docs.stale' });
  assert.throws(() => docs.read({ id: '../../secrets', bundleDigest: docs.bundle.digest }), { code: 'engine.docs.not-found' });
  assert.throws(() => search('😀'.repeat(600)), { code: 'engine.docs.invalid' });
});

test('bounded pagination preserves complete blocks and rejects cross-document cursors', () => {
  const entry = { id: 'doc:' + '1'.repeat(24), title: 'Atomic example', surface: 'studio-script', source: 'test:atomic', summary: 'A complete example', keywords: '', capabilityIds: [], relatedIds: [], blocks: ['```ts\n' + '// 注释\n'.repeat(100) + 'const first = 1;\n```', '```ts\nconst second = 2;\n```'] };
  entry.digest = hash(entry.blocks);
  const bundle = { schemaVersion: 1, binding: raw.binding, entries: [entry] }; bundle.digest = hash({ binding: bundle.binding, entries: bundle.entries });
  const store = new EngineDocumentationStore(bundle);
  assert.throws(() => store.read({ id: entry.id, bundleDigest: bundle.digest, maxBytes: 1024 }), { code: 'engine.docs.budget-too-small' });
  const full = store.read({ id: entry.id, bundleDigest: bundle.digest });
  assert.deepEqual(full.blocks, entry.blocks);
  const pageBudget = Buffer.byteLength(JSON.stringify(full)) - 1;
  // The cursor adds overhead; use a longer final block so it exceeds that overhead.
  entry.blocks[1] = '```ts\n' + '// second\n'.repeat(100) + '```'; entry.digest = hash(entry.blocks); bundle.digest = hash({ binding: bundle.binding, entries: bundle.entries });
  const paged = new EngineDocumentationStore(bundle);
  const first = paged.read({ id: entry.id, bundleDigest: bundle.digest, maxBytes: pageBudget + 350 });
  assert.equal(first.blocks.length, 1); assert.ok(first.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= pageBudget + 350);
  const second = paged.read({ id: entry.id, bundleDigest: bundle.digest, cursor: first.nextCursor });
  assert.deepEqual([...first.blocks, ...second.blocks], entry.blocks); assert.equal(second.nextCursor, null);
  const forged = Buffer.from(JSON.stringify({ id: 'doc:' + '2'.repeat(24), digest: bundle.digest, offset: 1 })).toString('base64url');
  assert.throws(() => paged.read({ id: entry.id, bundleDigest: bundle.digest, cursor: forged }), { code: 'engine.docs.cursor-invalid' });
});

test('documentation tools use the normal preparation, result-artifact and History boundaries', async () => {
  const fixture = await openBehaviorToolsFixture({ runtimeOptions: { documentation: docs } });
  try {
    const revision = fixture.workspace.snapshot().document.revision;
    const result = await execute(fixture, 'engine.docs.search', { query: 'api.input.interactions', surface: 'studio-script' });
    assert.equal(result.status, 'completed');
    const response = await execute(fixture, 'engine.docs.read', { id: result.value.matches[0].id, bundleDigest: result.value.bundleDigest });
    assert.equal(response.status, 'completed'); assert.match(response.value.blocks.join('\n'), /interactions/);
    assert.equal(fixture.workspace.snapshot().document.revision, revision);
    const records = await fixture.operationLog.query({ kinds: ['engine/documentation-read'], limit: 10, traverseCorrelation: false });
    assert.equal(records.events.length, 2);
    const persisted = await fixture.operationLog.readArtifact(records.events.find(event => event.payload.documentationId === response.value.id).artifactRefs[0]);
    assert.deepEqual(persisted.value, response.value, 'full model-visible documentation is reconstructable after an app update');
    const catalog = new ToolCatalogRuntime(GAME_AUTHORING_TOOL_DEFINITIONS, () => new ComponentRegistry().snapshot().definitions);
    for (const request of ['', '制作棋盘', '旋转自身']) assert.ok(['engine.docs.search', 'engine.docs.read'].every(id => catalog.selectDefinitions(request).selectedIds.includes(id)));
  } finally { await fixture.close(); }
});

test('shipped Studio examples compile against real declarations and rotate the actual Engine transform', async () => {
  const validator = new ScriptValidationWorker();
  try {
    for (const name of ['grid-placement', 'rotate-self']) {
      const text = await readFile(new URL(`../../../docs/examples/${name}.ts`, import.meta.url), 'utf8');
      const result = await validator.validate({ scriptId: `script:${name}`, textRevision: 1, sourcePath: `scripts/${name}.ts`, text, capabilities: ['read', 'input', 'scene'] });
      assert.deepEqual(result.diagnostics.filter(item => item.severity === 'error'), [], name);
      if (name === 'rotate-self') {
        const entity = new Entity(); const transform = new CartesianTransform3D(); entity.addComponent(transform);
        const update = new Function('entity', 'component', 'world', 'time', 'delta', 'api', result.emittedText);
        for (let tick = 0; tick < 60; tick++) update(entity, { data: {} }, null, tick * 1000 / 60, 1000 / 60, {});
        assert.ok(Math.abs(transform.rotation[1] - Math.PI / 2) < 0.00001);
        entity.destroy();
      }
    }
  } finally { await validator.dispose(); }
});
