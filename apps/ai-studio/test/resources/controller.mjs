import assert from 'node:assert/strict';
import path from 'node:path';
import { unlink, writeFile } from 'node:fs/promises';
import { resourceFixture } from '../../../../packages/editor-plugins/test/resources/fixture.mjs';
import { seedResourceProject } from '../../../../packages/editor-plugins/test/resources/large-fixture.mjs';

/** G06 isolated module harness. G09 must replace this with lifecycle-owned app wiring. */
export async function createResourceTestController() {
  const f = await resourceFixture(), texture = await f.importTexture();
  let page, target = { entityId: f.entityId, label: 'Controller' }, query = { limit: 25 }, error = [], last = null;
  const intents = [];
  const display = () => ({ projectKey: page.binding ? `${page.binding.projectId}/${page.binding.documentId}` : null, viewToken: page.binding?.digest ?? null, state: 'ready', items: page.items.map(item => ({
    entry: item.entry, health: item.health, diagnostics: item.diagnostics, locations: item.locations, target: item.target, assignments: item.assignments,
    configuration: item.configuration === null ? null : JSON.stringify(item.configuration, null, 2),
    metadata: item.asset ? [{ label: '项目路径', value: item.asset.projectPath }, { label: '许可', value: item.asset.license }, { label: '来源说明', value: item.asset.provenance }, { label: '文件 / 解码预算', value: `${item.asset.byteLength} / ${item.asset.decodedBytes} 字节` }, { label: '格式', value: item.asset.mimeType }] : [],
  })), total: page.total, nextCursor: page.nextCursor, categories: page.categories, diagnostics: [...page.diagnostics, ...error], target });
  const refresh = async (next = query) => { query = next; page = await f.catalog.query(query); return display(); };
  await refresh();
  return {
    f, display, intents, get last() { return last; },
    async dispatch(input) {
      assert.ok(input && typeof input === 'object' && !Array.isArray(input)); assert.ok(JSON.stringify(input).length < 512 * 1024);
      intents.push(input); error = [];
      if (input.type === 'cancel') { f.catalog.cancel(); return display(); }
      if (input.type === 'query') return refresh(input.query);
      if (input.type === 'refresh') { page = await f.catalog.refresh(input.query); query = input.query; return display(); }
      if (input.type === 'select-target') { target = { entityId: f.entityId, label: 'Controller' }; return display(); }
      assert.equal(input.viewToken, page.binding.digest, 'UI request refers to displayed source');
      const binding = page.binding;
      try {
        if (input.type === 'action') {
          last = await f.catalog.execute({ binding, entry: input.entry, action: input.action, ...(input.targetEntityId ? { targetEntityId: input.targetEntityId } : {}), ...(input.usage ? { usage: input.usage } : {}) });
          if (last.kind === 'workflow' && last.result.status === 'completed' && last.result.value.entity) target = { entityId: last.result.value.entity.id, label: last.result.value.entity.name };
        } else if (input.type === 'locate-use') last = f.catalog.locateUsage({ binding, entry: input.entry, ref: input.ref, field: input.field });
        else if (input.type === 'import') {
          // The real app must open its controlled import form. The harness supplies
          // a concrete invalid project file to exercise the real rejection path.
          await writeFile(path.join(f.directory, 'project/assets/invalid.png'), Buffer.from('invalid PNG'));
          last = await f.catalog.importAsset({ binding, projectPath: 'assets/invalid.png', kind: input.kind, mimeType: 'image/png', license: 'internal-test', provenance: 'fixture:g06', decodedBytes: 64, width: 2, height: 1 });
        } else throw Error('unsupported test intent');
      } catch { error = ['资源操作失败，请检查项目文件、格式和当前版本后重试。']; }
      const { cursor: _cursor, ...firstPage } = query;
      return refresh(firstPage);
    },
    async missing() { await unlink(texture.target); return refresh({ kind: 'asset', limit: 25 }); },
    async seed(count, scripts = 0) { await seedResourceProject(f, count, scripts); target = null; error = []; return refresh({ kind: 'instance', limit: 25 }); },
    async reopen() { await f.workspace.save(); await f.workspace.openProject(path.join(f.directory, 'project')); return refresh({ kind: 'asset', limit: 25 }); },
    close: f.close,
  };
}
