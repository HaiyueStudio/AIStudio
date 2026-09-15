import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const directory = process.env.HAIYUE_GRAPH_UI_ROOT;
app.setPath('userData', path.join(directory, 'user-data'));
app.whenReady().then(async () => {
  // Keep frame-based assertions progressing without taking focus from the user's app.
  const window = new BrowserWindow({ width: 760, height: 880, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const evaluate = code => window.webContents.executeJavaScript(code).catch(async cause => { await writeFile(path.join(directory, 'failure.png'), (await window.webContents.capturePage()).toPNG()); console.error(errors); throw new Error(`Fixture script failed: ${code}; evidence: ${directory}`, { cause }); });
  const frame = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const move = async selector => { const point = await evaluate(`uiPoint(${JSON.stringify(selector)})`); window.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await frame(); return point; };
  const click = async selector => { const point = await move(selector); for (const type of ['mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 }); await frame(); };
  const switchView = async value => {
    const point = await evaluate(`(() => { const host=document.querySelector('.chat-view-tabs'), button=host.shadowRoot.querySelector('[role="tab"][data-value="${value}"]'), r=button.getBoundingClientRect(); const point={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; if(document.elementFromPoint(point.x,point.y)!==host) throw Error('View tab is not hittable'); return point; })()`);
    for (const type of ['mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 }); await frame();
  };
  const escape = async () => { window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await frame(); };
  const opened = selector => evaluate(`!!document.querySelector(${JSON.stringify(selector)})?.matches(':popover-open')`);
  const errors = []; window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  await window.loadFile(path.join(directory, 'index.html')); window.showInactive(); await frame();
  assert.deepEqual(await evaluate('[...document.querySelector(".chat-view-tabs").shadowRoot.querySelectorAll("[role=tab]")].map(tab=>tab.textContent)'), ['拓扑图', '执行步骤']);
  assert.equal(await evaluate('document.querySelector(".chat-feed").getBoundingClientRect().height'), 0, 'steps are not stacked below the graph');
  assert.equal(await evaluate('document.querySelectorAll(".execution-node.status-running hy-border-beam").length'), 1);
  assert.equal(await evaluate('document.querySelectorAll(".execution-node:not(.status-running) hy-border-beam").length'), 0);
  assert.equal(await evaluate('!!document.querySelector("hy-border-beam").shadowRoot.querySelector(".beam")'), true);
  assert.equal(await evaluate('document.querySelector(".execution-graph-region > .execution-node-detail") === null'), true);
  assert.equal(await evaluate('document.querySelector(".chat-task-cost").getBoundingClientRect().height'), 0);
  await move('[aria-label="上下文与任务用量"]'); assert.equal(await opened('.execution-usage-popover'), true);
  assert.equal(await evaluate('document.querySelector(".execution-usage-popover").textContent.includes("50%") && document.querySelector(".execution-usage-popover").textContent.includes("1007 / 20000")'), true);
  await move('.execution-usage-popover'); await evaluate('new Promise(resolve => setTimeout(resolve, 230))'); assert.equal(await opened('.execution-usage-popover'), true);
  await writeFile(path.join(directory, 'usage.png'), (await window.webContents.capturePage()).toPNG());
  assert.deepEqual(await evaluate('graphIntents'), []);
  await click('.execution-pressure button'); await click('.execution-pressure button');
  assert.deepEqual(await evaluate('graphIntents'), [{ type: 'conversation/request-compaction', sessionId: 'session:ui', requestId: 'compaction-request:session:ui:4' }]);
  await escape(); assert.equal(await opened('.execution-usage-popover'), false);
  await move('[aria-label="会话历史"]'); assert.equal(await opened('.execution-history-popover'), true); await escape();
  await move('.execution-node[data-node-id="node:0"]'); assert.equal(await opened('.execution-detail-popover'), true);
  assert.equal(await evaluate('document.querySelector(".execution-node-detail").textContent.includes("518 ms")'), true);
  await move('.execution-node-detail'); await evaluate('new Promise(resolve => setTimeout(resolve, 230))'); assert.equal(await opened('.execution-detail-popover'), true);
  await evaluate('showGraph()'); await frame(); assert.equal(await opened('.execution-detail-popover'), true);
  await evaluate(`window.retainedGraph = {
    viewport: document.querySelector('.execution-graph-viewport'), canvas: document.querySelector('.execution-graph-canvas'),
    node: document.querySelector('.execution-node[data-node-id="node:0"]'), beam: document.querySelector('.execution-node[data-node-id="node:0"] hy-border-beam'),
    edge: document.querySelector('.execution-edges path'), panel: document.querySelector('.execution-detail-popover'), detail: document.querySelector('.execution-node-detail'), scale: graphScale(),
  }; window.nodeMutations=[]; window.nodeObserver=new MutationObserver(records=>nodeMutations.push(...records)); nodeObserver.observe(retainedGraph.node,{subtree:true,childList:true,attributes:true,characterData:true});
  retainedGraph.detail.querySelector('details').open=true;
  const selection=getSelection(), range=document.createRange(); range.selectNodeContents(retainedGraph.detail.querySelector('h3')); selection.removeAllRanges(); selection.addRange(range); window.retainedText=selection.toString();`);
  for (let i=0;i<4;i++) { await evaluate('streamGraph("other")'); await frame(); }
  assert.deepEqual(await evaluate(`({
    viewport: retainedGraph.viewport===document.querySelector('.execution-graph-viewport'), canvas:retainedGraph.canvas===document.querySelector('.execution-graph-canvas'),
    node: retainedGraph.node===document.querySelector('.execution-node[data-node-id="node:0"]'), beam:retainedGraph.beam===document.querySelector('.execution-node[data-node-id="node:0"] hy-border-beam'),
    edge:retainedGraph.edge===document.querySelector('.execution-edges path'), panel:retainedGraph.panel===document.querySelector('.execution-detail-popover'),
    detail:retainedGraph.detail===document.querySelector('.execution-node-detail'), open:retainedGraph.panel.matches(':popover-open'),
    selectedText: getSelection().toString()===retainedText, expanded:retainedGraph.detail.querySelector('details').open, scale:graphScale()===retainedGraph.scale,
    unchangedNode:nodeMutations.length===0, added:!!document.querySelector('.execution-node[data-node-id="node:stream"]')
  })`), { viewport:true,canvas:true,node:true,beam:true,edge:true,panel:true,detail:true,open:true,selectedText:true,expanded:true,scale:true,unchangedNode:true,added:true });
  await evaluate('nodeObserver.disconnect(); getSelection().removeAllRanges(); streamGraph("remove")'); await frame();
  assert.equal(await evaluate(`document.querySelector('.execution-node[data-node-id="node:stream"]')===null`), true);

  await writeFile(path.join(directory, 'node-detail.png'), (await window.webContents.capturePage()).toPNG());
  await move('.chat-composer');
  await evaluate(`new Promise((resolve, reject) => { const deadline = performance.now() + 2500; const check = () => {
    if (!document.querySelector('.execution-detail-popover')?.matches(':popover-open')) return resolve();
    if (performance.now() > deadline) return reject(Error('Hover panel did not close; focus: ' + document.activeElement?.outerHTML.slice(0, 240)));
    setTimeout(check, 50);
  }; check(); })`);
  await click('.execution-node[data-node-id="node:0"]'); assert.equal(await opened('.execution-detail-popover'), true);
  await move('.chat-composer'); await evaluate('new Promise(resolve => setTimeout(resolve, 230))'); assert.equal(await opened('.execution-detail-popover'), true);
  await evaluate('document.querySelector(".execution-node-detail details").open=true; streamGraph("self")'); await frame();
  assert.equal(await opened('.execution-detail-popover'), true, 'updating the pinned node keeps its popover open');
  assert.equal(await evaluate('document.querySelector(".execution-detail-popover")===retainedGraph.panel'), true);
  assert.equal(await evaluate('document.querySelector(".execution-node-detail").textContent.includes("已创建棋盘纹理，验证完成。")'), true);
  assert.equal(await evaluate(`document.querySelector('.execution-node[data-node-id="node:0"] hy-border-beam')===null`), true);
  assert.equal(await evaluate('document.querySelector(".execution-node-detail details").open'), true);
  await evaluate('streamGraph("restore")'); await frame();
  await evaluate(`{ window.removedTrigger=document.querySelector('.execution-node[data-node-id="node:0"]'); const filter=document.querySelector('[aria-label="Filter execution graph"]'); filter.value='failed'; filter.dispatchEvent(new Event('change')); }`); await frame();
  assert.equal(await opened('.execution-detail-popover'), false, 'filtering out the inspected node closes only its detail');
  await evaluate('removedTrigger.dispatchEvent(new PointerEvent("pointerenter")); removedTrigger.click()'); await frame();
  assert.equal(await opened('.execution-detail-popover'), false, 'removed node hover bindings are released');
  await evaluate(`{ const filter=document.querySelector('[aria-label="Filter execution graph"]'); filter.value='all'; filter.dispatchEvent(new Event('change')); }`); await frame();


  await escape(); assert.equal(await opened('.execution-detail-popover'), false);
  window.webContents.focus(); await frame();
  await evaluate('document.querySelector(".execution-node[data-node-id=\\"node:0\\"]").blur(); document.querySelector(".execution-node[data-node-id=\\"node:0\\"]").focus()'); await frame(); assert.equal(await opened('.execution-detail-popover'), true);
  await click('.execution-node-detail button'); assert.equal(await evaluate('!!document.querySelector(".execution-transcript")'), true);
  await evaluate('[...document.querySelectorAll(".execution-controls button")].find(el=>el.textContent==="返回拓扑图").click()'); await frame();
  // In-place wheel zoom keeps cursor coordinates and selection, rather than rebuilding nodes.
  await evaluate('while(graphScale()<1.25) document.querySelector("[aria-label=\\"Zoom in execution graph\\"]").click()'); await frame();
  const wheel = await evaluate(`(() => {
    const v = document.querySelector('.execution-graph-viewport'); const r = v.getBoundingClientRect(); const old = graphScale();
    const node = document.querySelector('.execution-node.is-selected'); const x = 140, y = 100;
    const before = [(v.scrollLeft+x)/old, (v.scrollTop+y)/old];
    const event = new WheelEvent('wheel', { deltaY:-180, clientX:r.left+v.clientLeft+x, clientY:r.top+v.clientTop+y, bubbles:true, cancelable:true }); v.dispatchEvent(event);
    const after = [(v.scrollLeft+x)/graphScale(), (v.scrollTop+y)/graphScale()];
    return { prevented:event.defaultPrevented, old, next:graphScale(), same:node===document.querySelector('.execution-node.is-selected'), error:Math.max(...after.map((n,i)=>Math.abs(n-before[i]))) };
  })()`);
  assert.equal(wheel.prevented, true); assert.equal(wheel.same, true); assert.ok(wheel.next > wheel.old); assert.ok(wheel.error < 4, JSON.stringify(wheel));
  const point = await move('.execution-graph-viewport'); const previous = await evaluate('graphScale()');
  window.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaY: -100, deltaX: 0 }); await frame(); assert.ok(await evaluate('graphScale()') < previous);
  await evaluate(`(() => { const v=document.querySelector('.execution-graph-viewport'); for (const deltaMode of [1,2]) v.dispatchEvent(new WheelEvent('wheel',{deltaY:100000,deltaMode,bubbles:true,cancelable:true})); })()`); await frame(); assert.ok(await evaluate('graphScale()') >= .01);
  await evaluate('while(graphScale()<1.25) document.querySelector("[aria-label=\\"Zoom in execution graph\\"]").click(); const viewport=document.querySelector(".execution-graph-viewport"); viewport.scrollLeft=60; viewport.scrollTop=40;'); await frame();
  const graphPosition = await evaluate('({scale:graphScale(), left:document.querySelector(".execution-graph-viewport").scrollLeft, top:document.querySelector(".execution-graph-viewport").scrollTop, selected:document.querySelector(".execution-node.is-selected").dataset.nodeId})');
  await evaluate('streamGraph("other")'); await frame();
  assert.deepEqual(await evaluate('({scale:graphScale(), left:document.querySelector(".execution-graph-viewport").scrollLeft, top:document.querySelector(".execution-graph-viewport").scrollTop, selected:document.querySelector(".execution-node.is-selected").dataset.nodeId})'), graphPosition, 'streamed nodes preserve zoom and nonzero pan position');
  await switchView('steps');
  assert.equal(await evaluate('document.querySelector(".execution-graph-viewport").getBoundingClientRect().height'), 0);
  assert.ok(await evaluate('document.querySelector(".chat-feed").clientHeight') > 100);
  await evaluate('document.querySelector(".chat-feed").scrollTop=150; const input=document.querySelector(".chat-composer textarea"); input.value="保留这段输入"; input.focus(); input.setSelectionRange(2,5);'); await frame();
  const feedTop = await evaluate('document.querySelector(".chat-feed").scrollTop');
  await evaluate('showGraph()'); await frame();
  assert.equal(await evaluate('document.querySelector(".chat-view-tabs").value'), 'steps', 'updates preserve the chosen view');
  assert.equal(await evaluate('document.querySelector(".chat-feed").scrollTop'), feedTop, 'updates preserve reading position');
  assert.deepEqual(await evaluate('({text:document.activeElement.value,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd})'), { text:'保留这段输入', start:2, end:5 });
  await writeFile(path.join(directory, 'steps-view.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate('document.querySelector(".chat-view-tabs").shadowRoot.querySelector("[role=tab][data-value=steps]").focus()');
  window.webContents.sendInputEvent({ type:'keyDown', keyCode:'Left' }); window.webContents.sendInputEvent({ type:'keyUp', keyCode:'Left' }); await frame();
  assert.equal(await evaluate('document.querySelector(".chat-view-tabs").value'), 'graph', 'library tabs support keyboard switching');
  assert.deepEqual(await evaluate('({scale:graphScale(), left:document.querySelector(".execution-graph-viewport").scrollLeft, top:document.querySelector(".execution-graph-viewport").scrollTop, selected:document.querySelector(".execution-node.is-selected").dataset.nodeId})'), graphPosition);
  assert.equal(await evaluate('revealStep()'), true); await frame();
  assert.equal(await evaluate('document.querySelector(".chat-view-tabs").value'), 'steps', 'notification navigation opens the target view');
  assert.equal(await evaluate('document.activeElement.dataset.conversationNodeId'), 'node:feed:40');
  await switchView('graph');
  for (const [width, height] of [[760, 880], [320, 600]]) {
    window.setContentSize(width, height); await evaluate('showGraph()'); await frame();
    await evaluate('[...document.querySelectorAll(".execution-graph-toolbar button")].find(el=>el.textContent==="适应视图").click()'); await frame();
    await move('[aria-label="上下文与任务用量"]');
    const bounds = await evaluate('(() => { const r=document.querySelector(".execution-usage-popover").getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight; })()'); assert.equal(bounds, true);
    await escape(); await writeFile(path.join(directory, `graph-${width}x${height}.png`), (await window.webContents.capturePage()).toPNG());
  }
  await evaluate('showGraph(true, true)'); await frame(); assert.equal(await evaluate('document.querySelectorAll(".execution-node hy-border-beam").length'), 0);
  await move('[aria-label="上下文与任务用量"]'); assert.equal(await evaluate('document.querySelector(".execution-pressure progress").hidden'), true);
  assert.equal(await evaluate('document.querySelector(".execution-usage-popover").textContent.includes("null")'), false);
  assert.equal(await evaluate('document.querySelector(".chat-task-cost progress") === null'), true);
  await evaluate('window.oldUsage=document.querySelector("[aria-label=\\"上下文与任务用量\\"]"); window.oldPanel=document.querySelector(".execution-usage-popover"); showGraph(false, false, true); oldUsage.dispatchEvent(new PointerEvent("pointerenter"))'); await frame();
  assert.equal(await evaluate('oldPanel.hidden'), true); await move('[aria-label="上下文与任务用量"]'); assert.equal(await opened('.execution-usage-popover'), true);
  await evaluate('disposeGraph()'); assert.equal(await opened('.execution-usage-popover'), false);
  window.setContentSize(760, 880); await evaluate('showTaskChain(0)'); await frame();
  const originalIds = await evaluate('[...document.querySelectorAll(".execution-node")].map(node=>node.dataset.nodeId)');
  await evaluate('document.querySelector(".execution-node.kind-tool").click(); document.querySelector("[aria-label=\\"Zoom in execution graph\\"]").click()'); await frame();
  const selected = await evaluate('document.querySelector(".execution-node.is-selected").dataset.nodeId');
  const scale = await evaluate('graphScale()');
  await evaluate('showTaskChain(.5)'); await frame();
  assert.equal(await evaluate('document.querySelectorAll(".execution-node").length'), originalIds.length, 'unbound provider bootstrap must not replace the current task');
  await evaluate('showTaskChain(1)'); await frame();
  const continuedIds = await evaluate('[...document.querySelectorAll(".execution-node")].map(node=>node.dataset.nodeId)');
  for (const id of originalIds) assert.ok(continuedIds.includes(id), `Lost previous task node: ${id}`);
  assert.equal(continuedIds.length, originalIds.length + 2, 'a new phase includes its model round');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.execution-node')].filter(node=>!${JSON.stringify(originalIds)}.includes(node.dataset.nodeId)).map(node=>node.classList.contains('kind-model')?'model':node.classList.contains('kind-turn')?'turn':'other').sort()`), ['model','turn']);
  assert.equal(await evaluate('document.querySelector(".execution-workspace").dataset.sessionId'), 'session:execute');
  assert.equal(await evaluate('document.querySelector(".execution-workspace").dataset.taskId'), 'task:continuity');
  assert.equal(await evaluate('document.querySelector(".execution-node.is-selected").dataset.nodeId'), selected);
  assert.equal(await evaluate('graphScale()'), scale);
  await evaluate('showTaskChain(2)'); await frame();
  const fullCount = await evaluate('document.querySelectorAll(".execution-node").length'); assert.ok(fullCount > continuedIds.length);
  await escape(); await writeFile(path.join(directory, 'task-chain.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate('showTaskChain(2, true)'); await frame();
  assert.equal(await evaluate('document.querySelectorAll(".execution-node").length'), 3, 'a genuinely new task must not inherit previous task nodes');
  await evaluate('const history=document.querySelector("[aria-label=\\"Agent session\\"]"); history.value="task:continuity"; history.dispatchEvent(new Event("change"));'); await frame();
  assert.equal(await evaluate('document.querySelectorAll(".execution-node").length'), fullCount);
  await evaluate('showTaskChain(2, true)'); await frame(); assert.equal(await evaluate('document.querySelectorAll(".execution-node").length'), fullCount, 'explicit history selection survives updates');
  await evaluate('disposeGraph(); showGraph()'); await frame();
  const terminalColors = await evaluate(`['node:0','node:2','node:3'].map(id => getComputedStyle(document.querySelector('.execution-node[data-node-id="'+id+'"]')).backgroundColor)`);
  assert.equal(new Set(terminalColors).size, 3);
  assert.equal(terminalColors[1], 'rgb(82, 38, 48)');
  assert.equal(terminalColors[2], 'rgb(220, 226, 233)');
  for (const [id, expected, background] of [['node:2', '脚本编译失败', terminalColors[1]], ['node:3', '确认检查点', terminalColors[2]], ['node:4', '该记录未保存具体原因', terminalColors[2]]]) {
    await click(`.execution-node[data-node-id="${id}"]`);
    assert.equal(await evaluate(`document.querySelector('.execution-node-reason').textContent.includes(${JSON.stringify(expected)})`), true);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.execution-node[data-node-id="${id}"]')).backgroundColor`), background, 'selection and hover preserve terminal background');
    if (id !== 'node:4') await writeFile(path.join(directory, `${id === 'node:2' ? 'failed' : 'cancelled'}-detail.png`), (await window.webContents.capturePage()).toPNG());
    await escape();
  }
  await evaluate('showDuplicateFailure()'); await frame();
  await click('.execution-node[data-node-id="node:2"]');
  const duplicate = await evaluate(`(() => { const panel = document.querySelector('.execution-node-detail'); return { count: panel.textContent.split('gesture.interactions.0.type is not an event-trace field').length - 1, reason: !!panel.querySelector('.execution-node-reason'), result: panel.textContent.includes('执行结果') }; })()`);
  assert.deepEqual(duplicate, { count: 1, reason: false, result: true });
  await writeFile(path.join(directory, 'deduplicated-failure.png'), (await window.webContents.capturePage()).toPNG());
  await escape(); await evaluate('showDuplicateFailure(true)'); await frame();
  await click('.execution-node[data-node-id="node:2"]');
  assert.match(await evaluate("document.querySelector('.execution-node-reason').textContent"), /项目修订已经改变/);
  await escape();
  await evaluate('showMarkdownDetail()'); await frame();
  await click('.execution-node[data-node-id="node:0"]');
  const markdown = await evaluate(`(() => { const panel = document.querySelector('.execution-node-detail'); return {
    paragraphs: panel.querySelectorAll('.studio-markdown p').length,
    ordered: panel.querySelectorAll('.studio-markdown ol > li').length,
    nested: panel.querySelectorAll('.studio-markdown ol ul > li').length,
    code: panel.querySelector('.studio-markdown pre code')?.textContent,
    strong: panel.querySelector('.studio-markdown strong')?.textContent,
    quote: panel.querySelector('.studio-markdown blockquote')?.textContent,
    unsafe: panel.querySelectorAll('img,script,iframe,a[href^="javascript:"]').length,
    injected: window.markdownInjected === true,
    overflow: panel.scrollWidth > panel.clientWidth + 1,
  }; })()`);
  assert.ok(markdown.paragraphs >= 8); assert.equal(markdown.ordered, 2); assert.equal(markdown.nested, 1);
  assert.equal(markdown.code, 'const count = 27;\nconst ready = true;'); assert.equal(markdown.strong, 'PBR 材质');
  assert.match(markdown.quote, /验收后/); assert.equal(markdown.unsafe, 0); assert.equal(markdown.injected, false); assert.equal(markdown.overflow, false);
  await writeFile(path.join(directory, 'markdown-detail.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate('disposeGraph()');
  assert.deepEqual(errors, []);
  const result = { status: 'passed', terminalReasons: { failed: true, cancelled: true, historicalFallback: true, colorsRetainedOnSelection: true }, presentationTabs: { libraryComponent: true, mutuallyExclusive: true, keyboard: true, preservesDraftAndSelection: true, preservesFeedAndGraphPosition: true, preservesChoiceOnReplay: true, notificationTarget: true }, wheelCursorAnchor: wheel, nativeWheel: true, hoverAndKeyboard: true, pinAndEscape: true, runningBeamOnly: true, narrowBounds: true, unknownUsage: true, compactionOnce: true, cleanup: true, replayPreservesHover: true, incrementalGraph: { retainedNodesAndEdges: true, retainedPopoverAndSelection: true, unchangedNodeNoMutations: true, latestDetail: true, additionAndRemoval: true }, taskContinuity: { before: originalIds.length, afterHandoff: continuedIds.length, afterExecution: fullCount, selectionAndZoomPreserved: true, separateRequests: true, historySelection: true }, sizes: [[760,880],[320,600]], screenshots: ['usage.png','node-detail.png','steps-view.png','graph-760x880.png','graph-320x600.png','task-chain.png'] };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log('[graph-ui] passed'); window.destroy(); app.exit(0);
}).catch(cause => { console.error(cause); app.exit(1); });
