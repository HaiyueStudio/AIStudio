import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import electronPath from 'electron';
import { build } from 'esbuild';

test('Electron experience UI requires reviewed applicability, supports editing/disable and clears old-project data',{timeout:60000},async()=>{
  const output=await mkdtemp(path.join(tmpdir(),'haiyue-experience-ui-'));
  const entry=fileURLToPath(new URL('../../../packages/studio-shell/dist/panels/history/reviews.js',import.meta.url));
  await build({stdin:{contents:browserSource(entry),resolveDir:path.dirname(entry)},outfile:path.join(output,'app.js'),bundle:true,format:'esm',platform:'browser',target:'chrome132'});
  const styles=await readFile(new URL('../renderer/styles.css',import.meta.url),'utf8');
  await writeFile(path.join(output,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${styles}body{height:100vh;padding:16px}main{height:100%;max-width:480px;margin:auto;overflow:auto}</style><main><div id="agent-review-viewer"></div></main><script type="module" src="./app.js"></script></html>`);
  const fixture=fileURLToPath(new URL('./fixtures/project-history-electron-main.mjs',import.meta.url));
  const env={...process.env,HAIYUE_HISTORY_UI_ROOT:output};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
  const result=await new Promise((resolve,reject)=>{const child=spawn(electronPath,[fixture],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let text='';const timer=setTimeout(()=>child.kill(),55000);child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);resolve({code,text});});});
  assert.equal(result.code,0,result.text);assert.ok((await readFile(path.join(output,'project-history.png'))).byteLength>10000);console.log(`Experience screenshot: ${path.join(output,'project-history.png')}`);
});
function browserSource(entry){return `
import { AgentReviewViewer } from ${JSON.stringify(entry.replaceAll('\\','/'))};
const root=document.querySelector('#agent-review-viewer'),at='2026-10-11T00:00:00.000Z';
const finding={code:'tool-failure',severity:'warning',title:'棋盘朝向',detail:'XY 平面朝向与水平面不一致。',recommendation:'检查创建平面的坐标系，再设置朝向。',recordIds:['record:1']};
const report={schemaVersion:1,ruleVersion:'1.0.0',projectId:'project:a',taskId:'task:a',taskRevision:1,title:'制作棋盘游戏',outcome:'blocked',generatedAt:at,sourceDigest:'a'.repeat(64),coverage:{records:1,missing:0,partial:false,omittedEvidence:0},metrics:{toolCalls:1,failed:1,cancelled:0,suspended:0,repeatedFailures:0,userMessages:1,durationMs:2000,repairs:0},findings:[finding],evidence:[{recordId:'record:1',kind:'tool-result',toolId:'scene.create',status:'failed',startedAt:at,durationMs:20}],deep:null};
let adopted=0,updated=0,entries=[],reuseGate=null;const reuseStates=new Map();
const reuseState=projectId=>reuseStates.get(projectId)??{schemaVersion:1,projectId,revision:0,paused:false,updatedAt:null};
const viewer=new AgentReviewViewer(root,{
 async list(projectId){return {projectId,records:projectId==='project:a'?[{...report,findingCount:1}]:[],error:null};},async read(){return report;},async evidence(){return {};},async deepen(){throw new Error('No AI requested');},
 experiences:{async list(projectId){return {schemaVersion:1,projectId,revision:entries.length,entries:projectId==='project:a'?entries:[],reuse:reuseState(projectId),reuseError:null,error:null,uses:entries.length?[{taskId:'task:next',at,experienceIds:[entries[0].id]}]:[]};},
 async setReuse(input){await reuseGate;const old=reuseState(input.projectId);if(input.expectedRevision!==old.revision)throw new Error('stale reuse state');const next={...old,revision:old.revision+1,paused:input.paused,updatedAt:at};reuseStates.set(input.projectId,next);return next;},
 async adopt(input){adopted++;const entry={schemaVersion:1,id:'experience:1',projectId:input.projectId,revision:1,enabled:true,createdAt:at,updatedAt:at,...input.draft,source:{taskId:report.taskId,taskRevision:1,reviewDigest:report.sourceDigest,reviewArtifactId:'artifact:review',findingSource:input.findingSource,finding:input.finding}};entries=[entry];return entry;},
 async update(projectId,entry,draft,enabled){if(projectId!=='project:a'||entry.revision!==entries[0].revision)throw new Error('stale revision');updated++;const next={...entry,...draft,enabled,revision:entry.revision+1};entries=[next];return next;}}
});
const wait=async(predicate,label)=>{const until=Date.now()+5000;while(!predicate()){if(Date.now()>until)throw new Error('Experience UI timeout: '+label);await new Promise(r=>setTimeout(r,20));}};
const button=text=>[...root.querySelectorAll('button')].find(b=>b.textContent===text);
try{
 viewer.setProject('project:a','project');await wait(()=>root.querySelector('[data-review-task]'),'report');root.querySelector('[data-review-task] > summary').click();await wait(()=>button('整理为经验'),'adopt button');
 if(adopted!==0)throw new Error('Auto adoption');button('整理为经验').click();await wait(()=>root.querySelector('form'),'draft');
 const form=root.querySelector('form');form.querySelector('[aria-label^="匹配关键词"]').value='棋盘, 旋转';form.querySelector('[aria-label="适用条件"]').value='创建平面棋盘时';
 form.querySelector('[aria-label="至少命中几个关键词"]').value='2';form.querySelector('[aria-label^="必须出现"]').value='棋盘';form.querySelector('[aria-label^="排除词"]').value='海报';
 viewer.setBusy(true);if(!form.querySelector('[type="submit"]').disabled)throw new Error('Busy adoption enabled');viewer.setBusy(false);
 form.requestSubmit();await wait(()=>adopted===1&&!root.querySelector('form'),'adopted');await wait(()=>root.querySelector('[data-experience-id]'),'entry');root.querySelector('[data-experience-library]').open=true;
 if(!root.textContent.includes('task:next'))throw new Error('Citation missing');button('停用').click();await wait(()=>button('重新启用'),'disabled');
 if(entries[0].matching?.minimumMatches!==2||entries[0].matching?.requiredKeywords[0]!=='棋盘'||entries[0].matching?.excludedKeywords[0]!=='海报')throw new Error('Trigger rules lost on toggle');
 if(entries[0].enabled||updated!==1)throw new Error('Disable not persisted');button('编辑经验').click();await wait(()=>root.querySelector('form'),'edit');
 root.querySelector('form [aria-label="经验建议"]').value='<img src=x onerror=alert(1)>检查 XZ 平面';
 viewer.setBusy(true);if(button('立即暂停经验复用').disabled)throw new Error('Pause unavailable while busy');button('立即暂停经验复用').click();await wait(()=>button('恢复经验复用')&&!button('恢复经验复用').disabled,'paused while busy');
 if(!root.querySelector('form [aria-label="经验建议"]').value.includes('XZ'))throw new Error('Pause destroyed unsaved draft');viewer.setBusy(false);
 root.querySelector('form').requestSubmit();await wait(()=>updated===2&&!root.querySelector('form'),'edited');
 if(entries[0].matching?.minimumMatches!==2)throw new Error('Trigger rules lost on edit');
 if(root.querySelector('img'))throw new Error('Advice HTML executed');button('重新启用').click();await wait(()=>button('停用'),'reenabled');
 let complete;reuseGate=new Promise(resolve=>complete=resolve);button('恢复经验复用').click();viewer.setProject('project:b','project');await wait(()=>root.textContent.includes('还没有确认的经验'),'project switched');complete();await new Promise(r=>setTimeout(r,30));reuseGate=null;
 if(root.textContent.includes('XZ')||root.textContent.includes('task:next')||!button('立即暂停经验复用'))throw new Error('Cross-project leak');
 viewer.setProject('project:a','project');await wait(()=>root.querySelector('[data-experience-library]'),'return');root.querySelector('[data-experience-library]').open=true;
 if(root.scrollWidth>root.clientWidth+1)throw new Error('Experience UI overflows');document.body.dataset.historyStatus='passed';
}catch(cause){document.body.dataset.historyStatus='failed';document.body.dataset.historyError=String(cause);}
`;}
