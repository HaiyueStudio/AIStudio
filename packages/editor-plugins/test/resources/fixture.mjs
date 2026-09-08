import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createBehaviorSourceBinding, parseBehaviorContract } from '@haiyue/ai-studio-script-preview';
import { behaviorFixture, call, execute } from '../../../game-authoring-tools/test/behavior-fixture.mjs';
import { ProjectResourceCatalog } from '../../dist/assets/resources/index.js';

export { execute };
export async function resourceFixture(options = {}) {
  const f = await behaviorFixture({ noSource: true, ...options });
  f.requests = []; f.dependencyHook = null; f.requestHook = null; f.readHook = null; f.bindingVersion = '1.0.0'; f.approvalDecision = 'allow-once';
  f.binding = () => { const input = f.input(); return createBehaviorSourceBinding({ ...input, registry: { ...input.registry, version: f.bindingVersion } }); };
  const owner = binding => {
    const current = f.workspace.snapshot().document;
    assert.equal(current?.projectId, binding.projectId, 'request keeps project identity');
    assert.equal(current?.documentId, binding.documentId, 'request keeps document identity');
    assert.equal(current?.revision, binding.documentRevision, 'request keeps exact revision');
  };
  f.ports = {
    workspace: { snapshot: () => f.workspace.snapshot(), gameSnapshot: () => f.workspace.gameSnapshot(), componentRegistry: f.workspace.componentRegistry,
      readControlledAsset: async (...args) => { if (f.readHook) await f.readHook(...args); return f.workspace.readControlledAsset(...args); } },
    binding: f.binding,
    validateEntry: value => parseBehaviorContract('resource-catalog-entry', value),
    validateLocation: value => parseBehaviorContract('editor-location', value),
    dependencies: async signal => {
      const result = (await execute(f, 'asset.dependencies', {})).value;
      return f.dependencyHook ? f.dependencyHook(result, signal) : result;
    },
    request: async (toolId, args, binding, signal) => {
      if (f.requestHook) await f.requestHook(toolId, args, binding, signal);
      owner(binding); f.requests.push({ toolId, args, binding });
      const prepared = await f.runtime.prepare(call(`call:resource-${++f.sequence}`, toolId, args), signal);
      if (prepared.approvalId) await f.runtime.decide(prepared.approvalId, f.approvalDecision);
      owner(binding);
      return f.runtime.execute(prepared.id, signal);
    },
  };
  f.catalog = new ProjectResourceCatalog(f.ports);
  const close = f.close; f.close = async () => { f.catalog.dispose(); await close(); };
  f.page = query => f.catalog.query({ limit: 100, ...query });
  f.action = (page, item, action, args = {}, signal) => f.catalog.execute({ binding: page.binding, entry: item.entry, action, ...args }, signal);
  f.importTexture = async (relative = 'assets/sky.png', width = 2, height = 1) => {
    const bytes = png(width, height);
    const target = path.join(f.directory, 'project', relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
    const page = await f.page();
    const result = await f.catalog.importAsset({ binding: page.binding, projectPath: relative, kind: 'texture', mimeType: 'image/png', license: 'internal-test', provenance: 'fixture:g06', decodedBytes: Math.max(bytes.length, width * height * 4), width, height });
    assert.equal(result.kind, 'workflow'); assert.equal(result.result.status, 'completed');
    return { bytes, target, assetId: result.result.value.asset.id, result };
  };
  return f;
}
export function png(width, height) {
  const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const type = Buffer.from(name), result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); type.copy(result, 4); data.copy(result, 8); result.writeUInt32BE(crc(Buffer.concat([type, data])), result.length - 4); return result; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set([40 + x % 200, 140, 220, 255], y * (width * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
