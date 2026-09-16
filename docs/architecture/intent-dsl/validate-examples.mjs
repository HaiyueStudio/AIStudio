// Design-only fixtures: no runtime imports, model calls, or Document effects.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';

const schema = JSON.parse(readFileSync(new URL('./intent-proposal.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);
const messageRef = 'message:example';
const message = '把选中的按钮改成 #FF0000，保持其他对象不变。不要创建实体。';
const source = (text) => {
  const start = message.indexOf(text);
  assert.ok(start >= 0);
  return { messageRef, start, end: start + text.length };
};

// References/spans/DAGs require semantic validation beyond JSON Schema.
// This is deliberately NOT a production binder or a proof of NL interpretation.
function inspect(value, sources = new Map([[messageRef, message]])) {
  if (!validate(value)) return ['schema-invalid'];
  const errors = [];
  const goals = new Map(value.goals.map((g) => [g.id, g]));
  const targets = new Map(value.targets.map((t) => [t.id, t]));
  const requirements = new Map(value.requirements.map((r) => [r.id, r]));
  const all = [...value.goals, ...value.targets, ...value.requirements];
  if (new Set(all.map((x) => x.id)).size !== all.length) errors.push('duplicate-id');
  const used = new Set();
  for (const goal of value.goals) {
    if (goal.targetRefs.some((id) => !targets.has(id))) errors.push('unknown-target');
    if (goal.requirementRefs.some((id) => !requirements.has(id))) errors.push('unknown-requirement');
    goal.requirementRefs.forEach((id) => used.add(id));
    if (goal.dependsOn.some((id) => !goals.has(id))) errors.push('unknown-dependency');
    if (['modify', 'delete'].includes(goal.action) && !goal.targetRefs.length) errors.push('missing-target');
  }
  if ([...requirements.keys()].some((id) => !used.has(id))) errors.push('orphan-requirement');
  for (const item of [...value.targets, ...value.requirements]) {
    const s = item.source, text = sources.get(s.messageRef);
    if (text === undefined || s.start >= s.end || s.end > text.length) errors.push('invalid-source');
    // Offsets cannot split a UTF-16 surrogate pair.
    const split = (i) => i > 0 && i < (text?.length ?? 0) && /[\uD800-\uDBFF]/u.test(text[i - 1]) && /[\uDC00-\uDFFF]/u.test(text[i]);
    if (split(s.start) || split(s.end)) errors.push('invalid-source');
  }
  for (const target of value.targets) {
    if (target.selector.kind === 'complement' && target.selector.of.some((id) => !targets.has(id))) errors.push('unknown-target');
  }
  for (const requirement of value.requirements) {
    const p = requirement.predicate;
    if ('targetRef' in p && !targets.has(p.targetRef)) errors.push('unknown-target');
    if (p.kind === 'compare' && p.operator !== 'eq' && typeof p.value !== 'number') errors.push('invalid-comparison');
    if (p.kind === 'compare' && p.unit === 'hex-srgb' && (p.operator !== 'eq' || typeof p.value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(p.value))) errors.push('invalid-color');
    if (p.kind === 'prohibit' && p.scope === 'document' && value.goals.some((g) => g.action === p.action)) errors.push('contradiction');
  }
  function checkCycle(nodes, next) {
    const visiting = new Set(), done = new Set();
    function visit(id) {
      if (visiting.has(id)) return true;
      if (done.has(id) || !nodes.has(id)) return false;
      visiting.add(id);
      if (next(nodes.get(id)).some(visit)) return true;
      visiting.delete(id); done.add(id); return false;
    }
    return [...nodes.keys()].some(visit);
  }
  if (checkCycle(goals, (g) => g.dependsOn)) errors.push('goal-cycle');
  if (checkCycle(targets, (t) => t.selector.kind === 'complement' ? t.selector.of : [])) errors.push('target-cycle');
  return [...new Set(errors)];
}

const example = {
  version: 'intent/0.1',
  goals: [{ id: 'goal:color', action: 'modify', domain: 'appearance', targetRefs: ['target:button'], requirementRefs: ['req:color', 'req:preserve', 'req:no-create'], dependsOn: [] }],
  targets: [
    { id: 'target:button', selector: { kind: 'selection' }, source: source('选中的按钮') },
    { id: 'target:others', selector: { kind: 'complement', of: ['target:button'], universe: 'document.entities' }, source: source('其他对象') },
  ],
  requirements: [
    { id: 'req:color', source: source('改成 #FF0000'), predicate: { kind: 'compare', targetRef: 'target:button', property: 'appearance.color', operator: 'eq', value: '#FF0000', unit: 'hex-srgb' } },
    { id: 'req:preserve', source: source('保持其他对象不变'), predicate: { kind: 'preserve', targetRef: 'target:others', baseline: 'request-snapshot', extent: 'authored-state' } },
    { id: 'req:no-create', source: source('不要创建实体'), predicate: { kind: 'prohibit', action: 'create', scope: 'document.entities' } },
  ],
};
if (process.argv.includes('--example')) {
  console.log(JSON.stringify({ message, proposal: example }, null, 2));
} else {
  let passed = 0;
  function positive(name, change = () => {}) {
    const v = structuredClone(example); change(v);
    assert.deepEqual(inspect(v), [], name); passed++;
  }
  function negative(name, error, change) {
    const v = structuredClone(example); change(v);
    assert.ok(inspect(v).includes(error), `${name}: ${inspect(v)}`); passed++;
  }
  positive('color + preserve + negation');
  positive('unresolved target is representable, NOT execution ready', (v) => { v.targets[0].selector = { kind: 'unresolved', phrase: '它' }; });
  positive('explicit qualitative requirement', (v) => { v.requirements[0].predicate = { kind: 'unresolved', text: '颜色更柔和，待确定基准' }; });
  positive('name selector', (v) => { v.targets[0].selector = { kind: 'name', value: '开始按钮', cardinality: 'one' }; });
  negative('unknown version', 'schema-invalid', (v) => { v.version = 'intent/99'; });
  negative('model cannot grant permission', 'schema-invalid', (v) => { v.approved = true; });
  negative('model cannot declare parallel safety', 'schema-invalid', (v) => { v.goals[0].parallel = true; });
  negative('unexpected credential field', 'schema-invalid', (v) => { v.apiKey = 'synthetic-placeholder'; });
  negative('duplicate ID', 'duplicate-id', (v) => { v.targets.push(v.targets[0]); });
  negative('dangling target', 'unknown-target', (v) => { v.goals[0].targetRefs = ['target:missing']; });
  negative('dangling requirement', 'unknown-requirement', (v) => { v.goals[0].requirementRefs.push('req:missing'); });
  negative('lost constraint', 'orphan-requirement', (v) => { v.goals[0].requirementRefs.pop(); });
  negative('cyclic goals', 'goal-cycle', (v) => { v.goals[0].dependsOn.push('goal:color'); });
  negative('cyclic selectors', 'target-cycle', (v) => { v.targets[1].selector.of = ['target:others']; });
  negative('unknown source', 'invalid-source', (v) => { v.requirements[0].source.messageRef = 'message:missing'; });
  negative('out-of-range span', 'invalid-source', (v) => { v.requirements[0].source.end = 9999; });
  negative('reversed span', 'invalid-source', (v) => { v.requirements[0].source.start = 9999; });
  negative('missing edit target', 'missing-target', (v) => { v.goals[0].targetRefs = []; });
  negative('ordered comparison needs numeric value', 'invalid-comparison', (v) => { v.requirements[0].predicate.operator = 'gte'; });
  negative('malformed color', 'invalid-color', (v) => { v.requirements[0].predicate.value = 'red'; });
  negative('create conflicts with document-wide prohibition', 'contradiction', (v) => { v.goals[0].action = 'create'; v.requirements[2].predicate.scope = 'document'; });
  console.log(`${passed} design fixture checks passed; production grounding, redaction and execution are not implemented here.`);
}
