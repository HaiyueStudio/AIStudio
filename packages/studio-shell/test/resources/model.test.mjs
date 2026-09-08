import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceActions, resourceUsageLabel, resourceCategoryLabel } from '../../dist/panels/resources/index.js';
import { resourceFixture } from '../../../editor-plugins/test/resources/fixture.mjs';

test('resource presentation preserves authoritative kind, unsupported presets and proven zero versus unknown', async t => {
  const f = await resourceFixture(); t.after(f.close); await f.importTexture();
  const page = await f.page();
  for (const item of page.items) {
    assert.deepEqual(resourceActions(item), item.entry.intents);
    if (item.entry.kind === 'preset') assert.deepEqual(resourceActions(item), []);
    if (item.entry.kind === 'instance') assert.doesNotMatch(resourceUsageLabel(item.entry), /0 处使用/);
    if (item.entry.kind === 'asset') assert.match(resourceUsageLabel(item.entry), /已确认 0/);
  }
  const asset = page.items.find(item => item.entry.kind === 'asset');
  assert.deepEqual(resourceActions({ ...asset, entry: { ...asset.entry, schemaVersion: 2 } }), []);
  assert.deepEqual(resourceActions({ ...asset, entry: { ...asset.entry, ref: { kind: 'template' } } }), []);
  const template = page.items.find(item => item.entry.kind === 'template' && item.entry.status === 'available');
  assert.deepEqual(resourceActions({ ...template, entry: { ...template.entry, intents: ['asset.assign', 'template.create'] } }), ['template.create']);
  assert.match(resourceUsageLabel(template.entry), /未知/);
  assert.equal(resourceCategoryLabel('Lighting'), '灯光'); assert.equal(resourceCategoryLabel('New registered category'), 'New registered category');
});
