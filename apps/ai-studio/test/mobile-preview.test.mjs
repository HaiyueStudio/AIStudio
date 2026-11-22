import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {randomBytes,createCipheriv,createDecipheriv,X509Certificate,createHash} from 'node:crypto';
import {MobilePreviewServer} from '../dist/mobile-preview-server.js';
import {PointerButtonTracker,RuntimePointerIds} from '../dist/pointer-buttons.js';
import {StudioIpcRouter,validateStudioIpcRequest} from '../dist/ipc.js';

function protector(){const key=randomBytes(32);return {
 seal(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');},
 open(value){const bytes=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8');},
};}
const game={name:'Snapshot fixture',scene:{documentId:'document:mobile',revision:1,entities:[],assets:[]},plan:{id:'preview-plan:mobile',documentId:'document:mobile',documentRevision:1,selection:'all-enabled',scriptSetDigest:'sha256:'+'a'.repeat(64),scripts:[],capabilities:[],runtimeConfig:{schemaVersion:1,mode:'fixed-step',tickRateHz:60,maxSubSteps:1000,seed:1},risk:'trusted-project',diagnostics:[]},assets:[],viewport:{width:393,height:852}};

test('opaque Safari pointer ids are stable, collision-free and bounded without changing legal mouse ids',()=>{
 const ids=new RuntimePointerIds();assert.equal(ids.resolve(1),1);assert.equal(ids.resolve(123),123);
 const first=ids.resolve(2_147_483_647),second=ids.resolve(2_147_483_646);assert.equal(first,2);assert.equal(second,3);assert.equal(ids.resolve(2_147_483_647),first);
 ids.release(2_147_483_647);assert.equal(ids.resolve(2_147_483_645),first);assert.equal(ids.resolve(2_147_483_646),second);
 ids.clear();for(let i=0;i<500;i++){const browserId=2_000_000_000+i;assert.equal(ids.resolve(browserId),1);ids.release(browserId);}
 assert.equal(ids.resolve(Number.NaN),null);assert.equal(ids.resolve(Number.POSITIVE_INFINITY),null);
 for(let i=0;i<64;i++)assert.notEqual(ids.resolve(2_000_000_000+i),null);assert.equal(ids.resolve(2_100_000_000),null);assert.equal(ids.resolve(2_000_000_000),1);
 ids.clear();assert.equal(ids.resolve(0),0);assert.equal(ids.resolve(1_000_000),1_000_000);
});
async function fixture(options={}){const directory=await mkdtemp(path.join(tmpdir(),'haiyue-mobile-tls-'));const service=new MobilePreviewServer({dist:path.resolve('apps/ai-studio/dist'),certificateDirectory:directory,protector:protector(),addresses:()=>[{name:'test',address:'127.0.0.1'}],listenHost:'127.0.0.1',...options});return {directory,service};}
function request(url,ca,options={}){return new Promise((resolve,reject)=>{const req=https.request(url,{ca,agent:false,...options},response=>{let text='';response.setEncoding('utf8');response.on('data',part=>text+=part);response.on('end',()=>resolve({status:response.statusCode,text,headers:response.headers}));});req.on('error',reject);req.end();});}
function authority(info){return new X509Certificate(Buffer.from(info.certificateBase64,'base64')).toString();}

test('HTTPS snapshot is CA-verifiable, bounded to its routes, revocable and uses encrypted device keys',async()=>{
 const f=await fixture();
 try{
  const info=await f.service.start(game),url=info.urls[0].url,ca=authority(info);
  assert.equal((await request(url,ca)).status,200);
  const snapshot=await request(url+'snapshot.json',ca);assert.equal(snapshot.status,200);assert.equal(JSON.parse(snapshot.text).scene.documentId,'document:mobile');
  assert.equal((await request(url+'assets/'+'f'.repeat(24),ca)).status,404);
  for(const file of ['main.js','preload.cjs','authority.json','../authority.json','../../.haiyue-project.json'])assert.equal((await request(url+file,ca)).status,404,file);
  assert.equal((await request(url+'snapshot.json',ca,{headers:{origin:'https://unrelated.example'}})).status,403);
  assert.equal((await request(url,ca,{servername:'localhost',headers:{host:'unrelated.example:'+new URL(url).port}})).status,404);
  assert.equal((await request(url+'snapshot.json',ca,{method:'POST'})).status,404);
  const stored=await readFile(path.join(f.directory,'authority.json'),'utf8');assert.ok(!stored.includes('PRIVATE KEY'));assert.ok(JSON.parse(stored).encryptedKey);
  const next=await f.service.start(game);assert.equal(next.fingerprint,info.fingerprint);assert.notEqual(next.urls[0].url,url);
  await assert.rejects(request(url,ca));
  assert.equal((await request(next.urls[0].url,authority(next))).status,200);
  await f.service.stop();assert.equal(f.service.current(),null);await assert.rejects(request(next.urls[0].url,ca));
 }finally{await f.service.dispose();}
});

test('share transfers only referenced controlled assets, verifies their digest and aborts a read after document replacement',async()=>{
 const bytes=Buffer.from([1,2,3,4]),id='asset:'+'b'.repeat(24),asset={id,kind:'texture',mimeType:'image/png',byteLength:4,decodedBytes:16,digest:'sha256:'+createHash('sha256').update(bytes).digest('hex'),projectPath:'assets/controlled.png'};
 let revision=1,read=0,started=0,captured,afterRead=()=>{};
 const router=new StudioIpcRouter({workspace:{snapshot:()=>({document:{name:'fixture'}}),cancelAll(){},async readControlledAsset(){read++;afterRead();return bytes;}},scene:{snapshot:()=>({...game.scene,revision,assets:[asset,{...asset,id:'asset:'+'c'.repeat(24)}],entities:[{components:[{enabled:true,value:{textureAssetId:id}}]}]})},scripts:{consume:()=>game.plan},mobilePreview:{current:()=>null,async start(value){started++;captured=value;return {urls:[],documentRevision:1};},async stop(){}},operationLog:{async append(){}},conversation:{cancelPending(){}},agentPreview:{cancelPending(){}}});
 let serial=0;const call=(channel,payload={})=>router.handle({schemaVersion:1,id:'request:asset-share-'+serial++,correlationId:'correlation:asset-share',channel,payload}),share=()=>call('preview/share-start',{planId:game.plan.id,viewport:game.viewport});
 try{
  await call('preview/consume',{grantId:'preview-grant:fixture'});assert.equal((await share()).ok,true);assert.equal(read,1);assert.equal(started,1);assert.equal(captured.assets.length,1);assert.equal(captured.assets[0].base64,'AQIDBA==');assert.equal(captured.scene.assets.length,1);assert.ok(!JSON.stringify(captured).includes('assets/controlled.png'));
  bytes[0]=9;assert.equal((await share()).payload.diagnostic.code,'asset-integrity-failed');assert.equal(started,1);bytes[0]=1;
  afterRead=()=>{revision=2;};assert.equal((await share()).payload.diagnostic.code,'mobile-preview.stale-plan');assert.equal(started,1);
 }finally{router.dispose();}
});

test('stop/dispose during TLS preparation cannot publish a late share; concurrent starts keep the newest owner',async()=>{
 const f=await fixture();
 const pending=f.service.start(game);const rejected=assert.rejects(pending,/cancelled|disposed/);await f.service.dispose();await rejected;assert.equal(f.service.current(),null);
 const other=await fixture();
 try{
  const a=other.service.start(game),b=other.service.start(game);
  const results=await Promise.allSettled([a,b]);assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');assert.equal(other.service.current(),results[1].value);
 }finally{await other.service.dispose();}
});

test('share expires and no-network fails before listening',async()=>{
 const f=await fixture({ttlMs:120});
 try{const info=await f.service.start(game);await new Promise(resolve=>setTimeout(resolve,200));assert.equal(f.service.current(),null);await assert.rejects(request(info.urls[0].url,authority(info)));}finally{await f.service.dispose();}
 const none=await fixture({addresses:()=>[]});try{await assert.rejects(none.service.start(game),/no-network/);}finally{await none.service.dispose();}
});

test('DOM chord edges survive both press/release orders while ordinary movement, cancellation and pointer ownership remain distinct',()=>{
 for(const [first,second,firstMask] of [[0,2,1],[2,0,2]]){
  const tracker=new PointerButtonTracker(),event=(button,buttons,pointerId=1)=>({button,buttons,pointerId});
  assert.deepEqual(tracker.translate('move',event(-1,0)),[{phase:'move'}]);
  assert.deepEqual(tracker.translate('down',event(first,firstMask)),[{phase:'down',button:first}]);
  assert.deepEqual(tracker.translate('move',event(second,3)),[{phase:'down',button:second}]);
  assert.deepEqual(tracker.translate('move',event(-1,3)),[{phase:'move'}]);
  assert.deepEqual(tracker.translate('move',event(first,3^firstMask)),[{phase:'up',button:first}]);
  assert.deepEqual(tracker.translate('up',event(second,0)),[{phase:'up',button:second}]);assert.equal(tracker.has(1),false);
  tracker.translate('down',event(0,1,7));assert.deepEqual(tracker.translate('up',event(0,0,8)),[]);
  assert.deepEqual(tracker.pressed(7),[0]);assert.deepEqual(tracker.translate('cancel',event(-1,0,7)),[{phase:'cancel'}]);assert.deepEqual(tracker.pressed(7),[]);
 }
});

test('mobile sharing requires the exact consumed revision, remains independent of desktop viewport and stops with Play',async()=>{
 let revision=1,active=null,starts=0,stops=0;const events=[];
 const request=(channel,payload={})=>({schemaVersion:1,id:'request:share',correlationId:'correlation:share',channel,payload});
 const mobilePreview={current:()=>active,async start(value){starts++;active={urls:[{label:'test',url:'https://127.0.0.1:1234/s/'+'a'.repeat(32)+'/'}],expiresAt:Date.now()+60000,fingerprint:'public',certificateBase64:'public',documentRevision:value.scene.revision};return active;},async stop(){stops++;active=null;}};
 const router=new StudioIpcRouter({workspace:{snapshot:()=>({document:{name:'fixture',projectId:'project:fixture'}}),cancelAll(){}},scene:{snapshot:()=>({...game.scene,revision})},scripts:{consume:()=>game.plan},mobilePreview,operationLog:{async append(event){events.push(event);}},conversation:{cancelPending(){}},agentPreview:{cancelPending(){},observeStopped(){}}});
 const share=viewport=>router.handle(request('preview/share-start',{planId:game.plan.id,viewport:viewport??game.viewport}));
 try{
  assert.equal((await share()).payload.diagnostic.code,'mobile-preview.stale-plan');assert.equal(starts,0);
  assert.equal((await router.handle(request('preview/consume',{grantId:'preview-grant:fixture'}))).ok,true);
  assert.equal((await share()).ok,true);assert.equal((await share()).ok,true);assert.equal(starts,1);
  assert.equal((await share({width:800,height:600})).ok,true);assert.equal(starts,1);
  revision=2;assert.equal((await share()).payload.diagnostic.code,'mobile-preview.stale-plan');assert.equal(starts,1);
  revision=1;assert.equal((await router.handle(request('preview/report',{event:'stopped',message:'test',disposableCount:0}))).ok,true);assert.ok(stops>0);assert.equal((await share()).ok,false);
  assert.ok(!JSON.stringify(events).includes('https://')); // Link tokens and public/private certificates are not journal payloads.
 }finally{router.dispose();}
 for(const payload of [{planId:game.plan.id,viewport:{width:239,height:800}},{planId:game.plan.id,viewport:{width:600,height:800},source:'unapproved code'},{planId:game.plan.id,viewport:{width:600.5,height:800}}])assert.throws(()=>validateStudioIpcRequest(request('preview/share-start',payload)));
 assert.throws(()=>validateStudioIpcRequest(request('preview/share-stop',{url:'https://outside.example'})));
});
