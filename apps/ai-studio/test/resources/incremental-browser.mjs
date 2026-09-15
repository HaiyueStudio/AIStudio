import { ResourceExplorerPanel } from '../../../../packages/studio-shell/dist/panels/resources/index.js';

// Browser DOM and canvas assertions, independent of live projects or model calls.
export async function verifyIncrementalResources(sample) {
  const assert = (value, message) => { if (!value) throw Error(message); };
  const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const host = document.createElement('div'); document.body.append(host);
  const jobs = [];
  const panel = new ResourceExplorerPanel(document, host, () => {}, (canvas, item, signal) => new Promise(resolve => {
    jobs.push({ canvas, item, signal, finish(color) { canvas.getContext('2d').fillStyle = color; canvas.getContext('2d').fillRect(0, 0, 128, 128); resolve(); } });
  }));
  const get = key => panel.root.querySelector(`[data-resource="${key}"]`);
  const item = (id, label = id) => ({ ...sample, entry: { ...sample.entry, catalogEntryId: id, label } });
  const items = Array.from({ length: 25 }, (_, i) => item(`resource-${i}`));
  let data = { projectKey: 'incremental-test', viewToken: 'view-1', state: 'ready', items, total: 25, nextCursor: null, categories: ['Geometry'], diagnostics: [], target: null };
  const update = patch => { data = { ...data, ...patch }; panel.update(data); };
  update({}); await tick();
  assert(jobs.length === 25, 'one thumbnail per initial card');
  jobs.forEach(job => job.finish('red')); await tick();
  const list = get('list'), row = list.firstElementChild, button = row.querySelector('button'), canvas = row.querySelector('canvas');
  const pixel = () => [...canvas.getContext('2d').getImageData(64, 64, 1, 1).data].join(',');
  button.click(); button.focus();
  const detail = get('detail').firstElementChild, disclosure = get('detail').querySelector('details'); disclosure.open = true;
  list.scrollTop = 50; const scroll = list.scrollTop;
  const mutations = []; const observer = new MutationObserver(records => mutations.push(...records)); observer.observe(list, { childList: true, subtree: true });
  for (let i = 0; i < 4; i++) {
    panel.update({ ...structuredClone(data), state: 'loading', items: [], total: 0 });
    assert(list.firstElementChild === row && list.children.length === 25 && !button.disabled, 'loading retains enabled cards');
    assert(get('status').hidden && !panel.root.textContent.includes('正在处理资源'), 'background loading has no top status text');
    update({ viewToken: `view-${i + 2}` });
  }
  await tick();
  assert(mutations.length + observer.takeRecords().length === 0, 'unchanged results cause no list child mutations'); observer.disconnect();
  assert(jobs.length === 25 && pixel() === '255,0,0,255', 'unchanged updates retain thumbnail pixels and jobs');
  assert(document.activeElement === button && list.scrollTop === scroll, 'focus and list scroll remain stable');
  assert(get('detail').firstElementChild === detail && disclosure.open, 'unchanged detail and disclosure survive refresh');
  update({ items: [item('resource-0', 'Renamed'), ...items.slice(1)] }); await tick();
  assert(list.firstElementChild === row && button.textContent.includes('Renamed') && jobs.length === 25, 'label changes patch existing card without thumbnail work');
  const ref = { kind: 'instance', projectId: 'incremental-test', entityId: 'entity-0', componentId: 'component-0', documentRevision: 1 };
  update({ items: [{ ...data.items[0], entry: { ...data.items[0].entry, kind: 'instance', ref } }, ...items.slice(1)] }); await tick();
  jobs.at(-1).finish('red'); await tick(); const beforeRevision = jobs.length;
  update({ items: [{ ...data.items[0], entry: { ...data.items[0].entry, ref: { ...ref, documentRevision: 2 } } }, ...items.slice(1)] }); await tick();
  assert(jobs.length === beforeRevision, 'unrelated document revision does not redraw resource thumbnail');
  update({ items: [{ ...data.items[0], configuration: '{"version":1}' }, ...items.slice(1)] }); await tick();
  const older = jobs.at(-1);
  assert(pixel() === '255,0,0,255', 'old pixels stay visible during changed thumbnail render');
  update({ items: [{ ...data.items[0], configuration: '{"version":2}' }, ...items.slice(1)] }); await tick();
  const newer = jobs.at(-1); newer.finish('blue'); await tick(); older.finish('green'); await tick();
  assert(older.signal.aborted && pixel() === '0,0,255,255', 'late thumbnail cannot overwrite newer pixels');
  update({ items: [items[2], data.items[0], item('added')], total: 3 }); await tick();
  assert(list.children.length === 3 && list.children[1] === row, 'reorder/add/remove retains surviving row identity');
  assert(jobs[1].signal.aborted, 'removed card releases thumbnail scope');
  const added = jobs.at(-1);
  panel.update({ ...data, state: 'error', viewToken: null, diagnostics: ['查询失败'] });
  assert(list.children[1] === row && !get('error').hidden, 'query errors retain existing cards and show error');
  update({ projectKey: 'different-project', state: 'loading', items: [], total: 0, viewToken: null });
  assert(!row.isConnected && list.querySelectorAll('button').length === 0 && added.signal.aborted && get('detail').hidden, 'project switch clears old content and aborts pending thumbnail');
  added.finish('white'); await tick();
  update({ state: 'ready', items: [item('resource-0')], total: 1 }); await tick();
  assert(list.firstElementChild !== row, 'same ID in another project never reuses old card');
  const disposed = jobs.at(-1); panel.dispose(); panel.dispose(); disposed.finish('yellow'); await tick();
  assert(disposed.signal.aborted && !panel.root.isConnected, 'dispose aborts thumbnails and ignores late paint');
  host.remove();
}
