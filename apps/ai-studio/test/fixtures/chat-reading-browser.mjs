import { renderChatPanel, disposeChatPanel } from '../../../../packages/studio-shell/dist/index.js';

export async function verifyChatReading(baseModel) {
  const assert = (ok, message) => { if (!ok) throw Error(`Chat reading: ${message}`); };
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const root = document.createElement('section'); root.className = 'chat-content';
  root.style.cssText = 'position:fixed;inset:0;width:720px;height:650px;z-index:99999;background:#14172c'; document.body.append(root);
  const intents = [];
  const card = index => ({ id: `reading:${index}`, kind: 'tool-result', status: 'completed', title: `步骤 ${index}`, body: '已完成本次对象数据查询。'.repeat(8), tone: 'success', actions: [], metadata: [], provenance: { backendId: 'backend:reading', sessionId: 'session:reading', turnId: 'turn:reading' }, details: { summary: '返回数据', body: `结果 ${index}` } });
  let model = { ...baseModel, executionGraphs: [], taskAccounting: null, taskRuns: [], cards: Array.from({ length: 40 }, (_, i) => card(i)) };
  const render = () => renderChatPanel(root, model, intent => intents.push(intent));
  let nextIndex = 40;
  const append = () => { model = { ...model, cards: [...model.cards, card(nextIndex++)] }; render(); };
  render(); await settle();
  const feed = root.querySelector('.chat-feed'), steps = root.querySelector('.chat-steps-view');
  const near = element => element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
  assert(feed.scrollHeight > feed.clientHeight && near(feed), 'initial feed follows latest');
  feed.scrollTop = 130; feed.dispatchEvent(new Event('scroll')); await settle();
  const first = feed.firstElementChild, detail = first.querySelector('details'); detail.open = true;
  feed.scrollTop = 130; feed.dispatchEvent(new Event('scroll')); await settle();
  const top = feed.scrollTop, button = root.querySelector('.chat-jump-latest');
  assert(!button.hidden, 'jump latest available while reading history');
  const mutations = []; const observer = new MutationObserver(records => mutations.push(...records)); observer.observe(feed, { childList: true });
  append(); await settle();
  assert(root.querySelector('.chat-feed') === feed && root.querySelector('.chat-steps-view') === steps, 'list containers survive update');
  assert(feed.firstElementChild === first && first.querySelector('details') === detail && detail.open, 'unchanged card and disclosures survive');
  assert(Math.abs(feed.scrollTop - top) < 1, 'appending does not scroll history to bottom');
  assert(mutations.length === 1 && mutations[0].addedNodes.length === 1 && mutations[0].removedNodes.length === 0, 'only new card is inserted'); observer.disconnect();
  const last = feed.lastElementChild, body = last.querySelector('.chat-card-content > p');
  model = { ...model, cards: model.cards.map((item, i) => i === model.cards.length - 1 ? { ...item, body: '更新后的执行结果。'.repeat(18) } : item) }; render(); await settle();
  assert(feed.lastElementChild === last && last.querySelector('.chat-card-content > p') === body, 'text update patches body without replacing card');
  assert(Math.abs(feed.scrollTop - top) < 1, 'offscreen text update does not move history');
  button.click(); await settle(); append(); await settle(); assert(near(feed), 'explicit latest resumes following new cards');
  // A pending plan must retain unsent feedback and selections through unrelated events.
  const plan = { ...card(1000), id: 'reading:plan', kind: 'plan', status: 'pending', tone: 'warning', details: undefined, planItems: [{ id: 'step:1', label: '准备物体', status: 'pending' }, { id: 'step:2', label: '验证交互', status: 'pending' }] };
  model = { ...model, cards: [...model.cards, plan] }; render(); await settle();
  const attention = root.querySelector('.chat-attention'), note = attention.querySelector('textarea'), checkbox = attention.querySelector('input');
  note.value = '保留原来的颜色'; checkbox.checked = false; note.focus();
  append(); await settle();
  assert(root.querySelector('.chat-attention') === attention && attention.querySelector('textarea') === note && note.value === '保留原来的颜色' && !checkbox.checked && document.activeElement === note, 'pending plan form survives unrelated updates');
  attention.querySelector('.chat-plan-review button').click();
  assert(intents.length === 1 && intents[0].acceptedItemIds.length === 1 && intents[0].note === note.value, 'retained approval handler dispatches once with live form values');
  model = { ...model, cards: model.cards.filter(item => item.id !== plan.id) }; render(); await settle();
  // Some product sizes scroll the outer steps panel while the feed has no scrollbar.
  feed.style.cssText = 'flex:none;height:auto;overflow:visible'; await settle();
  assert(steps.scrollHeight > steps.clientHeight && near(feed), 'outer scroll fixture has a non-scrolling feed');
  steps.scrollTop = 600; steps.dispatchEvent(new Event('scroll')); await settle();
  const visible = () => [...feed.children].find(node => node.getBoundingClientRect().bottom > steps.getBoundingClientRect().top);
  const anchor = visible(), offset = anchor.getBoundingClientRect().top - steps.getBoundingClientRect().top;
  append(); await settle();
  assert(visible() === anchor && Math.abs(anchor.getBoundingClientRect().top - steps.getBoundingClientRect().top - offset) < 1, 'outer history stays anchored after append');
  model = { ...model, cards: model.cards.map((item, i) => i === 0 ? { ...item, body: '上方较早步骤补充了执行数据。'.repeat(80) } : item) }; render(); await settle();
  assert(visible() === anchor && Math.abs(anchor.getBoundingClientRect().top - steps.getBoundingClientRect().top - offset) < 1, 'growth above viewport preserves visible reading anchor');
  root.style.display = 'none'; append(); await settle(); root.style.display = ''; await settle();
  assert(visible() === anchor, 'updates while the entire panel is hidden do not reset history');
  // Hide the list in Graph view, append, then return to the same history position.
  model = { ...model, executionGraphs: baseModel.executionGraphs }; render(); await settle();
  const tabs = root.querySelector('.chat-view-tabs');
  tabs.dispatchEvent(new CustomEvent('tab-change', { detail: { value: 'graph' } })); await settle(); append(); await settle();
  tabs.dispatchEvent(new CustomEvent('tab-change', { detail: { value: 'steps' } })); await settle();
  assert(visible() === anchor, 'hidden tab updates retain reading position');
  root.querySelector('.chat-jump-latest').click(); await settle(); append(); await settle();
  assert(near(feed) && near(steps), 'latest follows actual outer scrolling container');
  model = { ...model, cards: [] }; render(); await settle(); assert(feed.children.length === 0, 'reset removes old session cards');
  disposeChatPanel(root); root.remove(); return true;
}
