import { PARAMETRIC_ARRAY_COMPONENT, parseParametricArray, parametricArrayCell, type ParametricArrayV1 } from '@haiyue/ai-studio-contracts';
import { CartesianTransform3D, Entity, System, type Geometry3D } from '@haiyue/engine';
import { InstancedMesh3D } from '@haiyue/engine/components';
import { Camera3D } from '@haiyue/engine/components';
import { InstancedMaterial, InstancedPbrMaterial } from '@haiyue/engine/material';
import { multiply, inverse, transformPoint } from '@haiyue/ai-studio-script-preview/transforms';
import { playWorldMatrix } from './play-transforms.js';

interface ArrayVisual { readonly spec: ParametricArrayV1; readonly material: InstancedMaterial; readonly local: readonly Float32Array[]; readonly minimum: readonly number[]; readonly maximum: readonly number[]; lastWorld: Float32Array | null; scriptControlled: boolean; }
const visuals=new WeakMap<Entity,ArrayVisual>();
export function sceneParametricArray(item: Readonly<{components?:readonly Readonly<{type:string;enabled?:boolean;value:Readonly<Record<string,unknown>>}>[]}>): ParametricArrayV1 | null {
  const c=item.components?.find(c=>c.type===PARAMETRIC_ARRAY_COMPONENT&&c.enabled!==false);
  return c?parseParametricArray(c.value):null;
}
/** Scene owns native mesh/material resources; weak handles cannot outlive their entity. */
export function attachParametricArrayVisual(entity: Entity,spec: ParametricArrayV1,geometry: Geometry3D): void {
  const count=spec.layout.rows*spec.layout.columns;
  const material=spec.template.material==='pbr'?new InstancedPbrMaterial(count,{metallic:0.05,roughness:0.65}):new InstancedMaterial(count);
  const local:Float32Array[]=[];
  for(let r=0;r<spec.layout.rows;r++)for(let c=0;c<spec.layout.columns;c++){
    const cell=parametricArrayCell(spec,r,c),pose=new CartesianTransform3D({position:[cell.position.x,cell.position.y,cell.position.z],rotation:[cell.rotationDegrees.x*Math.PI/180,cell.rotationDegrees.y*Math.PI/180,cell.rotationDegrees.z*Math.PI/180],scale:[cell.scale.x,cell.scale.y,cell.scale.z]});
    local.push(new Float32Array(pose.localMatrix));material.setColor(cell.index,...cell.color);
  }
  material.setActiveInstanceCount(count);entity.addComponent(new InstancedMesh3D(geometry,material));
  const minimum=[Infinity,Infinity,Infinity],maximum=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<geometry.positions.length;i++){const axis=i%3;minimum[axis]=Math.min(minimum[axis]!,geometry.positions[i]!);maximum[axis]=Math.max(maximum[axis]!,geometry.positions[i]!);}
  visuals.set(entity,{spec,material,local,minimum,maximum,lastWorld:null,scriptControlled:false});refreshParametricArrayVisual(entity);
}
export function refreshParametricArrayVisual(entity: Entity): void {
  const visual=visuals.get(entity);if(!visual||visual.scriptControlled)return;
  const world=playWorldMatrix(entity);
  if(visual.lastWorld&&world.every((v,i)=>v===visual.lastWorld![i]))return;
  visual.local.forEach((m,i)=>visual.material.setTransform(i,multiply(world,m)));visual.lastWorld=world;
}
export function refreshParametricArrays(entities: Iterable<Entity>): void { for(const entity of entities)refreshParametricArrayVisual(entity); }
export class ParametricArrayTransformSystem extends System {
  constructor(){super(entity=>visuals.has(entity),entity=>refreshParametricArrayVisual(entity),'AIStudio Parametric Array Transforms');this.priority=-500;}
}
/** Script instance positions follow the existing world-space API; static layout initialization stops on takeover. */
export function takeParametricArrayVisual(entity:Entity,capacity:number): InstancedMaterial | null {
  const visual=visuals.get(entity);if(!visual)return null;
  if(capacity!==visual.material.instanceCount)throw new RangeError(`Authored array capacity is ${visual.material.instanceCount}; use that fixed capacity for this Play run.`);
  refreshParametricArrayVisual(entity);visual.scriptControlled=true;return visual.material;
}
export function parametricArrayCapacity(entity:Entity):number | null { return visuals.get(entity)?.material.instanceCount??null; }
export function parametricArrayVisualState(entity:Entity) {
  refreshParametricArrayVisual(entity);
  const v=visuals.get(entity);if(!v)return null;
  return Object.freeze({arrayId:v.spec.arrayId,capacity:v.material.instanceCount,count:v.material.activeInstanceCount,
    sample:Object.freeze(Array.from({length:Math.min(8,v.material.activeInstanceCount)},(_,index)=>Object.freeze({index,key:`${Math.floor(index/v.spec.layout.columns)}:${index%v.spec.layout.columns}`,position:Object.freeze(Array.from(v.material.transforms.slice(index*16+12,index*16+15))),color:Object.freeze(Array.from(v.material.colors.slice(index*4,index*4+4)))}))),sampleTruncated:v.material.activeInstanceCount>8});
}

/** Editor selection uses each actual instance transform, without materializing proxy entities. */
export function pickParametricArray(cameraEntity:Entity,ndcX:number,ndcY:number,entities:Iterable<Entity>) {
  const camera=cameraEntity.getComponent(Camera3D);if(!camera)return null;
  const cameraWorld=playWorldMatrix(cameraEntity),unproject=multiply(cameraWorld,inverse(camera.projectionMatrix));
  const distance=(p:readonly number[])=>Math.hypot(p[0]!-cameraWorld[12]!,p[1]!-cameraWorld[13]!,p[2]!-cameraWorld[14]!);
  const points: (readonly [number,number,number])[]=[];
  for(const z of [0,1,.5]){try{points.push(transformPoint(unproject,[ndcX,ndcY,z]));}catch{/* Infinite far planes have one non-finite endpoint. */}}
  if(points.length<2)return null;points.sort((a,b)=>distance(a)-distance(b));
  const origin=points[0]!,far=points.at(-1)!;
  const length=Math.hypot(far[0]-origin[0],far[1]-origin[1],far[2]-origin[2]);if(!length)return null;
  const direction=far.map((v,i)=>(v-origin[i]!)/length),next=origin.map((v,i)=>v+direction[i]!);
  let best:Readonly<{entity:Entity;index:number;key:string;point:readonly number[];distance:number}>|null=null;
  for(const entity of entities){
    refreshParametricArrayVisual(entity);const visual=visuals.get(entity);if(!visual)continue;
    for(let index=0;index<visual.material.activeInstanceCount;index++){
      let inv:Float32Array;try{inv=inverse(visual.material.transforms.subarray(index*16,(index+1)*16));}catch{continue;}
      const localOrigin=transformPoint(inv,origin),localNext=transformPoint(inv,next);let near=0,farT=Infinity;
      for(let axis=0;axis<3;axis++){
        const d=localNext[axis]!-localOrigin[axis]!;
        if(Math.abs(d)<1e-12){if(localOrigin[axis]!<visual.minimum[axis]!||localOrigin[axis]!>visual.maximum[axis]!)farT=-1;continue;}
        const t1=(visual.minimum[axis]!-localOrigin[axis]!)/d,t2=(visual.maximum[axis]!-localOrigin[axis]!)/d;near=Math.max(near,Math.min(t1,t2));farT=Math.min(farT,Math.max(t1,t2));
      }
      if(near>farT||farT<0)continue;
      const point=origin.map((v,i)=>v+direction[i]!*near),hitDistance=distance(point);
      if(!best||hitDistance<best.distance)best=Object.freeze({entity,index,key:`${Math.floor(index/visual.spec.layout.columns)}:${index%visual.spec.layout.columns}`,point:Object.freeze(point),distance:hitDistance});
    }
  }
  return best;
}
