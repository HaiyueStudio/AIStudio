import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifySubtasks } from '../dist/subtask-qualification.js';
import { qualificationFixture } from './fixtures/qualification.mjs';
import { sha256 as rawHash, canonicalStringify } from '@haiyue/ai-studio-operation-log';
const sha256 = text => `sha256:${rawHash(text)}`;
const identity = q => Object.fromEntries(['backendId','model','profileDigest','registryDigest'].map(k=>[k,q.identity[k]]));
const check = q => qualifySubtasks(q.qualification,'report:fixture',identity(q),[],new AbortController().signal);

test('P1 W7 validates retained paired trials including final M12 parent, child and merge ledgers',async()=>{
 const q=qualificationFixture();assert.match(await check(q),/^report:fixture#sha256:/);
});
for(const mode of ['future','synthetic','wrong-model','wrong-profile','wrong-registry','wrong-revision','wrong-cohort','few-pairs','duplicate-case','missing-merge','bad-digest','unknown-usage','unknown-cost','slow','expensive','quality','secret','missing-ledger'])test(`P1 W7 rejects ${mode}`,async()=>{
 const q=qualificationFixture(),trial=q.report.trials[0],e=q.artifacts.get(trial.parallel.ref);
 if(mode==='future')q.report.schemaVersion=2;
 if(mode==='synthetic')q.report.measurement='mock';
 if(mode==='wrong-model')q.report.identity={...q.identity,model:'other'};
 if(mode==='wrong-profile')q.report.identity={...q.identity,profileDigest:sha256('other')};
 if(mode==='wrong-registry')q.report.identity={...q.identity,registryDigest:sha256('other')};
 if(mode==='wrong-revision')q.qualification.sourceRevision='other';
 if(mode==='wrong-cohort')q.qualification.cohortFor=()=> 'other';
 if(mode==='few-pairs')q.report.trials.length=4;
 if(mode==='duplicate-case')q.report.trials[1].caseId=trial.caseId;
 if(mode==='missing-merge')e.phases=e.phases.filter(p=>p.role!=='merge');
 if(mode==='bad-digest')trial.parallel.digest=sha256('wrong');
 if(mode==='unknown-usage')q.artifacts.get(e.phases[0].ledgerRefs[0].usage).inputTokens=null;
 if(mode==='unknown-cost')q.artifacts.get(e.phases[0].ledgerRefs[0].cost).status='unknown';
 if(mode==='missing-ledger')q.artifacts.delete(e.phases[0].ledgerRefs[0].cost);
 if(mode==='slow') for(const t of q.report.trials)q.artifacts.get(t.parallel.ref).completedAtMs=1100;
 if(mode==='expensive')for(const t of q.report.trials)q.artifacts.get(q.artifacts.get(t.parallel.ref).phases[2].ledgerRefs[0].cost).amountMicros=200;
 if(mode==='quality')e.quality.passed=2;
 if(mode==='secret')q.report.secret='Authorization: Bearer fixture-secret';
 if(mode!=='bad-digest')for(const t of q.report.trials)for(const side of ['serial','parallel'])t[side].digest=sha256(canonicalStringify(q.artifacts.get(t[side].ref)));
 assert.equal(await check(q),null);
});
