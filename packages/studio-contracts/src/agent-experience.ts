import { asStableId, type StableId } from './index.js';
import { parseReviewFindings, type AgentReviewFindingV1 } from './agent-review.js';

/** User-reviewed project advice. It never grants tools, approvals or mutation authority. */
export interface AgentExperienceDraftV1 {
  readonly title: string;
  readonly condition: string;
  readonly recommendation: string;
  readonly keywords: readonly string[];
  readonly matching?: {
    readonly schemaVersion: 1;
    readonly minimumMatches: number;
    readonly requiredKeywords: readonly string[];
    readonly excludedKeywords: readonly string[];
  };
}
export interface AgentExperienceV1 extends AgentExperienceDraftV1 {
  readonly schemaVersion: 1;
  readonly id: StableId;
  readonly projectId: StableId;
  readonly revision: number;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source: {
    readonly taskId: StableId;
    readonly taskRevision: number;
    readonly reviewDigest: string;
    readonly reviewArtifactId: StableId;
    readonly findingSource: 'rules' | 'deep';
    readonly finding: AgentReviewFindingV1;
  };
}
export interface AgentExperienceLibraryV1 {
  readonly schemaVersion: 1;
  readonly projectId: StableId;
  readonly revision: number;
  readonly entries: readonly AgentExperienceV1[];
}
/** Operational project switch; independent of draft edits and published versions. */
export interface AgentExperienceReuseStateV1 {
  readonly schemaVersion: 1; readonly projectId: StableId; readonly revision: number;
  readonly paused: boolean; readonly updatedAt: string | null;
}
export interface AgentExperienceReuseChangeV1 {
  readonly schemaVersion: 1; readonly projectId: StableId; readonly expectedRevision: number; readonly paused: boolean;
}
export function parseExperienceReuseState(value: unknown): AgentExperienceReuseStateV1 {
  const v = shape(value,['schemaVersion','projectId','revision','paused','updatedAt']);
  if (v.schemaVersion !== 1 || typeof v.paused !== 'boolean') fail(); id(v.projectId); integer(v.revision);
  if (v.revision === 0) { if (v.updatedAt !== null || v.paused) fail(); } else date(v.updatedAt);
  return v as unknown as AgentExperienceReuseStateV1;
}
export function parseExperienceReuseChange(value: unknown): AgentExperienceReuseChangeV1 {
  const v = shape(value,['schemaVersion','projectId','expectedRevision','paused']);
  if (v.schemaVersion !== 1 || typeof v.paused !== 'boolean') fail(); id(v.projectId); integer(v.expectedRevision);
  return v as unknown as AgentExperienceReuseChangeV1;
}
export interface AgentExperienceAdoptionV1 {
  readonly schemaVersion: 1;
  readonly projectId: StableId;
  readonly taskId: StableId;
  readonly reviewDigest: string;
  readonly findingSource: 'rules' | 'deep';
  readonly finding: AgentReviewFindingV1;
  readonly draft: AgentExperienceDraftV1;
}
/** Selection travels through the existing ContextArtifactV2 playbook path. */
export interface AgentExperienceSelectionV1 {
  readonly schemaVersion: 1;
  readonly projectId: StableId;
  readonly libraryRevision: number;
  readonly libraryArtifactId: StableId | null;
  readonly releaseId?: StableId;
  readonly entries: readonly { readonly experience: AgentExperienceV1; readonly matchedKeywords: readonly string[] }[];
}
export function parseExperienceDraft(value: unknown): AgentExperienceDraftV1 {
  const v = shape(value, ['title','condition','recommendation','keywords',...optionalMatching(value)]);
  text(v.title, 200); text(v.condition, 800); text(v.recommendation, 2000); keywords(v.keywords);
  if ('matching' in v) {
    const m = shape(v.matching,['schemaVersion','minimumMatches','requiredKeywords','excludedKeywords']);
    if (m.schemaVersion !== 1) fail(); integer(m.minimumMatches,1);
    const terms = (v.keywords as string[]).map(normalizeTerm);
    if (new Set(terms).size !== terms.length || Number(m.minimumMatches) > terms.length) fail();
    for (const list of [m.requiredKeywords,m.excludedKeywords]) {
      if (!Array.isArray(list) || list.length > 12) fail();
      if (list.length) keywords(list);
      if (new Set(list.map(normalizeTerm)).size !== list.length) fail();
    }
    if ((m.requiredKeywords as string[]).some(k => !terms.includes(normalizeTerm(k))) || (m.excludedKeywords as string[]).some(k => terms.includes(normalizeTerm(k)))) fail();
  }
  return v as unknown as AgentExperienceDraftV1;
}
export function parseAgentExperience(value: unknown): AgentExperienceV1 {
  const v = shape(value, ['schemaVersion','id','projectId','revision','enabled','createdAt','updatedAt','title','condition','recommendation','keywords','source',...optionalMatching(value)]);
  if (v.schemaVersion !== 1 || typeof v.enabled !== 'boolean') fail();
  id(v.id); id(v.projectId); integer(v.revision, 1); date(v.createdAt); date(v.updatedAt);
  parseExperienceDraft({title:v.title,condition:v.condition,recommendation:v.recommendation,keywords:v.keywords,...('matching' in v ? {matching:v.matching} : {})});
  const s = shape(v.source, ['taskId','taskRevision','reviewDigest','reviewArtifactId','findingSource','finding']);
  id(s.taskId); integer(s.taskRevision); digest(s.reviewDigest); id(s.reviewArtifactId); findingSource(s.findingSource); finding(s.finding);
  return v as unknown as AgentExperienceV1;
}
export function parseExperienceLibrary(value: unknown): AgentExperienceLibraryV1 {
  const v = shape(value, ['schemaVersion','projectId','revision','entries']);
  if (v.schemaVersion !== 1 || !Array.isArray(v.entries) || v.entries.length > 100) fail();
  id(v.projectId); integer(v.revision);
  if (v.entries.length && Number(v.revision) < 1) fail();
  const ids = new Set<string>();
  for (const raw of v.entries) { const e = parseAgentExperience(raw); if (e.projectId !== v.projectId || ids.has(e.id)) fail(); ids.add(e.id); }
  return v as unknown as AgentExperienceLibraryV1;
}
export function parseExperienceAdoption(value: unknown): AgentExperienceAdoptionV1 {
  const v = shape(value, ['schemaVersion','projectId','taskId','reviewDigest','findingSource','finding','draft']);
  if (v.schemaVersion !== 1) fail();
  id(v.projectId); id(v.taskId); digest(v.reviewDigest); findingSource(v.findingSource); finding(v.finding); parseExperienceDraft(v.draft);
  return v as unknown as AgentExperienceAdoptionV1;
}
export function parseExperienceSelection(value: unknown): AgentExperienceSelectionV1 {
  const released = !!value && typeof value === 'object' && 'releaseId' in value;
  const v = shape(value, ['schemaVersion','projectId','libraryRevision','libraryArtifactId','entries',...(released ? ['releaseId'] : [])]);
  if (released) id(v.releaseId);
  if (v.schemaVersion !== 1 || !Array.isArray(v.entries) || v.entries.length > 3) fail();
  id(v.projectId); integer(v.libraryRevision); if (v.libraryArtifactId !== null) id(v.libraryArtifactId);
  if (v.entries.length && v.libraryArtifactId === null) fail();
  if (v.entries.length && Number(v.libraryRevision) < 1) fail();
  const ids = new Set<string>();
  for (const raw of v.entries) {
    const item = shape(raw, ['experience','matchedKeywords']); const e = parseAgentExperience(item.experience);
    keywords(item.matchedKeywords);
    if (!e.enabled || e.projectId !== v.projectId || ids.has(e.id) || (item.matchedKeywords as string[]).some(k => !e.keywords.includes(k))) fail();
    if (e.matching) {
      const matches = new Set((item.matchedKeywords as string[]).map(normalizeTerm));
      if (matches.size < e.matching.minimumMatches || e.matching.requiredKeywords.some(k => !matches.has(normalizeTerm(k)))) fail();
    }
    ids.add(e.id);
  }
  return v as unknown as AgentExperienceSelectionV1;
}
function finding(value: unknown): void {
  if (!value || typeof value !== 'object' || !('recordIds' in value) || !Array.isArray(value.recordIds)) fail();
  value.recordIds.forEach(id);
  parseReviewFindings([value],new Set(value.recordIds));
  const f = value as AgentReviewFindingV1;
  text(f.code,120); text(f.title,200); text(f.detail,2000); text(f.recommendation,2000);
}
function shape(value: unknown, keys: readonly string[]): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k))) fail();
  return value as Record<string,unknown>;
}
function optionalMatching(value: unknown): string[] { return value !== null && typeof value === 'object' && 'matching' in value ? ['matching'] : []; }
function normalizeTerm(value: string): string { return value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu,' '); }
function text(value: unknown, max: number): void {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /Bearer\s+[\w.~-]{8,}|\bsk-[\w-]{8,}|SECRET_CANARY|CODEX_TOKEN_CANARY|API_KEY_CANARY|(?:api[_-]?key|authorization|access[_-]?token|private[_-]?key)\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu.test(value)) fail();
}
function keywords(value: unknown): void {
  if (!Array.isArray(value) || !value.length || value.length > 12 || new Set(value).size !== value.length) fail();
  for (const k of value) { text(k, 40); if ((k as string).trim().length < 2) fail(); }
}
function id(value: unknown): void { text(value, 256); asStableId(value as string); }
function integer(value: unknown, min = 0): void { if (!Number.isSafeInteger(value) || Number(value) < min) fail(); }
function date(value: unknown): void { text(value,40); if (!Number.isFinite(Date.parse(value as string))) fail(); }
function digest(value: unknown): void { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(); }
function findingSource(value: unknown): void { if (value !== 'rules' && value !== 'deep') fail(); }
function fail(): never { throw new Error('项目经验数据格式无效、包含敏感信息或版本不受支持。'); }

/** Archived advice is immutable evidence, outside the bounded working library. */
export interface AgentExperienceArchiveV1 {
  readonly schemaVersion: 1; readonly projectId: StableId; readonly archivedAt: string; readonly experience: AgentExperienceV1;
}
export interface AgentExperienceArchiveChangeV1 {
  readonly schemaVersion: 1; readonly projectId: StableId; readonly id: StableId;
  readonly expectedRevision: number; readonly libraryRevision: number; readonly action: 'archive' | 'restore';
}
export function parseExperienceArchive(value: unknown): AgentExperienceArchiveV1 {
  const v = shape(value,['schemaVersion','projectId','archivedAt','experience']);
  if (v.schemaVersion !== 1) fail(); id(v.projectId); date(v.archivedAt);
  if (parseAgentExperience(v.experience).projectId !== v.projectId) fail();
  return v as unknown as AgentExperienceArchiveV1;
}
export function parseExperienceArchiveChange(value: unknown): AgentExperienceArchiveChangeV1 {
  const v = shape(value,['schemaVersion','projectId','id','expectedRevision','libraryRevision','action']);
  if (v.schemaVersion !== 1 || !['archive','restore'].includes(String(v.action))) fail();
  id(v.projectId); id(v.id); integer(v.expectedRevision,1); integer(v.libraryRevision);
  return v as unknown as AgentExperienceArchiveChangeV1;
}
export function parseExperienceHistoryQuery(value: unknown): {readonly projectId: StableId; readonly cursor?: string} {
  const hasCursor = !!value && typeof value === 'object' && 'cursor' in value;
  const v = shape(value,['projectId',...(hasCursor ? ['cursor'] : [])]); id(v.projectId);
  if (hasCursor && (typeof v.cursor !== 'string' || !/^[0-9]{1,16}:[0-9]{1,16}$/u.test(v.cursor))) fail();
  return v as unknown as {readonly projectId: StableId; readonly cursor?: string};
}
