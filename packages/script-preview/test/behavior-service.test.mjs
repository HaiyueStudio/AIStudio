import assert from 'node:assert/strict';
import test from 'node:test';
import { BehaviorReadService, analyzeBehavior } from '../dist/behavior/index.js';
import { clone, controlScript, declarativeInput, makeInput, query } from './behavior-fixtures.mjs';

test('worker analysis, bounded queries, independent explanations and source locations use the same contracts', async t => {
  const service = new BehaviorReadService(); t.after(() => service.dispose());
  const input = declarativeInput(controlScript), before = JSON.stringify(input);
  const manifest = await service.analyze(input);
  assert.deepEqual(manifest, analyzeBehavior(input)); assert.equal(JSON.stringify(input), before);
  const first = service.query(query(manifest, { offset: 0, limit: 5 }));
  assert.equal(first.nodes.length, 5); assert.equal(first.nextOffset, 5);
  assert.ok(Object.isFrozen(first.nodes));
  assert.throws(() => service.query(query(manifest, { offset: 0, limit: 101 })), /budget/);
  assert.throws(() => service.query({...query(manifest, {offset: 0, limit: 1}), schemaVersion: 2}), /version/);
  const node = manifest.nodes.find(node => node.source.kind === 'declarative-component' && node.source.field.includes('/actions/'));
  const location = service.locate(query(manifest, { nodeId: node.id }));
  assert.equal(service.resolveLocation(location).status, 'current');
  const en = service.explain(query(manifest, { nodeIds: [node.id], language: 'en' }));
  const zh = service.explain(query(manifest, { nodeIds: [node.id], language: 'zh-CN' }));
  assert.notEqual(en.digest, zh.digest); assert.equal(en.manifestDigest, zh.manifestDigest);
  assert.equal(service.query(query(manifest, {offset:0,limit:1})).manifestDigest, manifest.digest);
  const tampered = clone(location); tampered.target.source.field = '/rules/99';
  assert.equal(service.resolveLocation(tampered).status, 'historical');
  const field = {...location, target: {kind:'component', entityId:node.source.entityId, componentId:node.source.componentId, componentVersion:node.source.componentVersion, field:node.source.field}};
  assert.equal(service.resolveLocation(field).status, 'current');
  field.target.field = '/not-present'; assert.equal(service.resolveLocation(field).status, 'historical');
  const copy = clone(input); copy.projectId = 'project:copy'; await service.analyze(copy);
  assert.equal(service.resolveLocation(location).status, 'historical');
  assert.throws(() => service.query(query(manifest, {offset:0,limit:1})), /stale/);
});

test('original script locations cannot reuse stale or forged ranges', async t => {
  const service = new BehaviorReadService(); t.after(() => service.dispose());
  const manifest = await service.analyze(makeInput({ script: '// 😀\r\nfirst();' }));
  const call = manifest.nodes.find(node => node.kind === 'call');
  const location = service.locate(query(manifest, {nodeId:call.id}));
  const script = {...location, target:{kind:'script',source:call.source}};
  assert.equal(service.resolveLocation(script).status, 'current');
  const forged = clone(script); forged.target.source.range.startLine++;
  assert.equal(service.resolveLocation(forged).status, 'historical');
  await service.analyze(makeInput({script:'second();'}));
  assert.equal(service.resolveLocation(script).status, 'historical');
});

test('abort, replacement, invalidate and repeated disposal terminate workers and prevent late publication', async () => {
  const service = new BehaviorReadService(), controller = new AbortController();
  const cancelled = service.analyze(makeInput({script:'first();'.repeat(5000)}),controller.signal);
  const rejected = assert.rejects(cancelled, /cancelled/); controller.abort(); await rejected;
  const previous = service.analyze(makeInput({script:controlScript}));
  const previousRejected = assert.rejects(previous, /cancelled/);
  const latestInput = makeInput({script:'latest();',projectId:'project:latest'});
  const latest = await service.analyze(latestInput); await previousRejected;
  assert.equal(latest.binding.projectId, 'project:latest');
  service.invalidate(); assert.throws(() => service.query(query(latest,{offset:0,limit:1})), /stale/);
  const pending = service.analyze(makeInput({script:controlScript}));
  const disposed = assert.rejects(pending, /cancelled/); await service.dispose(); await disposed; await service.dispose();
  await assert.rejects(service.analyze(makeInput()), /disposed/);
});
