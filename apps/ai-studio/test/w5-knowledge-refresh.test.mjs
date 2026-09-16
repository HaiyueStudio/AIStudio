import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioKnowledgeSourceLoader } from '../dist/knowledge-source-loader.js';

test('same revision and inflight refreshes reuse one successful index; changes, failure and close invalidate it', async () => {
  let revision = 1, failure = false;
  const calls = [];
  const knowledge = {
    async initialize() {},
    async upsert(value) { calls.push(['upsert', value.sourceId, value.projectRevision]); if (failure && value.projectRevision) throw new Error('index unavailable'); },
    async tombstone(id) { calls.push(['tombstone', id]); },
  };
  const workspace = { componentRegistry: { snapshot: () => ({ definitions: [] }) }, gameSnapshot: () => ({ id: 'document:w5', revision, scenes: [], entities: [], components: [], scripts: [], assets: [], settings: {} }) };
  const loader = new StudioKnowledgeSourceLoader(knowledge, workspace);
  let exact = { query() {}, diff() {} };
  const project = () => ({ projectId: 'project:w5', documentId: 'document:w5', revision, manifest: {}, exact });
  await loader.initialize(); calls.length = 0;
  await Promise.all(Array.from({ length: 20 }, () => loader.refresh(project())));
  assert.equal(calls.length, 2, 'one project upsert and one empty-asset tombstone');
  await loader.refresh(project()); assert.equal(calls.length, 2);
  exact = { query() {}, diff() {} };
  await loader.refresh(project()); assert.equal(calls.length, 4, 'reopened project owner cannot reuse an identical revision');
  revision = 2; failure = true;
  await assert.rejects(loader.refresh(project()), /index unavailable/);
  failure = false;
  await loader.refresh(project()); assert.equal(calls.at(-2)[2], 2, 'failed revision is retried');
  const count = calls.length;
  const stale = project(); revision = 3;
  await assert.rejects(loader.refresh(stale), /revision mismatch/);
  assert.equal(calls.length, count, 'cache hit cannot bypass live revision validation');
  await loader.refresh(project());
  await Promise.all([loader.refresh(null), loader.refresh(null)]);
  assert.equal(calls.filter(call => call[0] === 'tombstone' && call[1] === 'knowledge-source:active-project').length, 1);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(loader.refresh(project(), controller.signal), /cancelled/);
  await loader.refresh(project()); assert.equal(calls.at(-2)[2], 3);
});
