import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolPreferences } from '../dist/tool-preferences.js';
import { parseToolPreferences } from '../dist/tool-preferences-model.js';
import { loadParallelQualification } from '../dist/parallel-qualification.js';
import { validateStudioIpcRequest } from '../dist/ipc.js';

test('tool switches persist for restart, respect deployment disable and omit unavailable runtimes',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'p1-tool-settings-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const prefs=new ToolPreferences(path.join(dir,'settings.json'));await prefs.initialize();
 await prefs.configure({web:true,browser:true,node:true,browserBackend:'playwright'});
 const config=await prefs.configuration('harness-api-key',{AI_STUDIO_WEB_TOOLS:'0',AI_STUDIO_BROWSER_EXECUTABLE:'/missing/chrome',AI_STUDIO_NODE_EXECUTABLE:'/missing/node'});
 assert.equal(config.web,false);assert.equal(config.browser,undefined);assert.equal(config.node,undefined);assert.equal(prefs.snapshot().capabilities.browser.reason,'browser-executable-unavailable');
 assert.ok(!JSON.stringify(prefs.snapshot()).includes('/missing'));
 await prefs.configure({web:false,browser:false,node:false,browserBackend:'chrome-devtools'});assert.equal(prefs.snapshot().restartRequired,true);
 await prefs.dispose();const next=new ToolPreferences(path.join(dir,'settings.json'));await next.initialize();assert.equal(next.snapshot().preferences.browserBackend,'chrome-devtools');assert.equal(next.snapshot().restartRequired,false);await next.dispose();
 assert.throws(()=>parseToolPreferences({web:true,browser:true,node:true,browserBackend:'playwright',apiKey:'secret'}));
 const envelope={schemaVersion:1,id:'ipc:one',correlationId:'corr:one',channel:'tools/configure',payload:{preferences:{web:true,browser:false,node:false,browserBackend:'playwright'}}};assert.ok(validateStudioIpcRequest(envelope));assert.throws(()=>validateStudioIpcRequest({...envelope,payload:{...envelope.payload,executablePath:'/tmp/model'}}));
});
test('parallel product admission fails closed without matching immutable measured evidence',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'p1-qualification-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'qualification.json');
 assert.equal((await loadParallelQualification(file,'revision:one')).create,undefined);
 await writeFile(file,JSON.stringify({schemaVersion:1,sourceRevision:'old',cohort:'independent-artifact-research-v1',expiresAt:Date.now()+60000,reportRef:'fake',artifacts:[]}));
 assert.equal((await loadParallelQualification(file,'revision:one')).create,undefined);
});

test('product parallel loader retains CAS evidence and still rejects unmeasured qualification before child dispatch',async t=>{
 const {canonicalStringify,sha256,OperationLog}=await import('@haiyue/ai-studio-operation-log');
 const {qualifySubtasks}=await import('@haiyue/ai-studio-agent-orchestration');
 const dir=await mkdtemp(path.join(tmpdir(),'p1-qualified-entry-')),log=await OperationLog.open({rootDirectory:path.join(dir,'log'),appVersion:'test'});
 t.after(async()=>{await log.close();await rm(dir,{recursive:true,force:true});});
 const value={schemaVersion:1,measurement:'synthetic-validator-fixture'},ref=`artifact:sha256:${sha256(canonicalStringify(value))}`;
 const file=path.join(dir,'qualification.json');await writeFile(file,JSON.stringify({schemaVersion:1,sourceRevision:'revision:test',cohort:'independent-artifact-research-v1',expiresAt:Date.now()+60000,reportRef:ref,artifacts:[{ref,value}]}));
 const loaded=await loadParallelQualification(file,'revision:test');assert.equal(typeof loaded.create,'function');
 const runtime={registry:{get:()=>({descriptor:{kind:'harness-api-key'},requestContextMode:'per-request',async detach(){}})}};
 const options=loaded.create(runtime,log,{backendId:'backend:test',model:'fixture-model'},async()=>[]);
 const signal=new AbortController().signal;assert.deepEqual(await options.qualification.load(ref,signal),value);const events=(await log.query({kinds:['agent/parallel-evidence'],limit:10,traverseCorrelation:false})).events;assert.equal(events.length,1);const retained=(await log.readArtifact(events[0].artifactRefs[0])).value;assert.deepEqual(retained.artifacts,[{ref,value}]);
 assert.equal(await qualifySubtasks(options.qualification,ref,{backendId:'backend:test',model:'fixture-model',profileDigest:`sha256:${'a'.repeat(64)}`,registryDigest:`sha256:${'b'.repeat(64)}`},[],signal),null);
});
