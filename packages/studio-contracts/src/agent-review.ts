import { asStableId, type StableId } from './index.js';

/** Derived evidence, never executable instructions or an automatically adopted policy. */
export interface AgentReviewFindingV1 {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly title: string;
  readonly detail: string;
  readonly recommendation: string;
  readonly recordIds: readonly StableId[];
}
export interface AgentReviewV1 {
  readonly schemaVersion: 1;
  readonly ruleVersion: string;
  readonly projectId: StableId;
  readonly taskId: StableId;
  readonly taskRevision: number;
  readonly title: string;
  readonly outcome: 'completed' | 'failed' | 'blocked' | 'cancelled';
  readonly generatedAt: string;
  readonly sourceDigest: string;
  readonly coverage: { readonly records: number; readonly missing: number; readonly partial: boolean; readonly omittedEvidence: number };
  readonly metrics: { readonly toolCalls: number; readonly failed: number; readonly cancelled: number; readonly suspended: number; readonly repeatedFailures: number; readonly userMessages: number; readonly durationMs: number; readonly repairs: number };
  readonly findings: readonly AgentReviewFindingV1[];
  readonly evidence: readonly { readonly recordId: StableId; readonly kind: string; readonly toolId: string | null; readonly status: string; readonly startedAt: string; readonly durationMs: number | null }[];
  readonly deep: null | { readonly createdAt: string; readonly backendId: StableId; readonly model: string; readonly summary: string; readonly findings: readonly AgentReviewFindingV1[]; readonly usageLabel: string; readonly accountingArtifactId: StableId };
}

export function parseAgentReview(value: unknown): AgentReviewV1 {
  const v = shape(value, ['schemaVersion','ruleVersion','projectId','taskId','taskRevision','title','outcome','generatedAt','sourceDigest','coverage','metrics','findings','evidence','deep']);
  if (v.schemaVersion !== 1) fail();
  id(v.projectId); id(v.taskId); integer(v.taskRevision); str(v.ruleVersion, 40); str(v.title, 2048); date(v.generatedAt);
  if (!['completed','failed','blocked','cancelled'].includes(String(v.outcome)) || !/^[a-f0-9]{64}$/u.test(String(v.sourceDigest))) fail();
  const coverage = shape(v.coverage, ['records','missing','partial','omittedEvidence']);
  for (const k of ['records','missing','omittedEvidence']) integer(coverage[k]);
  if (typeof coverage.partial !== 'boolean') fail();
  const metrics = shape(v.metrics, ['toolCalls','failed','cancelled','suspended','repeatedFailures','userMessages','durationMs','repairs']);
  Object.values(metrics).forEach(integer);
  if (!Array.isArray(v.evidence) || v.evidence.length > 300) fail();
  const ids = new Set<string>();
  for (const raw of v.evidence) {
    const e = shape(raw, ['recordId','kind','toolId','status','startedAt','durationMs']);
    id(e.recordId); if (ids.has(String(e.recordId))) fail(); ids.add(String(e.recordId));
    str(e.kind, 100); if (e.toolId !== null) str(e.toolId, 200); str(e.status, 40); date(e.startedAt); if (e.durationMs !== null) integer(e.durationMs);
  }
  parseReviewFindings(v.findings, ids);
  if (v.deep !== null) {
    const d = shape(v.deep, ['createdAt','backendId','model','summary','findings','usageLabel','accountingArtifactId']);
    date(d.createdAt); id(d.backendId); str(d.model, 200); str(d.summary, 4000); str(d.usageLabel, 1000); id(d.accountingArtifactId); parseReviewFindings(d.findings, ids);
  }
  return v as unknown as AgentReviewV1;
}
export function parseReviewFindings(value: unknown, allowed: ReadonlySet<string>): readonly AgentReviewFindingV1[] {
  if (!Array.isArray(value) || value.length > 24) fail();
  for (const raw of value) {
    const f = shape(raw, ['code','severity','title','detail','recommendation','recordIds']);
    str(f.code, 120); str(f.title, 200); str(f.detail, 2000); str(f.recommendation, 2000);
    if (!['info','warning','error'].includes(String(f.severity)) || !Array.isArray(f.recordIds) || f.recordIds.length > 20 || f.recordIds.some(r => typeof r !== 'string' || !allowed.has(r))) fail();
  }
  return value as unknown as readonly AgentReviewFindingV1[];
}
function shape(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k))) fail();
  return value as Record<string, unknown>;
}
function str(value: unknown, max: number): void { if (typeof value !== 'string' || value.length > max || /Bearer\s+[\w.~-]{8,}|\bsk-[\w-]{8,}|SECRET_CANARY|CODEX_TOKEN_CANARY|API_KEY_CANARY/iu.test(value)) fail(); }
function id(value: unknown): void { str(value, 256); asStableId(value as string); }
function integer(value: unknown): void { if (!Number.isSafeInteger(value) || Number(value) < 0) fail(); }
function date(value: unknown): void { str(value, 40); if (!Number.isFinite(Date.parse(value as string))) fail(); }
function fail(): never { throw new Error('任务复盘数据格式无效或版本不受支持。'); }
