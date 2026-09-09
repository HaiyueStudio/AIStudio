import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { PlayObservationRepository } from '@haiyue/ai-studio-game-authoring-tools';
import { fixture } from './fixture.mjs';
import { adaptAdvancedStudioIntent, projectAdvancedStudio, isAdvancedStudioCurrent } from '../../dist/panels/advanced/index.js';

test('actual M12 document and registry project complete hierarchy, components and the same public Selection/History',async t=>{
  const f=await fixture();t.after(f.close);const source=f.source(),view=f.view();
  assert.deepEqual(view.selection,source.selection);assert.deepEqual(view.history,source.history);assert.equal(view.hierarchy.length,source.document.entities.length);assert.equal(view.selection.active.kind,'scene-entity');
  assert.equal(view.sections.length,source.document.entities.find(e=>e.id===f.entityId).componentIds.length);assert.equal(view.additions.length,source.definitions.length);
  assert.equal(view.capabilities.multiSelection,false);assert.equal(view.runtime.status,'stopped');
  const unknown=projectAdvancedStudio({...source,definitions:[]});assert.ok(unknown.sections.every(section=>!section.editable));assert.equal(unknown.gizmo.enabled,false);
  const closed=projectAdvancedStudio({...source,document:null,selection:{revision:source.selection.revision+1,active:null,items:[]}});assert.equal(closed.binding,null);assert.deepEqual(closed.additions,[]);assert.deepEqual(closed.hierarchy,[]);assert.deepEqual(closed.sections,[]);
  const output=pathToFileURL(path.join(process.env.HAIYUE_M14_G09_OUTPUT ?? f.directory,'advanced')+path.sep);await mkdir(output,{recursive:true});await writeFile(new URL('studio-view.json',output),JSON.stringify(view,null,2));
});

test('manual component edits, rename, hierarchy and Transform use actual tools and exactly one existing History transaction each',async t=>{
  const f=await fixture();t.after(f.close);
  const perform=async(type,args)=>{const before=f.workspace.snapshot().history.entries.length;const result=await f.dispatch(f.emit(type,args));assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(f.workspace.snapshot().history.entries.length,before+1);return result;};
  await perform('rename',{reference:f.source().selection.active,name:'Advanced controller'});
  assert.equal(f.workspace.gameSnapshot().entities.find(e=>e.id===f.entityId).name,'Advanced controller');
  const added=f.view().additions.find(item=>item.id.startsWith('haiyue.gameplay.timers@'));
  await perform('section.add',{additionId:added.id});let section=f.view().sections.find(s=>s.description.startsWith('haiyue.gameplay.timers@'));
  await perform('field.edit',{sectionId:section.id,fieldId:'timers',value:[{id:'clock',durationTicks:10,startDelayTicks:0,repeat:true,running:true,event:'elapsed'}]});
  await perform('section.toggle',{sectionId:section.id,enabled:false});assert.equal(f.workspace.gameSnapshot().components.find(c=>c.id===section.id).enabled,false);
  await perform('section.remove',{sectionId:section.id});assert.equal(f.workspace.gameSnapshot().components.some(c=>c.id===section.id),false);
  await f.dispatch(f.emit('undo'));assert.equal(f.workspace.gameSnapshot().components.some(c=>c.id===section.id),true);
  await f.dispatch(f.emit('redo'));assert.equal(f.workspace.gameSnapshot().components.some(c=>c.id===section.id),false);
  const before=f.view().gizmo.transforms.find(item=>item.id===f.entityId).value;
  await perform('transform',{changes:[{reference:f.source().selection.active,before,after:{...before,position:[3,4,5]}}]});
  assert.deepEqual(f.scene.snapshot().entities.find(e=>e.id===f.entityId).transform.position,{x:3,y:4,z:5});
  await f.dispatch(f.emit('undo'));assert.deepEqual(f.scene.snapshot().entities.find(e=>e.id===f.entityId).transform.position,{x:0,y:0,z:0});await f.dispatch(f.emit('redo'));
  await perform('reparent',{reference:f.source().selection.active,parent:null,order:37});assert.equal(f.workspace.gameSnapshot().entities.find(e=>e.id===f.entityId).order,37);
  const selectionRevision=f.selection.snapshot().revision;await f.dispatch(f.emit('selection',{references:[],active:null}));assert.equal(f.unified.snapshot().activeEntityId,null);assert.ok(f.selection.snapshot().revision>selectionRevision);
});

test('unknown authority, versions, component owners, exact revisions, selection and reopen epoch fail closed',async t=>{
  const f=await fixture();t.after(f.close);const view=f.view(),ref=view.selection.active,section=view.sections[0];
  const rejects=patch=>assert.throws(()=>adaptAdvancedStudioIntent(patch,f.source()),/invalid-or-stale/);
  rejects({type:'rename',binding:view.binding,reference:ref,name:'bad',approved:true});
  rejects({type:'rename',binding:{...view.binding,revision:0},reference:ref,name:'bad'});
  rejects({type:'rename',binding:view.binding,reference:{...ref,documentId:'foreign'},name:'bad'});
  rejects({type:'field.edit',binding:view.binding,sectionId:'foreign',fieldId:'$value',value:{}});
  rejects({type:'field.edit',binding:view.binding,sectionId:section.id,fieldId:'invented',value:3});
  rejects({type:'section.add',binding:view.binding,additionId:'haiyue.transform.3d@unknown'});
  rejects({type:'reparent',binding:view.binding,reference:ref,parent:ref,order:0});
  rejects({type:'transform',binding:view.binding,changes:[{reference:ref,before:{position:[999,0,0],rotationDegrees:[0,0,0],scale:[1,1,1]},after:view.gizmo.transforms[0].value}]});
  let reads=0; rejects({get type(){reads++;return 'undo';},binding:view.binding});assert.equal(reads,0);
  rejects(JSON.parse('{"type":"cancel","__proto__":{}}'));
  const intent=f.emit('rename',{reference:ref,name:'later'});f.setEpoch('open:fixture-2');assert.equal(isAdvancedStudioCurrent(f.source(),intent.stamp),false);await assert.rejects(f.dispatch(intent),/stale/);
  f.setEpoch('open:fixture-1');f.unified.select(null,'hierarchy');await assert.rejects(f.dispatch(intent),/stale/);
  assert.equal(f.workspace.gameSnapshot().entities.find(e=>e.id===f.entityId).name,'Controller');
});

test('registry validation and withheld approval reject edits without changing Document or History',async t=>{
  const f=await fixture();t.after(f.close);const view=f.view(),before=f.workspace.snapshot().history.entries.length;
  const section=view.sections.find(s=>s.description.startsWith('haiyue.transform.3d@'));
  await assert.rejects(f.dispatch(f.emit('field.edit',{sectionId:section.id,fieldId:'scale',value:{x:0,y:1,z:1}})),/must be/);assert.equal(f.workspace.snapshot().history.entries.length,before);
  await assert.rejects(f.dispatch(f.emit('rename',{reference:view.selection.active,name:'Never approved'}),undefined,false),/requires approval/);assert.equal(f.workspace.snapshot().history.entries.length,before);
  const signal=AbortSignal.abort();await assert.rejects(f.dispatch(f.emit('rename',{reference:view.selection.active,name:'cancelled'}),signal));
});

test('runtime inspection projects persisted ObservationArtifactV2 and separates previous run/revision/project without authoring writes',async t=>{
  const f=await fixture();t.after(f.close);const repository=new PlayObservationRepository(f.operationLog),source=f.source(),before=f.workspace.snapshot().history.entries.length;
  const persisted=await repository.persistState({schemaVersion:1,id:'call:advanced-observation',toolId:'play.inspect',toolVersion:'1.0.0',arguments:{},sessionId:'session:advanced',turnId:'turn:advanced'}, {playId:'play:advanced',documentRevision:source.document.revision,scriptDigests:[],tick:2,frame:2,viewport:null,device:null,capturedAt:new Date().toISOString(),value:{entities:[{id:f.entityId,position:{x:1,y:0,z:0}}],runtimeErrorCount:0}});
  const input={...source,playId:persisted.artifact.playId,observation:persisted.artifact,observationValue:persisted.projection,observationEpoch:source.epoch,observationDocumentId:source.document.id};
  const projected=projectAdvancedStudio(input);assert.equal(projected.runtime.status,'current');assert.ok(projected.runtime.fields.every(field=>field.readOnly));
  assert.equal(projectAdvancedStudio({...input,playId:'play:next'}).runtime.status,'historical');
  assert.equal(projectAdvancedStudio({...input,document:{...source.document,revision:source.document.revision+1}}).runtime.status,'historical');
  assert.equal(projectAdvancedStudio({...input,epoch:'open:different'}).runtime.fields.length,0);
  assert.equal((await repository.read(persisted.artifact.id)).artifact.digest,persisted.artifact.digest);assert.equal(f.workspace.snapshot().history.entries.length,before);
});
