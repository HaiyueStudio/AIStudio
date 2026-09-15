import { defineExpandableComponents } from '@haiyue/ui/expandable';
defineExpandableComponents();
import { renderChatPanel, disposeChatPanel, presentChatPanel, ConversationProjector, projectExecutionGraph, revealChatAttention } from '@haiyue/ai-studio-shell';
import { defineBorderBeamComponents } from '@haiyue/ui/border-beam';
import { defineTabsComponents } from '@haiyue/ui/tabs';
defineBorderBeamComponents();
defineTabsComponents();
const root = document.getElementById('chat');
const nodes = Array.from({ length: 24 }, (_, i) => ({
  id: `node:${i}`, kind: 'tool', status: i === 0 ? 'running' : i === 1 ? 'waiting' : i === 2 ? 'failed' : i === 3 || i === 4 ? 'cancelled' : 'completed',
  title: i === 0 ? '正在绘制棋盘纹理' : `创建游戏步骤 ${i}`, summary: '创建素材并检查对应的游戏表现。',
  turnId: 'turn:ui', batchId: null, sourceNodeId: null, sourceOpIds: [], artifactRefs: ['artifact:ui'],
  projectRevisionBefore: 1, projectRevisionAfter: 2, startedAt: '2026-09-10T00:00:00Z', completedAt: null, durationMs: 518,
  detail: { toolId: 'asset.texture', toolVersion: '1.0', executionClass: 'write', barrierKind: null, transactionId: null, usageRecordIds: [], costRecordIds: [], diagnostic: i === 2 ? 'script.compile-failed' : null, reason: i === 2 ? '脚本编译失败：未知标识符。' : i === 3 ? '已保存用户确认检查点，确认后继续。' : null, validation: null },
}));
const graph = { schemaVersion: 1, sessionId: 'session:ui', revision: 4, title: '创建一个五子棋游戏，支持黑白双方轮流下棋', status: 'running', nodes,
  edges: nodes.slice(4).map((node, i) => ({ id: `edge:${i}`, kind: 'depends-on', from: nodes[i].id, to: node.id, sourceOpIds: [] })),
  criticalPathNodeIds: [], currentNodeIds: ['node:0'], transcript: [{ id: 'transcript:ui', kind: 'message', role: 'assistant', timestamp: nodes[0].startedAt, title: '生成纹理', body: '完成绘制', status: 'completed', sourceOpIds: [], graphNodeIds: ['node:0'], artifactRefs: [] }],
  context: { pressure: { maxInputTokens: 100000, reservedOutputTokens: 10000, reservedSafetyTokens: 2000, usedInputTokens: 50000, ratio: .5, measurement: 'provider-reported', state: 'normal' }, latestCompaction: null, compactionAvailable: true, compactionBlockedReason: null },
  diagnostics: [], throughSequence: 10, digest: `sha256:${'a'.repeat(64)}`,
};
const accounting = { taskId: 'task:ui', budgetStatus: 'within', budget: { schemaVersion: 2, id: 'budget:ui', enforcement: 'hard', limits: { inputTokens: 200000, outputTokens: 20000, estimatedCostMicros: 1000000, wallTimeMs: 600000, turns: 30, toolCalls: 100, repairIterations: 3, observationBytes: 1000000 } }, usage: { inputTokens: 43921, cachedInputTokens: 17920, outputTokens: 1007, reasoningTokens: 206, toolInputBytes: 1000, toolOutputBytes: 30468, wallTimeMs: 8000 }, cost: { status: 'unknown', amountMicros: null, currency: null, cacheSavingMicros: null, explanation: 'Subscription limits are not API billing amounts.', final: false } };
window.graphIntents = [];
const cards = Array.from({ length: 80 }, (_, i) => ({ id: `node:feed:${i}`, kind: 'progress', status: 'completed', title: `执行步骤 ${i + 1}`, body: '读取项目、准备素材并验证结果。', tone: 'progress', metadata: [], actions: [], provenance: { backendId: 'backend:ui', sessionId: 'session:ui', turnId: 'turn:ui', stepId: null } }));
window.revealStep = () => revealChatAttention(root, { nodeId: 'node:feed:40', taskId: null });
window.showGraph = (completed = false, unknown = false, absent = false) => {
  const shown = { ...graph, status: completed ? 'completed' : 'running', nodes: nodes.map(node => completed ? { ...node, status: 'completed' } : node), context: unknown ? { pressure: null, compactionAvailable: false, compactionBlockedReason: '容量未知', latestCompaction: null } : graph.context };
  renderChatPanel(root, { backendId: null, backends: [], cards, composer: { busy: false, canSend: false, canCancel: false, blockedReason: 'Fixture' }, connection: 'connected', taskAccounting: unknown ? { ...accounting, budget: { ...accounting.budget, limits: { ...accounting.budget.limits, outputTokens: null, estimatedCostMicros: null } }, usage: { ...accounting.usage, outputTokens: null } } : accounting, taskRuns: [], executionGraphs: absent ? [] : [shown], ariaLive: '' }, intent => window.graphIntents.push(intent));
};
window.disposeGraph = () => disposeChatPanel(root);
window.uiPoint = selector => {
  const el = document.querySelector(selector), r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  if (!el.contains(document.elementFromPoint(x, y))) throw Error(`Not hittable: ${selector}: ${JSON.stringify({ x, y, rect: r.toJSON(), covering: document.elementFromPoint(x, y)?.outerHTML.slice(0,250) })}`);
  return { x, y };
};
window.graphScale = () => Number(document.querySelector('.execution-graph-canvas').style.transform.match(/[\d.]+/)[0]);
window.showGraph();

window.showMarkdownDetail = () => {
  nodes[0] = { ...nodes[0], kind: 'model', title: '模型处理 · 分段说明', summary: '创建圆角立方体。\n\n配置相机和交互。', detail: { ...nodes[0].detail,
    modelExplanation: '# 实现方案\n\n保留 **PBR 材质**，使用 `rounded-box`。\n\n1. 查询引擎接口\n2. 配置相机\n   - 验证拖拽\n\n> 验收后保留实际结果。\n\n```ts\nconst count = 27;\nconst ready = true;\n```\n\n<img src="https://invalid.example/test.png" onerror="window.markdownInjected=true">\n\n[危险链接](javascript:alert(1))',
    actionSummary: '**模型处理 · 第 1 轮**\n\n查询引擎接口。\n\n**模型处理 · 第 2 轮**\n\n创建物体并配置相机。', resultSummary: '- 已创建物体\n- 等待交互验收',
  } }; window.showGraph();
};

const chainPhase = (sessionId, taskId, offset, startedOnly) => {
  const kinds = startedOnly ? ['session.created', 'turn.started', 'user.message'] : ['session.created', 'turn.started', 'user.message', 'tool.started', 'tool.completed', 'turn.completed'];
  const ops = kinds.map((kind, sequence) => ({ schemaVersion: 1, id: `${sessionId}:op:${sequence}`, sessionId, sequence, kind, timestamp: new Date(Date.UTC(2026, 8, 10, 0, 0, offset + sequence)).toISOString(), turnId: sequence ? `${sessionId}:turn` : null, stepId: null, batchId: kind.startsWith('tool.') ? `${sessionId}:batch` : null, nodeId: kind.startsWith('tool.') ? `${sessionId}:tool` : null, parentOpId: null, dependsOn: [], projectRevision: null, artifactRefs: [], payload: { ...(kind === 'turn.started' ? { taskId } : {}), ...(kind.startsWith('tool.') ? { toolId: 'scene.query' } : {}), ...(kind.endsWith('.completed') ? { status: 'completed' } : {}) }, payloadDigest: `sha256:${'a'.repeat(64)}` }));
  return projectExecutionGraph({ sessionId, activeGoal: '任务跨会话连续执行', ops, transcript: [] });
};
window.showTaskChain = (stage, newTask = false) => {
  const graphs = [chainPhase('session:plan', 'task:continuity', 0, false)];
  if (stage === .5) graphs.push(projectExecutionGraph({ sessionId: 'session:bootstrap', activeGoal: '任务跨会话连续执行', ops: [{ schemaVersion: 1, id: 'op:bootstrap', sessionId: 'session:bootstrap', sequence: 0, kind: 'session.created', timestamp: '2026-09-10T00:00:30.000Z', turnId: null, stepId: null, batchId: null, nodeId: null, parentOpId: null, dependsOn: [], projectRevision: null, artifactRefs: [], payload: {}, payloadDigest: `sha256:${'a'.repeat(64)}` }] }));
  else if (stage) graphs.push(chainPhase('session:execute', 'task:continuity', 60, stage === 1));
  if (newTask) graphs.push(chainPhase('session:other', 'task:other', 120, true));
  const snapshot = new ConversationProjector().reset({ revision: Math.ceil(stage) + 1, connection: 'connected', busy: false, backendId: null, backends: [], taskAccounting: { ...accounting, taskId: newTask ? 'task:other' : 'task:continuity' }, taskRuns: [], executionGraphs: graphs, events: [] });
  renderChatPanel(root, presentChatPanel(snapshot), intent => graphIntents.push(intent));
};

window.showDuplicateFailure = (distinct = false) => {
  const message = 'acceptance[7]: gesture.interactions.0.type is not an event-trace field. Pointer events are under interactions.<index>.type/entityId.';
  nodes[2] = { ...nodes[2], title: 'Tool batch', summary: 'studio.plan.propose（失败）；0 completed, 1 failed, 0 cancelled.', detail: { ...nodes[2].detail, toolId: null,
    actionSummary: '**studio.plan.propose**\n\n准备提交“三阶圆角 PBR 魔方游戏”供用户确认。',
    resultSummary: '**studio.plan.propose（失败）**\n\n' + message,
    reason: distinct ? '另一个原因：项目修订已经改变。' : 'studio.plan.propose: ' + message,
  } }; window.showGraph();
};

// Simulate full read-model snapshots while only one node actually changes.
window.streamGraph = (mode) => {
  if (mode === 'other') {
    nodes[23] = { ...nodes[23], summary: '已验证其他对象 ' + ++graph.revision };
    if (!nodes.some(node => node.id === 'node:stream')) {
      nodes.push({ ...nodes[23], id: 'node:stream', title: '新增验收节点' });
      graph.edges.push({ id: 'edge:stream', kind: 'depends-on', from: 'node:23', to: 'node:stream', sourceOpIds: [] });
    }
  } else if (mode === 'self') nodes[0] = { ...nodes[0], status: 'completed', summary: '纹理生成完成', detail: { ...nodes[0].detail, resultSummary: '已创建棋盘纹理，验证完成。' } };
  else if (mode === 'remove') {
    nodes.splice(nodes.findIndex(node => node.id === 'node:stream'), 1);
    graph.edges = graph.edges.filter(edge => edge.id !== 'edge:stream');
  } else if (mode === 'restore') nodes[0] = { ...nodes[0], status: 'running', summary: '创建素材并检查对应的游戏表现。', detail: { ...nodes[0].detail, resultSummary: undefined } };
  window.showGraph();
};
