import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OperationLog} from '@haiyue/ai-studio-operation-log';
import {GestureRegressions} from '../dist/gesture-regressions.js';
const before={playId:'play:one',tick:1,documentRevision:37,viewport:{width:1856,height:864},value:{seed:'fixed',state:{camera:{position:[0,12,10]},entities:[{id:'entity:cue',parentId:null,worldMatrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,.19,3,1]}]}}};
const expect={cameraChanged:true,changedTransformEntityIds:['entity:cue'],unchangedEntityIds:['entity:cloth']};
const gesture=(y,extra={})=>({points:[{phase:'down',x:.5,y},{phase:'move',x:.5,y:y+.15},{phase:'up',x:.5,y:y+.25}],pointerId:1,settleTicks:32,expect,...extra});
const bad={stage:'pointer-unavailable',hitEntityId:'entity:cloth',expectationMatched:false};
const good={stage:'effects-observed',hitEntityId:'entity:cue',expectationMatched:true};
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'gesture-probes-'));let log=await OperationLog.open({rootDirectory:dir,appVersion:'test'});t.after(async()=>{await log.close();await rm(dir,{recursive:true,force:true});});const suite=new GestureRegressions(log);await suite.sync('project:one','document:one');suite.begin(before);return{suite,log,reopen:async()=>{await log.close();log=await OperationLog.open({rootDirectory:dir,appVersion:'test'});const restored=new GestureRegressions(log);await restored.sync('project:one','document:one');return restored;}};}

test('failed named exploration does not gate; a corrected target can be promoted and replay has no exploratory assertions',async t=>{
 const {suite}=await fixture(t);
 const missed=await suite.record(gesture(.5734,{caseLabel:'miss',targetEntityId:'entity:cue'}),before,false,undefined,[bad]);
 assert.equal(missed.mode,'probe');assert.deepEqual(suite.pending(37),[]);
 const hit=await suite.record(gesture(.658,{caseLabel:'shot',targetEntityId:'entity:cue'}),before,true,undefined,[good]);
 assert.equal(hit.passed,true);assert.equal(suite.get(hit.id).sequence[0].expect,undefined);assert.equal(suite.get(hit.id).sequence[0].targetEntityId,undefined);assert.deepEqual(suite.get(hit.id).sequence[1].expect,expect);
 await suite.promote(hit.id,37);assert.equal(suite.get(hit.id).mode,'regression');assert.equal(suite.pending(38).length,1);
 suite.begin({...before,playId:'play:repeat'});
 await suite.record(gesture(.5734,{caseLabel:'miss',targetEntityId:'entity:cue'}),before,false,undefined,[bad]);
 await suite.record(gesture(.658,{caseLabel:'shot',targetEntityId:'entity:cue'}),before,true,undefined,[good]);
 assert.equal(suite.get(hit.id).mode,'regression','repeating a promoted probe cannot demote a formal case');
 assert.equal(suite.get(missed.id).passed,false,'exploration verdict remains visible');
});

test('cancelled correction preserves the original acceptance gate and both original artifacts',async t=>{
 const {suite}=await fixture(t);
 const original=await suite.record(gesture(.5734,{mode:'regression',caseLabel:'original'}),before,false,undefined,[bad]);
 suite.begin({...before,playId:'play:replacement'});
 const replacement=await suite.record(gesture(.658,{targetEntityId:'entity:cue'}),before,true,undefined,[good]);
 let calls=0;
 await assert.rejects(suite.correct(original.id,replacement.id,'Wrong coordinate',37,()=>{if(++calls===3)throw Error('cancelled');}),/cancelled/);
 assert.equal(suite.get(original.id).supersededBy,undefined);assert.ok(suite.pending(37).some(id=>id.startsWith(original.id)));
});

test('a formal failing prelude cannot be hidden by a passing final gesture',async t=>{
 const {suite}=await fixture(t);
 await suite.record(gesture(.5734,{mode:'regression',caseLabel:'reported failure'}),before,false,undefined,[bad]);
 const last=await suite.record(gesture(.658,{mode:'regression',caseLabel:'final pass'}),before,true,undefined,[good]);
 assert.equal(last.passed,false);assert.equal(suite.pending(37).length,2);
 assert.deepEqual(suite.get(last.id).sequence.map(x=>x.expect),[expect,expect]);
});

test('legacy wrong-target case is corrected append-only with unchanged expectations, then restored after restart',async t=>{
 const {suite,log,reopen}=await fixture(t);
 const legacy={id:'regression:legacy',label:'eight-ball-shot',sequence:[gesture(.5734)],baseline:{camera:before.value.state.camera,entities:before.value.state.entities,seed:'fixed',viewport:before.viewport},revision:37,passed:false};
 const artifact=await log.putArtifact({kind:'haiyue.gesture-regression.v1',projectId:'project:one',documentId:'document:one',test:legacy});
 await log.append({kind:'interaction/regression',source:'test.regression',severity:'warning',correlation:{projectId:'project:one',documentId:'document:one'},payload:{artifactId:artifact.id},artifactRefs:[artifact.id]});await suite.sync('project:one','document:one');
 const replacement=await suite.record(gesture(.658,{targetEntityId:'entity:cue'}),before,true,undefined,[good]);
 await assert.rejects(suite.correct(legacy.id,replacement.id,'Wrong screen coordinate',37),e=>e.code==='interaction.regression-correction-invalid');
 await suite.record({},before,false,legacy.id,[bad]);
 const corrected=await suite.correct(legacy.id,replacement.id,'Recorded hit was cloth; verified replacement hits the cue.',37);
 assert.equal(corrected.historyPreserved,true);assert.deepEqual(suite.pending(37),[]);
 assert.deepEqual((await log.readArtifact(artifact.id)).value.test,legacy,'original artifact is immutable');
 assert.deepEqual(suite.get(legacy.id).sequence,legacy.sequence);assert.equal(suite.get(legacy.id).passed,false);
 const restored=await reopen();
 assert.equal(restored.get(legacy.id).supersededBy,replacement.id);assert.equal(restored.get(replacement.id).mode,'regression');assert.deepEqual(restored.pending(37),[]);assert.equal(restored.pending(38).length,1);
 await assert.rejects(restored.correct(legacy.id,replacement.id,'again',37));
 await restored.sync('project:another','document:another');assert.equal(restored.list().count,0);
});

test('legacy successful last step cannot conceal a failed exploratory prefix when correcting a saved case',async t=>{
 const {suite,log}=await fixture(t);
 const blank={...gesture(.1),expect:{cameraChanged:false,unchangedEntityIds:['entity:cue','entity:cloth']}};
 const old={id:'regression:contaminated',label:'eight-ball-break',sequence:[blank,gesture(.5734),gesture(.658)],baseline:{camera:before.value.state.camera,entities:before.value.state.entities,seed:'fixed',viewport:before.viewport},revision:37,passed:true};
 const artifact=await log.putArtifact({kind:'haiyue.gesture-regression.v1',projectId:'project:one',documentId:'document:one',test:old});await log.append({kind:'interaction/regression',source:'test.regression',severity:'info',correlation:{projectId:'project:one',documentId:'document:one'},payload:{artifactId:artifact.id},artifactRefs:[artifact.id]});await suite.sync('project:one','document:one');
 await suite.record({},before,false,old.id,[{...good,hitEntityId:null},bad,good]);
 await suite.record({...blank,mode:'regression',caseLabel:'invalid drag'},before,true,undefined,[{...good,hitEntityId:null}]);
 const replacement=await suite.record({...gesture(.658),targetEntityId:'entity:cue'},before,true,undefined,[good]);
 await suite.correct(old.id,replacement.id,'Verified target coordinates; original assertions preserved.',37);
 assert.deepEqual(suite.get(old.id).sequence,old.sequence);assert.equal(suite.get(old.id).passed,false);assert.deepEqual(suite.pending(37),[]);
});

test('correction refuses weakened expectations, genuine handler failures, changed setup and stale evidence',async t=>{
 for(const kind of ['weakened','handler','setup','stale']){
  const {suite}=await fixture(t);
  const original=await suite.record(gesture(.5734,{mode:'regression',caseLabel:'protected'}),before,false,undefined,[kind==='handler'?{...bad,hitEntityId:'entity:cue',stage:'read-without-entity-effect'}:bad]);
  suite.begin({...before,playId:'play:two',...(kind==='setup'?{viewport:{width:800,height:600}}:{})});
  const replacement=await suite.record(gesture(.658,{targetEntityId:'entity:cue',...(kind==='weakened'?{expect:{cameraChanged:true}}:{})}),{...before,...(kind==='stale'?{documentRevision:38}:{})},true,undefined,[good]);
  await assert.rejects(suite.correct(original.id,replacement.id,'Test correction',37),e=>e.code==='interaction.regression-correction-invalid',kind);
  assert.ok(suite.pending(37).some(id=>id.startsWith(original.id)));assert.equal(suite.get(original.id).supersededBy,undefined);
 }
});
