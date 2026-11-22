import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import electron from 'electron';
import {ScriptValidationWorker} from '@haiyue/ai-studio-script-preview';
import {SCRIPT_CAPABILITIES} from '@haiyue/engine/components';

test('HTTPS mobile player normalizes trusted mouse chords and Safari-sized touch ids in the isolated runtime', {timeout:85000},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'haiyue-mobile-native-')),output=process.env.HAIYUE_M14_G09_OUTPUT?path.join(process.env.HAIYUE_M14_G09_OUTPUT,'mobile-preview'):path.join(root,'evidence');await mkdir(output,{recursive:true});
 const source=`const memory=component.data as unknown as {edges?:{phase:string;button:number;pointerId:number}[]};
 memory.edges??=[];
 for(const e of api.input.pointerEvents())memory.edges.push({phase:e.type,button:e.button??-1,pointerId:e.pointerId});
 memory.edges=memory.edges.slice(-32);
 api.scene.observe('native-buttons',{edges:memory.edges});`;
 const validator=new ScriptValidationWorker();let validated;try{validated=await validator.validate({scriptId:'script:mobile',textRevision:1,sourcePath:'scripts/mobile.ts',text:source,capabilities:['input','scene']});assert.deepEqual(validated.diagnostics,[]);}finally{await validator.dispose();}
 const scene={documentId:'document:mobile-native',revision:1,assets:[],entities:[{id:'entity:mobile',name:'Native input observer',kind:'cube',parentId:null,order:0,appearance:{material:'basic',color:[.3,.6,1,1]},transform:{position:{x:0,y:0,z:0},rotationDegrees:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}},components:[]}]};
 const plan={id:'preview-plan:mobile-native',documentId:scene.documentId,documentRevision:1,selection:'all-enabled',scriptSetDigest:'sha256:'+'a'.repeat(64),scripts:[{scriptId:'script:mobile',entityId:'entity:mobile',order:0,textRevision:1,digest:'a'.repeat(64),capabilities:['input','scene'],diagnostics:[],emittedText:validated.emittedText}],capabilities:['input','scene'],runtimeConfig:{schemaVersion:1,mode:'fixed-step',tickRateHz:60,maxSubSteps:1000,seed:'native-mobile'},risk:'trusted-project',diagnostics:[]};
 plan.capabilities=SCRIPT_CAPABILITIES.filter(c=>plan.capabilities.includes(c));
 plan.runtimeConfig.seed='haiyue-play';
 await writeFile(path.join(root,'game.json'),JSON.stringify({name:'Native input fixture',scene,plan,assets:[],viewport:{width:600,height:800}}));
 const env={...process.env,HAIYUE_MOBILE_ROOT:root,HAIYUE_MOBILE_OUTPUT:output};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
 const result=await new Promise((resolve,reject)=>{const child=spawn(electron,[fileURLToPath(new URL('./fixtures/mobile-preview-main.mjs',import.meta.url))],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let text='';const timer=setTimeout(()=>child.kill(),75000);child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve({code,text});});});
 assert.equal(result.code,0,result.text);const receipt=JSON.parse(await readFile(path.join(output,'result.json'),'utf8'));assert.equal(receipt.security.secure,true);assert.equal(receipt.revoked,true);assert.equal(receipt.samples.length,2);assert.equal(receipt.restarted,true);assert.equal(receipt.safariTouch,true);assert.equal(receipt.viewportSamples.length,4);
});
