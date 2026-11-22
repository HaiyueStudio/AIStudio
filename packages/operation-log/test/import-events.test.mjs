import test from'node:test';
import assert from'node:assert/strict';
import{mkdtemp,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import path from'node:path';
import{OperationLog}from'../dist/index.js';
async function fixture(t,options={}){const root=await mkdtemp(path.join(tmpdir(),'journal-import-'));let log=await OperationLog.open({rootDirectory:root,appVersion:'test',...options});t.after(async()=>{await log.close();await rm(root,{recursive:true,force:true});});return{get log(){return log;},async reopen(){await log.close();log=await OperationLog.open({rootDirectory:root,appVersion:'test',...options});return log;}};}
const input=i=>({schemaVersion:1,eventId:`event:import-${i}`,sequence:100+i,timestamp:'2026-11-22T01:00:00.000Z',kind:'project/imported',source:'test.import',severity:'info',correlation:{projectId:'project:one'},payload:{index:i,apiKey:'fixture-private-value'},payloadDigest:'ignored-recomputed',redactedFields:[],provenance:{appVersion:'source',schemaVersion:'operation-event/1'},artifactRefs:[]});

test('bounded import syncs groups, preserves event order and IDs, redacts and recovers exact facts after reopening',async t=>{
 let writes=0;const f=await fixture(t,{maxSegmentBytes:1800,faultInjector:point=>{if(point==='before-journal-write')writes++;}}),seen=[];
 const subscription=f.log.subscribeAppends(async event=>{assert.ok((await f.log.query({projectId:'project:one',limit:100})).events.some(e=>e.eventId===event.eventId));seen.push(event.eventId);});
 const events=await f.log.importEvents(Array.from({length:12},(_,i)=>input(i)));
 assert.deepEqual(events.map(e=>e.sequence),Array.from({length:12},(_,i)=>i));assert.deepEqual(seen,events.map(e=>e.eventId));assert.ok(writes<12);assert.ok(f.log.status().segmentCount>1);
 assert.ok(events.every(e=>e.payload.apiKey==='[REDACTED]'));
 subscription.dispose();const reopened=await f.reopen(),restored=(await reopened.query({projectId:'project:one',limit:100})).events;
 assert.deepEqual(restored,events);assert.equal(reopened.status().health,'healthy');
});

test('invalid references and malformed or aborted batches do not publish a partial group',async t=>{
 const f=await fixture(t);const bad={...input(2),artifactRefs:[`artifact:sha256:${'f'.repeat(64)}`]};
 await assert.rejects(f.log.importEvents([input(1),bad]),e=>e.code==='artifact-missing');assert.equal(f.log.status().eventCount,0);
 await assert.rejects(f.log.importEvents([{...input(1),correlation:{}}]),e=>e.code==='import-batch-invalid');
 await assert.rejects(f.log.importEvents(Array.from({length:129},(_,i)=>input(i))),e=>e.code==='import-batch-invalid');
 const controller=new AbortController();controller.abort();await assert.rejects(f.log.importEvents([input(1)],{signal:controller.signal}),e=>e.code==='append-cancelled');assert.equal(f.log.status().eventCount,0);
});

test('a failed journal write delivers no observer event and disables protected operations',async t=>{
 const f=await fixture(t,{faultInjector:point=>{if(point==='before-journal-write')throw Error('disk failure');}});let delivered=0;f.log.subscribeAppends(async()=>{delivered++;});
 await assert.rejects(f.log.importEvents([input(1),input(2)]),e=>e.code==='journal-write-failed');assert.equal(delivered,0);assert.equal(f.log.status().eventCount,0);assert.equal(f.log.status().allowsMutation,false);
});

test('normal appends and imports share one serializer and await replica observers',async t=>{
 const f=await fixture(t);let release;const barrier=new Promise(resolve=>release=resolve),seen=[];let entered;const first=new Promise(resolve=>entered=resolve);
 f.log.subscribeAppends(async event=>{seen.push(event.eventId);if(event.eventId==='event:import-1'){entered();await barrier;}});
 const imported=f.log.importEvents([input(1),input(2)]);await first;
 let completed=false;const next=f.log.append({...input(3),eventId:'event:normal'}).then(()=>completed=true);
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(completed,false);release();await imported;await next;
 assert.deepEqual(seen,['event:import-1','event:import-2','event:normal']);assert.deepEqual((await f.log.query({limit:10})).events.map(e=>e.sequence),[0,1,2]);
});
