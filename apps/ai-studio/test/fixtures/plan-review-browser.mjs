import { ConversationProjector, presentChatPanel, projectExecutionGraph, renderChatPanel } from '@haiyue/ai-studio-shell';
import { defineBorderBeamComponents } from '@haiyue/ui/border-beam';
import { defineTabsComponents } from '@haiyue/ui/tabs';
defineTabsComponents();
defineBorderBeamComponents();
const root = document.getElementById('chat');
const stamp = '2026-09-10T00:00:00.000Z', digest = `sha256:${'a'.repeat(64)}`;
const provenance = { backendId: 'backend:review', sessionId: 'session:review', turnId: 'turn:review' };
const op = (sequence, kind, payload = {}) => ({ schemaVersion: 1, id: `op:${sequence}`, ...provenance, sequence, kind, timestamp: stamp, stepId: null, batchId: null, nodeId: null, parentOpId: null, dependsOn: [], projectRevision: null, artifactRefs: [], payload, payloadDigest: digest });
const graph = projectExecutionGraph({ sessionId: provenance.sessionId, activeGoal: '实现用户的游戏需求', status: 'waiting-user', ops: [op(0, 'session.created', { activeGoal: '实现用户的游戏需求' }), op(1, 'turn.started'), op(2, 'question.requested', { questionId: 'question:plan', barrierKind: 'plan-review', reason: '等待确认计划' })], transcript: [] });
const backend = { id: provenance.backendId, label: 'Local backend', kind: 'harness-api-key', state: 'ready', authMode: 'api-key', protocolVersion: 'fixture', capabilities: { resume: true, questions: true, structuredTools: true, backendApprovals: false, usage: true, rateLimits: true }, promptProfile: null, rateLimits: [{ name: 'Account usage', usedPercent: 20 }], models: [{ id: 'model:review', label: 'Review model', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 8192, isDefault: true }], selectedModel: 'model:review', selectedReasoningEffort: 'high', outputTokenLimit: 4096 };
const budget = { schemaVersion: 2, id: 'budget:review', enforcement: 'hard', limits: { inputTokens: 100000, outputTokens: 10000, estimatedCostMicros: 1000000, wallTimeMs: 600000, turns: 30, toolCalls: 100, repairIterations: 4, observationBytes: 1000000 } };
const accounting = { taskId: 'task:review', budgetStatus: 'within', budget, usage: { inputTokens: 12000, cachedInputTokens: 4000, outputTokens: 1200, reasoningTokens: 600, toolInputBytes: 1000, toolOutputBytes: 2000, wallTimeMs: 8000 }, cost: { status: 'unknown', amountMicros: null, currency: null, cacheSavingMicros: null, explanation: 'Unknown cost', final: false } };
const run = { schemaVersion: 1, revision: 1, taskId: 'task:review', title: '创建游戏', status: 'waiting-user', phase: 'planning', startedAt: stamp, updatedAt: stamp, ...provenance, model: { id: 'model:review', reasoningEffort: 'high', outputTokenLimit: 4096 }, promptProfile: { id: 'prompt:review', version: '1', digest }, documentRevision: 1, repairIteration: 0, repairLimit: 2, terminalDiagnostic: null, acceptance: [], evidence: [], timeline: [] };
const items = Array.from({ length: 20 }, (_, i) => ({ id: `plan:item-${i}`, label: `步骤 ${i + 1}`, details: '创建并验证对应的游戏交互、界面与素材。', status: 'pending' }));
const contents = {
  plan: { title: '游戏实现计划', summary: '确认计划后开始执行。'.repeat(25), items },
  question: { prompt: '请选择游戏视角', options: [{ id: 'option:top', label: '俯视角' }] },
  approval: { approvalId: 'approval:review', toolCallId: 'call:review', toolId: 'script.apply', toolVersion: '1.0.0', target: 'script:review', effect: 'trusted-code', risk: 'high', argumentsSummary: 'Write the approved game controller', previewDiff: '+ controller', baseRevision: 1, argsDigest: digest, previewDigest: digest, scope: 'operation', decision: 'pending' },
};
window.reviewIntents = [];
window.showReview = (kind = 'plan', status = 'pending', details = true) => {
  const event = { schemaVersion: 1, sequence: 1, source: 'replay', node: { schemaVersion: 1, id: `node:${kind}`, kind, status, createdAt: stamp, provenance, content: contents[kind] } };
  const snapshot = { revision: 1, connection: 'connected', busy: false, backendId: backend.id, backends: [backend], taskAccounting: details ? accounting : null, taskRuns: details ? [run] : [], executionGraphs: details ? [graph] : [], events: [event] };
  renderChatPanel(root, presentChatPanel(new ConversationProjector().reset(snapshot)), intent => window.reviewIntents.push(intent));
};
window.reviewButton = text => [...root.querySelectorAll('button')].find(button => button.textContent === text);
window.reviewButtonPoint = text => {
  const button = window.reviewButton(text); if (!button) throw Error(`Missing button: ${text}`);
  const r = button.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  if (r.width < 10 || r.height < 10 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || !button.contains(document.elementFromPoint(x, y))) throw Error(`Button is clipped or covered: ${text}; ${JSON.stringify({ x, y, width: innerWidth, height: innerHeight })}`);
  return { x: Math.round(x), y: Math.round(y) };
};
window.showReview();
