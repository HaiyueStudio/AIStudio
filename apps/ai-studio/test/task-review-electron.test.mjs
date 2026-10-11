import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import electronPath from 'electron';
import { build } from 'esbuild';

test('real Electron review panel shows evidence, invokes AI only on click, cancels and clears project data', {timeout:60000}, async()=>{
  const output=await mkdtemp(path.join(tmpdir(),'haiyue-review-ui-'));
  const entry=fileURLToPath(new URL('../../../packages/studio-shell/dist/panels/history/reviews.js',import.meta.url));
  await build({stdin:{contents:browserSource(entry),resolveDir:path.dirname(entry)},outfile:path.join(output,'app.js'),bundle:true,format:'esm',platform:'browser',target:'chrome132'});
  const styles=await readFile(new URL('../renderer/styles.css',import.meta.url),'utf8');
  await writeFile(path.join(output,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${styles}body{height:100vh;padding:16px}main{height:100%;max-width:480px;margin:auto}</style><main><div id="agent-review-viewer"></div></main><script type="module" src="./app.js"></script></html>`);
  const fixture=fileURLToPath(new URL('./fixtures/project-history-electron-main.mjs',import.meta.url));
  const env={...process.env,HAIYUE_HISTORY_UI_ROOT:output};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(electronPath,[fixture],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let text='';
    const timer=setTimeout(()=>child.kill(),55000);child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b);
    child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);resolve({code,text});});
  });
  assert.equal(result.code,0,result.text);assert.ok((await readFile(path.join(output,'project-history.png'))).byteLength>10000);
  console.log(`Review screenshot: ${path.join(output,'project-history.png')}`);
});
function browserSource(entry){return `
import { AgentReviewViewer } from ${JSON.stringify(entry.replaceAll('\\','/'))};
const root=document.querySelector('#agent-review-viewer'),at='2026-10-11T00:00:00.000Z';
const finding={code:'repeated-tool-failure',severity:'warning',title:'重复参数错误',detail:'观察到两次相同工具失败。',recommendation:'先读取参数约束，再重试。',recordIds:['record:1']};
const report={schemaVersion:1,ruleVersion:'1.0.0',projectId:'project:a',taskId:'task:a',taskRevision:1,title:'制作棋盘游戏',outcome:'blocked',generatedAt:at,sourceDigest:'a'.repeat(64),coverage:{records:4,missing:0,partial:false,omittedEvidence:0},metrics:{toolCalls:2,failed:2,cancelled:0,suspended:1,repeatedFailures:1,userMessages:1,durationMs:20000,repairs:1},findings:[finding],evidence:[{recordId:'record:1',kind:'tool-result',toolId:'scene.create',status:'failed',startedAt:at,durationMs:20}],deep:null};
let calls=0,aborts=0;
const viewer=new AgentReviewViewer(root,{
 async list(projectId,_signal,cursor){return {projectId,total:projectId==='project:a'?51:0,nextCursor:projectId==='project:a'&&!cursor?'1:50':null,records:projectId==='project:a'?[{...report,...(cursor?{taskId:'task:old',title:'很早以前的任务'}:{}),findingCount:1}]:[],error:null};},async read(_project,taskId){return taskId==='task:old'?{...report,taskId,title:'很早以前的任务'}:report;},
 async evidence(projectId,id){return {projectId,record:{id},data:{parameters:{plane:'xz'},result:{error:{code:'tool.arguments-invalid'}}}};},
 async deepen(projectId,taskId,signal){calls++;if(calls===1)return {...report,deep:{createdAt:at,backendId:'backend:test',model:'fixture-model',summary:'<img src=x onerror=alert(1)>先修正参数。',findings:[finding],usageLabel:'输入 100 · 输出 50',accountingArtifactId:'artifact:account'}};return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{aborts++;reject(new Error('cancelled'));},{once:true});});}
});
const wait=async predicate=>{const until=Date.now()+5000;while(!predicate()){if(Date.now()>until)throw new Error('Review UI timeout');await new Promise(r=>setTimeout(r,20));}};
const button=text=>[...root.querySelectorAll('button')].find(b=>b.textContent===text);
try{
 viewer.setProject('project:a','project');await wait(()=>root.querySelector('[data-review-task]'));button('更早报告').click();await wait(()=>root.textContent.includes('很早以前的任务'));root.querySelector('summary').click();await wait(()=>button('AI 深度复盘'));button('较新报告').click();await wait(()=>root.textContent.includes('制作棋盘游戏'));root.querySelector('summary').click();await wait(()=>button('AI 深度复盘'));
 if(calls!==0)throw new Error('AI ran without a click');
 root.querySelector('.agent-review-finding summary').click();await wait(()=>root.querySelector('pre')?.textContent.includes('xz'));
 viewer.setBusy(true);if(!button('AI 深度复盘').disabled)throw new Error('Busy task did not disable AI');viewer.setBusy(false);
 button('AI 深度复盘').click();await wait(()=>root.textContent.includes('fixture-model'));if(root.querySelector('img'))throw new Error('Model HTML executed');
 button('重新 AI 深度复盘').click();await wait(()=>!button('取消复盘').hidden);button('取消复盘').click();await wait(()=>root.textContent.includes('已取消'));
 if(aborts!==1)throw new Error('Cancel did not abort request');
 button('重新 AI 深度复盘').click();await wait(()=>calls===3);viewer.setProject('project:b','project');await wait(()=>root.textContent.includes('将自动生成报告'));
 if(root.textContent.includes('fixture-model')||root.textContent.includes('xz')||aborts!==2)throw new Error('Project switch leaked data or left AI running');
 viewer.setProject('project:a','project');await wait(()=>root.querySelector('summary'));root.querySelector('summary').click();await wait(()=>button('AI 深度复盘'));
 if(root.scrollWidth>root.clientWidth+1)throw new Error('Review overflows panel');
 document.body.dataset.historyStatus='passed';
}catch(cause){document.body.dataset.historyStatus='failed';document.body.dataset.historyError=String(cause);}
`;}
