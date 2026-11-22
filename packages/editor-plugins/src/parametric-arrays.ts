import { asStableId, PARAMETRIC_ARRAY_COMPONENT, parseParametricArray, parametricArrayCell, type ParametricArrayV1, type GameDocumentOperationV2, type GameComponentInstanceV2, type JsonObject, type JsonValue, type StableId } from '@haiyue/ai-studio-contracts';
import { sha256, canonicalStringify } from '@haiyue/ai-studio-operation-log';
import type { ProjectWorkspace } from './history/index.js';

const ownedTypes = ['haiyue.transform.3d','haiyue.render.geometry','haiyue.render.material'];
const identity = {position:{x:0,y:0,z:0},rotationDegrees:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}};
const id = (prefix: string, key: string): StableId => asStableId(`${prefix}:array:${sha256(key).slice(0,28)}`);
export const parametricArrayEntityId = (rootId: string, row: number, column: number): StableId => id('entity',`${rootId}:${row}:${column}`);
const componentId = (entityId: string, type: string): StableId => id('component',`${entityId}:${type}`);
export function planParametricArray(workspace: Pick<ProjectWorkspace,'gameSnapshot'|'componentRegistry'|'primarySceneId'>, input: unknown, commandId: StableId, previousSpec?: ParametricArrayV1 | null) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('Array command must be an object.');
  const v=input as Record<string,unknown>;
  if(Object.keys(v).some(k=>!['baseRevision','arrayId','representation','layout','template','templateEntityId','name','parentId','rootEntityId'].includes(k)))throw new TypeError('Unknown array command field.');
  const document=workspace.gameSnapshot();
  if(v.baseRevision!==document.revision)throw new Error('Array command requires the exact current document revision.');
  const existingComponents=document.components.filter(c=>c.type===PARAMETRIC_ARRAY_COMPONENT);
  const match=existingComponents.filter(c=>c.value.arrayId===v.arrayId);
  if(match.length>1)throw new Error('Array id is ambiguous; repair duplicate array descriptors first.');
  const oldComponent=match[0];
  const existingRoot=oldComponent?document.entities.find(e=>e.componentIds.includes(oldComponent.id)):v.rootEntityId?document.entities.find(e=>e.id===v.rootEntityId):undefined;
  if(v.rootEntityId&&(!existingRoot||existingRoot.id!==v.rootEntityId))throw new Error('Array root does not match the requested array.');
  const old=previousSpec===undefined?(oldComponent?parseParametricArray(oldComponent.value):null):previousSpec;
  if(v.template!==undefined&&v.templateEntityId!==undefined)throw new TypeError('Choose template or templateEntityId, not both.');
  let template=v.template??old?.template;
  if(v.templateEntityId!==undefined){
    const source=document.entities.find(e=>e.id===v.templateEntityId);
    if(!source||document.entities.some(e=>e.parentId===source.id)||document.scripts.some(s=>s.entityId===source.id))throw new Error('Array templates must be one geometry entity without children or scripts. Use assembly or prefab for composites.');
    const components=document.components.filter(c=>source.componentIds.includes(c.id)&&c.enabled);
    const geometry=components.find(c=>c.type==='haiyue.render.geometry'),material=components.find(c=>c.type==='haiyue.render.material'),transform=components.find(c=>c.type==='haiyue.transform.3d');
    if(!geometry||!material||!transform)throw new Error('Array template requires geometry, material and transform.');
    template={...geometry.value,...material.value,rotationDegrees:transform.value.rotationDegrees,scale:transform.value.scale,components:components.filter(c=>!ownedTypes.includes(c.type)).map(({type,version,value})=>({type,version,value}))};
  }
  const spec=parseParametricArray({schemaVersion:1,arrayId:v.arrayId,representation:v.representation??old?.representation,layout:v.layout??old?.layout,template});
  const rootId=existingRoot?asStableId(existingRoot.id):id('entity',`${commandId}:${spec.arrayId}`);
  if(existingRoot&&existingRoot.componentIds.some(id=>document.components.some(c=>c.id===id&&(c.type==='haiyue.render.geometry'||c.type==='haiyue.render.material'))))throw new Error('Array roots must be empty groups. Put geometry/material in the array template.');
  const parentId=v.parentId===undefined?existingRoot?.parentId??null:v.parentId===null?null:asStableId(String(v.parentId));
  if(parentId&&!document.entities.some(e=>e.id===parentId&&e.sceneId===workspace.primarySceneId()))throw new Error('Array parent must belong to the active scene.');
  if(existingRoot&&existingRoot.sceneId!==workspace.primarySceneId())throw new Error('Array must belong to the active scene.');
  const extra=spec.template.components??[];
  for(const c of extra){
    if(ownedTypes.includes(c.type)||c.type===PARAMETRIC_ARRAY_COMPONENT||/script/iu.test(c.type))throw new Error('Array template components must not replace transforms, geometry, material, arrays or scripts.');
    const definition=workspace.componentRegistry.get(c.type,c.version); if(definition.risk==='high')throw new Error('High-risk template components require separate authoring.');
    if(definition.effect!=='data'&&c.type!=='haiyue.interaction.pointer'&&!/^haiyue\.physics\.(?:rigidbody|collider)\.[23]d$/u.test(c.type)&&c.type!=='haiyue.gameplay.state')throw new Error('Only per-cell data, pointer, rigidbody, collider and gameplay-state components can be repeated. Global runtime/GPU/audio owners need separate entities.');
    workspace.componentRegistry.create({id:componentId(rootId,c.type),type:asStableId(c.type),version:c.version,value:c.value});
  }
  const operations: GameDocumentOperationV2[]=[];
  const put=(entityId:StableId,type:string,value:JsonObject,version='1.0.0')=>{
    if(previousSpec!==undefined&&type===PARAMETRIC_ARRAY_COMPONENT)return;
    const owner=document.entities.find(e=>e.id===entityId);
    const current=owner?document.components.find(c=>owner.componentIds.includes(c.id)&&c.type===type):undefined;
    const component=workspace.componentRegistry.create({id:current?asStableId(current.id):componentId(entityId,type),type:asStableId(type),version,value,enabled:current?.enabled??true});
    if(previousSpec!==undefined&&current&&canonicalStringify(current as unknown as JsonValue)===canonicalStringify(component as unknown as JsonValue))return;
    operations.push(current?{op:'component.replace',component}:{op:'component.add',entityId,component});
  };
  const count=spec.layout.rows*spec.layout.columns;
  const nextIds=new Set<string>();
  if(spec.representation==='entities')for(let r=0;r<spec.layout.rows;r++)for(let c=0;c<spec.layout.columns;c++)nextIds.add(parametricArrayEntityId(rootId,r,c));
  const removed=new Set<string>();
  if(old?.representation==='entities')for(let r=0;r<old.layout.rows;r++)for(let c=0;c<old.layout.columns;c++){const oldId=parametricArrayEntityId(rootId,r,c);if(!nextIds.has(oldId)&&document.entities.some(e=>e.id===oldId))removed.add(oldId);}
  // Never silently discard independently authored data when shrinking or changing representation.
  const referencesRemoved=(x:unknown):boolean=>typeof x==='string'?[...removed].some(k=>x.includes(k)):Array.isArray(x)?x.some(referencesRemoved):!!x&&typeof x==='object'?Object.values(x).some(referencesRemoved):false;
  if(removed.size){
    for(const e of document.entities.filter(e=>removed.has(e.id))){
      const expectedTypes=[...ownedTypes,...(old?.template.components??[]).map(c=>c.type)];
      if(e.parentId!==rootId||document.scripts.some(s=>s.entityId===e.id)||document.entities.some(child=>child.parentId===e.id&&!removed.has(child.id))||e.componentIds.some(c=>!expectedTypes.some(t=>componentId(e.id,t)===c)))throw new Error('A removed array cell has independent edits, children or scripts. Preserve or detach those before shrinking.');
    }
    const removedComponents=new Set(document.entities.filter(e=>removed.has(e.id)).flatMap(e=>e.componentIds));
    if(document.components.some(c=>!removedComponents.has(c.id)&&referencesRemoved(c.value))||document.scripts.some(s=>referencesRemoved(s))||referencesRemoved(document.settings))throw new Error('Other authored data references cells that would be removed. Resolve those references before shrinking.');
    for(const e of document.entities.filter(e=>removed.has(e.id))){for(const c of [...e.componentIds].reverse())operations.push({op:'component.remove',entityId:e.id,componentId:c});operations.push({op:'entity.remove',entityId:e.id});}
  }
  const name=v.name===undefined?existingRoot?.name??spec.arrayId:v.name;
  if(typeof name!=='string'||!name.trim()||name.length>80)throw new TypeError('Array name must contain 1-80 characters.');
  if(!existingRoot){operations.push({op:'entity.add',entity:{id:rootId,sceneId:workspace.primarySceneId(),name,parentId,order:document.entities.filter(e=>e.parentId===parentId).length,componentIds:[]}});put(rootId,'haiyue.transform.3d',identity);}
  else if(existingRoot.parentId!==parentId||existingRoot.name!==name)operations.push({op:'entity.update',entityId:rootId,patch:{parentId,name}});
  put(rootId,PARAMETRIC_ARRAY_COMPONENT,spec as unknown as JsonObject);
  const sample: JsonObject[]=[];
  if(spec.representation==='entities')for(let r=0;r<spec.layout.rows;r++)for(let c=0;c<spec.layout.columns;c++){
    const cell=parametricArrayCell(spec,r,c),cellId=parametricArrayEntityId(rootId,r,c);
    const previous=document.entities.find(e=>e.id===cellId);
    if(previous&&previous.parentId!==rootId)throw new Error('A generated cell was moved out of its array. Detach it explicitly before regenerating.');
    if(!previous)operations.push({op:'entity.add',entity:{id:cellId,sceneId:workspace.primarySceneId(),name:`${name} [${r},${c}]`.slice(0,80),parentId:rootId,order:cell.index,componentIds:[]}});
    else if(previous.order!==cell.index)operations.push({op:'entity.update',entityId:cellId,patch:{order:cell.index}});
    if(previous)for(const oldExtra of old?.template.components??[]){
      const oldId=componentId(cellId,oldExtra.type);
      if(!extra.some(c=>c.type===oldExtra.type)&&previous.componentIds.includes(oldId))operations.push({op:'component.remove',entityId:cellId,componentId:oldId});
    }
    put(cellId,'haiyue.transform.3d',{position:cell.position,rotationDegrees:cell.rotationDegrees,scale:cell.scale} as unknown as JsonObject);
    put(cellId,'haiyue.render.geometry',{kind:spec.template.kind,...(spec.template.plane?{plane:spec.template.plane}:{}),...(spec.template.radius===undefined?{}:{radius:spec.template.radius,segments:spec.template.segments!})});
    put(cellId,'haiyue.render.material',{material:spec.template.material,color:cell.color as unknown as JsonValue});
    for(const comp of extra)put(cellId,comp.type,comp.value,comp.version);
    if(sample.length<8)sample.push({key:cell.key,index:cell.index,entityId:cellId});
  }
  if(operations.length>1000)throw new RangeError('Array update exceeds the 1000-operation atomic Document budget. Use a smaller independently editable array or instances. No changes were committed.');
  if(spec.representation==='instances')for(let i=0;i<Math.min(8,count);i++){const cell=parametricArrayCell(spec,Math.floor(i/spec.layout.columns),i%spec.layout.columns);sample.push({key:cell.key,index:cell.index,position:cell.position,color:cell.color as unknown as JsonValue});}
  const modeChanged=!!old&&old.representation!==spec.representation;
  return Object.freeze({rootEntityId:rootId,spec,operations:Object.freeze(operations),value:Object.freeze({arrayId:spec.arrayId,rootEntityId:rootId,representation:spec.representation,count,rows:spec.layout.rows,columns:spec.layout.columns,cellKeys:'row:column',sample:Object.freeze(sample),sampleTruncated:count>sample.length,templateSourceRetained:v.templateEntityId!==undefined,modeChanged,requiresScriptReview:modeChanged&&document.scripts.some(s=>s.entityId===rootId)}) as JsonObject});
}
