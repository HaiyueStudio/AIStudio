import test from 'node:test';
import assert from 'node:assert/strict';
import {compactExternalResult} from '../dist/external-result-projection.js';

test('same-batch Web references preserve provenance and only reuse identical confirmed content',()=>{
 const value={status:'completed',url:'https://example.com',retrievedAt:'2026-10-06',content:'page '.repeat(2000),cached:true,untrusted:true,truncated:false};
 const original={status:'completed',beforeRevision:2,afterRevision:2,value};const delivered=[{toolId:'official.web.fetch',callId:'call:earlier',value:{...value,cached:false}}];
 const result=compactExternalResult(original,'official.web.fetch',delivered);
 assert.equal(result.value.content,undefined);assert.equal(result.value.url,value.url);assert.equal(result.value.duplicateOf.toolCallId,'call:earlier');assert.equal(result.afterRevision,2);
 assert.ok(JSON.stringify(result).length<JSON.stringify(original).length/5);
 for(const previous of [[],[{...delivered[0],toolId:'other.tool'}],[{...delivered[0],value:{...value,retrievedAt:'new'}}],[{...delivered[0],value:{...value,content:'changed'}}]])assert.equal(compactExternalResult(original,'official.web.fetch',previous),original);
});
test('repeated logs and source blocks are losslessly encoded without dropping distinct evidence',()=>{
 for(const [toolId,field] of [['official.code.run','logs'],['official.web.search','sources'],['official.browser.snapshot','content']]){
  const a={text:'same line '.repeat(100)},b={text:'different reference [e2]'};const rows=[a,a,a,b,a];const original={status:'completed',value:{[field]:rows,files:[{name:'out.txt'}],value:{answer:42}}};
  const result=compactExternalResult(original,toolId),counts=result.value.repetitionEncoding.counts;
  assert.deepEqual(result.value[field].flatMap((entry,i)=>Array.from({length:counts[i]},()=>entry)),rows);
  assert.deepEqual(result.value.files,original.value.files);assert.deepEqual(result.value.value,{answer:42});
  assert.equal(compactExternalResult({...original,status:'failed'},toolId).status,'failed');assert.equal(compactExternalResult(original,'script.get'),original);
 }
});
