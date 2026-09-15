import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPlanProgress } from '../dist/plan-progress.js';
import { approvedPlanRequest, canonicalPlan } from '../dist/plan-policy.js';
const items = [{ id: 'step:scene', label: '场景', status: 'accepted' }, { id: 'step:script', label: '脚本', status: 'accepted' }, { id: 'step:skip', label: '拒绝项', status: 'rejected' }];
test('progress reports support independent active steps without altering approval or source inputs', () => {
  const result = applyPlanProgress({ updates: items.slice(0, 2).map(item => ({ stepId: item.id, status: 'in_progress', summary: `执行 ${item.label}` })) }, items);
  assert.equal(result.filter(item => item.executionStatus === 'in_progress').length, 2);
  assert.deepEqual(result.map(item => item.status), ['accepted', 'accepted', 'rejected']);
  assert.equal(items[0].executionStatus, undefined);
  const finished = applyPlanProgress({ updates: [{ stepId: 'step:scene', status: 'completed', summary: '已创建场景' }, { stepId: 'step:script', status: 'blocked', summary: '等待 API 文档' }] }, result);
  assert.equal(finished[0].executionStatus, 'completed'); assert.equal(finished[1].executionSummary, '等待 API 文档');
});
test('invalid, duplicate, unapproved and scope-changing updates reject atomically', () => {
  for (const updates of [[], [{ stepId: 'step:unknown', status: 'completed', summary: 'done' }], [{ stepId: 'step:skip', status: 'in_progress', summary: 'go' }], [{ stepId: 'step:scene', status: 'completed', summary: '' }], [{ stepId: 'step:scene', status: 'completed', summary: 'done', label: 'Changed scope' }], Array(2).fill({ stepId: 'step:scene', status: 'completed', summary: 'done' })]) assert.throws(() => applyPlanProgress({ updates }, items), error => error.code === 'plan.progress-invalid');
  assert.equal(items[0].executionStatus, undefined);
});
test('approval continuation provides exact step IDs and separates progress from acceptance', () => {
  const plan = { title: 'Build', summary: 'Build a scene', items, attempts: 0, mutationCount: 0 };
  assert.deepEqual(JSON.parse(canonicalPlan(plan)).items.map(item => item.id), items.map(item => item.id));
  assert.match(approvedPlanRequest(plan, true), /studio.plan.update/);
  assert.match(approvedPlanRequest(plan, true), /not acceptance evidence/);
});
