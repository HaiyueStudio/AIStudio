import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electronPath from 'electron';
import { build } from 'esbuild';

test('G11 real sandboxed product UI exposes task, evidence, resume and bounded long-task behavior', { timeout: 100_000 }, async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'haiyue-g11-product-electron-'));
  const shellEntry = path.resolve(new URL('../../../packages/studio-shell/dist/index.js', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1'));
  await build({ stdin: { contents: appSource(shellEntry), resolveDir: path.dirname(shellEntry), sourcefile: 'g11-product-app.ts' }, outfile: path.join(output, 'app.js'), bundle: true, format: 'esm', platform: 'browser', target: 'chrome132' });
  await writeFile(path.join(output, 'host.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{background:#0b1020;color:#fff}.chat-content{height:850px}</style></head><body><main id="root" class="chat-content"></main><script type="module" src="./app.js"></script></body></html>');
  const fixture = new URL('./fixtures/g11-product-main.mjs', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1');
  const result = await run(electronPath, [fixture], { ...process.env, HAIYUE_G11_PRODUCT_ROOT: output, HAIYUE_G11_USER_DATA: path.join(output, 'user-data') });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /\[g11-product-smoke\].*"task":true.*"acceptance":true.*"imageReleased":true.*"timelineRows":100.*"resume":true.*"keyboard":true/u);
});

function appSource(shellEntry) { return `
  import { ConversationProjector, presentChatPanel, renderChatPanel } from ${JSON.stringify(shellEntry.replaceAll('\\', '/'))};
  const backendId = 'backend:g11-electron', sessionId = 'session:g11-electron', turnId = 'turn:g11-electron';
  const digest = 'sha256:' + 'a'.repeat(64); const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Z20yAAAAAElFTkSuQmCC';
  const timeline = Array.from({length:150},(_,i)=>({id:'timeline:'+i,at:new Date(Date.UTC(2026,7,29,0,Math.floor(i/60),i%60)).toISOString(),phase:i===149?'blocked':'editing',status:i===149?'warning':'complete',title:'步骤 '+i,detail:'bounded',turnId,toolCallId:null,playId:null,tick:null}));
  const task = {schemaVersion:1,revision:9,taskId:'task:g11-electron',title:'通用交互验收',requestSummary:'验证一次交互并收集截图。',status:'blocked',phase:'blocked',startedAt:'2026-08-29T00:00:00.000Z',updatedAt:'2026-08-29T00:03:00.000Z',backendId,sessionId,turnId,model:{id:'fixture-model',reasoningEffort:'high',outputTokenLimit:4096},promptProfile:{id:'prompt:general',version:'2.0.0',digest},documentRevision:9,repairIteration:2,repairLimit:3,acceptance:[{id:'acceptance:interaction',label:'交互状态发生变化',assertion:'evidence state signal interaction.changed equals true',category:'functional',required:true,visibility:'agent',status:'fail',evidenceIds:['artifact:sha256:evidence'],diagnostic:'evaluation.condition-failed'}],evidence:[{id:'artifact:sha256:evidence',type:'screenshot',taskId:'task:g11-electron',turnId,playId:'play:g11-electron',documentRevision:9,tick:42,frame:42,viewport:{width:393,height:852},device:'phone-fixture',capturedAt:'2026-08-29T00:02:00.000Z',byteLength:68,redacted:false,producerVersion:'fixture',provenanceStatus:'current',previewDataUrl:png}],timeline,terminalDiagnostic:'task.repair-budget-checkpoint',resumable:true};
  const backend = {id:backendId,label:'Fixture',kind:'harness-api-key',state:'ready',authMode:'api-key',protocolVersion:'fixture/1',capabilities:{resume:true,questions:true,structuredTools:true,backendApprovals:false,usage:true,rateLimits:true},promptProfile:{id:'prompt:general',version:'2.0.0',digest},rateLimits:[{name:'requests',usedPercent:25}],models:[{id:'fixture-model',label:'Fixture',reasoningEfforts:['high'],defaultReasoningEffort:'high',maxOutputTokens:8192,isDefault:true}],selectedModel:'fixture-model',selectedReasoningEffort:'high',outputTokenLimit:4096};
  const snapshot = extra => ({revision:1,connection:'connected',busy:false,backendId,backends:[backend],taskAccounting:{taskId:task.taskId,budgetStatus:'hard-exceeded',budget:{schemaVersion:2,id:'budget:g11',enforcement:'hard',limits:{inputTokens:1000,outputTokens:100,estimatedCostMicros:10000,wallTimeMs:60000,turns:3,toolCalls:10,repairIterations:3,observationBytes:10000}},usage:{inputTokens:100,cachedInputTokens:null,outputTokens:20,reasoningTokens:null,toolInputBytes:10,toolOutputBytes:20,wallTimeMs:1000,contextCache:{localArtifactHits:1,localArtifactMisses:0,deltaReuseBytes:20,providerCacheEligibleBytes:40,providerReportedHitTokens:null}},cost:{status:'unknown',amountMicros:null,currency:null,cacheSavingMicros:null,explanation:'Provider did not report billable usage.',final:false}},taskRuns:[{...task,...extra}],events:[]});
  const root = document.querySelector('#root'); const intents=[]; const projector = new ConversationProjector();
  renderChatPanel(root,presentChatPanel(projector.reset(snapshot({}))),intent=>intents.push(intent));
  const oldImage=root.querySelector('.chat-evidence-preview'); const resume=root.querySelector('.chat-task-run button'); resume?.click();
  const textarea=root.querySelector('.chat-composer textarea'); let sent=false; textarea.value='继续'; textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); sent=intents.some(i=>i.type==='conversation/send');
  renderChatPanel(root,presentChatPanel(projector.reset(snapshot({evidence:[{...task.evidence[0],previewDataUrl:undefined}]}))),intent=>intents.push(intent));
  const result={task:!!root.querySelector('[aria-label="Agent task status and acceptance evidence"]'),acceptance:root.textContent.includes('验收标准'),imageReleased:!oldImage.hasAttribute('src'),timelineRows:root.querySelectorAll('.chat-task-timeline li').length,resume:intents.some(i=>i.type==='conversation/retry'),keyboard:sent,aria:!!root.querySelector('[aria-current="step"]'),bilingual:root.textContent.includes('Backend capabilities')&&root.textContent.includes('任务状态与验收证据')};
  document.body.dataset.g11Result=JSON.stringify(result); document.body.dataset.g11Status=Object.values(result).every(Boolean)?'passed':'failed'; if(document.body.dataset.g11Status==='failed')document.body.dataset.g11Error=JSON.stringify(result);
  `; }

function run(command, args, env) { return new Promise((resolve, reject) => { const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; }); child.once('error', reject); child.once('exit', (code) => resolve({ code, output })); }); }
