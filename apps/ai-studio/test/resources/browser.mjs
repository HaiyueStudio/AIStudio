import { ResourceExplorerPanel } from '../../../../packages/studio-shell/dist/panels/resources/index.js';
import { defineTabsComponents } from '@haiyue/ui/tabs';
defineTabsComponents();
let pending = Promise.resolve(), data, block = null;
const intents = [];
const panel = new ResourceExplorerPanel(document, document.getElementById('host'), intent => {
  intents.push(intent);
  pending = (async () => {
    if (block) return block;
    data = await window.resourceBridge.intent(intent); panel.update(data);
  })();
  return pending;
});
const get = key => panel.root.querySelector(`[data-resource="${key}"]`);
const assert = (condition, message) => { if (!condition) throw Error(message); };
const idle = async () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    await Promise.resolve(); const current = pending; await current;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (current === pending && panel.root.getAttribute('aria-busy') === 'false') return;
  }
  throw Error('Resource panel did not settle');
};
const query = async (key, value) => { get(key).value = value; get(key).dispatchEvent(new Event('change')); await idle(); };
const tab = async value => { await idle(); const button = get('tabs').shadowRoot.querySelector(`[data-value="${value}"]`); assert(button, `tab ${value} exists`); button.click(); await idle(); assert(get('tabs').value === value, `tab ${value} selected`); };
const select = predicate => {
  const item = data.items.find(predicate); assert(item, 'real catalog item exists');
  [...get('list').querySelectorAll('button')].find(button => button.dataset.resourceEntry === item.entry.catalogEntryId).click();
};
const update = value => { data = value; panel.update(value); };
const action = async name => { const button = panel.root.querySelector(`[data-resource-action="${name}"]`); assert(button && !button.disabled, `action ${name} available`); button.focus(); button.click(); await idle(); };
window.resourceTest = { panel, get, assert, intents, idle, query, tab, select, action, update, get data() { return data; }, setBlock(value) { block = value; } };
update(await window.resourceBridge.current());
