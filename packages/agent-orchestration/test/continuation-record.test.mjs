import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContinuationRecord } from '../dist/continuation-record.js';
const record={schemaVersion:1,id:`continuation:${'a'.repeat(64)}`,taskId:'task:receipt',instruction:'Continue with the recorded answer.',budgetGranted:false,plan:null,
 node:{schemaVersion:1,id:'node:receipt',kind:'question',status:'completed',createdAt:'2026-10-07T00:00:00.000Z',provenance:{backendId:'backend:receipt',sessionId:'session:receipt',turnId:'turn:receipt'},content:{prompt:'Which color?',options:[{id:'option:blue',label:'Blue'},{id:'option:green',label:'Green'}],allowFreeform:true,multiple:false}}};
test('continuation payload validates versions, ownership IDs, terminal decisions and secret-free content',()=>{
 assert.equal(parseContinuationRecord(record).taskId,record.taskId);
 for(const value of [null,{}, {...record,schemaVersion:2}, {...record,id:'continuation:invalid'}, {...record,taskId:''}, {...record,extra:true}, {...record,instruction:'Bearer SECRET_CANARY'}, {...record,node:{...record.node,status:'pending'}}, {...record,plan:{title:'Bad',summary:'Bad',items:[],attempts:-1,mutationCount:0}}])assert.throws(()=>parseContinuationRecord(value));
});
