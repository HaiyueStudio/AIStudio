import test from 'node:test';
import assert from 'node:assert/strict';
import {parseParametricArray,parametricArrayCell} from '../dist/index.js';
import {PARAMETRIC_ARRAY_SCHEMA} from '../dist/index.js';
import {readFile} from 'node:fs/promises';
const spec={schemaVersion:1,arrayId:'tiles',representation:'instances',layout:{kind:'grid',rows:20,columns:20,plane:'xy',origin:{x:-10,y:-10,z:0},spacing:{x:1,y:1},seed:17},template:{kind:'rounded-box',palette:[[1,0,0,1],[0,0,1,1]]}};
test('the versioned JSON schema matches the canonical contract used by tools and component validation',async()=>{
 const {$id,$schema,...schema}=JSON.parse(await readFile(new URL('../../../config/contracts/schemas/parametric-array-v1.schema.json',import.meta.url),'utf8'));
 assert.equal($id,'haiyue://contracts/parametric-array/v1');assert.deepEqual(schema,PARAMETRIC_ARRAY_SCHEMA);
 const index=JSON.parse(await readFile(new URL('../../../config/contracts/m12-contract-index.json',import.meta.url),'utf8'));
 assert.equal(index.contracts.find(c=>c.name==='ParametricArrayV1').schemaId,$id);
});
test('parameterized layout is deterministic, bounded and stable by coordinate after a resize',()=>{
 const a=parseParametricArray(spec),b=parseParametricArray({...spec,layout:{...spec.layout,columns:24}});
 assert.deepEqual(parametricArrayCell(a,3,7).position,{x:-3,y:-7,z:0});
 assert.equal(parametricArrayCell(a,3,7).key,'3:7');assert.deepEqual(parametricArrayCell(a,3,7).color,parametricArrayCell(b,3,7).color);
 assert.throws(()=>parametricArrayCell(a,20,0),/outside/);
 assert.deepEqual(parseParametricArray(JSON.parse(JSON.stringify(a))),a);
 for(const plane of ['xz','yz'])assert.equal(parametricArrayCell(parseParametricArray({...spec,layout:{kind:'grid',rows:2,columns:2,plane}}),1,1).position.z,1);
});
test('unknown versions, secrets, unsupported instanced components and oversized layouts fail before allocation',()=>{
 for(const patch of [{schemaVersion:2},{apiKey:'fixture'},{representation:'unknown'},{layout:{kind:'grid',rows:4096,columns:4096}},{layout:{kind:'grid',rows:2,columns:2,spacing:{x:0,y:1}}},{template:{kind:'cube',components:[{type:'haiyue.interaction.pointer',version:'1.0.0',value:{}}]}}])assert.throws(()=>parseParametricArray({...spec,...patch}));
 assert.throws(()=>parseParametricArray({...spec,representation:'entities',layout:{kind:'grid',rows:1,columns:2},template:{kind:'cube',components:[{type:'haiyue.test',version:'1.0.0',value:{authorization:'fixture'}}]}}));
});
