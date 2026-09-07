import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeBehavior, associateBehaviorTrace, createBehaviorTrace, parseBehaviorContract, projectBehaviorResources } from '../dist/behavior/index.js';
import { canonical, clone, digest, hashText, makeInput, resourceExamples, traceEvent, observationFor } from './behavior-fixtures.mjs';

test('four resource identities reject mixed references, illegal operations and inappropriate unused semantics', () => {
  for (const entry of resourceExamples) {
    assert.deepEqual(parseBehaviorContract('resource-catalog-entry',entry),entry);
    assert.throws(()=>parseBehaviorContract('resource-catalog-entry',{...entry,schemaVersion:99}));
    assert.throws(()=>parseBehaviorContract('resource-catalog-entry',{...entry,ref:resourceExamples[(resourceExamples.indexOf(entry)+1)%4].ref}));
    assert.throws(()=>parseBehaviorContract('resource-catalog-entry',{...entry,authorization:'fixture-redacted'}),/secret/);
    if(entry.kind!=='asset') assert.throws(()=>parseBehaviorContract('resource-catalog-entry',{...entry,intents:['asset.assign']}));
    if(entry.kind!=='asset') assert.throws(()=>parseBehaviorContract('resource-catalog-entry',{...entry,unused:'yes'}));
  }
  assert.throws(()=>parseBehaviorContract('resource-catalog-entry',{...resourceExamples[0],unused:'yes'}),/unused/);
  assert.throws(()=>parseBehaviorContract('resource-catalog-entry',{...resourceExamples[2],status:'available',intents:['preset.apply']}),/persisted/);
  assert.throws(()=>parseBehaviorContract('resource-catalog-entry',{...resourceExamples[1],status:'unavailable'}),/unavailable/);
});

test('resource projection keeps existing asset identity/license/budgets and distinguishes missing knowledge', () => {
  const input=makeInput({types:['haiyue.light.point']});
  const asset={schemaVersion:1,id:'asset:light',kind:'texture',digest:digest('fixture-bytes'),projectPath:'assets/light.png',mimeType:'image/png',byteLength:100,decodedBytes:1024,license:'internal-test',provenance:'Synthetic contract fixture',width:16,height:16};
  asset.id = `asset:${asset.digest.slice(7,31)}`;
  input.document.assets=[{id:asset.id,kind:asset.kind,digest:asset.digest,source:'project'}];
  input.document.settings['studio.assets.catalog.v1']=[asset];
  const before=JSON.stringify(input),entries=projectBehaviorResources(input),projected=entries.find(entry=>entry.kind==='asset');
  assert.equal(projected.ref.assetId,asset.id);assert.equal(projected.ref.digest,asset.digest);assert.equal(projected.unused,'unknown');
  assert.equal(entries.find(entry=>entry.kind==='template').status,'unavailable');
  assert.equal(entries.find(entry=>entry.kind==='instance').unused,'inapplicable');
  assert.equal(JSON.stringify(input),before);
  const bad=clone(input);bad.document.settings['studio.assets.catalog.v1'][0].license='unlicensed';assert.throws(()=>projectBehaviorResources(bad));
  const mismatch=clone(input);mismatch.document.assets[0].digest=digest('wrong');assert.throws(()=>projectBehaviorResources(mismatch),/mismatch/);
});

test('trace association reuses ObservationArtifactV2 and checks source, play, generation and exact bytes', () => {
  const manifest=analyzeBehavior(makeInput({script:'first();'})),node=manifest.nodes.find(node=>node.kind==='call');
  const trace=createBehaviorTrace(manifest,{schemaVersion:1,playId:'play:test',generation:1,events:[traceEvent(node),{...traceEvent(node),sequence:1,kind:'node-exit',durationMicros:25}]});
  const observation=observationFor(trace,manifest);
  assert.equal(associateBehaviorTrace(observation,trace,manifest,{playId:'play:test',generation:1}).status,'current');
  assert.equal(associateBehaviorTrace(observation,trace,manifest,{playId:'play:test',generation:2}).status,'historical');
  const other=analyzeBehavior(makeInput({script:'second();'}));
  assert.equal(associateBehaviorTrace(observation,trace,other,{playId:'play:test',generation:1}).status,'historical');
  assert.throws(()=>associateBehaviorTrace({...observation,byteLength:0},trace,manifest,{playId:'play:test',generation:1}),/association/);
  assert.throws(()=>associateBehaviorTrace({...observation,documentRevision:2},trace,manifest,{playId:'play:test',generation:1}),/binding/);
  assert.throws(()=>createBehaviorTrace(manifest,{schemaVersion:1,playId:'play:test',generation:1,events:[{...traceEvent(node),scriptId:'script:other'}]}),/source/);
  assert.equal(analyzeBehavior(makeInput({script:'first();'})).digest,manifest.digest);
});

test('trace bounds retain omission metadata, exceptions and cancellation; malformed or secret rows cannot hide in the tail', () => {
  const manifest=analyzeBehavior(makeInput({script:'first();'})),node=manifest.nodes.find(node=>node.kind==='call'),event=traceEvent(node);
  const events=Array.from({length:10001},(_,sequence)=>({...event,sequence}));
  const trace=createBehaviorTrace(manifest,{schemaVersion:1,playId:'play:test',generation:1,events});
  assert.equal(trace.events.length,10000);assert.deepEqual(trace.truncation,{truncated:true,reasons:['events'],omittedAtLeast:1});
  const special=createBehaviorTrace(manifest,{schemaVersion:1,playId:'play:test',generation:1,events:[{...event,kind:'error',error:'Fixture failure'},{...event,sequence:1,kind:'cancel'},{...event,sequence:2,kind:'state-diff',stateDiff:{score:{before:0,after:1}}}]});
  assert.deepEqual(special.events.map(event=>event.kind),['error','cancel','state-diff']);
  events.at(-1).stateDiff={apiKey:'redacted-fixture'};
  assert.throws(()=>createBehaviorTrace(manifest,{schemaVersion:1,playId:'play:test',generation:1,events}),/secret/);
});

test('trace byte budget truncates large state/error rows independently of the event-count limit', () => {
  const manifest=analyzeBehavior(makeInput({script:'first();'})),node=manifest.nodes.find(node=>node.kind==='call');
  const events=Array.from({length:2500},(_,sequence)=>({...traceEvent(node),sequence,kind:'error',error:'Fixture failure '.repeat(120)}));
  const trace=createBehaviorTrace(manifest,{schemaVersion:1,playId:'play:test',generation:1,events});
  assert.ok(trace.truncation.reasons.includes('bytes'));assert.ok(trace.events.length<2500);
  assert.ok(Buffer.byteLength(canonical(trace))<=4*1024*1024);
});

test('observation script selection reuses explicit Play subsets and excludes disabled resources', () => {
  const input=makeInput({script:'first();'});
  input.document.scripts.push({...input.document.scripts[0],id:'script:disabled',enabled:false,source:'disabled();',digest:hashText('disabled();')});
  input.document.scripts.push({...input.document.scripts[0],id:'script:other',source:'other();',digest:hashText('other();')});
  const manifest=analyzeBehavior(input),node=manifest.nodes.find(node=>node.kind==='call'&&node.source.scriptId==='script:main');
  const trace=createBehaviorTrace(manifest,{schemaVersion:1,playId:'play:test',generation:1,events:[traceEvent(node)]});
  const observation={...observationFor(trace,manifest),scriptDigests:[input.document.scripts[0].digest]};
  assert.equal(associateBehaviorTrace(observation,trace,manifest,{playId:'play:test',generation:1}).status,'current');
  assert.throws(()=>associateBehaviorTrace({...observation,scriptDigests:[]},trace,manifest,{playId:'play:test',generation:1}),/binding/);
  assert.throws(()=>associateBehaviorTrace({...observation,scriptDigests:[...observation.scriptDigests,input.document.scripts[1].digest]},trace,manifest,{playId:'play:test',generation:1}),/binding/);
});
