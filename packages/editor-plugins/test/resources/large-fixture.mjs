import { createHash } from 'node:crypto';

/** Real Document commands; only test data, no alternative resource implementation. */
export async function seedResourceProject(f, entityCount, scriptCount = 0) {
  await f.workspace.newProject(null, `Resource fixture ${entityCount}`);
  const sceneId = f.workspace.gameSnapshot().scenes[0].id, operations = [];
  for (let i = 0; i < entityCount; i++) {
    const entityId = `entity:resource-${i}`;
    operations.push({ op: 'entity.add', entity: { id: entityId, sceneId, name: i === 0 ? '<img src=x onerror=alert(1)> 长名称 '.repeat(4).slice(0, 80) : `Resource entity ${i}`, parentId: null, order: i, componentIds: [] } });
    operations.push({ op: 'component.add', entityId, component: f.workspace.componentRegistry.create({ id: `component:resource-transform-${i}`, type: 'haiyue.transform.3d', version: '1.0.0' }) });
  }
  for (let i = 0; i < scriptCount; i++) {
    const source = `Math.sin(time + ${i});`;
    operations.push({ op: 'script.upsert', script: { id: `script:resource-${i}`, entityId: `entity:resource-${i % entityCount}`, name: `Resource script ${i}`, sourcePath: `scripts/resource-${i}.ts`, source, digest: `sha256:${createHash('sha256').update(source).digest('hex')}`, textRevision: 1, enabled: true, order: i, capabilities: ['read', 'input', 'debug'] } });
  }
  for (let offset = 0; offset < operations.length; offset += 200) await f.workspace.executeBatch({ id: `command:resource-seed-${++f.sequence}`, label: 'Resource test fixture', baseRevision: f.workspace.gameSnapshot().revision, operations: operations.slice(offset, offset + 200) });
}
