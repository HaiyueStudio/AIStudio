import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { PromptContextRuntime, KnowledgeRetrievalRuntime, ContextRouterRuntime, RequestContextRuntime } from '../dist/index.js';
const base = { conversationKey: 'conversation:w4', backendId: 'backend:w4', taskId: 'task:w4', request: 'camera framing', tools: [{ id: 'scene.query', description: 'NATIVE_DESCRIPTION '.repeat(30), inputSchema: { type: 'object' } }], project: null };
const envelope = value => JSON.parse(value.prompt.split('\n\n')[1]);
const commit = (runtime, project = null) => runtime.commit({ ...base, sessionId: 'session:w4', turnId: 'turn:w4', projectId: project?.projectId ?? null });
async function fixture(t) { const root = await mkdtemp(path.join(tmpdir(), 'w4-context-')); const log = await OperationLog.open({ rootDirectory: root, appVersion: 'test' }); t.after(async () => { await log.close(); await rm(root, { recursive: true, force: true }); }); return log; }

test('confirmed exact working set avoids repeat queries; scope, revision, owner, manifest and provider epoch fence reuse', async t => {
  const log = await fixture(t), runtime = new PromptContextRuntime(log);
  let queries = 0, diffs = 0;
  const exact = { query: ({ revision, request }) => { queries++; return { revision, entities: [{ id: request.scope?.entityIds[0] ?? 'entity:one', name: 'Target' }], truncated: false, nextCursor: null }; }, diff: ({ fromRevision, toRevision }) => { diffs++; return { fromRevision, toRevision, changedIds: ['entity:one'], truncated: false, nextCursor: null }; } };
  let project = { projectId: 'project:w4', documentId: 'document:w4', revision: 7, manifest: { revision: 7 }, focusEntityIds: ['entity:one'], exact };
  const first = await runtime.prepare({ ...base, project });
  assert.match(first.prompt, /entity:one/); assert.doesNotMatch(first.prompt, /NATIVE_DESCRIPTION/);
  await runtime.prepare({ ...base, project }); assert.equal(queries, 2, 'unconfirmed preparation is never a reusable baseline');
  await commit(runtime, project);
  const same = await runtime.prepare({ ...base, project }); assert.equal(queries, 2);
  assert.equal(envelope(same).find(x => x.kind === 'project-manifest').transmission, 'reference-only');
  project = { ...project, focusEntityIds: ['entity:two'] };
  const scoped = await runtime.prepare({ ...base, project }); assert.equal(queries, 3); assert.match(scoped.prompt, /entity:two/); await commit(runtime, project);
  project = { ...project, revision: 8, manifest: { revision: 8 } };
  const delta = await runtime.prepare({ ...base, project }); assert.equal(diffs, 1); assert.match(delta.prompt, /changedIds/); await commit(runtime, project);
  const unchanged = await runtime.prepare({ ...base, project }); assert.equal(queries, 3); assert.equal(diffs, 1); assert.equal(envelope(unchanged).find(x => x.kind === 'document-delta').transmission, 'reference-only');
  project = { ...project, exact: { ...exact } }; await runtime.prepare({ ...base, project }); assert.equal(queries, 4); await commit(runtime, project);
  project = { ...project, manifest: { revision: 8, saved: true } }; await runtime.prepare({ ...base, project }); assert.equal(queries, 5); await commit(runtime, project);
  runtime.invalidateSentArtifacts('session:w4'); await runtime.prepare({ ...base, project }); assert.equal(queries, 6);
  const restored = new PromptContextRuntime(log); await restored.prepare({ ...base, project }); assert.equal(queries, 7);
  const disabled = new PromptContextRuntime(log, undefined, undefined, { compactContext: false }); const full = await disabled.prepare({ ...base, project }); await commit(disabled, project); await disabled.prepare({ ...base, project }); assert.equal(queries, 9); assert.match(full.prompt, /NATIVE_DESCRIPTION/);
});

test('truncated working sets and changed project identity are never treated as complete confirmed context', async t => {
  const log = await fixture(t), runtime = new PromptContextRuntime(log); let reads = 0;
  const exact = { query: ({ revision }) => ({ revision, truncated: ++reads < 3, nextCursor: reads < 3 ? 'page:next' : null }), diff() { throw Error('unexpected'); } };
  let project = { projectId: 'project:w4', documentId: 'document:w4', revision: 1, manifest: {}, exact };
  for (let i = 0; i < 3; i++) { await runtime.prepare({ ...base, project }); await commit(runtime, project); }
  assert.equal(reads, 3); project = { ...project, projectId: 'project:other', documentId: 'document:other' }; await runtime.prepare({ ...base, project }); assert.equal(reads, 4);
});

test('knowledge deduplicates ranking changes only after confirmation; CAS digest supports W3 hydration and restart', async t => {
  const log = await fixture(t), retrieval = new KnowledgeRetrievalRuntime(log);
  t.after(() => retrieval.dispose());
  const source = { sourceId: 'source:w4', source: 'engine://camera', sourceKind: 'engine-doc', text: 'Camera framing uses orthographic projection. '.repeat(12), packageVersion: '1.0.0', projectRevision: null, permissionScope: 'knowledge:engine-local', authorized: true };
  await retrieval.upsert(source);
  const runtime = new PromptContextRuntime(log, undefined, retrieval);
  const first = await runtime.prepare(base); const knowledge = envelope(first).filter(x => x.kind === 'knowledge-hit'); assert.ok(knowledge.length);
  for (const item of knowledge) assert.equal(item.digest, 'sha256:' + (await log.readArtifact(item.artifactId)).digest);
  const unconfirmed = await runtime.prepare(base); assert.ok(envelope(unconfirmed).filter(x => x.kind === 'knowledge-hit').every(x => x.transmission === 'full'));
  await commit(runtime);
  const again = await runtime.prepare({ ...base, request: 'orthographic camera framing' });
  for (const item of knowledge) assert.equal(envelope(again).find(x => x.artifactId === item.artifactId)?.transmission, 'reference-only');
  assert.ok(again.prompt.length < first.prompt.length);
  const request = new RequestContextRuntime(log, runtime), port = request.port(); t.after(() => request.dispose());
  const messages = [{ id: 'u1', role: 'user', text: first.prompt, toolCallIds: [], resultFor: null }, { id: 'a1', role: 'assistant', text: 'old context '.repeat(16000), toolCallIds: [], resultFor: null }, { id: 'u2', role: 'user', text: again.prompt, toolCallIds: [], resultFor: null }];
  const prepared = await port.prepare({ schemaVersion: 1, sessionId: 'session:w4', turnId: 'turn:w4', model: 'fixture', epoch: 0, maxInputTokens: 70000, reservedOutputTokens: 1024, requestBytes: JSON.stringify(messages).length, previousUsage: null, messages, tools: [] });
  assert.ok(prepared.replacement); assert.match(prepared.replacement.summary, /Camera framing/); assert.doesNotMatch(prepared.replacement.summary, /reference-only/);
  runtime.invalidateSentArtifacts('session:w4'); assert.ok(envelope(await runtime.prepare(base)).filter(x => x.kind === 'knowledge-hit').every(x => x.transmission === 'full'));
  await commit(runtime);
  await retrieval.upsert({ ...source, packageVersion: '2.0.0' });
  const changed = await runtime.prepare(base); assert.ok(envelope(changed).some(x => x.kind === 'knowledge-hit' && x.transmission === 'full' && x.projection.citation.packageVersion === '2.0.0'));
  const restored = new PromptContextRuntime(log, undefined, retrieval); await restored.initialize(); await restored.assertReadable(first.contextArtifactIds);
  assert.ok(envelope(await restored.prepare(base)).filter(x => x.kind === 'knowledge-hit').every(x => x.transmission === 'full'));
});

test('router deduplicates equivalent knowledge ranges but validates all permissions and keeps distinct ranges', async t => {
  const log = await fixture(t), retrieval = new KnowledgeRetrievalRuntime(log); t.after(() => retrieval.dispose());
  await retrieval.upsert({ sourceId: 'source:w4', source: 'engine://camera', sourceKind: 'engine-doc', text: 'Camera framing uses orthographic projection.', packageVersion: '1.0.0', projectRevision: null, permissionScope: 'knowledge:engine-local', authorized: true });
  const found = await retrieval.search({ query: 'camera', allowedPermissionScopes: ['knowledge:engine-local'] });
  const one = await log.readArtifact(found.artifactIds[0]);
  const two = await log.putArtifact({ ...one.value, retrievedAt: '2026-09-16T00:00:00Z', hit: { ...one.value.hit, score: .2 } });
  const router = new ContextRouterRuntime(log, { scene: { query: () => ({ revision: 1 }), diff: () => ({}) } }); t.after(() => router.dispose());
  const input = { sessionId: 'session:w4', turnId: 'turn:w4', projectRevision: 1, previousProjectRevision: null, knowledgePolicy: { allowedPermissionScopes: ['knowledge:engine-local'], packageVersions: ['1.0.0'] }, knowledgeHitArtifactIds: [one.id, two.id] };
  assert.equal((await router.route(input)).inputs.filter(x => x.kind === 'knowledge-hit').length, 1);
  const different = await log.putArtifact({ ...one.value, hit: { ...one.value.hit, chunk: { start: 1, end: 8 } }, citation: { ...one.value.citation, start: 1, end: 8 }, excerpt: 'amera f' });
  assert.equal((await router.route({ ...input, knowledgeHitArtifactIds: [one.id, different.id] })).inputs.filter(x => x.kind === 'knowledge-hit').length, 2);
  const denied = await log.putArtifact({ ...one.value, hit: { ...one.value.hit, permissionScope: 'knowledge:private' } });
  await assert.rejects(router.route({ ...input, knowledgeHitArtifactIds: [one.id, denied.id] }), e => e.code === 'context.knowledge-hit-permission');
});

test('a failed durable context commit never confirms a working-set or knowledge transmission', async t => {
  const log = await fixture(t), runtime = new PromptContextRuntime(log);
  await runtime.prepare(base);
  const append = log.append.bind(log); let fail = true;
  t.mock.method(log, 'append', async (...args) => { if (fail && args[0].kind === 'agent/conversation-indexed') { fail = false; throw Error('fixture durable commit failure'); } return append(...args); });
  await assert.rejects(commit(runtime), /durable commit failure/);
  const retry = await runtime.prepare(base); assert.equal(retry.reusedSessionId, null); assert.doesNotMatch(retry.prompt, /reference-only/);
  await commit(runtime); assert.equal((await runtime.prepare(base)).reusedSessionId, 'session:w4');
});
