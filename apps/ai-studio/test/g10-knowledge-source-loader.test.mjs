import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { KnowledgeRetrievalRuntime } from '@haiyue/ai-studio-agent-runtime';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { StudioKnowledgeSourceLoader } from '../dist/knowledge-source-loader.js';

test('production source loader indexes registry truth, refreshes project metadata and tombstones stale revisions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g10-source-loader-'));
  const log = await OperationLog.open({ rootDirectory: root, appVersion: 'g10-test', flushPolicy: 'always' });
  try {
    const documents = { current: gameDocument(3, []) };
    const workspace = {
      componentRegistry: { snapshot: () => ({ schemaVersion: 2, digest: digest('registry'), definitions: [component('haiyue.camera.3d', 'camera.3d', 'Camera 3D', 'Camera'), component('haiyue.physics.rigidbody.2d', 'physics.2d', 'Rigid Body 2D', 'Physics')] }) },
      gameSnapshot: () => documents.current,
    };
    const knowledge = new KnowledgeRetrievalRuntime(log);
    const loader = new StudioKnowledgeSourceLoader(knowledge, workspace);
    await loader.initialize();
    assert.equal(knowledge.snapshot().sourceCount, 7, 'two component schemas plus five reviewed engine guides');

    const project3 = project(3);
    await loader.refresh(project3);
    assert.equal(knowledge.snapshot().sourceCount, 8);
    const camera = await knowledge.search({ query: '俯视相机 camera top down', allowedPermissionScopes: ['knowledge:engine-local', projectPermission()], projectRevision: 3, limit: 5, tokenBudget: 1024 });
    assert.ok(camera.hits.some((hit) => hit.hit.source.includes('camera')));
    assert.ok(camera.hits.every((hit) => hit.hit.stale === false));

    documents.current = gameDocument(4, [{ id: 'asset:fixture', kind: 'texture', digest: digest('asset'), source: 'project' }]);
    await loader.refresh(project(4));
    assert.equal(knowledge.snapshot().sourceCount, 9);
    assert.ok(knowledge.snapshot().tombstoneCount >= 1);
    const current = await knowledge.search({ query: 'board root asset texture', allowedPermissionScopes: [projectPermission()], projectRevision: 4, limit: 8, tokenBudget: 1024 });
    assert.ok(current.hits.length > 0);
    assert.ok(current.hits.every((hit) => hit.hit.projectRevision === 4));

    await loader.refresh(null);
    assert.equal(knowledge.snapshot().sourceCount, 7, 'closing a project removes both active project sources');
    knowledge.dispose();
  } finally {
    await log.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function component(type, capability, label, category) {
  return { schemaVersion: 2, type, version: '1.0.0', capability, effect: 'runtime-owner', risk: 'medium', owner: 'g10-test', valueSchema: { type: 'object', additionalProperties: false, properties: {}, required: [] }, defaults: {}, editor: { label, category, inspector: `inspector.${type}` }, serializable: true, runtimeAdapter: `adapter.${type}`, validation: { mode: 'json-schema', unknownProperties: 'reject', maxSerializedBytes: 65536 }, serialization: { format: 'json', persistDisabled: true }, testOwner: 'g10-test' };
}
function gameDocument(revision, assets) {
  return { schemaVersion: 2, id: 'document:g10', revision, savedRevision: revision, scenes: [{ id: 'scene:g10', name: 'Board', rootEntityIds: ['entity:root'] }], entities: [{ id: 'entity:root', sceneId: 'scene:g10', name: 'Board Root', parentId: null, order: 0, componentIds: ['component:camera'] }], components: [{ id: 'component:camera', type: 'haiyue.camera.3d', version: '1.0.0', enabled: true, value: {} }], scripts: [], assets, settings: {}, migration: { fromVersion: null, migratedAt: null, sourceDigest: null } };
}
function project(revision) { return { projectId: 'project:g10', documentId: 'document:g10', revision, manifest: { schemaVersion: 1 } }; }
function projectPermission() { return `knowledge:project:${createHash('sha256').update('project:g10').digest('hex').slice(0, 24)}`; }
function digest(value) { return `sha256:${Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64)}`; }
