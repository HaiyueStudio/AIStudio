import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {isSubtaskSelectionV1,isSubtaskCandidateV1,SUBTASK_SELECTION_SCHEMA,SUBTASK_CANDIDATE_SCHEMA} from '../dist/index.js';
test('W7 contract fixtures reject unknown versions, secrets and malformed envelopes; published schema parity',async()=>{
 const fixture=JSON.parse(await readFile(new URL('../../../config/contracts/fixtures/w7-subtask-contract-cases.json',import.meta.url)));
 const validate=f=>f.schemaId.includes('selection')?isSubtaskSelectionV1(f.value):isSubtaskCandidateV1(f.value);
 for(const f of fixture.valid)assert.ok(validate(f));for(const f of fixture.invalid)assert.equal(validate(f),false);
 assert.equal(isSubtaskSelectionV1({schemaVersion:1,taskIds:['task:one','task:one']}),false);
 for(const [name,schema] of [['selection',SUBTASK_SELECTION_SCHEMA],['candidate',SUBTASK_CANDIDATE_SCHEMA]]){const {$id,$schema,...body}=JSON.parse(await readFile(new URL(`../../../config/contracts/schemas/w7-subtask-${name}.schema.json`,import.meta.url)));assert.deepEqual(body,schema);}
});
