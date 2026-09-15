import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseGesture, gestureRouting, GestureProgressGuard } from '../dist/interaction-diagnostics.js';
const entity = { id: 'entity:face', position: [0,0,0], rotation: [0,0,0] };
const before = { state: { entities: [entity] } };
const effects = { cameraChanged: true, changedEntityCount: 0 };
const route = (hit={}, reads=[]) => ({ available:true, hits:[{phase:'down',hitEntityId:'entity:face',receiverEntityId:'entity:face',pointer:{enabled:true},emitted:[{type:'down',entityId:'entity:face'}],...hit}], reads });
const diagnose = (routing, expectation={cameraChanged:false}) => diagnoseGesture([{routing}],before,before,effects,expectation);
test('diagnostics locate the earliest known break without inventing a handler success',()=>{
  assert.equal(diagnose({available:false}).stage,'routing-incomplete');
  assert.equal(diagnose({...route(),truncated:true}).stage,'routing-incomplete');
  assert.equal(diagnose(route({raycastFailed:true})).stage,'raycast-error');
  assert.equal(diagnose(route({hitEntityId:null,emitted:[]})).stage,'background-hit');
  assert.equal(diagnose(route({pointer:null,emitted:[]})).stage,'pointer-unavailable');
  assert.equal(diagnose(route({pointer:{enabled:false},emitted:[]})).stage,'pointer-unavailable');
  assert.equal(diagnose(route({emitted:[],suppressed:[{reason:'event-not-subscribed'}]})).stage,'events-filtered');
  assert.equal(diagnose(route({},[{scriptId:'script:camera',entityId:'entity:camera',scope:'self',eventCount:0}])).stage,'events-unread');
  const read=diagnose(route({},[{scriptId:'script:handler',eventCount:1}]));
  assert.equal(read.stage,'read-without-entity-effect'); assert.equal(read.expectationMatched,false);
  assert.match(read.nextAction,/does not prove.*branch/);assert.match(read.nextAction,/Camera changed/);
  assert.equal(diagnose(route({hitEntityId:null}),{cameraChanged:true}).expectationMatched,true,'background camera movement can be intended');
});
test('expectations compare real full entity data, including unchanged nonmembers, not gameplay counters',()=>{
  const after={state:{entities:[{...entity,rotation:[0,1,0]}]},gameplay:[{moves:99}]};
  const result=diagnoseGesture([{routing:route()}],before,after,{cameraChanged:false,changedEntityCount:1},{changedEntityIds:[entity.id],unchangedEntityIds:['entity:missing'],minChangedEntities:9,cameraChanged:false});
  assert.equal(result.expectationMatched,false);assert.equal(result.mismatches.length,2);
  const pass=diagnoseGesture([],before,after,{cameraChanged:false,changedEntityCount:1},{changedEntityIds:[entity.id],cameraChanged:false});
  assert.equal(pass.expectationMatched,true);assert.equal(pass.stage,'routing-incomplete');
});
test('routing is byte bounded and explicit about absent/truncated reader evidence',()=>{
  const full={routing:{tick:1,hits:[{pointerId:1,phase:'down'}],reads:Array.from({length:100},(_,i)=>({scriptId:'script:'+i,eventCount:0})),orbit:{scriptId:'script:camera',mode:'background',decisions:[{pointerId:1,action:'yield-object'},{pointerId:2,action:'claim'}]}}};
  const projected=gestureRouting(full,1);assert.equal(projected.truncated,true);assert.equal(projected.reads.length,4);assert.equal(projected.orbit.decisions.length,1);
  assert.deepEqual(gestureRouting({},1),{available:false});
  full.routing.reads=[{scriptId:'x'.repeat(10000)}];assert.deepEqual(gestureRouting(full,1),{available:true,truncated:true});
});
test('progress guard ignores artifact/tick churn; permits an explained distinct probe or new revision',()=>{
  const guard=new GestureProgressGuard();const args={points:[{phase:'down',x:.5,y:.5},{phase:'up',x:.6,y:.5}],expect:{cameraChanged:false}};
  const diagnostic=diagnose(route({pointer:null,emitted:[]}));
  assert.equal(guard.after('task:1/document:1/r1',args,diagnostic),1);
  guard.before('task:1/document:1/r1',args);assert.equal(guard.after('task:1/document:1/r1',args,diagnostic),2);
  assert.throws(()=>guard.before('task:1/document:1/r1',args),e=>e.code==='interaction.diagnostic-required');
  assert.throws(()=>guard.before('task:1/document:1/r1',{...args,hypothesis:'try again'}));
  guard.before('task:1/document:1/r1',{...args,points:[{phase:'down',x:.2,y:.2},{phase:'up',x:.3,y:.2}],hypothesis:'Probe the outer visible surface rather than the occluded center.'});
  guard.before('task:1/document:1/r2',args);guard.before('task:2/document:1/r1',args);
  guard.after('task:1/document:1/r1',args,{...diagnostic,expectationMatched:true});guard.before('task:1/document:1/r1',args);
  guard.after('k',args,diagnostic);guard.after('k',args,diagnostic);guard.clear();guard.before('k',args);
});

test('a color change cannot satisfy a requested transform change',()=>{
 const colored={state:{entities:[{...entity,materialColor:[1,0,0,1]}]}};
 const result=diagnoseGesture([{routing:route()}],before,colored,{cameraChanged:false,changedEntityCount:1},{changedTransformEntityIds:[entity.id]});
 assert.equal(result.expectationMatched,false);assert.match(result.mismatches[0],/observed unchanged/);
 const rotated={state:{entities:[{...entity,rotation:[0,1,0]}]}};
 assert.equal(diagnoseGesture([{routing:route()}],before,rotated,{cameraChanged:false,changedEntityCount:1},{changedTransformEntityIds:[entity.id]}).expectationMatched,true);
});
