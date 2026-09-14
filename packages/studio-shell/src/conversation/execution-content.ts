import type { SessionOpV1 } from '@haiyue/ai-studio-contracts';
import type { ExecutionGraphProjectionInput, ExecutionGraphNodeReadModel, ExecutionTranscriptItemReadModel } from './execution-graph-types.js';

type ContentNode = Pick<ExecutionGraphNodeReadModel, 'id' | 'kind' | 'status' | 'turnId' | 'sourceOpIds'> & {
  title: string; summary: string; modelExplanation?: string | null; actionSummary?: string | null; resultSummary?: string | null;
};
const text = (value: unknown, max = 2048): string => typeof value === 'string' ? value.trim().slice(0, max) : '';
const join = (values: readonly (string | null | undefined)[], max = 2048): string => [...new Set(values.filter(Boolean))].join('；').slice(0, max);
const paragraphs = (values: readonly (string | null | undefined)[]): string => [...new Set(values.filter(Boolean))].join('\n\n').slice(0, 2048);
const group = (title: string, body: string): string => `**${title.replace(/[\\`*_{}[\]()#+.!>~-]/gu, '\\$&')}**\n\n${body}`;
const status = (value: string): string => ({ completed: '已完成', failed: '失败', cancelled: '已取消', waiting: '待确认', running: '执行中', pending: '待处理', 'outcome-unknown': '结果待核验' }[value] ?? value);

/** Enrich presentation from public, redacted facts. Never infer hidden reasoning,
 * fetch artifacts, or attach a turn-wide message to an earlier model round. */
export function enrichExecutionContent(input: ExecutionGraphProjectionInput, ops: readonly SessionOpV1[], nodes: Map<string, ContentNode>, edges: readonly { kind: string; from: string; to: string }[], transcript: readonly ExecutionTranscriptItemReadModel[]): void {
  const byOp = new Map(ops.map(op => [op.id, op]));
  const records = (input.records ?? []).filter(record => record.provenance.sessionId === input.sessionId);
  const byCall = new Map<string, typeof records>();
  const byId = new Map<string, (typeof records)[number]>(records.map(record => [record.id, record]));
  for (const record of records) {
    const id = text(record.content.toolCallId);
    if (id) byCall.set(id, [...(byCall.get(id) ?? []), record]);
  }
  const children = new Map<string, ContentNode[]>();
  for (const edge of edges) if (edge.kind === 'contains') {
    const child = nodes.get(edge.to); if (child) children.set(edge.from, [...(children.get(edge.from) ?? []), child]);
  }
  for (const node of nodes.values()) {
    const history = node.sourceOpIds.flatMap(id => byOp.has(id) ? [byOp.get(id)!] : []);
    if (node.kind === 'tool') {
      const calls = [...new Set(history.map(op => text(op.payload.toolCallId)).filter(Boolean))];
      const related = calls.flatMap(id => byCall.get(id) ?? []).filter(record => record.provenance.turnId === node.turnId);
      node.actionSummary = paragraphs(related.filter(record => record.kind === 'tool-call').map(record => text(record.content.argumentsSummary)));
      node.resultSummary = paragraphs(related.filter(record => record.kind === 'tool-result').map(record => text(record.content.summary)));
      // Operation summaries remain the fallback for historical records without projections.
      node.summary = join([node.actionSummary, node.resultSummary || node.summary]);
    } else if (['plan', 'question', 'approval'].includes(node.kind)) {
      const related = history.flatMap(op => [op.nodeId, text(op.payload.questionId), text(op.payload.approvalId)].flatMap(id => id && byId.has(id) ? [byId.get(id)!] : []))
        .filter(record => record.provenance.turnId === node.turnId && ['plan', 'question', 'approval'].includes(record.kind));
      const record = related.at(-1);
      if (record) {
        const content = record.content;
        node.actionSummary = paragraphs([text(content.summary), text(content.prompt), text(content.argumentsSummary), text(content.previewDiff)]);
        if (Array.isArray(content.items)) node.actionSummary = paragraphs([node.actionSummary, ...content.items.slice(0, 8).map(item => item && typeof item === 'object' && !Array.isArray(item) ? text(item.label) : '')]);
        const title = text(content.title, 160); if (title) node.title = title;
        node.summary = join([node.actionSummary, node.summary]);
      }
    }
  }
  // Non-structural links identify the actual changed/validated target without guessing.
  for (const node of nodes.values()) {
    const relation = node.kind === 'transaction' ? 'modified' : ['evidence', 'evaluation'].includes(node.kind) ? 'validated-by' : null;
    if (!relation) continue;
    const sources = edges.filter(edge => edge.kind === relation && edge.to === node.id).flatMap(edge => nodes.has(edge.from) ? [nodes.get(edge.from)!] : []);
    if (sources.length) {
      node.actionSummary = paragraphs(sources.map(source => group(source.title, source.actionSummary || source.summary)));
      node.summary = join([node.summary, `${relation === 'modified' ? '提交内容' : '验证对象'}：${join(sources.map(source => source.title), 400)}`]);
    }
    node.resultSummary = node.summary;
  }
  // Model transcript entries were assigned by exact operation boundaries, not wall clocks.
  for (const node of nodes.values()) if (node.kind === 'model') {
    const messages = transcript.filter(item => item.kind === 'message' && item.role === 'assistant' && item.graphNodeIds.includes(node.id));
    node.modelExplanation = paragraphs(messages.map(item => item.body));
    if (node.status === 'running' && input.liveAssistant?.turnId === node.turnId) node.modelExplanation = paragraphs([node.modelExplanation, text(input.liveAssistant.content)]);
  }
  const visited = new Set<string>();
  const summarize = (node: ContentNode, depth = 0): void => {
    if (visited.has(node.id) || depth > 8) return; visited.add(node.id);
    const owned = children.get(node.id) ?? []; for (const child of owned) summarize(child, depth + 1);
    if (!['model', 'turn', 'tool-batch', 'goal', 'transaction'].includes(node.kind)) return;
    const work = owned.filter(child => !['result', 'unknown'].includes(child.kind));
    const actions = work.map(child => group(child.title, child.actionSummary || child.summary));
    const results = work.map(child => group(`${child.title}（${status(child.status)}）`, child.resultSummary ?? ''));
    if (actions.length) node.actionSummary = paragraphs(actions);
    if (results.length) node.resultSummary = paragraphs(results);
    if (node.kind === 'model') {
      const action = work.length ? join(work.map(child => child.kind === 'tool-batch' ? (children.get(child.id) ?? []).map(tool => tool.title).join('、') : child.title), 400) : '';
      node.summary = join([node.modelExplanation && text(node.modelExplanation, 700), action && `本轮操作：${action}`, /用户|确认/.test(node.summary) ? node.summary : null, !action && !node.modelExplanation ? node.summary : '']);
    } else if (node.kind === 'tool-batch' && work.length) {
      node.summary = join([join(work.map(child => `${child.title}（${status(child.status)}）`), 700), node.summary]);
    } else if (node.kind === 'turn' || node.kind === 'goal') {
      const request = transcript.find(item => item.kind === 'message' && item.role === 'user' && (node.kind === 'goal' || item.graphNodeIds.includes(node.id)))?.body;
      const current = [...work].reverse().find(child => ['running', 'waiting', 'outcome-unknown'].includes(child.status)) ?? work.at(-1);
      node.summary = join([request && `目标：${text(request, 400)}`, current && `${current.title}：${text(current.summary, 800)}`, /用户|验收/.test(node.summary) ? node.summary : null, !current ? node.summary : '']);
    } else if (node.kind === 'transaction' && work.length) node.summary = join([node.summary, node.actionSummary]);
  };
  for (const node of nodes.values()) if (node.kind === 'goal') summarize(node);
  for (const node of nodes.values()) summarize(node);
}
