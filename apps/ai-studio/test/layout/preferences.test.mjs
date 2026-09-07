import assert from 'node:assert/strict';
import test from 'node:test';
import { loadWorkspacePreferences, parseWorkspacePreferences, saveWorkspacePreferences, WORKSPACE_PREFERENCE_KEY, workspaceSplitPreferenceKey } from '@haiyue/ai-studio-shell';

test('workspace migration preserves classic split settings and keeps new ratios separate', () => {
  const values = new Map([['haiyue.ai-studio.split.v2.workspace', '0.37']]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const preferences = loadWorkspacePreferences(storage);
  assert.equal(preferences.mode, 'intent'); assert.equal(values.size, 1);
  assert.equal(saveWorkspacePreferences(storage, { ...preferences, mode: 'classic', tab: 'resources', category: 'lights' }), true);
  assert.equal(loadWorkspacePreferences(storage).category, 'lights');
  assert.equal(values.get(workspaceSplitPreferenceKey('classic', 'workspace')), '0.37');
  assert.notEqual(workspaceSplitPreferenceKey('intent', 'workspace'), workspaceSplitPreferenceKey('classic', 'workspace'));
  assert.ok(values.has(WORKSPACE_PREFERENCE_KEY));
});

test('unknown versions, corrupt, oversized and unavailable storage retain a usable workspace', () => {
  const valid = loadWorkspacePreferences();
  for (const raw of ['broken-json', 'x'.repeat(2000), JSON.stringify({ ...valid, schemaVersion: 2 }), JSON.stringify({ ...valid, mode: 'missing' })]) {
    assert.deepEqual(loadWorkspacePreferences({ getItem: () => raw }), valid);
  }
  const denied = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
  assert.deepEqual(loadWorkspacePreferences(denied), valid); assert.equal(saveWorkspacePreferences(denied, valid), false);
  const getter = { ...valid }; Object.defineProperty(getter, 'tab', { get() { throw Error('must not run'); } });
  assert.equal(parseWorkspacePreferences(getter), null);
});
