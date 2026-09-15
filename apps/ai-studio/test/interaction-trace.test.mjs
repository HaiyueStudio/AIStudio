import test from 'node:test';
import assert from 'node:assert/strict';
import {InteractionTrace} from '../dist/interaction-trace.js';
test('trace is tick local and distinguishes global/self event reads without a per-frame journal',()=>{
 const trace=new InteractionTrace();trace.begin(1);trace.read('script:idle','entity:idle','global',[]);assert.equal(trace.snapshot(null).reads.length,0);
 trace.hit({phase:'down',hitEntityId:'entity:child'});
 trace.read('script:parent','entity:parent','self',[]);trace.read('script:controller','entity:parent','global',[{entityId:'entity:child'}]);
 assert.deepEqual(trace.snapshot(null).reads.map(r=>r.eventCount),[0,1]);
 trace.read('script:controller','entity:parent','global',[{entityId:'entity:child'}]);assert.equal(trace.snapshot(null).reads.length,2);
 for(let i=0;i<100;i++){trace.hit({phase:'move'});trace.read('script:'+i,'entity:'+i,'self',[]);}
 assert.equal(trace.snapshot(null).truncated,true);assert.equal(trace.snapshot(null).hits.length,64);assert.equal(trace.snapshot(null).reads.length,32);
 trace.begin(2);assert.deepEqual(trace.snapshot(null),{tick:2,hits:[],reads:[],orbit:null,truncated:false});trace.clear();assert.equal(trace.snapshot(null).tick,-1);
});
