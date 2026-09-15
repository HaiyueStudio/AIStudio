import test from 'node:test';
import assert from 'node:assert/strict';
import { Entity, SphericalTransform3D, CartesianTransform3D } from '@haiyue/engine';
import { PlayOrbitControls } from '../dist/play-orbit-controls.js';
const event = (phase,x=.5,y=.5,pointerId=1) => ({kind:'pointer',phase,x,y,pointerId,tick:1,order:1,button:0});
function fixture() {
  const camera=new Entity('Camera');const transform=new SphericalTransform3D({radius:8,phi:Math.PI/2});camera.addComponent(transform);
  const control=new PlayOrbitControls();
  return {camera,transform,control,update:(tick,events,mode='all',hits=[])=>control.update('controller',camera,tick,events,hits,{mode})};
}
test('orbit is deterministic, once per tick and changes the actual Engine camera',()=>{
  const f=fixture();f.update(1,[event('down'),event('move',.7,.6),event('up',.7,.6)]);
  assert.ok(Math.abs(f.transform.theta + .2*Math.PI*2)<1e-8);
  assert.ok(Math.abs(f.transform.phi - .4*Math.PI)<1e-8);
  const theta=f.transform.theta;f.update(1,[event('down'),event('move',.7,.6)]);assert.equal(f.transform.theta,theta);
  f.update(2,[event('move',.9,.9)]);assert.equal(f.transform.theta,theta,'up releases ownership');
});
test('background mode locks ownership at down; reset, skipped ticks and disposal release it',()=>{
  const f=fixture();f.update(1,[event('down'),event('move',.7)],'background',[{type:'down',pointerId:1}]);assert.equal(f.transform.theta,0);
  f.update(2,[event('move',.8)],'background');assert.equal(f.transform.theta,0,'moving off an object never steals its gesture');
  f.update(3,[event('down',.1,.1)],'background');f.update(4,[event('move',.3,.1)],'background',[{type:'move',pointerId:1}]);assert.notEqual(f.transform.theta,0);
  const theta=f.transform.theta;f.update(5,[{kind:'reset',reason:'blur',tick:5,order:1},event('move',.6)],'background');assert.equal(f.transform.theta,theta);
  f.update(6,[event('down')]);f.update(8,[event('move',.8)]);assert.equal(f.transform.theta,theta);
  f.update(9,[event('down')]);f.control.dispose();f.update(10,[event('move',.8)]);assert.equal(f.transform.theta,theta);
});
test('authored root cameras convert without changing position; options validate before mutation',()=>{
  const camera=new Entity('Authored camera'),cartesian=new CartesianTransform3D({position:[2,3,8]});camera.addComponent(cartesian);
  const control=new PlayOrbitControls();
  assert.throws(()=>control.update('a',camera,1,[],[],{rotateSpeed:NaN}),/rotateSpeed/);assert.equal(camera.getComponent(CartesianTransform3D),cartesian);
  control.update('a',camera,1,[],[],{target:{x:0,y:0,z:0}});
  assert.equal(camera.getComponent(CartesianTransform3D),null);
  const t=camera.getComponent(SphericalTransform3D);t.eyePosition.forEach((v,i)=>assert.ok(Math.abs(v-[2,3,8][i])<1e-5));
  assert.throws(()=>control.update('another',camera,1,[],[]),/one script owner/);
  control.update('a',camera,2,[event('wheel')].map(e=>({...e,wheelY:100000})),[],{maxRadius:10});assert.equal(t.radius,10);
  control.update('a',camera,3,[event('wheel')].map(e=>({...e,wheelY:-100000})),[],{minRadius:1});assert.equal(t.radius,1);
});

test('Orbit diagnostics preserve geometric ownership and reset rather than reporting stale activity',()=>{
 const f=fixture();f.update(1,[event('down')],'background',[{type:'down',pointerId:1,entityId:'entity:opaque'}]);
 assert.deepEqual(f.control.snapshot(1).decisions,[{phase:'down',pointerId:1,action:'yield-object',hitEntityId:'entity:opaque'}]);
 f.update(2,[event('move',.8)],'background');assert.equal(f.transform.theta,0);assert.deepEqual(f.control.snapshot(2).decisions,[]);
 f.update(3,[event('down'),event('move',.8)],'all',[{type:'down',pointerId:1,entityId:'entity:opaque'}]);
 assert.notEqual(f.transform.theta,0);assert.deepEqual(f.control.snapshot(3).decisions.map(d=>d.action),['claim','rotate']);
 assert.equal(f.control.snapshot(4),null);f.control.dispose();assert.equal(f.control.snapshot(3),null);
});

test('a raycast error is unknown rather than empty background',()=>{
 const f=fixture();f.update(1,[event('down'),event('move',.8)],'background',[{type:'down',pointerId:1,raycastFailed:true}]);
 assert.equal(f.transform.theta,0);assert.equal(f.control.snapshot(1).decisions[0].action,'yield-raycast-error');
});
