import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import electronPath from 'electron';
import { build } from 'esbuild';

test('G09 real Electron renders an accessible replayed graph and bounded large-graph layout', { timeout: 100_000 }, async () => {
  const output = process.env.HAIYUE_G09_FIXTURE_ROOT ?? await mkdtemp(path.join(tmpdir(), 'haiyue-g09-execution-graph-'));
  await mkdir(output, { recursive: true });
  const screenshot = process.env.HAIYUE_G09_SCREENSHOT_OUT ?? path.join(output, 'execution-graph.png');
  const shellEntry = path.resolve(new URL('../../../packages/studio-shell/dist/index.js', import.meta.url).pathname.replace(/^\/(.:\/)/u, '$1'));
  await build({ stdin: { contents: appSource(shellEntry), resolveDir: path.dirname(shellEntry), sourcefile: 'g09-execution-graph-app.ts' }, outfile: path.join(output, 'app.js'), bundle: true, format: 'esm', platform: 'browser', target: 'chrome132' });
  const studioStyles = await readFile(new URL('../renderer/styles.css', import.meta.url), 'utf8');
  await writeFile(path.join(output, 'host.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>html,body{margin:0;background:#080d18;color:#e8eefc;font:14px system-ui}body{padding:18px}.chat-content{height:940px;max-width:1400px;margin:auto}${studioStyles}</style></head><body><main id="root" class="chat-content"></main><script type="module" src="./app.js"></script></body></html>`);
  const fixture = new URL('./fixtures/g09-execution-graph-main.mjs', import.meta.url).pathname.replace(/^\/(.:\/)/u, '$1');
  const result = await run(electronPath, [fixture], { ...process.env, HAIYUE_G09_GRAPH_ROOT: output, HAIYUE_G09_USER_DATA: path.join(output, 'user-data'), HAIYUE_G09_SCREENSHOT_OUT: screenshot });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /\[g09-execution-graph-smoke\].*"graph":true.*"transcript":true.*"keyboard":true.*"idempotent":true.*"accessible":true/u);
  const png = await readFile(screenshot);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.byteLength > 20_000, `execution graph screenshot is unexpectedly small: ${png.byteLength}`);
});

function appSource(shellEntry) { return `
import { ConversationProjector, layoutExecutionGraph, presentChatPanel, projectExecutionGraph, renderChatPanel } from ${JSON.stringify(shellEntry.replaceAll('\\', '/'))};
const backendId='backend:g09-ui',sessionId='session:g09-ui',turnId='turn:g09-ui';
const pressure={maxInputTokens:100000,reservedOutputTokens:10000,reservedSafetyTokens:10000,usedInputTokens:64000,ratio:.8,measurement:'tokenizer-estimated',state:'compact-required'};
const afterPressure={...pressure,usedInputTokens:48000,ratio:.6,state:'normal'};
const compaction={id:'compaction:g09-ui',reason:'manual',coveredStartSequence:1,coveredEndSequence:4,before:pressure,after:afterPressure,sourceSurfaceGeneration:0,targetSurfaceGeneration:1,summaryArtifactId:'artifact:summary',pinnedFactDigests:[],validation:'passed',diagnostic:null};
const makeOp=(sequence,kind,options={})=>({schemaVersion:1,id:'op:'+sequence,sessionId,sequence,kind,timestamp:new Date(Date.UTC(2026,8,2,0,0,sequence)).toISOString(),turnId:options.turnId===undefined?turnId:options.turnId,stepId:null,batchId:options.batchId??null,nodeId:options.nodeId??null,parentOpId:options.parentOpId??null,dependsOn:options.dependsOn??[],projectRevision:options.projectRevision??null,artifactRefs:options.artifactRefs??[],payload:options.payload??{},payloadDigest:'sha256:'+String(sequence).padStart(64,'0')});
const ops=[
  makeOp(0,'session.created',{turnId:null,payload:{activeGoal:'创建并验证一个跨类型游戏交互'}}),makeOp(1,'turn.started',{payload:{title:'实现游戏交互'}}),makeOp(2,'user.message',{artifactRefs:['artifact:user']}),
  makeOp(3,'tool-batch.planned',{batchId:'batch:1'}),makeOp(4,'tool-batch.started',{batchId:'batch:1'}),
  makeOp(5,'tool-batch.planned',{batchId:'batch:1',nodeId:'node:scene',payload:{toolId:'scene.diff',executionClass:'parallel-read'}}),makeOp(6,'tool.started',{batchId:'batch:1',nodeId:'node:scene',payload:{toolId:'scene.diff'}}),
  makeOp(7,'tool-batch.planned',{batchId:'batch:1',nodeId:'node:diagnostics',payload:{toolId:'diagnostics.query',executionClass:'parallel-read'}}),makeOp(8,'tool.started',{batchId:'batch:1',nodeId:'node:diagnostics',payload:{toolId:'diagnostics.query'}}),
  makeOp(9,'tool.completed',{batchId:'batch:1',nodeId:'node:scene',payload:{toolId:'scene.diff',status:'completed'}}),makeOp(10,'tool.completed',{batchId:'batch:1',nodeId:'node:diagnostics',payload:{toolId:'diagnostics.query',status:'completed'}}),
  makeOp(11,'document.committed',{projectRevision:9,artifactRefs:['receipt:9'],payload:{transactionId:'transaction:9',beforeRevision:8,afterRevision:9,memberNodeIds:['node:scene']}}),
  makeOp(12,'approval.requested',{nodeId:'approval:run',payload:{approvalId:'approval:run',barrierKind:'runtime-start',reason:'运行隔离预览'}}),makeOp(13,'approval.resolved',{nodeId:'approval:run',payload:{approvalId:'approval:run',resolution:'allow-once'}}),
  makeOp(14,'evidence.captured',{nodeId:'evidence:screenshot',projectRevision:9,artifactRefs:['artifact:screenshot'],payload:{evidenceType:'screenshot',transactionId:'transaction:9',summary:'运行画面已采集',pressure}}),
  makeOp(15,'evaluation.completed',{nodeId:'evaluation:1',projectRevision:9,artifactRefs:['artifact:evaluator'],payload:{status:'passed',transactionId:'transaction:9',summary:'交互验收通过'}}),
  makeOp(16,'compaction.completed',{nodeId:'compaction:g09-ui',artifactRefs:['artifact:summary'],payload:{phase:'completed',compaction}}),makeOp(17,'tool-batch.completed',{batchId:'batch:1',payload:{status:'completed'}}),makeOp(18,'assistant.message',{artifactRefs:['artifact:assistant']}),makeOp(19,'turn.completed',{payload:{status:'completed',summary:'游戏交互已完成并验证'}})
];
const transcript=[{id:'transcript:user',opId:'op:2',role:'user',content:'创建一个可运行并经过验证的游戏。',timestamp:ops[2].timestamp},{id:'transcript:assistant',opId:'op:18',role:'assistant',content:'实现、运行和验证已经完成。',timestamp:ops[18].timestamp}];
const graph=projectExecutionGraph({sessionId,activeGoal:'创建并验证一个跨类型游戏交互',status:'completed',ops,transcript});
const backend={id:backendId,label:'Fixture',kind:'harness-api-key',state:'ready',authMode:'api-key',protocolVersion:'fixture',capabilities:{resume:true,questions:true,structuredTools:true,backendApprovals:false,usage:true,rateLimits:true},promptProfile:null,rateLimits:[],models:[{id:'fixture-model',label:'Fixture',reasoningEfforts:['high'],defaultReasoningEffort:'high',maxOutputTokens:8192,isDefault:true}],selectedModel:'fixture-model',selectedReasoningEffort:'high',outputTokenLimit:4096};
const snapshot={revision:1,connection:'connected',busy:false,backendId,backends:[backend],taskAccounting:{taskId:'task:g09-ui',budgetStatus:'within',budget:{schemaVersion:2,id:'budget:g09-ui',enforcement:'hard',limits:{inputTokens:100000,outputTokens:10000,estimatedCostMicros:1000000,wallTimeMs:600000,turns:30,toolCalls:100,repairIterations:4,observationBytes:1000000}},usage:{inputTokens:12000,cachedInputTokens:4000,outputTokens:1200,reasoningTokens:600,toolInputBytes:1000,toolOutputBytes:2000,wallTimeMs:8000,contextCache:{localArtifactHits:5,localArtifactMisses:1,deltaReuseBytes:4096,providerCacheEligibleBytes:8192,providerReportedHitTokens:null}},cost:{status:'unknown',amountMicros:null,currency:null,cacheSavingMicros:null,explanation:'Provider subscription did not expose billable cost.',final:true}},taskRuns:[],executionGraphs:[graph],events:[]};
const root=document.querySelector('#root'),intents=[]; const projector=new ConversationProjector(); const model=presentChatPanel(projector.reset(snapshot));
const renderStarted=performance.now(); renderChatPanel(root,model,intent=>intents.push(intent)); const renderMs=performance.now()-renderStarted;
const graphVisible=!!root.querySelector('[aria-label="Agent execution graph and transcript"]')&&root.querySelectorAll('.execution-node').length>3&&root.querySelectorAll('.execution-edges path').length>0;
const firstNode=root.querySelector('.execution-node'); firstNode?.focus(); firstNode?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); const keyboard=document.activeElement?.classList.contains('execution-node')===true;
const compact=[...root.querySelectorAll('button')].find(button=>button.textContent==='压缩上下文'); compact?.click(); compact?.click(); const idempotent=intents.filter(intent=>intent.type==='conversation/request-compaction').length===1;
const transcriptTab=[...root.querySelectorAll('[role="tab"]')].find(button=>button.textContent.startsWith('完整记录')); transcriptTab?.click(); const transcriptVisible=!!root.querySelector('.execution-transcript')&&root.textContent.includes('实现、运行和验证已经完成');
const locate=[...root.querySelectorAll('button')].find(button=>button.textContent==='在拓扑中定位'); locate?.click();
const accessible=!!root.querySelector('.execution-accessible-list')&&root.textContent.includes('使用层级列表浏览全部执行步骤');
const largeOps=[makeOp(0,'session.created',{turnId:null}),makeOp(1,'turn.started'),makeOp(2,'tool-batch.planned',{batchId:'batch:large'}),makeOp(3,'tool-batch.started',{batchId:'batch:large'})]; let sequence=4;
for(let i=0;i<1000;i++){const nodeId='node:large:'+i;largeOps.push(makeOp(sequence++,'tool-batch.planned',{batchId:'batch:large',nodeId,payload:{toolId:'scene.query',executionClass:'parallel-read'}}),makeOp(sequence++,'tool.started',{batchId:'batch:large',nodeId,payload:{toolId:'scene.query'}}),makeOp(sequence++,'tool.completed',{batchId:'batch:large',nodeId,payload:{toolId:'scene.query',status:'completed'}}));} largeOps.push(makeOp(sequence++,'tool-batch.completed',{batchId:'batch:large',payload:{status:'completed'}}),makeOp(sequence++,'turn.completed',{payload:{status:'completed'}}));
const projectionStarted=performance.now();const largeGraph=projectExecutionGraph({sessionId,ops:largeOps});const projectionMs=performance.now()-projectionStarted;const layoutStarted=performance.now();const largeLayout=layoutExecutionGraph(largeGraph);const layoutMs=performance.now()-layoutStarted;
const result={graph:graphVisible,transcript:transcriptVisible,keyboard,idempotent,accessible,digest:/^sha256:[a-f0-9]{64}$/.test(graph.digest),parallel:graph.edges.some(edge=>edge.kind==='parallel-with'),large:largeGraph.nodes.filter(node=>node.kind==='tool').length===1000&&largeLayout.visibleNodeIds.length<100,renderBudget:renderMs<1500,projectionBudget:projectionMs<1500,layoutBudget:layoutMs<100,renderMs,projectionMs,layoutMs};
document.body.dataset.g09Result=JSON.stringify(result);document.body.dataset.g09Status=Object.entries(result).filter(([key])=>!key.endsWith('Ms')).every(([,value])=>value===true)?'passed':'failed';if(document.body.dataset.g09Status==='failed')document.body.dataset.g09Error=JSON.stringify(result);
`; }

function run(command, args, env) { return new Promise((resolve, reject) => { const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output=''; child.stdout.on('data',(chunk)=>{output+=chunk;}); child.stderr.on('data',(chunk)=>{output+=chunk;}); child.once('error',reject); child.once('exit',(code)=>resolve({code,output})); }); }
