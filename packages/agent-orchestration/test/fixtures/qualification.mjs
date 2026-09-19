import { sha256 as rawHash, canonicalStringify } from '@haiyue/ai-studio-operation-log';
const sha256 = text => `sha256:${rawHash(text)}`;
// Synthetic validator fixtures only. Never production A/B evidence or enablement.
export function qualificationFixture(overrides = {}) {
 const identity = { backendId:'backend:test',model:'fixture-model',profileDigest:sha256('profile'),registryDigest:sha256('registry'), ...overrides,sourceRevision:'fixture-revision',cohort:'fixture-cohort' };
 const artifacts = new Map(), trials=[];
 for(let i=0;i<5;i++) {
  const trial={caseId:`fixture-case:${i}`};
  for(const mode of ['serial','parallel']) {
   const phases=[];
   for(const role of mode==='serial'?['parent']:['parent','children','merge']) {
    const ledgerRefs=[];
    for(let n=0;n<(role==='children'?2:1);n++){
    const key=`fixture:${i}:${mode}:${role}:${n}`;
    const usage={schemaVersion:2,id:`usage:${key}`,taskId:`task:${i}:${mode}`,sessionId:`session:${key}`,turnId:`turn:${key}`,inputTokens:mode==='serial'?1000:100,outputTokens:10,cachedInputTokens:0,cacheWriteTokens:0,reasoningTokens:0,toolInputBytes:0,toolOutputBytes:0,wallTimeMs:100,providerRequestDigest:sha256(key),final:true};
    const cost={schemaVersion:2,id:`cost:${key}`,usageRecordId:usage.id,pricingCatalogId:'pricing:fixture',pricingCatalogVersion:'1',effectiveAt:'2026-01-01T00:00:00.000Z',currency:'USD',amountMicros:mode==='serial'?100:20,status:'estimated',formula:'fixture-only'};
    artifacts.set(usage.id,usage); artifacts.set(cost.id,cost); ledgerRefs.push({usage:usage.id,cost:cost.id});
    }
    phases.push({role,ledgerRefs});
   }
   const evidence={schemaVersion:1,identity,caseId:trial.caseId,mode,startedAtMs:0,completedAtMs:mode==='serial'?1000:700,quality:{required:3,passed:3,criteriaDigest:sha256('fixture-criteria')},phases};
   const ref=`evidence:${i}:${mode}`; artifacts.set(ref,evidence); trial[mode]={ref,digest:sha256(canonicalStringify(evidence))};
  }
  trials.push(trial);
 }
 const report={schemaVersion:1,identity,measurement:'real-provider',trials};
 artifacts.set('report:fixture',report);
 return { identity,report,artifacts,qualify:async()=> 'report:fixture',qualification:{sourceRevision:identity.sourceRevision,cohortFor:()=>identity.cohort,load:async ref=>structuredClone(artifacts.get(ref))} };
}
