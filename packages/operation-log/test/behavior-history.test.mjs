import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OperationLog, ProjectAgentHistory, ProjectBehaviorHistory, sha256 } from '../dist/index.js';
import { analyzeBehavior, BehaviorReadService, validateBehaviorArtifact } from '@haiyue/ai-studio-script-preview';

const corpus = JSON.parse(await readFile(new URL('../../../config/contracts/fixtures/m14-behavior-inputs.json', import.meta.url), 'utf8'));
const binding = manifest => ({ projectId: manifest.binding.projectId, documentId: manifest.binding.documentId, documentRevision: manifest.binding.documentRevision, sourceBindingDigest: manifest.binding.digest, manifestDigest: manifest.digest });

test('large behavior artifacts reuse project journal replication and survive a fresh local journal', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-behavior-history-'));
  const source = await OperationLog.open({ rootDirectory: path.join(root, 'source'), appVersion: 'g05-test' });
  const input = structuredClone(corpus.mixed), script = input.document.scripts[0];
  script.source = 'Math.sin(time);\n'.repeat(450); script.digest = `sha256:${sha256(script.source)}`; script.sourcePath = 'scripts/' + 'a'.repeat(400) + '.ts';
  const manifest = analyzeBehavior(input), owner = binding(manifest);
  assert.ok(Buffer.byteLength(JSON.stringify(manifest)) > 512 * 1024);
  const directory = path.join(root, 'project', '.aistudio', 'agent');
  const project = await ProjectAgentHistory.open({ projectId: owner.projectId, directory, source, storage: 'project' });
  const store = new ProjectBehaviorHistory({ log: source, validate: validateBehaviorArtifact });
  t.after(async () => { await project.dispose(); await source.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const record = await store.put(owner, 'manifest', manifest); await project.flush();
  assert.equal((await store.read(owner.projectId, record.artifactId, 'manifest')).value.digest, manifest.digest);
  const events = await source.query({ projectId: owner.projectId, kinds: ['behavior/manifest'], limit: 10, traverseCorrelation: false });
  assert.ok(events.events[0].artifactRefs.length > 2);
  assert.ok((await store.list(owner.projectId)).records.some(item => item.artifactId === record.artifactId));
  await assert.rejects(store.read('project:foreign', record.artifactId, 'manifest'), /behavior.history-project/);
  assert.equal((await store.list('project:foreign')).records.length, 0);
  await project.dispose(); await source.close();
  const fresh = await OperationLog.open({ rootDirectory: path.join(root, 'fresh-local'), appVersion: 'g05-test' });
  const reopened = await ProjectAgentHistory.open({ projectId: owner.projectId, directory, source: fresh, storage: 'project' });
  try {
    const freshStore = new ProjectBehaviorHistory({ log: fresh, validate: validateBehaviorArtifact });
    const result = await freshStore.read(owner.projectId, record.artifactId, 'manifest');
    assert.deepEqual(result.value, manifest); assert.equal(result.reference.documentRevision, input.document.revision);
    assert.equal((await freshStore.list(owner.projectId)).records.length, 1);
  } finally { await reopened.dispose(); await fresh.close(); }
});

test('independent explanation records reject wrong binding, invalid data and cancelled publication', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-behavior-history-'));
  const log = await OperationLog.open({ rootDirectory: root, appVersion: 'g05-test' });
  const reader = new BehaviorReadService();
  t.after(async () => { await reader.dispose(); await log.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const manifest = await reader.analyze(corpus.mixed), owner = binding(manifest);
  const store = new ProjectBehaviorHistory({ log, validate: validateBehaviorArtifact });
  const request = { schemaVersion: 1, manifestDigest: manifest.digest, sourceBindingDigest: manifest.binding.digest, nodeIds: [manifest.nodes[0].id], language: 'zh-CN' };
  const explanation = reader.explain(request), record = await store.put(owner, 'explanation', explanation);
  assert.deepEqual((await store.read(owner.projectId, record.artifactId, 'explanation')).value, explanation);
  await assert.rejects(store.put({ ...owner, manifestDigest: 'sha256:' + '0'.repeat(64) }, 'explanation', explanation), /behavior.history-binding/);
  await assert.rejects(store.put(owner, 'manifest', { ...manifest, authorization: 'sk-fake-g05-history-test' }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(store.put(owner, 'manifest', manifest, controller.signal));
  assert.equal((await store.list(owner.projectId)).records.length, 1);
  assert.equal((await store.list(owner.projectId, { kind: 'manifest' })).records.length, 0);
});
