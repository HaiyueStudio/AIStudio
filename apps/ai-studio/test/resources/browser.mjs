import { ResourceExplorerPanel } from '../../../../packages/studio-shell/dist/panels/resources/index.js';
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
const idle = async () => { await Promise.resolve(); await pending; await Promise.resolve(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); };
const query = async (key, value) => { get(key).value = value; get(key).dispatchEvent(new Event('change')); await idle(); };
const select = predicate => {
  const item = data.items.find(predicate); assert(item, 'real catalog item exists');
  [...get('list').querySelectorAll('button')].find(button => button.dataset.resourceEntry === item.entry.catalogEntryId).click();
};
const update = value => { data = value; panel.update(value); };
const action = async name => { const button = panel.root.querySelector(`[data-resource-action="${name}"]`); assert(button && !button.disabled, `action ${name} available`); button.focus(); button.click(); await idle(); };
window.resourceTest = { panel, get, assert, intents, idle, query, select, action, update, get data() { return data; }, setBlock(value) { block = value; } };
update(await window.resourceBridge.current());
