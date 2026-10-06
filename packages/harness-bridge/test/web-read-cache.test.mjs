import test from 'node:test';
import assert from 'node:assert/strict';
import { WebReadCache } from '../dist/web-read-cache.js';

test('concurrent identical reads share one request; a cancelled waiter does not cancel another', async () => {
 const cache=new WebReadCache(), gate=Promise.withResolvers(); let requests=0, inner;
 const read=async signal=>{requests++;inner=signal;await gate.promise;return {status:'completed',content:'evidence'};};
 const a=new AbortController(), b=new AbortController();
 const first=assert.rejects(cache.run('same',a.signal,read)); const second=cache.run('same',b.signal,read);
 await Promise.resolve();a.abort();await first;assert.equal(inner.aborted,false);gate.resolve();
 assert.equal((await second).cached,true);assert.equal(requests,1);
 assert.equal((await cache.run('same',b.signal,read)).cached,true);assert.equal(requests,1);await cache.dispose();
});
test('last cancellation drains actual exit, does not cache late success, and permits a fresh retry', async()=>{
 const cache=new WebReadCache(),entered=Promise.withResolvers(),exit=Promise.withResolvers(),a=new AbortController();let settled=false;
 const pending=assert.rejects(cache.run('key',a.signal,async signal=>{entered.resolve();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));await exit.promise;return {status:'completed'};})).then(()=>{settled=true;});
 await entered.promise;a.abort();await Promise.resolve();assert.equal(settled,false);exit.resolve();await pending;
 let calls=0;const result=await cache.run('key',new AbortController().signal,async()=>{calls++;return {status:'completed'};});assert.equal(result.cached,false);assert.equal(calls,1);await cache.dispose();
});
test('owner disposal aborts all distinct reads and waits for cleanup; errors are not cached',async()=>{
 const cache=new WebReadCache(),entered=Promise.withResolvers();let drained=false;
 const work=assert.rejects(cache.run('pending',new AbortController().signal,async signal=>{entered.resolve();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));drained=true;signal.throwIfAborted();}));
 await entered.promise;await cache.dispose();await work;assert.equal(drained,true);await assert.rejects(cache.run('new',new AbortController().signal,async()=>({})),/disposed/);
 const retry=new WebReadCache();let calls=0;for(let i=0;i<2;i++)await assert.rejects(retry.run('error',new AbortController().signal,async()=>{calls++;throw new Error('failed');}));assert.equal(calls,2);await retry.dispose();
});
