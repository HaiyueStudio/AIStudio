import type { JsonObject, JsonValue } from './index.js';
import type { ParametricArrayV1 } from './m12.js';

export const PARAMETRIC_ARRAY_COMPONENT = 'haiyue.scene.array';
export const PARAMETRIC_ARRAY_LIMITS = Object.freeze({ entities: 128, instances: 4096 });
const vec = { type:'object', additionalProperties:false, required:['x','y','z'], properties:{x:{type:'number',minimum:-100000,maximum:100000},y:{type:'number',minimum:-100000,maximum:100000},z:{type:'number',minimum:-100000,maximum:100000}} };
const color = {type:'array',minItems:4,maxItems:4,items:{type:'number',minimum:0,maximum:1}};
export const PARAMETRIC_ARRAY_SCHEMA: JsonObject = {
  type:'object',additionalProperties:false,required:['schemaVersion','arrayId','representation','layout','template'],properties:{
    schemaVersion:{enum:[1]},arrayId:{type:'string',pattern:'^[A-Za-z][A-Za-z0-9_-]{0,47}$'},representation:{enum:['entities','instances']},
    layout:{type:'object',additionalProperties:false,required:['kind','rows','columns'],properties:{kind:{enum:['grid']},rows:{type:'integer',minimum:1,maximum:4096},columns:{type:'integer',minimum:1,maximum:4096},plane:{enum:['xy','xz','yz']},origin:vec,spacing:{type:'object',additionalProperties:false,required:['x','y'],properties:{x:{type:'number',minimum:0.0001,maximum:100000},y:{type:'number',minimum:0.0001,maximum:100000}}},seed:{type:'integer',minimum:0,maximum:4294967295}}},
    template:{type:'object',additionalProperties:false,required:['kind'],properties:{kind:{enum:['cube','rounded-box','sphere','cone','cylinder','plane','torus','icosahedron']},material:{enum:['basic','pbr','blinn-phong','normal']},color,palette:{type:'array',minItems:1,maxItems:32,items:color},rotationDegrees:vec,scale:vec,plane:{enum:['xy','xz','yz']},radius:{type:'number',minimum:0,maximum:0.5},segments:{type:'integer',minimum:1,maximum:16},components:{type:'array',maxItems:8,items:{type:'object',additionalProperties:false,required:['type','version','value'],properties:{type:{type:'string',pattern:'^haiyue\\.[a-z0-9.-]+$'},version:{type:'string',pattern:'^[0-9]+\\.[0-9]+\\.[0-9]+$'},value:{type:'object'}}}}}}
  }
};
const bad = (): never => { throw new TypeError('Invalid parameterized array; use a bounded grid, supported geometry and registered component values.'); };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function keys(v: unknown, required: string[], optional: string[] = []): Record<string,unknown> {
  if (!record(v) || required.some(k=>!(k in v)) || Object.keys(v).some(k=>![...required,...optional].includes(k))) return bad(); return v;
}
function number(v: unknown, min: number, max: number, integer = false): number { if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||(integer&&!Number.isInteger(v))) return bad(); return v; }
function vector(v: unknown, fallback: Readonly<{x:number;y:number;z:number}>): Readonly<{x:number;y:number;z:number}> { if(v===undefined)return Object.freeze({...fallback});const p=keys(v,['x','y','z']);return Object.freeze({x:number(p.x,-100000,100000),y:number(p.y,-100000,100000),z:number(p.z,-100000,100000)}); }
function rgba(v: unknown): readonly [number,number,number,number] { if(!Array.isArray(v)||v.length!==4)return bad();return Object.freeze(v.map(n=>number(n,0,1))) as unknown as readonly [number,number,number,number]; }
function json(v: unknown, depth=0): JsonValue {
  if(depth>16)return bad(); if(v===null||typeof v==='boolean'||typeof v==='string')return v;
  if(typeof v==='number'&&Number.isFinite(v))return v;
  if(Array.isArray(v))return Object.freeze(v.map(i=>json(i,depth+1)));
  if(record(v)){if(Object.keys(v).some(k=>/^(?:__proto__|constructor|prototype|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|cookie|client[-_]?secret)$/iu.test(k)))return bad();return Object.freeze(Object.fromEntries(Object.entries(v).map(([k,x])=>[k,json(x,depth+1)])));}return bad();
}
export function parseParametricArray(value: unknown): ParametricArrayV1 {
  const v=keys(value,['schemaVersion','arrayId','representation','layout','template']);
  if(v.schemaVersion!==1||typeof v.arrayId!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,47}$/u.test(v.arrayId)||(v.representation!=='entities'&&v.representation!=='instances'))return bad();
  const l=keys(v.layout,['kind','rows','columns'],['plane','origin','spacing','seed']);
  if(l.kind!=='grid'||(l.plane!==undefined&&!['xy','xz','yz'].includes(String(l.plane))))return bad();
  const rows=number(l.rows,1,4096,true),columns=number(l.columns,1,4096,true);
  if(rows*columns>PARAMETRIC_ARRAY_LIMITS[v.representation])throw new RangeError(`Array ${v.representation} count exceeds ${PARAMETRIC_ARRAY_LIMITS[v.representation]}. Use instances for a large homogeneous display or a smaller independently editable array.`);
  const spacing=l.spacing===undefined?{x:1,y:1}:keys(l.spacing,['x','y']);
  const t=keys(v.template,['kind'],['material','color','palette','rotationDegrees','scale','plane','radius','segments','components']);
  if(!['cube','rounded-box','sphere','cone','cylinder','plane','torus','icosahedron'].includes(String(t.kind))||typeof t.kind!=='string')return bad();
  const material=t.material??'basic';if(!['basic','pbr','blinn-phong','normal'].includes(String(material))||typeof material!=='string')return bad();
  if(v.representation==='instances'&&!['basic','pbr'].includes(material))throw new TypeError('Instanced arrays support basic and pbr materials. Use entities for other materials.');
  if((t.plane!==undefined&&(t.kind!=='plane'||!['xy','xz','yz'].includes(String(t.plane))))||((t.radius!==undefined||t.segments!==undefined)&&t.kind!=='rounded-box'))return bad();
  if(t.components!==undefined&&(!Array.isArray(t.components)||t.components.length>8))return bad();
  if(v.representation==='instances'&&Array.isArray(t.components)&&t.components.length)throw new TypeError('Per-cell components require entities representation. Use a separate controller or interaction surface with instances.');
  const components=Array.isArray(t.components)?t.components.map(c=>{const p=keys(c,['type','version','value']);if(typeof p.type!=='string'||!/^haiyue\.[a-z0-9.-]+$/u.test(p.type)||typeof p.version!=='string'||!/^\d+\.\d+\.\d+$/u.test(p.version)||!record(p.value))return bad();return Object.freeze({type:p.type,version:p.version,value:json(p.value) as JsonObject});}):undefined;
  if(components&&new Set(components.map(c=>c.type)).size!==components.length)return bad();
  const scale=vector(t.scale,{x:1,y:1,z:1}); if([scale.x,scale.y,scale.z].some(n=>n<0.0001))return bad();
  if(t.palette!==undefined&&(!Array.isArray(t.palette)||!t.palette.length||t.palette.length>32))return bad();
  const result: ParametricArrayV1={schemaVersion:1,arrayId:v.arrayId,representation:v.representation,layout:Object.freeze({kind:'grid',rows,columns,plane:(l.plane??'xy') as 'xy'|'xz'|'yz',origin:vector(l.origin,{x:0,y:0,z:0}),spacing:Object.freeze({x:number(spacing.x,0.0001,100000),y:number(spacing.y,0.0001,100000)}),seed:number(l.seed??0,0,4294967295,true)}),template:Object.freeze({kind:t.kind as ParametricArrayV1['template']['kind'],material:material as ParametricArrayV1['template']['material'],color:rgba(t.color??[0.16,0.58,1,1]),rotationDegrees:vector(t.rotationDegrees,{x:0,y:0,z:0}),scale,...(t.plane===undefined?{}:{plane:t.plane as 'xy'|'xz'|'yz'}),...(t.kind==='rounded-box'?{radius:number(t.radius??0.075,0,0.5),segments:number(t.segments??4,1,16,true)}:{}),...(Array.isArray(t.palette)?{palette:Object.freeze(t.palette.map(rgba))}:{}),...(components?{components:Object.freeze(components)}:{})})};
  // Validate generated extents before allocating entities, matrices or GPU buffers.
  for(const r of [0,rows-1])for(const c of [0,columns-1]){const p=parametricArrayCell(result,r,c).position;if(Object.values(p).some(n=>!Number.isFinite(n)||Math.abs(n)>100000))return bad();}
  return Object.freeze(result);
}
export function parametricArrayCell(spec: ParametricArrayV1, row: number, column: number) {
  if(!Number.isInteger(row)||!Number.isInteger(column)||row<0||column<0||row>=spec.layout.rows||column>=spec.layout.columns)throw new RangeError('Array cell is outside the grid.');
  const {origin,spacing,plane,seed}=spec.layout; const a=column*spacing.x,b=row*spacing.y;
  const position=Object.freeze({x:origin.x+(plane==='yz'?0:a),y:origin.y+(plane==='xy'?b:plane==='yz'?a:0),z:origin.z+(plane==='xy'?0:b)});
  const hash=(Math.imul(row+1,73856093)^Math.imul(column+1,19349663)^seed)>>>0;
  const color=spec.template.palette?.[hash%spec.template.palette.length]??spec.template.color;
  return Object.freeze({key:`${row}:${column}`,index:row*spec.layout.columns+column,position,rotationDegrees:spec.template.rotationDegrees,scale:spec.template.scale,color});
}
export function parametricArrayAppearance(spec:ParametricArrayV1,material:ParametricArrayV1['template']['material'],color?:readonly number[]):ParametricArrayV1 {
  const {palette,...uniform}=spec.template;
  return parseParametricArray({...spec,template:color?{...uniform,material,color}:{...spec.template,material}});
}
