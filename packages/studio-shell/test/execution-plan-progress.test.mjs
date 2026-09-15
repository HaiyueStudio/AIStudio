import test from 'node:test';
import assert from 'node:assert/strict';
import { projectExecutionGraph, withExecutionPlan, executionProgressLabel, normalizeExecutionGraph, normalizeConversationNode, layoutExecutionGraph } from '../dist/conversation/index.js';
const sessionId = 'session:progress', turnId = 'turn:progress';
const provenance = { backendId: 'backend:progress', sessionId, turnId };
function graph(status = 'running') {
  const op = (sequence, kind, payload) => ({ schemaVersion: 1, id: `op:${sequence}`, sessionId, turnId: sequence ? turnId : null, sequence, kind, timestamp: `2026-09-15T00:00:0${sequence}.000Z`, stepId: null, batchId: null, nodeId: null, parentOpId: null, dependsOn: [], projectRevision: null, artifactRefs: [], payload, payloadDigest: `sha256:${'a'.repeat(64)}` });
  return projectExecutionGraph({ sessionId, status, activeGoal: 'Original user request repeated everywhere', ops: [op(0, 'session.created', {}), op(1, 'turn.started', { taskId: 'task:progress' }), ...(status !== 'running' ? [op(2, 'turn.completed', { status })] : [])] });
}
function plan(overrides = {}) {
  return normalizeConversationNode({ schemaVersion: 1, id: 'plan:progress', kind: 'plan', status: 'completed', createdAt: '2026-09-15T00:00:01.000Z', provenance, content: { taskId: 'task:progress', title: '实现五个工作步骤', decision: 'approved', items: ['搭建场景', '配置材质', '编写拖拽交互', '验证规则', '验证外观'].map((label, index) => ({ id: `step:${index}`, label, status: 'accepted', executionStatus: index < 2 ? 'completed' : index === 2 ? 'in_progress' : 'pending', executionSummary: index === 2 ? '处理命中对象与拖动方向' : '步骤进度' })), ...overrides } });
}
test('plan survives read-model normalization and shows five concrete nodes and current step', () => {
  const record = plan(); assert.equal(record.content.items[2].executionStatus, 'in_progress');
  const result = withExecutionPlan(graph(), [record]);
  assert.equal(result.nodes.filter(node => node.kind === 'plan-step').length, 5);
  assert.match(executionProgressLabel(result), /第 3\/5 步：编写拖拽交互.*已完成 2\/5/);
  assert.doesNotMatch(executionProgressLabel(result), /Original user request/);
  assert.ok(result.nodes.some(node => node.kind === 'model' && /编写拖拽交互/.test(node.title)));
  assert.equal(normalizeExecutionGraph(result).digest, result.digest);
  const layout = layoutExecutionGraph(result);
  assert.equal(layout.visibleNodeIds.filter(id => id.startsWith('plan-step:')).length, 5);
  assert.equal(result.nodes.find(node => node.kind === 'plan-step').sourceNodeId, 'plan:progress');
});
test('parallel steps retain individual progress and stable node identities across updates', () => {
  const first = plan(); const items = first.content.items.map((item, index) => ({ ...item, executionStatus: [2, 3].includes(index) ? 'in_progress' : item.executionStatus }));
  const before = withExecutionPlan(graph(), [first]), after = withExecutionPlan(graph(), [plan({ items })]);
  assert.match(executionProgressLabel(after), /第 3\/5 步.*第 4\/5 步/);
  assert.deepEqual(before.nodes.filter(node => node.kind === 'plan-step').map(node => node.id), after.nodes.filter(node => node.kind === 'plan-step').map(node => node.id));
  assert.notEqual(before.digest, after.digest);
});
test('unreported steps are not guessed from tool counts; task completion is not fabricated', () => {
  const items = plan().content.items.map(({ executionStatus, executionSummary, ...item }) => item);
  const unknown = withExecutionPlan(graph(), [plan({ items })]);
  assert.match(executionProgressLabel(unknown), /等待 Agent 更新.*0\/5/);
  assert.ok(unknown.nodes.filter(node => node.kind === 'plan-step').every(node => node.status === 'pending'));
  const done = withExecutionPlan(graph(), [plan({ items: items.map(item => ({ ...item, executionStatus: 'completed' })) })]);
  assert.equal(done.status, 'running'); assert.match(executionProgressLabel(done), /等待最终验收/);
});
test('stopped turns cannot leave step beams running and plans cannot leak between tasks', () => {
  const result = withExecutionPlan(graph('failed'), [plan()]);
  assert.ok(result.nodes.filter(node => node.kind === 'plan-step').every(node => node.status !== 'running'));
  assert.equal(result.currentNodeIds.some(id => id.startsWith('plan-step:')), false);
  assert.equal(withExecutionPlan(graph(), [plan({ taskId: 'task:other' })]).nodes.some(node => node.kind === 'plan-step'), false);
});
test('latest proposal replaces old steps, rejected items are excluded and block reasons remain visible', () => {
  const earlier = plan(); const latest = { ...plan({ decision: 'approved', items: [{ id: 'step:chosen', label: '修复输入', status: 'accepted', executionStatus: 'blocked', executionSummary: '等待修复拾取结果' }, { id: 'step:rejected', label: '放弃的方案', status: 'rejected' }] }), id: 'plan:new', createdAt: '2026-09-15T00:01:00.000Z' };
  const result = withExecutionPlan(graph(), [earlier, latest]);
  assert.equal(result.nodes.filter(node => node.kind === 'plan-step').length, 1);
  assert.match(executionProgressLabel(result), /修复输入.*阻塞/);
  assert.equal(result.nodes.find(node => node.kind === 'plan-step').detail.reason, '等待修复拾取结果');
});

test('unsynchronized progress survives normalization and stops the old step running animation', () => {
 const items=plan().content.items.map(item=>({...item,executionNeedsSync:item.executionStatus==='in_progress',executionOperationIds:['call:script']}));
 const record=plan({items,progressNeedsSync:true,recentOperations:[{callId:'call:script',toolId:'script.propose',summary:'Controller validated',revision:8}]});
 assert.equal(record.content.items[2].executionNeedsSync,true);
 assert.equal(record.content.recentOperations[0].summary,'Controller validated');
 const result=withExecutionPlan(graph(),[record]);
 const step=result.nodes.find(n=>n.kind==='plan-step'&&n.title.includes('编写拖拽交互'));
 assert.equal(step.status,'pending');assert.match(step.summary,/进度待同步/);
 assert.equal(result.nodes.filter(n=>n.kind==='plan-step'&&n.status==='completed').length,2);
});

test('exact approval ownership and consumption survive persisted node normalization', () => {
 const record=normalizeConversationNode({schemaVersion:1,id:'node:approval',kind:'approval',status:'completed',createdAt:'2026-09-15T00:00:01.000Z',provenance,content:{approvalId:'approval:one',toolCallId:'call:one',toolId:'script.apply',toolVersion:'1.0.0',target:'script:one',effect:'trusted-code',risk:'high',baseRevision:8,argsDigest:`sha256:${'a'.repeat(64)}`,previewDigest:`sha256:${'b'.repeat(64)}`,decision:'allow-once',taskId:'task:one',documentId:'document:one',consumedBy:'approval:two'}});
 assert.equal(record.content.taskId,'task:one');assert.equal(record.content.documentId,'document:one');assert.equal(record.content.consumedBy,'approval:two');
});
