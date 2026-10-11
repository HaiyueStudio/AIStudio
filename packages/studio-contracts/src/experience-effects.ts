import { asStableId, type StableId } from './index.js';
import { parseAgentReview, type AgentReviewV1 } from './agent-review.js';

/** Observational aggregates of retained task reviews, not an evaluation or release gate. */
export interface ExperienceEffectGroupV1 {
  readonly key: string; readonly label: string; readonly backend: string; readonly model: string;
  readonly tasks: number; readonly completed: number; readonly failed: number; readonly blocked: number; readonly cancelled: number;
  readonly toolCalls: number; readonly toolFailures: number; readonly repeatedFailures: number; readonly repairs: number; readonly durationMs: number;
  readonly inputTokens: number; readonly outputTokens: number; readonly tokenSamples: number; readonly environmentTasks: number;
}
export interface ExperienceEffectsV1 {
  readonly schemaVersion: 1; readonly projectId: StableId; readonly generatedAt: string; readonly sequence: number;
  readonly total: number; readonly excluded: number; readonly unreadable: number; readonly nextCursor: string | null;
  readonly groups: readonly ExperienceEffectGroupV1[];
  readonly records: readonly { readonly report: AgentReviewV1; readonly reviewArtifactId: StableId; readonly groupKey: string | null; readonly note: string; readonly experienceIds: readonly StableId[] }[];
}
export function parseExperienceEffects(value: unknown): ExperienceEffectsV1 {
  const v = shape(value,['schemaVersion','projectId','generatedAt','sequence','total','excluded','unreadable','nextCursor','groups','records']);
  if (v.schemaVersion !== 1) fail(); asStableId(text(v.projectId));
  if (!Number.isFinite(Date.parse(text(v.generatedAt)))) fail();
  for (const k of ['sequence','total','excluded','unreadable']) count(v[k]);
  if (v.nextCursor !== null && !/^\d{1,16}:\d{1,16}$/u.test(text(v.nextCursor))) fail();
  if (!Array.isArray(v.groups) || !Array.isArray(v.records) || v.records.length > 20) fail();
  const keys = new Set<string>(); let included = 0;
  for (const raw of v.groups) {
    const g = shape(raw,['key','label','backend','model','tasks','completed','failed','blocked','cancelled','toolCalls','toolFailures','repeatedFailures','repairs','durationMs','inputTokens','outputTokens','tokenSamples','environmentTasks']);
    for (const k of ['key','label','backend','model']) text(g[k]);
    if (keys.has(String(g.key))) fail(); keys.add(String(g.key));
    for (const k of Object.keys(g).filter(k => !['key','label','backend','model'].includes(k))) count(g[k]);
    if (Number(g.completed)+Number(g.failed)+Number(g.blocked)+Number(g.cancelled) !== g.tasks || Number(g.tokenSamples)>Number(g.tasks) || Number(g.environmentTasks)>Number(g.tasks)) fail();
    included += Number(g.tasks);
  }
  if (included+Number(v.excluded)+Number(v.unreadable) !== v.total) fail();
  const tasks = new Set<string>();
  for (const raw of v.records) {
    const r = shape(raw,['report','reviewArtifactId','groupKey','note','experienceIds']); const report = parseAgentReview(r.report);
    if (report.projectId !== v.projectId || tasks.has(report.taskId)) fail(); tasks.add(report.taskId);
    asStableId(text(r.reviewArtifactId)); text(r.note);
    if (r.groupKey !== null && !keys.has(text(r.groupKey))) fail();
    if (!Array.isArray(r.experienceIds) || r.experienceIds.length > 300) fail(); r.experienceIds.forEach(id => asStableId(text(id)));
  }
  return v as unknown as ExperienceEffectsV1;
}
function shape(value: unknown, keys: string[]): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !(k in value))) fail();
  return value as Record<string,unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /(?:sk-[a-z0-9]{16,}|bearer\s+\S+|authorization\s*[:=])/iu.test(value)) fail(); return value;
}
function count(value: unknown): void { if (!Number.isSafeInteger(value) || Number(value)<0) fail(); }
function fail(): never { throw new Error('真实任务对比数据无效或版本不兼容。'); }
