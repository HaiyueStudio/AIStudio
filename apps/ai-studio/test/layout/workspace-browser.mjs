import { IntentWorkspace, WORKSPACE_PREFERENCE_KEY } from '@haiyue/ai-studio-shell';
import { defineSplitComponents } from '@haiyue/ui/split';
import { defineTabsComponents } from '@haiyue/ui/tabs';
import { defineDialogComponents } from '@haiyue/ui/dialog';
import { defineSelectComponents } from '@haiyue/ui/select';
import fixtures from './fixtures.generated.json';

const get = id => document.getElementById(id);
const workspaceTab = value => get('workspace-tabs').shadowRoot.querySelector(`[data-value="${value}"]`);
const assert = (value, label) => { if (!value) throw Error(label); };
const settle = async () => { for (let frame = 0; frame < 4; frame++) await new Promise(resolve => requestAnimationFrame(resolve)); };
const change = (id, value) => { get(id).value = value; get(id).dispatchEvent(new Event('change', { bubbles: true })); };
const key = (id, value) => get(id).dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
const intents = [], samples = [];
const { manifest, catalog } = fixtures;
const base = { documentId: manifest.binding.documentId, documentRevision: manifest.binding.documentRevision, selectedEntityId: 'entity:main', entities: [{ id: 'entity:main', name: '灯光控制器', sources: ['script', 'declarative-component'] }], sourceBinding: manifest.binding, behavior: manifest, catalog };
defineSplitComponents(); defineTabsComponents(); defineDialogComponents(); defineSelectComponents();
const contractTabs = document.createElement('hy-tabs');
assert(contractTabs.attributes.length === 0, 'tabs constructor must leave host attributes empty');
contractTabs.options = [{ value: 'one', label: '<b>One</b>' }, { value: 'disabled', label: 'Disabled', disabled: true }, { value: 'two', label: 'Two' }];
contractTabs.setAttribute('aria-label', 'Component contract');
const content = document.createElement('section'); content.slot = 'two'; content.textContent = 'retained panel'; contractTabs.append(content);
const changes = []; contractTabs.addEventListener('tab-change', event => changes.push(event.detail));
document.body.append(contractTabs);
const contractButton = value => contractTabs.shadowRoot.querySelector(`[data-value="${value}"]`);
const contractKey = key => contractTabs.shadowRoot.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
contractButton('one').focus(); contractKey('ArrowRight');
assert(contractTabs.value === 'two' && contractTabs.shadowRoot.activeElement === contractButton('two') && changes.length === 1 && changes[0].option.value === 'two', 'keyboard skips disabled tab and emits one typed change');
contractKey('ArrowRight'); assert(contractTabs.value === 'one', 'keyboard wraps');
contractKey('End'); assert(contractTabs.value === 'two', 'End selects last enabled tab');
contractKey('Home'); assert(contractTabs.value === 'one', 'Home selects first enabled tab');
contractKey('ArrowLeft'); assert(contractTabs.value === 'two', 'left arrow wraps');
contractButton('two').click(); contractButton('disabled').click(); assert(changes.length === 5, 'same or disabled tab emits no change');
contractTabs.remove(); document.body.append(contractTabs);
assert(contractTabs.options.length === 3 && contractTabs.value === 'two' && contractTabs.firstElementChild === content && contractTabs.shadowRoot.querySelector('slot').assignedElements()[0] === content, 'reconnection preserves property options and live panel identity');
assert(contractButton('one').textContent === '<b>One</b>' && !contractButton('one').querySelector('b'), 'labels remain text');
assert(contractTabs.shadowRoot.querySelector('[role="tablist"]').getAttribute('aria-label') === 'Component contract', 'named tablist');
contractTabs.remove();
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
    workspaceTab('logic').focus(); workspaceTab('logic').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert(workspaceTab('resources').getAttribute('aria-selected') === 'true' && get('workspace-tabs').shadowRoot.activeElement === workspaceTab('resources'), 'tab keyboard selection and focus');
    assert(workspaceTab('logic').tabIndex === -1 && get('workspace-tabs').shadowRoot.getElementById(workspaceTab('resources').getAttribute('aria-controls')).getAttribute('role') === 'tabpanel', 'tab ARIA');
    assert(get('workspace-logic').hidden && !get('workspace-resources').hidden, 'public tab-change selects the matching slotted panel');
    assert(JSON.parse(localStorage.getItem(WORKSPACE_PREFERENCE_KEY)).tab === 'resources', 'public tab-change persists selection');
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
    workspace.setLanguage('en'); assert(workspaceTab('logic').textContent === 'Logic' && get('workspace-category').options[2].textContent === 'Lights', 'English labels');
    workspace.setLanguage('zh-CN'); assert(workspaceTab('logic').textContent === '逻辑', 'Chinese labels');
    workspace.setMode('classic');
    assert(get('workspace-split').firstElementChild === original['left-sidebar-split'] || original['left-sidebar-split'].parentElement === get('workspace-split'), 'classic hierarchy restored');
    assert(original['viewport-panel'].parentElement === get('authoring-split') && original['assets-panel'].parentElement === get('authoring-split'), 'classic authoring restored');
    assert(get('light-resources').parentElement.getAttribute('slot') === 'lights', 'classic resource tabs restored');
    workspace.setMode('intent');
    assert(get('workspace-tabs').options.length === 2 && get('workspace-tabs').value === 'resources' && !get('workspace-resources').hidden, 'tab selection and property options survive reparenting');
    workspaceTab('logic').click();
    assert(!get('workspace-logic').hidden && get('workspace-resources').hidden, 'component mouse click selects logic');
    workspace.update({ ...base, sourceBinding: null, behavior: null, catalog: null });
    assert(get('workspace-behavior-status').textContent.includes('尚未就绪'), 'honest product pending state');
    assert(JSON.parse(localStorage.getItem(WORKSPACE_PREFERENCE_KEY)).mode === 'intent', 'preferences saved');
    await settle(); document.body.dataset.layoutStatus = 'ready';
  }
} catch (error) { document.body.dataset.layoutStatus = 'failed'; document.body.dataset.layoutError = error.stack ?? String(error); }
