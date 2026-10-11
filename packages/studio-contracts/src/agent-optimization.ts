import { asStableId, type StableId } from './index.js';
import { parseExperienceDraft, type AgentExperienceDraftV1 } from './agent-experience.js';
import type { EvaluationResultV2 } from './m12.js';

/** Project-scoped advice releases. These never change executable code or approval policy. */
export interface ExperienceMatchCaseV1 { readonly id: StableId; readonly request: string; readonly expectedIds: readonly StableId[]; }
/** Untrusted model suggestions. Finding indexes refer only to the supplied review. */
export interface ExperienceSuggestionV1 {
  readonly schemaVersion: 1;
  readonly summary: string;
  readonly proposals: readonly Readonly<{ findingIndex: number; draft: AgentExperienceDraftV1; positiveRequest: string; negativeRequest: string }>[];
}
export interface ExperienceAutoStatusV1 {
  readonly schemaVersion: 1; readonly projectId: StableId;
  readonly taskId: StableId | null; readonly sourceDigest: string | null; readonly taskRevision: number;
  readonly status: 'idle' | 'running' | 'waiting' | 'completed' | 'none' | 'failed' | 'cancelled';
  readonly summary: string; readonly usageLabel: string | null;
}
export function parseExperienceAutoStatus(value: unknown): ExperienceAutoStatusV1 {
  const v = shape(value,['schemaVersion','projectId','taskId','sourceDigest','taskRevision','status','summary','usageLabel']);
  if (v.schemaVersion !== 1 || !['idle','running','waiting','completed','none','failed','cancelled'].includes(String(v.status))) fail();
  id(v.projectId); if (v.taskId !== null) id(v.taskId); integer(v.taskRevision);
  if (v.sourceDigest !== null && (typeof v.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(v.sourceDigest))) fail();
  if ((v.taskId === null) !== (v.sourceDigest === null)) fail();
  text(v.summary,2000); if (v.usageLabel !== null) text(v.usageLabel,2000);
  return v as unknown as ExperienceAutoStatusV1;
}
export function parseExperienceSuggestion(value: unknown): ExperienceSuggestionV1 {
  const v = shape(value,['schemaVersion','summary','proposals']);
  if (v.schemaVersion !== 1 || !Array.isArray(v.proposals) || v.proposals.length > 3) fail();
  text(v.summary,2000); const indexes = new Set<number>();
  for (const raw of v.proposals) {
    const p = shape(raw,['findingIndex','draft','positiveRequest','negativeRequest']);
    integer(p.findingIndex); if (Number(p.findingIndex) > 11 || indexes.has(Number(p.findingIndex))) fail(); indexes.add(Number(p.findingIndex));
    parseExperienceDraft(p.draft); text(p.positiveRequest,2000); text(p.negativeRequest,2000);
    if (String(p.positiveRequest).trim().toLowerCase() === String(p.negativeRequest).trim().toLowerCase()) fail();
  }
  return v as unknown as ExperienceSuggestionV1;
}
export interface ExperienceCandidateV1 {
  readonly id: StableId; readonly title: string; readonly revision: number; readonly createdAt: string;
  readonly baseReleaseId: StableId; readonly sourceLibraryRevision: number; readonly sourceLibraryArtifactId: StableId;
  readonly libraryArtifactId: StableId; readonly cases: readonly ExperienceMatchCaseV1[];
  readonly validation: null | Readonly<{ candidateRevision: number; evaluationArtifactId: StableId; comparisonArtifactId: StableId; passed: boolean; evaluatedAt: string }>;
}
export interface ExperienceReleaseV1 {
  readonly id: StableId; readonly number: number; readonly title: string; readonly createdAt: string;
  readonly kind: 'baseline' | 'publish' | 'rollback'; readonly libraryArtifactId: StableId; readonly sourceLibraryArtifactId: StableId;
  readonly candidateId: StableId | null; readonly evaluationArtifactId: StableId | null; readonly restoredReleaseId: StableId | null;
}
export interface ExperienceOptimizationStateV1 {
  readonly schemaVersion: 1; readonly projectId: StableId; readonly revision: number;
  readonly activeReleaseId: StableId | null; readonly candidate: ExperienceCandidateV1 | null;
  readonly releases: readonly ExperienceReleaseV1[];
  /** Absent in older projects; recovered from their saved candidate or published report. */
  readonly regressionCases?: readonly ExperienceMatchCaseV1[];
}
export interface ExperienceComparisonV1 {
  readonly projectId: StableId; readonly candidateId: StableId; readonly candidateRevision: number;
  readonly candidateLibraryArtifactId: StableId; readonly baselineLibraryArtifactId: StableId; readonly taskArtifactId: StableId;
  readonly cases: readonly (ExperienceMatchCaseV1 & Readonly<{beforeIds: readonly StableId[]; afterIds: readonly StableId[]; beforePass: boolean; afterPass: boolean; beforeBytes: number; afterBytes: number}>)[];
}
/** Validate the existing M12 envelope's offline experience evaluator subset, not a second evaluation format. */
export function parseExperienceValidation(evaluation: unknown, comparison: unknown): {evaluation: EvaluationResultV2; comparison: ExperienceComparisonV1} {
  const c = shape(comparison,['projectId','candidateId','candidateRevision','candidateLibraryArtifactId','baselineLibraryArtifactId','taskArtifactId','cases']);
  for (const key of ['projectId','candidateId','candidateLibraryArtifactId','baselineLibraryArtifactId','taskArtifactId']) id(c[key]);
  integer(c.candidateRevision,1);
  if (!Array.isArray(c.cases)) fail();
  parseExperienceCases(c.cases.map(raw => { const row = shape(raw,['id','request','expectedIds','beforeIds','afterIds','beforePass','afterPass','beforeBytes','afterBytes']);
    for (const key of ['beforeIds','afterIds']) { if (!Array.isArray(row[key]) || row[key].length > 3 || new Set(row[key]).size !== row[key].length) fail(); row[key].forEach(id); }
    bool(row.beforePass); bool(row.afterPass); integer(row.beforeBytes); integer(row.afterBytes);
    for (const side of ['before','after']) if (row[`${side}Pass`] !== equalIds(row[`${side}Ids`],row.expectedIds)) fail();
    return {id:row.id,request:row.request,expectedIds:row.expectedIds};
  }));
  const e = shape(evaluation,['schemaVersion','id','taskId','evaluatorVersion','status','acceptanceResults','budgetStatus','usageRecordIds','costRecordIds','turns','tools','completedAt']);
  if (e.schemaVersion !== 2 || !['1.0.0','1.1.0'].includes(String(e.evaluatorVersion)) || !['pass','fail'].includes(String(e.status)) || e.budgetStatus !== 'within' || e.taskId !== `task:${String(c.candidateId)}`) fail();
  id(e.id); id(e.taskId); date(e.completedAt);
  for (const key of ['usageRecordIds','costRecordIds','turns','tools']) if (!Array.isArray(e[key]) || e[key].length) fail();
  if (!Array.isArray(e.acceptanceResults) || e.acceptanceResults.length !== 4 + c.cases.length) fail();
  const expected = ['acceptance:current','acceptance:changed','acceptance:sources','acceptance:coverage',...c.cases.map(row => `acceptance:case-${row.id}`)];
  const checks = new Map<string,Record<string,unknown>>();
  for (const raw of e.acceptanceResults) {
    const r = shape(raw,['acceptanceId','status','evidenceIds','diagnostic']); id(r.acceptanceId);
    if (!expected.includes(String(r.acceptanceId)) || checks.has(String(r.acceptanceId)) || !['pass','fail'].includes(String(r.status)) || !Array.isArray(r.evidenceIds) || r.evidenceIds.length !== 1) fail();
    r.evidenceIds.forEach(id); if (r.diagnostic !== null) text(r.diagnostic,4096); checks.set(String(r.acceptanceId),r);
  }
  if ((e.status === 'pass') !== [...checks.values()].every(r => r.status === 'pass')) fail();
  for (const row of c.cases) if ((checks.get(`acceptance:case-${row.id}`)?.status === 'pass') !== row.afterPass) fail();
  return {evaluation:e as unknown as EvaluationResultV2,comparison:c as unknown as ExperienceComparisonV1};
}
function equalIds(a: unknown,b: unknown): boolean { return Array.isArray(a) && Array.isArray(b) && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()); }
type CommandBase = Readonly<{ schemaVersion: 1; projectId: StableId; expectedRevision: number }>;
export type ExperienceOptimizationCommandV1 = CommandBase & (
  | Readonly<{ action: 'create'; title: string }>
  | Readonly<{ action: 'edit'; experienceId: StableId; enabled: boolean; draft: AgentExperienceDraftV1 }>
  | Readonly<{ action: 'cases'; cases: readonly ExperienceMatchCaseV1[] }>
  | Readonly<{ action: 'validate' | 'publish' | 'discard' }>
  | Readonly<{ action: 'rollback'; releaseId: StableId }>
);
export function parseExperienceCases(value: unknown): readonly ExperienceMatchCaseV1[] {
  if (!Array.isArray(value) || value.length > 24) fail();
  const ids = new Set<string>(), requests = new Set<string>();
  for (const raw of value) {
    const v = shape(raw,['id','request','expectedIds']); id(v.id); text(v.id,96); text(v.request,2000);
    if (!Array.isArray(v.expectedIds) || v.expectedIds.length > 3 || new Set(v.expectedIds).size !== v.expectedIds.length) fail();
    v.expectedIds.forEach(id);
    const request = (v.request as string).trim().toLocaleLowerCase();
    if (ids.has(v.id as string) || requests.has(request)) fail(); ids.add(v.id as string); requests.add(request);
  }
  return value as unknown as readonly ExperienceMatchCaseV1[];
}
export function parseExperienceOptimizationCommand(value: unknown): ExperienceOptimizationCommandV1 {
  const v = object(value); const base = ['schemaVersion','projectId','expectedRevision','action'];
  if (v.schemaVersion !== 1) fail(); id(v.projectId); integer(v.expectedRevision);
  if (v.action === 'create') { shape(v,[...base,'title']); text(v.title,200); }
  else if (v.action === 'edit') { shape(v,[...base,'experienceId','enabled','draft']); id(v.experienceId); bool(v.enabled); parseExperienceDraft(v.draft); }
  else if (v.action === 'cases') { shape(v,[...base,'cases']); parseExperienceCases(v.cases); }
  else if (v.action === 'rollback') { shape(v,[...base,'releaseId']); id(v.releaseId); }
  else if (['validate','publish','discard'].includes(String(v.action))) shape(v,base);
  else fail();
  return v as unknown as ExperienceOptimizationCommandV1;
}
export function parseExperienceOptimizationState(value: unknown): ExperienceOptimizationStateV1 {
  const hasCases = !!value && typeof value === 'object' && 'regressionCases' in value;
  const v = shape(value,['schemaVersion','projectId','revision','activeReleaseId','candidate','releases',...(hasCases ? ['regressionCases'] : [])]);
  if (hasCases) parseExperienceCases(v.regressionCases);
  if (v.schemaVersion !== 1 || !Array.isArray(v.releases) || v.releases.length > 20) fail(); id(v.projectId); integer(v.revision);
  const ids = new Set<string>(); let last = 0;
  for (const raw of v.releases) {
    const r = shape(raw,['id','number','title','createdAt','kind','libraryArtifactId','sourceLibraryArtifactId','candidateId','evaluationArtifactId','restoredReleaseId']);
    id(r.id); integer(r.number,1); text(r.title,200); date(r.createdAt); id(r.libraryArtifactId); id(r.sourceLibraryArtifactId);
    for (const field of ['candidateId','evaluationArtifactId','restoredReleaseId']) if (r[field] !== null) id(r[field]);
    if (!['baseline','publish','rollback'].includes(String(r.kind)) || ids.has(String(r.id)) || Number(r.number) <= last) fail();
    if (r.kind === 'publish' && (r.candidateId === null || r.evaluationArtifactId === null)) fail();
    if (r.kind === 'rollback' && r.restoredReleaseId === null) fail();
    ids.add(String(r.id)); last = Number(r.number);
  }
  if (v.activeReleaseId === null ? v.releases.length > 0 : !ids.has(String(v.activeReleaseId))) fail();
  if (v.releases.length && (v.releases.at(-1) as ExperienceReleaseV1).id !== v.activeReleaseId) fail();
  if (v.candidate !== null) {
    const c = shape(v.candidate,['id','title','revision','createdAt','baseReleaseId','sourceLibraryRevision','sourceLibraryArtifactId','libraryArtifactId','cases','validation']);
    id(c.id); text(c.title,200); integer(c.revision,1); date(c.createdAt); id(c.baseReleaseId); integer(c.sourceLibraryRevision); id(c.sourceLibraryArtifactId); id(c.libraryArtifactId); parseExperienceCases(c.cases);
    if (c.baseReleaseId !== v.activeReleaseId) fail();
    if (c.validation !== null) {
      const check = shape(c.validation,['candidateRevision','evaluationArtifactId','comparisonArtifactId','passed','evaluatedAt']);
      if (check.candidateRevision !== c.revision) fail(); id(check.evaluationArtifactId); id(check.comparisonArtifactId); bool(check.passed); date(check.evaluatedAt);
    }
  }
  return v as unknown as ExperienceOptimizationStateV1;
}
function object(v: unknown): Record<string,unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(); return v as Record<string,unknown>; }
function shape(v: unknown, keys: readonly string[]): Record<string,unknown> { const o = object(v); if (Object.keys(o).length !== keys.length || Object.keys(o).some(k => !keys.includes(k))) fail(); return o; }
function text(v: unknown,max: number): void { parseExperienceDraft({title:'validation',condition:'validation',recommendation:v,keywords:['validation']}); if (typeof v !== 'string' || v.length > max) fail(); }
function id(v: unknown): void { text(v,128); asStableId(v as string); }
function date(v: unknown): void { text(v,40); if (!Number.isFinite(Date.parse(v as string))) fail(); }
function integer(v: unknown,min=0): void { if (!Number.isSafeInteger(v) || Number(v) < min) fail(); }
function bool(v: unknown): void { if (typeof v !== 'boolean') fail(); }
function fail(): never { throw new Error('候选优化数据无效、包含敏感信息或版本不受支持。'); }
