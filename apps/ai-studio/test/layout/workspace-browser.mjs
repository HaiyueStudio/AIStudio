import { IntentWorkspace, WORKSPACE_PREFERENCE_KEY } from '@haiyue/ai-studio-shell';
import { defineSplitComponents } from '@haiyue/ui/split';
import { defineTabsComponents } from '@haiyue/ui/tabs';
import { defineDialogComponents } from '@haiyue/ui/dialog';
import { defineSelectComponents } from '@haiyue/ui/select';
import fixtures from './fixtures.generated.json';

const get = id => document.getElementById(id);
const assert = (value, label) => { if (!value) throw Error(label); };
const settle = async () => { for (let frame = 0; frame < 4; frame++) await new Promise(resolve => requestAnimationFrame(resolve)); };
const change = (id, value) => { get(id).value = value; get(id).dispatchEvent(new Event('change', { bubbles: true })); };
const key = (id, value) => get(id).dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
const intents = [], samples = [];
const { manifest, catalog } = fixtures;
const base = { documentId: manifest.binding.documentId, documentRevision: manifest.binding.documentRevision, selectedEntityId: 'entity:main', entities: [{ id: 'entity:main', name: '灯光控制器', sources: ['script', 'declarative-component'] }], sourceBinding: manifest.binding, behavior: manifest, catalog };
defineSplitComponents(); defineTabsComponents(); defineDialogComponents(); defineSelectComponents();
get('right-tabs').options = [{ value: 'agent', label: 'Agent' }];
get('resource-tabs').options = ['geometry', 'lights', 'materials', 'textures', 'models', 'scripts'].map(value => ({ value, label: value }));
document.documentElement.dataset.hyTheme = 'dark';
get('chat-content').textContent = '布局测试：此区域仍由原 Agent 面板负责。';
get('geometry-resources').innerHTML = '<button id="fixture-create" type="button">创建立方体</button>';
get('light-resources').textContent = '方向光 · 点光源 · 环境光';
const original = Object.fromEntries(['left-sidebar-split', 'viewport-panel', 'assets-panel', 'script-panel', 'fixture-create'].map(id => [id, get(id)]));
let manualCalls = 0; get('fixture-create').addEventListener('click', () => manualCalls++);
let workspace;
try {
  const reload = localStorage.getItem('layout-test-phase') === 'reload';
  if (!reload) localStorage.setItem('haiyue.ai-studio.split.v2.workspace', '0.31');
  workspace = new IntentWorkspace(document, { dispatch: intent => intents.push(intent) }, localStorage);
  window.layoutTest = { workspace, get, assert, settle, base, intents, samples, update: snapshot => workspace.update(snapshot) };
  if (reload) {
    assert(document.body.dataset.workspaceMode === 'classic', 'classic mode persisted through reload');
    assert(get('workspace-category').value === 'lights', 'category persisted through reload');
    assert(localStorage.getItem('haiyue.ai-studio.split.v2.workspace') === '0.31', 'legacy ratio untouched');
    workspace.setMode('intent'); workspace.setTab('logic'); workspace.update({ ...base, sourceBinding: null, behavior: null, catalog: null });
    document.body.dataset.layoutStatus = 'reloaded';
  } else {
    assert(document.body.dataset.workspaceMode === 'intent', 'default workspace');
    assert(get('workspace-existing-resources').contains(original['assets-panel']), 'resources moved left');
    assert(get('workspace-manual-inspect').contains(original['left-sidebar-split']), 'manual panel preserved');
    assert(get('content-split').contains(original['viewport-panel']), 'viewport fills main content');
    workspace.update({ ...base, entities: [], selectedEntityId: null, sourceBinding: null, behavior: null, catalog: null });
    assert(get('workspace-entity').disabled && !get('workspace-events').children.length, 'empty state');
    for (const count of [1, 100, 1000]) {
      const entities = Array.from({ length: count }, (_, i) => ({ id: `entity:${i}`, name: i === 0 ? '<img src=x onerror=alert(1)>' : `对象 ${i}`, sources: [] }));
      const start = performance.now(); workspace.update({ ...base, entities, selectedEntityId: 'entity:0', sourceBinding: null, behavior: null, catalog: null });
      const durationMs = performance.now() - start; samples.push({ count, durationMs });
      assert(get('workspace-entity').options.length === count + 1 && durationMs < 5000, `bounded entity list ${count}`);
      assert(!get('intent-workspace').querySelector('img') && get('workspace-entity').options[1].textContent.startsWith('<img'), 'literal model text');
      change('workspace-entity', `entity:${count - 1}`); assert(intents.at(-1).entityId === `entity:${count - 1}`, 'typed authoritative selection intent');
    }
    workspace.update(base);
    get('workspace-search').value = '不存在'; get('workspace-search').dispatchEvent(new Event('input'));
    assert(get('workspace-entity').disabled, 'search no matches');
    get('workspace-search').value = ''; get('workspace-search').dispatchEvent(new Event('input'));
    assert(get('workspace-events').children.length === manifest.triggers.length, 'real analysis event entries');
    for (const kind of ['script', 'declarative-component', 'runtime-adapter']) {
      const button = get('workspace-sources').querySelector(`[data-source-kind="${kind}"]`);
      assert(button, `actual source ${kind}`); button.click();
      assert(intents.at(-1).location.target.source.kind === kind, `typed location ${kind}`);
      assert(get('workspace-source-reference').textContent.length > 20, `source details ${kind}`);
    }
    const obsolete = get('workspace-events').querySelector('button');
    workspace.update({ ...base, documentRevision: base.documentRevision + 1 });
    assert(!get('workspace-events').children.length && get('workspace-source-details').hidden && !get('workspace-catalog').children.length, 'stale content suppressed');
    const before = intents.length; obsolete.click(); assert(intents.length === before, 'detached stale action cannot navigate');
    workspace.update({ ...base, documentId: 'document:other', sourceBinding: null, behavior: null, catalog: null, entities: [], selectedEntityId: null });
    assert(!get('workspace-sources').children.length, 'project switch clears references');
    workspace.update(base);
    get('workspace-logic-tab').focus(); key('workspace-logic-tab', 'ArrowRight');
    assert(get('workspace-resources-tab').getAttribute('aria-selected') === 'true' && document.activeElement === get('workspace-resources-tab'), 'tab keyboard selection and focus');
    assert(get('workspace-logic-tab').tabIndex === -1 && get('workspace-resources-tab').getAttribute('aria-controls') === 'workspace-resources', 'tab ARIA');
    change('workspace-category', 'lights');
    assert(!get('light-resources').parentElement.hidden && get('geometry-resources').parentElement.hidden, 'lights separate from geometry');
    change('workspace-category', 'all');
    for (const kind of ['asset', 'template', 'preset', 'instance']) {
      change('workspace-kind', kind);
      const rows = [...get('workspace-catalog').children];
      assert(rows.length === 1 && rows[0].dataset.kind === kind, `four independent kinds ${kind}`);
      assert(get('geometry-resources').parentElement.hidden, 'legacy unclassified controls excluded from kind filter');
      const button = rows[0].querySelector('button'); if (button) { button.click(); assert(intents.at(-1).entry.kind === kind, 'typed resource intent'); }
      if (kind === 'preset') assert(!button && rows[0].textContent.includes('暂不可用'), 'unsupported preset has no operation');
    }
    change('workspace-kind', 'all'); change('workspace-category', 'geometry'); get('fixture-create').click();
    assert(manualCalls === 1 && get('fixture-create') === original['fixture-create'], 'existing control listener retained');
    workspace.setLanguage('en'); assert(get('workspace-logic-tab').textContent === 'Logic' && get('workspace-category').options[2].textContent === 'Lights', 'English labels');
    workspace.setLanguage('zh-CN'); assert(get('workspace-logic-tab').textContent === '逻辑', 'Chinese labels');
    workspace.setMode('classic');
    assert(get('workspace-split').firstElementChild === original['left-sidebar-split'] || original['left-sidebar-split'].parentElement === get('workspace-split'), 'classic hierarchy restored');
    assert(original['viewport-panel'].parentElement === get('authoring-split') && original['assets-panel'].parentElement === get('authoring-split'), 'classic authoring restored');
    assert(get('light-resources').parentElement.getAttribute('slot') === 'lights', 'classic resource tabs restored');
    workspace.setMode('intent'); workspace.setTab('logic');
    workspace.update({ ...base, sourceBinding: null, behavior: null, catalog: null });
    assert(get('workspace-behavior-status').textContent.includes('尚未就绪'), 'honest product pending state');
    assert(JSON.parse(localStorage.getItem(WORKSPACE_PREFERENCE_KEY)).mode === 'intent', 'preferences saved');
    await settle(); document.body.dataset.layoutStatus = 'ready';
  }
} catch (error) { document.body.dataset.layoutStatus = 'failed'; document.body.dataset.layoutError = error.stack ?? String(error); }
