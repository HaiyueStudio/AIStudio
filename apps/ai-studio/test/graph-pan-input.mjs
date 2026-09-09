import assert from 'node:assert/strict';

// Real Chromium input exercises pointer capture and native click synthesis.
export async function checkGraphPanning(window, selector, selectedClass) {
  const evaluate = code => window.webContents.executeJavaScript(`(()=>{const viewport=document.querySelector(${JSON.stringify(selector)});${code}})()`);
  const settle = () => window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const input = event => window.webContents.sendInputEvent(event);
  const selected = () => evaluate(`return viewport.querySelector('[data-node-id].${selectedClass}')?.dataset.nodeId??null;`);
  const scroll = () => evaluate('return {left:viewport.scrollLeft,top:viewport.scrollTop};');
  await evaluate(`viewport.style.maxWidth='600px';viewport.style.height='310px';viewport.scrollIntoView({block:'center'});viewport.scrollLeft=0;viewport.scrollTop=0;`);
  await settle();
  const origin = await evaluate(`const r=viewport.getBoundingClientRect();return {x:Math.ceil(r.left+viewport.clientLeft+5),y:Math.ceil(r.top+viewport.clientTop+5),width:viewport.scrollWidth,height:viewport.scrollHeight,clientWidth:viewport.clientWidth,clientHeight:viewport.clientHeight};`);
  assert.ok(origin.width > origin.clientWidth + 100 && origin.height > origin.clientHeight + 100, 'fixture must overflow on both axes');
  const pickNode = () => evaluate(`const v=viewport.getBoundingClientRect(),nodes=[...viewport.querySelectorAll('[data-node-id]')].sort((a,b)=>Number(a.classList.contains('${selectedClass}'))-Number(b.classList.contains('${selectedClass}')));for(const n of nodes){const r=n.getBoundingClientRect(),left=Math.max(r.left,v.left+8),top=Math.max(r.top,v.top+8),right=Math.min(r.right,v.left+viewport.clientWidth-8),bottom=Math.min(r.bottom,v.top+viewport.clientHeight-8);if(right-left>24&&bottom-top>24)return {id:n.dataset.nodeId,x:Math.floor((left+right)/2),y:Math.floor((top+bottom)/2)};}throw Error('no visible graph node');`);
  const drag = async (point, button) => {
    input({ type: 'mouseMove', x: point.x, y: point.y });
    input({ type: 'mouseDown', x: point.x, y: point.y, button, clickCount: 1 });
    input({ type: 'mouseMove', x: point.x - 65, y: point.y - 55, movementX: -65, movementY: -55, modifiers: [button === 'middle' ? 'middleButtonDown' : 'leftButtonDown'] });
    await settle();
    assert.equal(await evaluate('return viewport.classList.contains("is-panning");'), true, 'drag cursor');
    input({ type: 'mouseUp', x: point.x - 65, y: point.y - 55, button, clickCount: 1 });
    await settle();
    assert.equal(await evaluate('return viewport.classList.contains("is-panning");'), false, 'pointer release clears drag');
  };
  const before = await selected();
  const dragged = await pickNode(); assert.notEqual(dragged.id, before, 'drag over an unselected node to detect accidental selection');
  await drag(dragged, 'left');
  assert.deepEqual(await scroll(), { left: 65, top: 55 }, 'left drag pans in screen pixels');
  assert.equal(await selected(), before, 'dragging over a node must not select it');
  await evaluate('viewport.scrollLeft=0;viewport.scrollTop=0;');
  await drag(origin, 'middle');
  assert.deepEqual(await scroll(), { left: 65, top: 55 }, 'middle drag pans from background');
  assert.equal(await selected(), before, 'middle drag must not select a node');
  const node = await pickNode();
  input({ type: 'mouseMove', x: node.x, y: node.y });
  input({ type: 'mouseDown', x: node.x, y: node.y, button: 'left', clickCount: 1 });
  input({ type: 'mouseMove', x: node.x + 2, y: node.y + 1, modifiers: ['leftButtonDown'] });
  input({ type: 'mouseUp', x: node.x + 2, y: node.y + 1, button: 'left', clickCount: 1 });
  await settle();
  assert.equal(await selected(), node.id, 'ordinary click still selects the node');
  const restored = await scroll();
  assert.ok(restored.left > 0 && restored.top > 0, 'node selection preserves the panned viewport');
  await evaluate(`viewport.addEventListener('pointerdown',e=>viewport.dataset.testPointerId=String(e.pointerId),{once:true});`);
  const next = await pickNode();
  input({ type: 'mouseDown', x: next.x, y: next.y, button: 'left', clickCount: 1 });
  input({ type: 'mouseMove', x: next.x - 10, y: next.y - 10, modifiers: ['leftButtonDown'] });
  await settle();
  await evaluate(`viewport.dispatchEvent(new PointerEvent('pointercancel',{pointerId:Number(viewport.dataset.testPointerId),bubbles:true}));`);
  assert.equal(await evaluate('return viewport.classList.contains("is-panning");'), false, 'pointer cancellation clears drag');
  const cancelled = await scroll();
  input({ type: 'mouseMove', x: next.x - 25, y: next.y - 25, modifiers: ['leftButtonDown'] });
  input({ type: 'mouseUp', x: next.x - 25, y: next.y - 25, button: 'left', clickCount: 1 });
  await settle();
  assert.deepEqual(await scroll(), cancelled, 'cancelled pointer cannot keep panning');
  return true;
}
