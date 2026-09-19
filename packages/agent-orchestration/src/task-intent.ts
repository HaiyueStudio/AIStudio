import type { JsonObject } from '@haiyue/ai-studio-contracts';
import { requestRouting } from '@haiyue/ai-studio-agent-runtime';
import { canonicalStringify, redactObject } from '@haiyue/ai-studio-operation-log';

/** Internal, retained source binding. Does not grant authority or replace TaskSpec. */
export interface TaskIntent {
  readonly version: 'intent-constraints/1';
  readonly request: string;
  readonly amendments: readonly string[];
  readonly selection: readonly string[];
  readonly revision: number | null;
  readonly documentId: string | null;
}
export function taskIntent(request: string, selection: readonly string[], revision: number | null, amendments: readonly string[] = [], documentId: string | null = null): TaskIntent {
  const value = { version: 'intent-constraints/1', documentId, request, amendments: [...amendments], selection: [...selection], revision };
  if (!isTaskIntent(value)) throw new Error('Invalid or unsafe retained task intent.');
  return Object.freeze({ ...value, version: 'intent-constraints/1', amendments: Object.freeze([...amendments]), selection: Object.freeze([...selection]) });
}
export function isTaskIntent(value: unknown): value is TaskIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'amendments,documentId,request,revision,selection,version' || v.version !== 'intent-constraints/1'
    || !(v.documentId === null || typeof v.documentId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(v.documentId))
    || typeof v.request !== 'string' || v.request.length > 32_768
    || !Array.isArray(v.amendments) || v.amendments.length > 32 || !v.amendments.every(s => typeof s === 'string' && s.length <= 2048)
    || !Array.isArray(v.selection) || v.selection.length > 128 || !v.selection.every(s => typeof s === 'string' && /^entity:[A-Za-z0-9._:-]{3,120}$/u.test(s))
    || !(v.revision === null || Number.isSafeInteger(v.revision) && Number(v.revision) >= 0)) return false;
  return canonicalStringify(redactObject(v as JsonObject).value) === canonicalStringify(v as JsonObject);
}

/** Small source-backed requirement AST. Unknown preserve clauses stay unresolved;
 * regex hints must never invent a baseline, entity binding or supported property. */
export function intentRequirements(intent: TaskIntent) {
  return [intent.request, ...intent.amendments].flatMap((message, messageIndex) => {
    const routing = requestRouting(message);
    const clauses = [...routing.constraints];
    let cursor = 0;
    return clauses.map(text => {
      const start = message.indexOf(text, cursor) >= 0 ? message.indexOf(text, cursor) : message.indexOf(text);
      cursor = start + text.length;
      const predicate = requestRouting(text).noCreate ? 'prohibit-create'
        : requestRouting(text).prohibitEdits ? 'read-only'
        : /保持其他(?:对象|实体)不变|preserve (?:all )?other (?:objects|entities)|keep (?:all )?other (?:objects|entities) unchanged/iu.test(text) ? 'preserve-others' : 'unresolved';
      return Object.freeze({ source: Object.freeze({ messageIndex, start, end: start + text.length }), text, predicate });
    });
  });
}
export function intentConstraints(intent: TaskIntent): readonly string[] {
  const constraints = intentRequirements(intent).map(r => r.predicate === 'read-only' ? `Read-only: ${r.text}` : r.text);
  if (constraints.length > 64 || constraints.some(s => s.length > 2000)) throw new Error('Intent constraints exceed TaskSpec limits; split the request before execution.');
  return Object.freeze([...new Set(constraints)]);
}

/** Text submitted by the user, including explicitly selected option labels. */
export function questionAmendment(answer: JsonObject, options: unknown): string {
  const text: string[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 6) throw new Error('Question answer is too deeply nested.');
    if (typeof value === 'string') text.push(value);
    else if (Array.isArray(value)) value.forEach(v => visit(v, depth + 1));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) if (key !== 'optionIds') visit(item, depth + 1);
  };
  visit(answer);
  if (Array.isArray(answer.optionIds) && Array.isArray(options)) for (const id of answer.optionIds) {
    const option = options.find(v => v && typeof v === 'object' && v.id === id);
    if (option && typeof option.label === 'string') text.push(option.label);
  }
  const result = text.join('\n').trim();
  if (result.length > 2048) throw new Error('Question amendment exceeds the retained source limit.');
  return result;
}
export function intentContext(intent: TaskIntent): string {
  if (!intentRequirements(intent).length) return '';
  return `Retained user requirements (mandatory; plan approval does not remove them): ${JSON.stringify(intentRequirements(intent))}\nSubmission selection: ${JSON.stringify(intent.selection)} at revision ${intent.revision}. Resolve actual component types before choosing material.set (geometry only) or component.configure (typed component). Unsupported requirements must remain explicit blockers, not omitted acceptance.`;
}
export function assertIntentAllows(intent: TaskIntent, effect: string, toolId: string, args: JsonObject): void {
  if (['play.stop', 'preview.stop'].includes(toolId)) return;
  const requirements = intentRequirements(intent);
  const reject = (detail: string): never => { throw Object.assign(new Error(detail), { code: 'intent.constraint-blocked' }); };
  if (requirements.some(r => r.predicate === 'unresolved') && (effect !== 'observe' || toolId === 'task.evaluate')) reject('A user constraint has no supported execution guard yet. Retain it and clarify or bind a supported verification before editing or accepting completion.');
  if (effect === 'observe') return;
  if ([intent.request, ...intent.amendments].some(s => requestRouting(s).prohibitEdits)) reject('This request is read-only. A plan cannot authorize edits contrary to the user request.');
  // Play owns a separate runtime document; its existing approvals remain mandatory.
  if (effect === 'runtime-start') return;
  // These authoring operations only update the named entity, through existing revision/History checks.
  const local = ['material.set', 'entity.rename', 'transform.set', 'component.configure'].includes(toolId) && typeof args.entityId === 'string';
  if (requirements.some(r => r.predicate === 'prohibit-create') && !local) reject('Creating entities is prohibited. This operation has not been proven to preserve entity membership.');
  if (requirements.some(r => r.predicate === 'preserve-others')) {
    if (!/选中|selected|selection/iu.test(intent.request) || !intent.selection.length || !local || !intent.selection.includes(String(args.entityId))) {
      reject('Preserve-other-objects requires a submission-bound selection and an entity-local operation. This operation has no proven preservation guard.');
    }
  }
}
