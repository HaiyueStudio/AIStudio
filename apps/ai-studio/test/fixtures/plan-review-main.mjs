import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const directory = process.env.HAIYUE_PLAN_REVIEW_ROOT;
app.setPath('userData', path.join(directory, 'user-data'));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 700, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const evaluate = code => window.webContents.executeJavaScript(code);
  const frame = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const click = async label => { const point = await evaluate(`window.reviewButtonPoint(${JSON.stringify(label)})`); window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 }); window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 }); await frame(); };
  await window.loadFile(path.join(directory, 'index.html')); window.showInactive();
  const sizes = [[360, 720], [320, 600], [720, 900]];
  for (const [width, height] of sizes) {
    window.setContentSize(width, height); await evaluate('window.showReview()'); await frame();
    await evaluate('window.reviewButtonPoint("批准并执行"); window.reviewButtonPoint("补充后重新规划"); if(!document.querySelector(".execution-workspace") || !document.querySelector(".chat-task-workspace") || !document.querySelector(".chat-task-cost")) throw Error("Missing conditional panels");');
    const composer = await evaluate('(() => { const r=document.querySelector(".chat-composer").getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight; })()'); assert.equal(composer, true);
    await writeFile(path.join(directory, `plan-${width}x${height}.png`), (await window.webContents.capturePage()).toPNG());
    await evaluate('document.querySelector(".chat-view-tabs").shadowRoot.querySelector("[data-value=steps]").click()'); await frame();
    await evaluate('window.reviewButtonPoint("批准并执行"); window.reviewButtonPoint("补充后重新规划"); if(document.querySelector(".execution-workspace").getBoundingClientRect().height!==0) throw Error("Graph must be hidden in steps view");');
    await writeFile(path.join(directory, `plan-steps-${width}x${height}.png`), (await window.webContents.capturePage()).toPNG());
    await evaluate('document.querySelector(".chat-view-tabs").shadowRoot.querySelector("[data-value=graph]").click()'); await frame();
    await evaluate('document.querySelector(".chat-agent-settings").open=true'); await frame(); await evaluate('window.reviewButtonPoint("批准并执行")');
    await evaluate('document.querySelector(".chat-agent-settings").open=false'); await frame();
  }
  assert.deepEqual(await evaluate('window.reviewIntents'), []);
  await evaluate('document.querySelector(".chat-plan-items input").checked=false; document.querySelector(".chat-plan-review textarea").value="优先完成基础交互"');
  await click('批准并执行'); await click('批准并执行');
  const approved = await evaluate('window.reviewIntents'); assert.equal(approved.length, 1); assert.equal(approved[0].type, 'conversation/accept-plan'); assert.equal(approved[0].nodeId, 'node:plan'); assert.equal(approved[0].mode, 'approve'); assert.equal(approved[0].acceptedItemIds.length, 19); assert.equal(approved[0].note, '优先完成基础交互'); assert.ok(!approved[0].acceptedItemIds.includes('plan:item-0'));
  await evaluate('window.showReview(); document.querySelector(".chat-plan-review textarea").value="调整为横屏"'); await frame(); await click('补充后重新规划');
  const revised = await evaluate('window.reviewIntents.at(-1)'); assert.equal(revised.mode, 'revise'); assert.deepEqual(revised.acceptedItemIds, []); assert.equal(revised.note, '调整为横屏');
  for (const kind of ['question', 'approval']) { await evaluate(`window.showReview(${JSON.stringify(kind)})`); await frame(); assert.equal(await evaluate(`document.querySelector('.chat-attention [data-kind=${kind}]') !== null`), true); }
  await evaluate('window.showReview("plan", "completed")'); await frame(); assert.equal(await evaluate('document.querySelector(".chat-attention") === null && !!document.querySelector(".chat-feed [data-kind=plan]")'), true); assert.equal(await evaluate('!!window.reviewButton("批准并执行")'), false);
  await evaluate('window.showReview("plan", "pending", false)'); await frame(); await evaluate('window.reviewButtonPoint("批准并执行")');
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ status: 'passed', sizes, approveOnce: true, revisionFeedback: true, conditionalPanels: true, completedPlanReadonly: true, otherBarriersVisible: true }, null, 2));
  console.log('[plan-review] passed'); window.destroy(); app.exit(0);
}).catch(cause => { console.error(cause); app.exit(1); });
