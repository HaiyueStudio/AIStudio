import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';
import { AdvancedStudioPanel } from '../../dist/panels/advanced/index.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function setup(f,patch={}) {
  const counts={loads:0,mounts:0,updates:0,cancels:0,disposes:0,dispatches:0,previews:[]};let options,mountSignal;
  const mounted={update(){counts.updates++;},reveal(){return true;},cancel(){counts.cancels++;},dispose(){counts.disposes++;}};
  // Protocol double tests the adapter's lifecycle only. Editor separately tests the real module.
  const module={ADVANCED_AUTHORING_API_VERSION:1,parseAdvancedAuthoringView:input=>input,async mountAdvancedAuthoring(value,signal){options=value;mountSignal=signal;counts.mounts++;return mounted;}};
  const panel=new AdvancedStudioPanel({host:{},viewportHost:{},source:f.source,load:async()=>{counts.loads++;return module;},dispatch:async()=>{counts.dispatches++;},preview:value=>counts.previews.push(value),...patch});
  return {panel,module,mounted,counts,options:()=>options,signal:()=>mountSignal};
}

test('lazy adapter loads only on open, deduplicates, cancels, unmounts and retries with no late revival',async t=>{
  const f=await fixture();t.after(f.close);const s=setup(f);assert.equal(s.counts.loads,0);
  const first=s.panel.open();assert.equal(s.panel.open(),first);await first;assert.equal(s.counts.mounts,1);await s.panel.open();assert.equal(s.counts.loads,1);
  assert.equal(s.panel.reveal(f.source().selection.active),true);s.panel.cancel();assert.equal(s.counts.cancels,1);
  s.panel.close();assert.equal(s.signal().aborted,true);assert.equal(s.counts.disposes,1);await s.panel.open();assert.equal(s.counts.mounts,2);
  s.panel.dispose();s.panel.dispose();assert.equal(s.counts.disposes,2);await assert.rejects(s.panel.open(),/disposed/);
});

test('close/cancel during import, project replacement, and close during async mounting reject late ownership',async t=>{
  const f=await fixture();t.after(f.close);
  for(const action of ['close','cancel','project']) {
    const gate=deferred(),s=setup(f,{load:()=>gate.promise}),pending=s.panel.open();
    if(action==='project') f.setEpoch('open:next');else s.panel[action]();
    gate.resolve(s.module);await pending;assert.equal(s.counts.mounts,0);s.panel.dispose();f.setEpoch('open:fixture-1');
  }
  const s=setup(f),gate=deferred();s.module.mountAdvancedAuthoring=()=>gate.promise;const pending=s.panel.open();await Promise.resolve();s.panel.close();gate.resolve(s.mounted);await pending;assert.equal(s.counts.disposes,1);assert.equal(s.counts.updates,0);
});

test('module version/getter failure remains retryable and malformed mounted result rolls back',async t=>{
  const f=await fixture();t.after(f.close);let input={ADVANCED_AUTHORING_API_VERSION:2};const s=setup(f,{load:async()=>input});await assert.rejects(s.panel.open(),/invalid/);
  let reads=0;input={get ADVANCED_AUTHORING_API_VERSION(){reads++;return 1;}};await assert.rejects(s.panel.open(),/invalid/);assert.equal(reads,0);
  input=s.module;await s.panel.open();s.panel.close();
  s.module.mountAdvancedAuthoring=async()=>({dispose(){s.counts.disposes++;}});await assert.rejects(s.panel.open(),/invalid/);assert.equal(s.counts.disposes,2);s.panel.dispose();
});

test('adapter binds dispatch and preview to latest source, suppresses detached callbacks and never authors previews',async t=>{
  const f=await fixture();t.after(f.close);const s=setup(f);await s.panel.open();const options=s.options(),view=f.view(),before=view.gizmo.transforms.find(item=>item.id===f.entityId).value;
  const preview={binding:view.binding,changes:[{reference:view.selection.active,before,after:{...before,position:[2,0,0]}}]};options.preview(preview);assert.equal(s.counts.dispatches,0);assert.deepEqual(s.counts.previews.at(-1),preview);
  await options.dispatch({type:'rename',binding:view.binding,reference:view.selection.active,name:'Intent only'},new AbortController().signal);assert.equal(s.counts.dispatches,1);assert.equal(f.workspace.gameSnapshot().entities.find(e=>e.id===f.entityId).name,'Controller');
  f.setEpoch('open:new');s.panel.update();assert.throws(()=>options.preview(preview),/invalid/);await assert.rejects(options.dispatch({type:'undo',binding:view.binding},new AbortController().signal),/invalid/);
  s.panel.dispose();await assert.rejects(options.dispatch({type:'cancel'},new AbortController().signal),/invalid/);const count=s.counts.previews.length;options.preview(preview);options.preview(null);assert.equal(s.counts.previews.length,count);
});
