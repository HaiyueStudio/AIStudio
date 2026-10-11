import { app, BrowserWindow, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OperationLog, ProjectAgentHistory } from '@haiyue/ai-studio-operation-log';
import { ProjectExperiences } from '../../../../packages/agent-orchestration/dist/project-experiences.js';

const root=process.env.HAIYUE_OPTIMIZATION_UI_ROOT;
if(!root)throw new Error('Missing fixture output directory');
app.setPath('userData',path.join(root,'user-data'));app.disableHardwareAcceleration();
let finished=false,log,history,store;
const deadline=setTimeout(()=>void finish(1,'Optimization UI timed out'),45000);
app.whenReady().then(async()=>{
  log=await OperationLog.open({rootDirectory:path.join(root,'global'),appVersion:'test'});
  history=await ProjectAgentHistory.open({source:log,projectId:'project:a',directory:path.join(root,'project','.aistudio','agent'),storage:'project'});
  const at='2026-10-11T00:00:00.000Z';
  const finding={code:'revision',severity:'warning',title:'避免重复读取',detail:'相同版本多次读取。',recommendation:'复用未变化的读取结果，写入前确认当前版本。',recordIds:['record:1']};
  const report={schemaVersion:1,ruleVersion:'1.0.0',projectId:'project:a',taskId:'task:source',taskRevision:1,title:'制作游戏',outcome:'completed',generatedAt:at,sourceDigest:'a'.repeat(64),coverage:{records:1,missing:0,partial:false,omittedEvidence:0},metrics:{toolCalls:3,failed:0,cancelled:0,suspended:0,repeatedFailures:0,userMessages:1,durationMs:100,repairs:0},findings:[finding],evidence:[{recordId:'record:1',kind:'tool-result',toolId:'project.snapshot',status:'completed',startedAt:at,durationMs:20}],deep:null};
  store=new ProjectExperiences({projectId:'project:a',log:history.log,busy:()=>false,review:async()=>report,flush:()=>history.flush(),changed:()=>{}});
  await store.adopt({schemaVersion:1,projectId:'project:a',taskId:report.taskId,reviewDigest:report.sourceDigest,findingSource:'rules',finding,draft:{title:'减少重复读取',condition:'编辑棋盘时',recommendation:finding.recommendation,keywords:['棋盘']}});
  const window=new BrowserWindow({width:560,height:940,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false,preload:path.join(root,'preload.cjs')}});
  ipcMain.handle('optimization-fixture',async(event,kind,input)=>{
    if(event.sender!==window.webContents)throw new Error('Unexpected sender');
    if(kind==='generate-ai-candidate') {
      await store.dispose();
      const aiReport={...report,taskId:'task:ai-source',title:'材质绘制任务',sourceDigest:'c'.repeat(64)};
      store=new ProjectExperiences({projectId:'project:a',log:history.log,busy:()=>false,review:async taskId=>taskId===aiReport.taskId?aiReport:report,flush:()=>history.flush(),changed:()=>{},suggest:async()=>{
        const accounting=await history.log.putArtifact({fixture:true},{schemaVersion:'fixture/1'});
        return {value:{schemaVersion:1,summary:'根据本次记录整理材质操作建议，等待审阅与验证。',proposals:[{findingIndex:0,draft:{title:'材质修改前确认版本',condition:'修改已有材质时',recommendation:'检查当前版本并复用未变化的读取结果。',keywords:['材质']},positiveRequest:'修改材质',negativeRequest:'调整窗口'}]},metadata:{createdAt:at,backendId:'backend:fixture',model:'fixture-model',usageLabel:'输入 100 · 输出 50 · 测试样本',accountingArtifactId:accounting.id}};
      }});
      await store.initialize();const artifact=await history.log.putArtifact(aiReport,{schemaVersion:'agent-task-review/1'});
      await history.log.append({kind:'agent/task-review',severity:'info',source:'test',correlation:{projectId:'project:a'},payload:{taskId:aiReport.taskId,taskRevision:aiReport.taskRevision,sourceDigest:aiReport.sourceDigest},artifactRefs:[artifact.id]});store.observeSuggestions();
      const deadline=Date.now()+5000;while((await store.optimizations()).automatic.status!=='completed'){if(Date.now()>deadline)throw new Error('AI candidate did not complete: '+JSON.stringify(await store.optimizations()));await new Promise(r=>setTimeout(r,10));}return true;
    }
    if(kind==='capture-ai'){await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');await writeFile(path.join(root,'experience-ai-candidate.png'),(await window.webContents.capturePage()).toPNG());return true;}
    if(kind==='effects')return store.effects(input);
    if(kind==='seed-effects'){
      const selected=await store.select('棋盘','task:effect:a'),empty={schemaVersion:1,projectId:'project:a',libraryRevision:0,libraryArtifactId:null,entries:[]};
      for(const [index,selection] of [empty,selected].entries()){
        const taskId='task:effect:'+index,sessionId='session:effect:'+index,turnId='turn:effect:'+index;
        const correlation={projectId:'project:a',sessionId,turnId};
        const append=async(kind,payload,value)=>{const artifact=value?await history.log.putArtifact(value,{schemaVersion:'fixture/1'}):null;return history.log.append({kind,severity:'info',source:'test.effects',correlation,payload,artifactRefs:artifact?[artifact.id]:[]});};
        const run={schemaVersion:1,revision:1,taskId,title:'真实任务对比测试样本 '+index,requestSummary:'测试',status:'completed',phase:'complete',startedAt:at,updatedAt:at,backendId:'backend:fixture',sessionId,turnId,model:{id:'fixture-model',reasoningEffort:'medium',outputTokenLimit:1000},promptProfile:{id:'profile:fixture',version:'1.0.0',digest:'sha256:'+'a'.repeat(64)},documentRevision:1,repairIteration:0,repairLimit:2,acceptance:[],evidence:[],timeline:[],terminalDiagnostic:null,resumable:false};
        await append('agent/task-turn-bound',{schemaVersion:1,taskId,backendId:run.backendId,config:{schemaVersion:2,backendId:run.backendId,model:run.model.id,reasoningEffort:'medium',outputTokenLimit:1000,taskBudgetId:'budget:effects',promptProfile:run.promptProfile,requestedCapabilities:[]}});
        const artifact=await history.log.putArtifact({selection},{schemaVersion:'context-artifact/2'});
        await history.log.append({kind:'agent/conversation-indexed',severity:'info',source:'test.effects',correlation,payload:{taskId,backendId:run.backendId,experienceAttribution:{schemaVersion:1,artifactId:artifact.id}},artifactRefs:[artifact.id]});
        await append('conversation/task-projected',{taskId,revision:1,status:'completed'},run);
        await append('agent/task-review',{taskId,taskRevision:1,sourceDigest:report.sourceDigest},{...report,taskId,title:run.title,metrics:{...report.metrics,toolCalls:index?3:6}});
      }
      return true;
    }
    if(kind==='capture-effects'){await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');await writeFile(path.join(root,'experience-effects.png'),(await window.webContents.capturePage()).toPNG());return true;}
    if(kind==='history')return store.optimizations(undefined,input);
    if(kind==='roll-many'){const view=await store.optimizations(),targets=view.state.releases.slice(0,2).map(r=>r.id);for(let i=0;i<21;i++){const state=(await store.optimizations()).state;await store.optimize({schemaVersion:1,projectId:'project:a',expectedRevision:state.revision,action:'rollback',releaseId:targets[i%2]});}return true;}
    if(kind==='list')return store.optimizations(input);
    if(kind==='experiences')return store.list();
    if(kind==='archives')return store.archivePage(input);
    if(kind==='archive')return store.archive(input);
    if(kind==='reuse')return store.setReuse(input);
    if(kind==='reopen'){await store.dispose();await history.dispose();history=await ProjectAgentHistory.open({source:log,projectId:'project:a',directory:path.join(root,'project','.aistudio','agent'),storage:'project'});store=new ProjectExperiences({projectId:'project:a',log:history.log,busy:()=>false,review:async()=>report,flush:()=>history.flush(),changed:()=>{}});return true;}
    if(kind==='command')return store.optimize(input);
    if(kind==='select')return store.select(input,'task:next');
    if(kind==='capture'){
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await new Promise(resolve=>setTimeout(resolve,100));
      await writeFile(path.join(root,'optimization-candidate.png'),(await window.webContents.capturePage()).toPNG());return true;
    }
    if(kind==='capture-archive') {
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await writeFile(path.join(root,'experience-archive.png'),(await window.webContents.capturePage()).toPNG());return true;
    }
    if(kind==='capture-report') {
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await new Promise(resolve=>setTimeout(resolve,100));await writeFile(path.join(root,'optimization-history-report.png'),(await window.webContents.capturePage()).toPNG());return true;
    }
    throw new Error('Unexpected fixture operation');
  });
  window.webContents.on('render-process-gone',(_event,details)=>void finish(1,JSON.stringify(details)));
  await window.loadFile(path.join(root,'index.html'));
  await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const poll=()=>{if(document.body.dataset.historyStatus==='passed')resolve();else if(document.body.dataset.historyStatus==='failed')reject(new Error(document.body.dataset.historyError));else setTimeout(poll,40);};poll();})`);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const screenshot=await window.webContents.capturePage();if(screenshot.isEmpty())throw new Error('Empty screenshot');await writeFile(path.join(root,'optimization-panel.png'),screenshot.toPNG());
  await finish(0,'optimization: candidate isolation, diff, cases, publication and rollback verified');
}).catch(cause=>void finish(1,cause instanceof Error?cause.stack:String(cause)));
async function finish(code,message){if(finished)return;finished=true;clearTimeout(deadline);console.log(message);try{await store?.dispose();await history?.dispose();await log?.close();}finally{app.exit(code);}}
