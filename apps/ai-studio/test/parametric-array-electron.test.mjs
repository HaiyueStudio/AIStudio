import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import electron from 'electron';
import {EditorDocumentHost,EditorHistoryService,EditorProjectSessionState,EditorTaskCoordinator} from '@haiyue/editor-platform';
import {ProjectWorkspace,RecentProjectStore,ProjectSceneAuthoringService,planParametricArray} from '@haiyue/ai-studio-editor-plugins';
import {OperationLog} from '@haiyue/ai-studio-operation-log';
import {ScriptValidationWorker} from '@haiyue/ai-studio-script-preview';

test('real GPU editor and isolated Play restore compact arrays, preserve world transforms, allow script takeover and dispose', {timeout:90000}, async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'haiyue-parametric-array-'));
 const output=process.env.HAIYUE_M14_G09_OUTPUT?path.join(process.env.HAIYUE_M14_G09_OUTPUT,'parametric-arrays'):path.join(root,'evidence');await mkdir(output,{recursive:true});
 const log=await OperationLog.open({rootDirectory:path.join(root,'log'),appVersion:'array-test'});
 const resources={documents:new EditorDocumentHost(),history:new EditorHistoryService(),projectSession:new EditorProjectSessionState(),tasks:new EditorTaskCoordinator(),operationLog:log,recentProjects:new RecentProjectStore(path.join(root,'user'))};
 const workspace=new ProjectWorkspace(resources),scene=new ProjectSceneAuthoringService(workspace,log),validator=new ScriptValidationWorker();
 let snapshot,arrayRoot;
 try{
  await mkdir(path.join(root,'project'));
  await workspace.newProject(path.join(root,'project'),'Array GPU fixture');
  await scene.createEntity({commandId:'command:array-parent',baseRevision:1,kind:'empty',name:'Parent',transform:{position:{x:2,y:0,z:0},rotationDegrees:{x:0,y:0,z:90},scale:{x:1.5,y:1.5,z:1}}});
  const parent=scene.snapshot().entities[0].id;
  const plan=planParametricArray(workspace,{baseRevision:2,arrayId:'field',representation:'instances',parentId:parent,layout:{kind:'grid',rows:20,columns:20,origin:{x:-3.8,y:-3.8,z:0},spacing:{x:.4,y:.4},seed:11},template:{kind:'rounded-box',radius:.1,segments:3,scale:{x:.3,y:.3,z:.3},palette:[[1,0,0,1],[0,1,0,1],[0,0,1,1]]}},'command:array-field');
  await workspace.executeBatch({id:'command:array-field',baseRevision:2,label:'Populate array',operations:plan.operations});arrayRoot=plan.rootEntityId;
  const editable=planParametricArray(workspace,{baseRevision:3,arrayId:'editable',representation:'entities',layout:{kind:'grid',rows:2,columns:3,origin:{x:-7,y:-1,z:0},spacing:{x:.7,y:.7}},template:{kind:'sphere',scale:{x:.25,y:.25,z:.25},color:[1,1,0,1]}},'command:array-editable');
  await workspace.executeBatch({id:'command:array-editable',baseRevision:3,label:'Populate editable array',operations:editable.operations});
  await workspace.executeBatch({id:'command:array-camera',baseRevision:4,label:'Frame arrays',operations:[{op:'setting.set',key:'studio.camera.main',value:{projection:'orthographic',target:{x:0,y:0,z:0},distance:24,azimuthDegrees:0,elevationDegrees:0,fovDegrees:45,orthographicSize:16,near:.1,far:1000}}]});
  await workspace.save();await workspace.reopen();snapshot=scene.snapshot();
  assert.equal(snapshot.entities.length,9);assert.equal(snapshot.entities.filter(e=>e.components?.some(c=>c.type==='haiyue.scene.array')).length,2);
  const source=`const batch = api.scene.instances('${arrayRoot}');\nconst state = component.data as unknown as { initialized?: boolean };\nif (!state.initialized) { batch.set(0, { position: {x: 0, y: 0, z: 0}, color: [1, 1, 1, 1] }); state.initialized = true; }\napi.scene.observe('array-check', { capacity: batch.capacity });`;
  const validated=await validator.validate({scriptId:'script:array',textRevision:1,sourcePath:'scripts/array.ts',text:source,capabilities:['read','scene']});assert.deepEqual(validated.diagnostics,[]);
  const scriptPlan={id:'preview-plan:array',documentId:snapshot.documentId,documentRevision:snapshot.revision,selection:'all-enabled',scriptSetDigest:`sha256:${'a'.repeat(64)}`,scripts:[{scriptId:'script:array',entityId:arrayRoot,order:0,textRevision:1,digest:'a'.repeat(64),capabilities:['read','scene'],diagnostics:[],emittedText:validated.emittedText}],capabilities:['read','scene'],runtimeConfig:{schemaVersion:1,mode:'fixed-step',tickRateHz:60,maxSubSteps:1000,seed:'haiyue-play'},risk:'trusted-project',diagnostics:[]};
  await writeFile(path.join(root,'data.json'),JSON.stringify({snapshot,plan:scriptPlan,arrayRoot}));
 }finally{scene.dispose();await validator.dispose();await workspace.dispose();resources.tasks.dispose();await resources.documents.dispose();resources.history.dispose();resources.projectSession.dispose();await log.close();}
 await build({entryPoints:[fileURLToPath(new URL('./fixtures/parametric-array-browser.mjs',import.meta.url))],outfile:path.join(root,'browser.js'),bundle:true,format:'esm',platform:'browser',target:'chrome140',logLevel:'silent'});
 await writeFile(path.join(root,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:#050509}canvas,iframe{width:100%;height:100%;border:0;position:absolute;inset:0}</style></head><body><canvas id="canvas" width="800" height="600"></canvas><script type="module" src="browser.js"></script></body></html>');
 const env={...process.env,HAIYUE_ARRAY_TEST_ROOT:root,HAIYUE_ARRAY_OUTPUT:output,HAIYUE_ARRAY_PREVIEW_ROOT:fileURLToPath(new URL('../dist',import.meta.url))};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
 const result=await new Promise((resolve,reject)=>{const child=spawn(electron,[fileURLToPath(new URL('./fixtures/parametric-array-main.mjs',import.meta.url))],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let text='';const timer=setTimeout(()=>child.kill(),75000);child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve({code,text});});});
 assert.equal(result.code,0,result.text);const receipt=JSON.parse(await readFile(path.join(output,'result.json'),'utf8'));
 assert.equal(receipt.editor.count,400);assert.equal(receipt.reloaded.count,400);assert.equal(receipt.play.count,400);assert.equal(receipt.cleanup,0);
 assert.deepEqual(receipt.play.sample[0].position,[0,0,0]);assert.ok(receipt.coloredPixels>1000);assert.ok(receipt.capture.whitePixels>100);
 console.log(`[parametric-array] evidence: ${output}`);
});
