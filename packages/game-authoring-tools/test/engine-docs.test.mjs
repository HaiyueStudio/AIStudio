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
  const grid = search('贴图网格').matches.find(entry => entry.title.includes('Textured grid alignment'));
  assert.ok(grid, 'texture alignment is discoverable through the on-demand documentation search');
  assert.match(read(grid).blocks.join('\n'), /N intersections have N-1 intervals/);
  assert.equal(search('api.input.interactions').matches[0].title, 'api.input.interactions');
  const orbit = search('api.scene.orbitControls').matches[0];
  assert.equal(orbit.title, 'api.scene.orbitControls');
  assert.match(read(orbit).blocks.join('\n'), /background|onUpdate/);
  assert.ok(search('OrbitControls 拖拽相机').matches.some(entry => /orbitControls|运行时 OrbitControls/.test(entry.title)));
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
  assert.throws(() => docs.read({ id: raw.entries[0].id, bundleDigest: 'sha256:' + '0'.repeat(64) }), { code: 'engine.docs.stale' });
  assert.throws(() => docs.read({ id: '../../secrets', bundleDigest: docs.bundle.digest }), { code: 'engine.docs.reference-invalid' });
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
      if (name === 'grid-placement') {
        const update = new Function('entity', 'component', 'world', 'time', 'delta', 'api', result.emittedText);
        for (const [column, row] of [[0,0], [14,0], [0,14], [14,14], [7,7]]) {
          // Positions follow the texture recipe, independently of the script's snapping math.
          const x = ((64 + column * 64) / 1024 - 0.5) * 16;
          const z = ((64 + row * 64) / 1024 - 0.5) * 16;
          let placed, observed;
          update(null, { data: {} }, null, 0, 16, {
            input: { interactions: () => [{ type: 'click', entityId: 'entity:board', point: [x + 0.1, 0, z - 0.1] }] },
            scene: { instances: () => ({ setCount() {}, set(_index, value) { placed = value; } }), observe(_name, value) { observed = value; } },
          });
          assert.ok(observed.column === column && observed.row === row);
          assert.deepEqual([placed.position.x, placed.position.z], [x, z]);
        }
      }
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


test('short references preserve version binding and malformed ids are distinct from stale versions', () => {
  const match = search('api.input.interactions').matches[0];
  assert.match(match.ref, /^dref:[a-f0-9]{16}$/);
  assert.equal(docs.read({ ref: match.ref }).id, match.id);
  assert.throws(() => docs.read({ ref: match.ref, id: match.id }), { code: 'engine.docs.reference-invalid' });
  assert.throws(() => docs.read({ id: match.id, bundleDigest: 'sha256:a6af2??' }), { code: 'engine.docs.reference-invalid' });
  assert.throws(() => docs.read({ id: 'doc:970f?', bundleDigest: docs.bundle.digest }), { code: 'engine.docs.reference-invalid' });
  assert.throws(() => docs.read({ id: 'doc:' + '0'.repeat(24), bundleDigest: docs.bundle.digest }), { code: 'engine.docs.not-found' });
  const changed = { ...raw, binding: { ...raw.binding, guidesDigest: 'changed' } };
  changed.digest = hash({ binding: changed.binding, entries: changed.entries });
  assert.throws(() => new EngineDocumentationStore(changed).read({ ref: match.ref }), { code: 'engine.docs.reference-unavailable' });
});

test('larger documentation searches page within byte budgets without losing or repeating matches', () => {
  const input = { query: 'transform', surface: 'all', limit: 20, maxBytes: 4096 };
  let page = docs.search(input), ids = [], pages = 0;
  const total = page.candidateCount;
  assert.ok(total > 20);
  do {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= input.maxBytes);
    assert.ok(page.matches.length > 0);
    ids.push(...page.matches.map(m => m.id)); pages++;
    if (!page.nextCursor) break;
    assert.throws(() => docs.search({ ...input, query: 'different', cursor: page.nextCursor }), { code: 'engine.docs.cursor-invalid' });
    page = docs.search({ ...input, cursor: page.nextCursor });
  } while (pages < 1000);
  assert.equal(new Set(ids).size, ids.length); assert.equal(ids.length, total);
});

test('tool boundary accepts short doc references and gives actionable malformed scene scope diagnostics', async () => {
  const fixture = await openBehaviorToolsFixture({ runtimeOptions: { documentation: docs } });
  try {
    const result = await execute(fixture, 'engine.docs.search', { query: 'transform', limit: 20 });
    assert.equal((await execute(fixture, 'engine.docs.read', { ref: result.value.matches[0].ref })).status, 'completed');
    await assert.rejects(execute(fixture, 'scene.query', { scope: { sceneId: 'scene:??' } }), e => e.code === 'scene.scope-invalid' && /Omit scope.sceneId/.test(e.message));
    assert.equal((await execute(fixture, 'scene.query', { projection: ['hierarchy'] })).status, 'completed');
  } finally { await fixture.close(); }
});

test('search-result selection copies the identity from stored JSON without accepting model-supplied ids', () => {
  const searchResult = docs.search({ query: 'api.input.interactions' });
  const expectedId = searchResult.matches[0].id;
  const selected = { resultRef: searchResult.resultRef, index: searchResult.matches[0].index };
  // Even a caller mutating its returned JSON cannot rewrite the server-owned row.
  searchResult.matches[0].id = 'doc:' + '0'.repeat(24);
  const result = docs.read({ fromSearch: selected });
  assert.equal(result.id, expectedId);
  assert.deepEqual(result.resolvedFrom, selected);
  assert.match(result.blocks.join('\n'), /interactions/);
  assert.throws(() => docs.read({ fromSearch: selected, id: expectedId }), { code: 'engine.docs.selection-invalid' });
  assert.throws(() => docs.read({ fromSearch: { ...selected, index: 999 } }), { code: 'engine.docs.selection-invalid' });
  assert.throws(() => docs.read({ fromSearch: { ...selected, index: -1 } }), { code: 'engine.docs.selection-invalid' });
  assert.throws(() => docs.read({ fromSearch: { ...selected, id: expectedId } }), { code: 'engine.docs.selection-invalid' });
  const otherInstance = new EngineDocumentationStore(raw);
  otherInstance.search({ query: 'camera' });
  assert.throws(() => otherInstance.read({ fromSearch: selected }), { code: 'engine.docs.search-result-unavailable' });
});

test('expired search-result handles fail explicitly instead of selecting a newly reused row', () => {
  const store = new EngineDocumentationStore(raw);
  const first = store.search({ query: 'pointer' });
  for (let i = 0; i < 128; i++) store.search({ query: 'camera' });
  assert.throws(() => store.read({ fromSearch: { resultRef: first.resultRef, index: 0 } }), { code: 'engine.docs.search-result-unavailable' });
});

test('real tool calls read the chosen search row without any document id in their arguments', async () => {
  const fixture = await openBehaviorToolsFixture({ runtimeOptions: { documentation: docs } });
  try {
    const searchResult = (await execute(fixture, 'engine.docs.search', { query: 'api.input.interactions', limit: 20 })).value;
    const args = { fromSearch: { resultRef: searchResult.resultRef, index: 0 } };
    const result = await execute(fixture, 'engine.docs.read', args);
    assert.equal(result.value.id, searchResult.matches[0].id);
    assert.equal(result.status, 'completed');
    assert.deepEqual(Object.keys(args), ['fromSearch']);
  } finally { await fixture.close(); }
});

test('model-facing read schema selects stored results and does not invite identifier transcription', () => {
  const schema = GAME_AUTHORING_TOOL_DEFINITIONS.find(tool => tool.id === 'engine.docs.read').inputSchema;
  assert.ok(schema.properties.fromSearch);
  assert.equal(schema.properties.id, undefined);
  assert.equal(schema.properties.bundleDigest, undefined);
  assert.ok(schema.properties.ref, 'related-document handles remain available');
});

test('search continuation restores saved arguments and cursor without model transcription', () => {
  const input = { query: 'transform', surface: 'all', limit: 20, maxBytes: 4096 };
  let page = docs.search(input);
  const ids = [], total = page.candidateCount;
  for (let count = 0; count < 1000; count++) {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= input.maxBytes);
    assert.equal(page.requestedCount, 20);
    assert.equal(page.surface, 'all');
    ids.push(...page.matches.map(match => match.id));
    if (!page.nextCall) break;
    assert.equal(page.nextCall.toolId, 'engine.docs.search');
    assert.deepEqual(page.nextCall.arguments, { continueFrom: page.resultRef });
    const next = page.nextCall.arguments;
    const expected = docs.search({ ...input, cursor: page.nextCursor });
    // Changing the returned response or input cannot change the server-owned continuation.
    page.nextCursor = 'forged'; page.requestedCount = 999;
    page = docs.search(next);
    assert.deepEqual(page.matches, expected.matches);
  }
  assert.equal(ids.length, total); assert.equal(new Set(ids).size, total);
  assert.equal(page.nextCall, null);
  assert.throws(() => docs.search({ continueFrom: page.resultRef }), { code: 'engine.docs.page-unavailable' });
});

test('continuation rejects overrides, forged and expired references instead of guessing a query', () => {
  const store = new EngineDocumentationStore(raw);
  const page = store.search({ query: 'pointer', surface: 'all', limit: 20 });
  const args = page.nextCall.arguments;
  for (const override of [{ query: 'camera' }, { surface: 'all' }, { limit: 100 }, { requested: 12 }, { cursor: page.nextCursor }]) {
    assert.throws(() => store.search({ ...args, ...override }), { code: 'engine.docs.selection-invalid' });
  }
  assert.throws(() => store.search({ continueFrom: 'invented' }), { code: 'engine.docs.selection-invalid' });
  assert.throws(() => new EngineDocumentationStore(raw).search(args), { code: 'engine.docs.search-result-unavailable' });
  for (let i = 0; i < 128; i++) store.search({ query: 'camera' });
  assert.throws(() => store.search(args), { code: 'engine.docs.search-result-unavailable' });
});

test('real tool pagination uses returned JSON and malformed requests explain both supported modes', async () => {
  const fixture = await openBehaviorToolsFixture({ runtimeOptions: { documentation: docs } });
  try {
    const first = (await execute(fixture, 'engine.docs.search', { query: 'transform', limit: 20 })).value;
    const next = await execute(fixture, first.nextCall.toolId, first.nextCall.arguments);
    assert.equal(next.status, 'completed'); assert.equal(next.value.requestedCount, 20);
    assert.ok(!next.value.matches.some(m => first.matches.some(previous => previous.id === m.id)));
    await assert.rejects(execute(fixture, 'engine.docs.search', { requested: 12, cursor: 'invented' }), e => e.code === 'tool.arguments-invalid' && /limit, not requested/.test(e.message) && /nextCall.arguments/.test(e.message));
    await assert.rejects(execute(fixture, 'engine.docs.search', { ...first.nextCall.arguments, limit: 100 }), { code: 'tool.arguments-invalid' });
    const schema = GAME_AUTHORING_TOOL_DEFINITIONS.find(t => t.id === 'engine.docs.search').inputSchema;
    assert.ok(schema.properties.continueFrom); assert.equal(schema.properties.cursor, undefined);
    assert.equal(schema.properties.requested, undefined); assert.equal(schema.oneOf.length, 2);
  } finally { await fixture.close(); }
});


test('data-first verification guide is searchable and distinguishes runtime facts from image review',()=>{
 const result=search('数据优先验收');
 const entry=result.matches.find(item=>item.title.includes('数据优先验收'));
 assert.ok(entry);
 const content=JSON.stringify(read(entry,{maxBytes:12000}));
 assert.match(content,/includeGameplay/);
 assert.match(content,/missingEntityIds/);
 assert.match(content,/视觉/);
});

test('interaction diagnostics are independently retrievable within the default document budget',()=>{
 const result=search('交互故障诊断');const entry=result.matches.find(item=>item.title.includes('交互故障诊断'));assert.ok(entry);
 const content=JSON.stringify(read(entry));assert.match(content,/changedTransformEntityIds/);assert.match(content,/interaction.diagnostic-required/);assert.match(content,/selfInteractions/);
});
