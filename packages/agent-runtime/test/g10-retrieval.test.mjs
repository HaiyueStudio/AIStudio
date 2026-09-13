import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KnowledgeRetrievalError, KnowledgeRetrievalRuntime, PromptContextRuntime } from '../dist/index.js';
import { OperationLog } from '@haiyue/ai-studio-operation-log';

const ENGINE = 'knowledge:engine-local';
const PROJECT = 'knowledge:project:test';

test('local hybrid retrieval returns current cited knowledge and keeps exact context before semantic hits', async () => {
  const fixture = await openFixture('hybrid');
  try {
    const retrieval = new KnowledgeRetrievalRuntime(fixture.log);
    await retrieval.upsert(source('knowledge-source:camera', 'engine://docs/camera.md', 'engine-doc', 'Camera framing supports orbit, follow, perspective and orthographic projection. Use an orthographic view for flat boards.', { permissionScope: ENGINE, packageVersion: '0.1.0', capabilities: ['haiyue.camera.3d'] }));
    await retrieval.upsert(source('knowledge-source:physics', 'engine://docs/physics.md', 'engine-doc', 'Physics bodies expose collision events, raycasts and overlap queries.', { permissionScope: ENGINE, packageVersion: '0.1.0', capabilities: ['haiyue.physics.3d'] }));
    const result = await retrieval.search({ query: 'camera 修改镜头视角并使用正交投影', allowedPermissionScopes: [ENGINE], packageVersions: ['0.1.0'], capabilityIds: ['haiyue.camera.3d'], tokenBudget: 512 });
    assert.equal(result.hits[0].hit.source, 'engine://docs/camera.md');
    assert.equal(result.hits[0].hit.retrieval, 'hybrid');
    assert.match(result.hits[0].hit.reason, /keyword=.*embedding=.*provenance=authorized; verified=false/u);
    assert.equal(result.hits[0].citation.packageVersion, '0.1.0');
    assert.ok(result.hits[0].citation.startLine >= 1);
    await retrieval.assertReadable(result.artifactIds);

    const context = new PromptContextRuntime(fixture.log, undefined, retrieval);
    const prepared = await context.prepare({ conversationKey: 'conversation:g10', backendId: 'backend:g10', taskId: 'task:g10', request: '修改镜头视角并使用正交投影', tools: [], project: { projectId: 'project:g10', documentId: 'document:g10', revision: 2, manifest: { name: 'Exact project' } } });
    assert.ok(prepared.contextArtifactIds.includes(result.artifactIds[0]) || prepared.prompt.includes('knowledge-hit'));
    assert.ok(prepared.prompt.indexOf('project-manifest') < prepared.prompt.indexOf('knowledge-hit'), 'exact project facts must precede semantic knowledge');
    await context.assertReadable(prepared.contextArtifactIds);
    retrieval.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('permission, version, revision, conflict and secret boundaries fail closed', async () => {
  const fixture = await openFixture('boundaries');
  try {
    const retrieval = new KnowledgeRetrievalRuntime(fixture.log);
    await retrieval.upsert(source('knowledge-source:private', 'project://secret/design.md', 'project-doc', 'Private camera decision says use perspective.', { permissionScope: 'knowledge:private', projectRevision: 9, claims: ['camera.projection'] }));
    await retrieval.upsert(source('knowledge-source:old', 'project://docs/old.md', 'project-doc', 'Camera projection must be perspective.', { permissionScope: PROJECT, projectRevision: 8, claims: ['camera.projection'] }));
    await retrieval.upsert(source('knowledge-source:new-a', 'project://docs/new-a.md', 'project-doc', 'Camera projection must be orthographic.', { permissionScope: PROJECT, projectRevision: 9, claims: ['camera.projection'] }));
    await retrieval.upsert(source('knowledge-source:new-b', 'project://docs/new-b.md', 'project-doc', 'Camera projection must be perspective.', { permissionScope: PROJECT, projectRevision: 9, claims: ['camera.projection'] }));
    const result = await retrieval.search({ query: 'camera projection', allowedPermissionScopes: [PROJECT], projectRevision: 9, tokenBudget: 512 });
    assert.equal(result.hits.length, 0);
    assert.ok(result.diagnostics.some((entry) => entry.code === 'permission-filtered'));
    assert.ok(result.diagnostics.some((entry) => entry.code === 'stale-filtered'));
    assert.ok(result.diagnostics.some((entry) => entry.code === 'conflicting-sources'));
    await assert.rejects(retrieval.upsert(source('knowledge-source:secret', 'project://docs/secret.md', 'project-doc', 'Authorization: Bearer abcdefghijklmnop', { permissionScope: PROJECT, projectRevision: 9 })), (error) => error instanceof KnowledgeRetrievalError && error.code === 'knowledge.secret-rejected');
    retrieval.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

test('content hash updates create tombstones, graph traversal recalls related decisions, and replay rebuilds the same index digest', async () => {
  const fixture = await openFixture('replay');
  try {
    let retrieval = new KnowledgeRetrievalRuntime(fixture.log);
    await retrieval.upsert(source('knowledge-source:root', 'session://one/root', 'session-decision', '{"decision":"Use fixed-step state."}', { permissionScope: PROJECT, related: ['knowledge-source:child'] }));
    await retrieval.upsert(source('knowledge-source:child', 'session://one/child', 'session-decision', '{"decision":"Retain screenshot evidence."}', { permissionScope: PROJECT }));
    const graph = await retrieval.search({ query: 'unrelated-vocabulary', mode: 'exact-only', allowedPermissionScopes: [PROJECT], graphSeedSourceIds: ['knowledge-source:root'], tokenBudget: 512 });
    assert.ok(graph.hits.some((entry) => entry.hit.source === 'session://one/child' && entry.hit.retrieval === 'graph'));
    await retrieval.upsert(source('knowledge-source:child', 'session://one/child', 'session-decision', '{"decision":"Retain state and screenshot evidence."}', { permissionScope: PROJECT }));
    const before = retrieval.snapshot(); assert.equal(before.tombstoneCount, 1);
    retrieval.dispose(); retrieval = new KnowledgeRetrievalRuntime(fixture.log); await retrieval.initialize();
    assert.equal(retrieval.snapshot().indexDigest, before.indexDigest);
    assert.equal(retrieval.snapshot().sourceCount, 2);
    retrieval.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});

function source(sourceId, uri, sourceKind, text, options = {}) { return { sourceId, source: uri, sourceKind, text, mediaType: sourceKind === 'session-decision' ? 'application/json' : 'text/markdown', packageVersion: options.packageVersion ?? null, projectRevision: options.projectRevision ?? null, permissionScope: options.permissionScope ?? ENGINE, capabilityIds: options.capabilities ?? [], claimKeys: options.claims ?? [], relatedSourceIds: options.related ?? [], authorized: true, verified: sourceKind === 'verified-example' ? true : undefined }; }
async function openFixture(name) { const root = await mkdtemp(path.join(tmpdir(), `haiyue-g10-retrieval-${name}-`)); const log = await OperationLog.open({ rootDirectory: root, appVersion: 'g10-test', flushPolicy: 'always' }); return { root, log, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) }; }

test('long Chinese requests and approved-plan repair continuations keep full model instructions while bounding retrieval', async () => {
  const fixture = await openFixture('bounded-query');
  try {
    const retrieval = new KnowledgeRetrievalRuntime(fixture.log);
    await retrieval.upsert(source('knowledge-source:rounded', 'engine://rounded-box', 'engine-doc', '圆角立方体 rounded-box radius segments geometry.'));
    await retrieval.upsert(source('knowledge-source:private-rounded', 'private://rounded-box', 'engine-doc', '圆角立方体 rounded-box radius segments geometry.', { permissionScope: 'knowledge:private' }));
    const search = retrieval.search.bind(retrieval); const inputs = [];
    retrieval.search = async input => { inputs.push(input); return search(input); };
    const context = new PromptContextRuntime(fixture.log, undefined, retrieval);
    const base = { conversationKey: 'conversation:bounded', backendId: 'backend:bounded', taskId: 'task:bounded', tools: [], project: null };
    const short = '圆角立方体 rounded-box';
    const requests = [short, 'a'.repeat(2048), 'a'.repeat(2049), '圆角立方体😀'.repeat(500) + '尾部要求 radius segments', 'Execute the already approved plan.\n' + '圆角方块 PBR '.repeat(110) + '\nFailed acceptance: ' + JSON.stringify(Array.from({ length: 6 }, (_, index) => ({ acceptanceId: `acceptance:repair:${index}`, evidenceIds: [`artifact:sha256:${'a'.repeat(64)}`], diagnostic: '验证截图与圆角 geometry' })))];
    for (const request of requests) {
      const prepared = await context.prepare({ ...base, request });
      assert.equal(prepared.prompt.split('[current-request-tail]\n\n')[1], request, 'retrieval budget must not truncate model instructions');
      const input = inputs.at(-1);
      assert.ok(Buffer.byteLength(input.query) <= 2048);
      assert.ok(input.query.trim()); assert.equal(input.query.isWellFormed(), true, 'never split emoji/surrogate pairs');
      assert.ok(!input.allowedPermissionScopes.includes('knowledge:private'));
      if (Buffer.byteLength(request) <= 2048) assert.equal(input.query, request);
      else { assert.ok(input.query.startsWith(request.slice(0, 32))); assert.ok(input.query.endsWith(request.slice(-32))); }
      assert.doesNotMatch(prepared.prompt, /private:\/\/rounded-box/);
      await context.commit({ ...base, projectId: null, sessionId: 'session:bounded', turnId: 'turn:bounded', goals: [short], decisions: [], toolFacts: [], acceptance: [], blockers: [] });
    }
    await context.prepare({ ...base, request: ' '.repeat(3000) + short + ' '.repeat(3000) });
    assert.equal(inputs.at(-1).query, short);
    const count = inputs.length;
    await context.prepare({ ...base, request: ' \n\t ' });
    assert.equal(inputs.length, count, 'empty retrieval query is skipped');
    const events = await fixture.log.query({ limit: 200 });
    assert.equal(events.events.filter(e => e.kind === 'knowledge/query-bounded').length, 4);
    await assert.rejects(search({ query: 'a'.repeat(2049), allowedPermissionScopes: [ENGINE] }), error => error.code === 'knowledge.query-invalid', 'direct API remains bounded');
    retrieval.dispose(); await fixture.log.close();
  } finally { await fixture.cleanup(); }
});


test('hybrid retrieval covers distinct relevant sources before repeating chunks of a long guide', async () => {
  const fixture = await openFixture('source-diversity');
  const retrieval = new KnowledgeRetrievalRuntime(fixture.log);
  try {
    await retrieval.upsert(source('knowledge-source:long-input', 'engine://input', 'engine-doc', 'Pointer input drag camera physics verification. '.repeat(180)));
    await retrieval.upsert(source('knowledge-source:camera-short', 'engine://camera', 'engine-doc', 'Camera orbit follows the pointer drag. Verify the camera transform.'));
    await retrieval.upsert(source('knowledge-source:physics-short', 'engine://physics', 'engine-doc', 'Physics verification uses fixed-step input and authoritative state.'));
    const result = await retrieval.search({ query:'pointer input drag camera physics verification', mode:'hybrid', allowedPermissionScopes:[ENGINE], limit:3, tokenBudget:2048 });
    assert.equal(new Set(result.hits.map(hit=>hit.hit.source)).size, 3);
    assert.ok(result.estimatedTokens <= 2048);
    await retrieval.assertReadable(result.artifactIds);
  } finally { retrieval.dispose(); await fixture.log.close(); await fixture.cleanup(); }
});
