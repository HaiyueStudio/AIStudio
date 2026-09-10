import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { layoutExecutionGraph, projectExecutionGraph, normalizeExecutionGraphs, groupExecutionGraphsByTask, executionGraphIdentity } from '../dist/index.js';

const SESSION = 'session:g09';
const TURN = 'turn:g09:1';

function op(sequence, kind, options = {}) {
  return Object.freeze({
    schemaVersion: 1,
    id: options.id ?? `op:${sequence}`,
    sessionId: SESSION,
    sequence,
    kind,
    timestamp: options.timestamp ?? new Date(Date.UTC(2026, 8, 1, 0, 0, sequence)).toISOString(),
    turnId: options.turnId === undefined ? TURN : options.turnId,
    stepId: options.stepId ?? null,
    batchId: options.batchId ?? null,
    nodeId: options.nodeId ?? null,
    parentOpId: options.parentOpId ?? null,
    dependsOn: Object.freeze(options.dependsOn ?? []),
    projectRevision: options.projectRevision ?? null,
    artifactRefs: Object.freeze(options.artifactRefs ?? []),
    payload: Object.freeze(options.payload ?? {}),
    payloadDigest: `sha256:${String(sequence).padStart(64, '0')}`,
  });
}

function linearFixture() {
  return [
    op(0, 'session.created', { turnId: null, payload: { activeGoal: 'Build a puzzle game' } }),
    op(1, 'turn.started', { payload: { title: 'Implement game' } }),
    op(2, 'user.message', { artifactRefs: ['artifact:user'] }),
    op(3, 'tool-batch.planned', { batchId: 'batch:1', turnId: TURN, payload: { protocol: 'plan-tool-batch-check' } }),
    op(4, 'tool-batch.started', { batchId: 'batch:1' }),
    op(5, 'tool-batch.planned', { batchId: 'batch:1', nodeId: 'node:read', payload: { toolId: 'scene.query', toolVersion: '1.0.0', executionClass: 'parallel-read', effects: ['observe'] } }),
    op(6, 'tool.started', { batchId: 'batch:1', nodeId: 'node:read', payload: { toolId: 'scene.query', toolVersion: '1.0.0', executionClass: 'parallel-read', effects: ['observe'] } }),
    op(7, 'tool.completed', { batchId: 'batch:1', nodeId: 'node:read', payload: { toolId: 'scene.query', status: 'completed', usageRecordId: 'usage:read', costRecordId: 'cost:read' } }),
    op(8, 'tool-batch.planned', { batchId: 'batch:1', nodeId: 'node:write', dependsOn: ['node:read'], payload: { toolId: 'scene.transaction', toolVersion: '1.0.0', executionClass: 'exclusive-mutation', effects: ['document-mutation'] } }),
    op(9, 'tool.started', { batchId: 'batch:1', nodeId: 'node:write', dependsOn: ['node:read'], payload: { toolId: 'scene.transaction', toolVersion: '1.0.0', executionClass: 'exclusive-mutation', effects: ['document-mutation'] } }),
    op(10, 'document.committed', { batchId: 'batch:1', projectRevision: 2, artifactRefs: ['receipt:1'], payload: { transactionId: 'transaction:1', beforeRevision: 1, afterRevision: 2, memberNodeIds: ['node:write'] } }),
    op(11, 'tool.completed', { batchId: 'batch:1', nodeId: 'node:write', projectRevision: 2, artifactRefs: ['receipt:1'], payload: { toolId: 'scene.transaction', status: 'completed', transactionId: 'transaction:1' } }),
    op(12, 'evidence.captured', { nodeId: 'evidence:1', projectRevision: 2, artifactRefs: ['screenshot:1'], payload: { evidenceType: 'screenshot', transactionId: 'transaction:1', summary: 'Board is visible.' } }),
    op(13, 'evaluation.completed', { nodeId: 'evaluation:1', projectRevision: 2, artifactRefs: ['evaluation:1'], payload: { status: 'passed', transactionId: 'transaction:1', summary: 'Visual check passed.' } }),
    op(14, 'tool-batch.completed', { batchId: 'batch:1', projectRevision: 2, payload: { status: 'completed', completed: 2, failed: 0, cancelled: 0 } }),
    op(15, 'assistant.message', { artifactRefs: ['artifact:assistant'] }),
    op(16, 'turn.completed', { payload: { status: 'completed', summary: 'Puzzle game completed.' } }),
  ];
}

test('projects a deterministic graph, transcript and modification evidence chain', () => {
  const ops = linearFixture();
  const transcript = [
    { id: 'transcript:user', opId: 'op:2', role: 'user', content: 'Create a puzzle game.', timestamp: ops[2].timestamp },
    { id: 'transcript:assistant', opId: 'op:15', role: 'assistant', content: 'The game is ready.', timestamp: ops[15].timestamp },
  ];
  const first = projectExecutionGraph({ sessionId: SESSION, activeGoal: 'Build a puzzle game', status: 'completed', ops, transcript });
  const replay = projectExecutionGraph({ sessionId: SESSION, activeGoal: 'Build a puzzle game', status: 'completed', ops: [...ops].reverse(), transcript: [...transcript].reverse() });

  assert.equal(first.digest, replay.digest);
  assert.match(first.digest, /^sha256:[a-f0-9]{64}$/u);
  const { digest, ...semantic } = first;
  assert.equal(digest, `sha256:${createHash('sha256').update(canonical(semantic)).digest('hex')}`);
  assert.equal(first.status, 'completed');
  assert.equal(first.nodes.find((node) => node.id === `turn:${TURN}`).status, 'completed');
  assert.equal(first.currentNodeIds.length, 0);
  assert.equal(first.throughSequence, 16);
  assert.deepEqual(first.transcript.filter((item) => item.kind === 'message').map((item) => item.body), ['Create a puzzle game.', 'The game is ready.']);
  assert.ok(first.nodes.some((node) => node.kind === 'transaction' && node.projectRevisionBefore === 1 && node.projectRevisionAfter === 2));
  assert.ok(first.nodes.some((node) => node.kind === 'evidence' && node.artifactRefs.includes('screenshot:1')));
  assert.ok(first.edges.some((edge) => edge.kind === 'modified' && edge.from === 'tool:node:write' && edge.to === 'transaction:transaction:1'));
  assert.ok(first.edges.some((edge) => edge.kind === 'validated-by' && edge.from === 'transaction:transaction:1'));
  assert.deepEqual(first.nodes.find((node) => node.id === 'tool:node:read').detail.usageRecordIds, ['usage:read']);
});

test('shows actual overlapping tool intervals as parallel and preserves dependency order', () => {
  const ops = [
    op(0, 'session.created', { turnId: null }),
    op(1, 'turn.started'),
    op(2, 'tool-batch.planned', { batchId: 'batch:p' }),
    op(3, 'tool-batch.started', { batchId: 'batch:p' }),
    op(4, 'tool-batch.planned', { batchId: 'batch:p', nodeId: 'node:a', payload: { toolId: 'scene.query', executionClass: 'parallel-read' } }),
    op(5, 'tool.started', { batchId: 'batch:p', nodeId: 'node:a', timestamp: '2026-09-01T00:00:05.000Z', payload: { toolId: 'scene.query' } }),
    op(6, 'tool-batch.planned', { batchId: 'batch:p', nodeId: 'node:b', payload: { toolId: 'diagnostics.query', executionClass: 'parallel-read' } }),
    op(7, 'tool.started', { batchId: 'batch:p', nodeId: 'node:b', timestamp: '2026-09-01T00:00:06.000Z', payload: { toolId: 'diagnostics.query' } }),
    op(8, 'tool.completed', { batchId: 'batch:p', nodeId: 'node:a', timestamp: '2026-09-01T00:00:08.000Z', payload: { toolId: 'scene.query', status: 'completed' } }),
    op(9, 'tool.completed', { batchId: 'batch:p', nodeId: 'node:b', timestamp: '2026-09-01T00:00:09.000Z', payload: { toolId: 'diagnostics.query', status: 'completed' } }),
    op(10, 'tool-batch.completed', { batchId: 'batch:p', payload: { status: 'completed', completed: 2 } }),
    op(11, 'turn.completed', { payload: { status: 'completed' } }),
  ];
  const graph = projectExecutionGraph({ sessionId: SESSION, ops });
  assert.ok(graph.edges.some((edge) => edge.kind === 'parallel-with' && new Set([edge.from, edge.to]).has('tool:node:a') && new Set([edge.from, edge.to]).has('tool:node:b')));
  assert.equal(graph.nodes.find((node) => node.id === 'tool:node:a').durationMs, 3_000);
  assert.equal(graph.diagnostics.length, 0);
});

test('keeps barriers, compaction and outcome-unknown visible in graph and transcript', () => {
  const pressure = { maxInputTokens: 100_000, reservedOutputTokens: 10_000, reservedSafetyTokens: 10_000, usedInputTokens: 64_000, ratio: 0.8, measurement: 'tokenizer-estimated', state: 'compact-required' };
  const after = { ...pressure, usedInputTokens: 48_000, ratio: 0.6, state: 'normal' };
  const compaction = { id: 'compact:1', reason: 'manual', coveredStartSequence: 1, coveredEndSequence: 2, before: pressure, after, sourceSurfaceGeneration: 0, targetSurfaceGeneration: 1, summaryArtifactId: 'summary:1', pinnedFactDigests: [], validation: 'passed', diagnostic: null };
  const ops = [
    op(0, 'session.created', { turnId: null }),
    op(1, 'turn.started'),
    op(2, 'approval.requested', { nodeId: 'approval:1', payload: { approvalId: 'approval:1', barrierKind: 'runtime-start', reason: 'Run trusted preview.' } }),
    op(3, 'approval.resolved', { nodeId: 'approval:1', payload: { approvalId: 'approval:1', resolution: 'allow-once' } }),
    op(4, 'tool.started', { batchId: 'batch:1', nodeId: 'node:uncertain', payload: { toolId: 'script.apply' } }),
    op(5, 'tool.outcome-unknown', { batchId: 'batch:1', nodeId: 'node:uncertain', payload: { toolId: 'script.apply', reason: 'Commit acknowledgement was lost.' } }),
    op(6, 'compaction.requested', { nodeId: 'compact:1', payload: { compaction } }),
    op(7, 'compaction.started', { nodeId: 'compact:1', parentOpId: 'op:6', dependsOn: ['op:6'], payload: { compaction } }),
    op(8, 'compaction.summary-created', { nodeId: 'compact:1', parentOpId: 'op:7', dependsOn: ['op:7'], artifactRefs: ['summary:1'], payload: { compaction } }),
    op(9, 'compaction.completed', { nodeId: 'compact:1', parentOpId: 'op:8', dependsOn: ['op:8'], payload: { compaction } }),
  ];
  const graph = projectExecutionGraph({ sessionId: SESSION, status: 'waiting-user', ops });
  assert.equal(graph.nodes.find((node) => node.id === 'tool:node:uncertain').status, 'outcome-unknown');
  assert.equal(graph.context.pressure.ratio, 0.6);
  assert.equal(graph.context.latestCompaction.id, 'compact:1');
  assert.equal(graph.context.compactionAvailable, false);
  assert.ok(graph.transcript.some((item) => item.kind === 'barrier'));
  assert.ok(graph.transcript.some((item) => item.kind === 'compaction' && item.body.includes('80% → 60%')));
  assert.ok(graph.transcript.some((item) => item.kind === 'recovery'));
  assert.ok(graph.currentNodeIds.includes('tool:node:uncertain'));
});

test('reports sequence gaps and dangling references without crashing', () => {
  const graph = projectExecutionGraph({ sessionId: SESSION, ops: [
    op(0, 'session.created', { turnId: null }),
    op(2, 'tool.started', { nodeId: 'node:missing', dependsOn: ['node:not-found'], payload: { toolId: 'scene.query' } }),
  ] });
  assert.ok(graph.diagnostics.some((item) => item.code === 'graph.sequence-gap'));
  assert.ok(graph.diagnostics.some((item) => item.code === 'graph.reference-missing'));
  assert.ok(graph.nodes.some((node) => node.id === 'tool:node:missing'));
});

test('projects a 1000-tool graph within a bounded unit-test budget', () => {
  const ops = [op(0, 'session.created', { turnId: null }), op(1, 'turn.started'), op(2, 'tool-batch.planned', { batchId: 'batch:large' }), op(3, 'tool-batch.started', { batchId: 'batch:large' })];
  let sequence = 4;
  for (let index = 0; index < 1_000; index += 1) {
    const nodeId = `node:large:${index}`;
    ops.push(op(sequence++, 'tool-batch.planned', { batchId: 'batch:large', nodeId, payload: { toolId: 'scene.query', executionClass: 'parallel-read' } }));
    ops.push(op(sequence++, 'tool.started', { batchId: 'batch:large', nodeId, payload: { toolId: 'scene.query', executionClass: 'parallel-read' } }));
    ops.push(op(sequence++, 'tool.completed', { batchId: 'batch:large', nodeId, payload: { toolId: 'scene.query', status: 'completed' } }));
  }
  ops.push(op(sequence++, 'tool-batch.completed', { batchId: 'batch:large', payload: { status: 'completed', completed: 1_000 } }));
  ops.push(op(sequence++, 'turn.completed', { payload: { status: 'completed' } }));
  const started = performance.now();
  const graph = projectExecutionGraph({ sessionId: SESSION, status: 'completed', ops });
  const elapsed = performance.now() - started;
  assert.ok(graph.nodes.filter((node) => node.kind === 'tool').length >= 1_000);
  assert.ok(elapsed < 1_500, `projection took ${elapsed.toFixed(1)}ms`);
  assert.match(graph.digest, /^sha256:[a-f0-9]{64}$/u);
  const overviewStarted = performance.now();
  const overview = layoutExecutionGraph(graph);
  const overviewElapsed = performance.now() - overviewStarted;
  assert.ok(overview.visibleNodeIds.length < 100, `overview retained ${overview.visibleNodeIds.length} nodes`);
  assert.ok(overviewElapsed < 100, `overview layout took ${overviewElapsed.toFixed(1)}ms`);
  const expandedStarted = performance.now();
  const expanded = layoutExecutionGraph(graph, { mode: 'expanded' });
  const expandedElapsed = performance.now() - expandedStarted;
  assert.equal(expanded.visibleNodeIds.length, graph.nodes.length);
  assert.ok(expandedElapsed < 1_500, `expanded layout took ${expandedElapsed.toFixed(1)}ms`);
});

test('session history orders actual execution time instead of unrelated operation counts', () => {
  const older = projectExecutionGraph({ sessionId: SESSION, ops: linearFixture() });
  const nextSession = 'session:g09:next';
  const newer = projectExecutionGraph({ sessionId: nextSession, ops: [op(0, 'session.created', { turnId: null }), op(1, 'turn.started')].map(value => ({ ...value, sessionId: nextSession, timestamp: '2026-09-02T00:00:00.000Z' })) });
  assert.ok(older.revision > newer.revision);
  assert.deepEqual(normalizeExecutionGraphs([newer, older]).map(graph => graph.sessionId), [SESSION, nextSession]);
  assert.equal(normalizeExecutionGraphs([newer, older])[1].digest, newer.digest);
});

function taskSession(sessionId, taskId, offset = 0, startedOnly = false) {
  const source = [op(0, 'session.created', { turnId: null }), op(1, 'turn.started', { payload: { taskId } }), op(2, 'user.message')];
  if (!startedOnly) source.push(op(3, 'tool.started', { batchId: 'batch:shared', nodeId: 'node:shared', payload: { toolId: 'scene.query' } }), op(4, 'tool.completed', { batchId: 'batch:shared', nodeId: 'node:shared', payload: { status: 'completed', toolId: 'scene.query' } }), op(5, 'turn.completed', { payload: { status: 'completed' } }));
  const ops = source.map(item => ({ ...item, sessionId, id: `${sessionId}:${item.id}`, turnId: item.turnId ? `${sessionId}:turn` : null, timestamp: new Date(Date.UTC(2026, 8, 10, 0, 0, offset + item.sequence)).toISOString() }));
  return projectExecutionGraph({ sessionId, activeGoal: 'The same visible title', ops, transcript: [{ id: `${sessionId}:message`, opId: ops[2].id, role: 'user', content: taskId, timestamp: ops[2].timestamp }] });
}

test('a task retains its full chain when an approval continuation starts a two-node provider session', () => {
  const old = taskSession('session:old', 'task:game'); const next = taskSession('session:next', 'task:game', 60, true);
  assert.equal(next.nodes.length, 2);
  const before = groupExecutionGraphsByTask([old])[0];
  const [after] = groupExecutionGraphsByTask([next, old]);
  assert.equal(executionGraphIdentity(after), executionGraphIdentity(before));
  assert.equal(after.sessionId, next.sessionId, 'compaction must keep targeting the actual current session');
  assert.deepEqual(after.sourceSessionIds, ['session:old', 'session:next']);
  assert.equal(after.nodes.length, old.nodes.length + 1);
  for (const node of before.nodes) assert.ok(after.nodes.some(item => item.id === node.id), node.id);
  assert.equal(after.transcript.filter(item => item.kind === 'message').length, 2);
  assert.equal(normalizeExecutionGraphs([after]).length, 1);
  assert.equal(groupExecutionGraphsByTask([old, next])[0].digest, after.digest);
  const completed = taskSession('session:next', 'task:game', 60);
  const [finished] = groupExecutionGraphsByTask([old, completed]);
  assert.equal(finished.nodes.filter(node => node.kind === 'tool').length, 2, 'session-local tool ids cannot overwrite one another');
  assert.equal(new Set(finished.nodes.map(node => node.id)).size, finished.nodes.length);
  assert.equal(layoutExecutionGraph(finished, { mode: 'expanded' }).visibleNodeIds.length, finished.nodes.length);
});

test('task membership separates different requests that reuse one provider session, even with identical titles', () => {
  const a = taskSession('session:shared', 'task:a');
  const source = [op(0, 'session.created', { turnId: null }), op(1, 'turn.started', { turnId: 'turn:a', payload: { taskId: 'task:a' } }), op(2, 'turn.completed', { turnId: 'turn:a', payload: { status: 'completed' } }), op(3, 'turn.started', { turnId: 'turn:b', payload: { taskId: 'task:b' } })].map(item => ({ ...item, sessionId: a.sessionId }));
  const shared = projectExecutionGraph({ sessionId: a.sessionId, activeGoal: a.title, ops: source });
  const bNext = taskSession('session:b-next', 'task:b', 60, true);
  const groups = groupExecutionGraphsByTask([shared, bNext], [{ taskId: 'task:a', title: 'First request', status: 'completed' }, { taskId: 'task:b', title: 'Second request', status: 'running' }]);
  assert.equal(groups.length, 2); assert.equal(groups[0].taskId, 'task:a'); assert.equal(groups[1].taskId, 'task:b');
  assert.ok(groups[0].nodes.some(node => node.turnId === 'turn:a')); assert.ok(!groups[0].nodes.some(node => node.turnId === 'turn:b'));
  assert.ok(!groups[1].nodes.some(node => node.turnId === 'turn:a')); assert.equal(groups[1].sourceSessionIds.length, 2);
  assert.equal(normalizeExecutionGraphs(groupExecutionGraphsByTask([shared])).length, 2, 'two tasks sharing a session are separate graph identities');
  const other = taskSession('session:unrelated', 'task:other', 120, true);
  assert.equal(groupExecutionGraphsByTask([shared, bNext, other]).length, 3, 'equal titles do not imply task membership');
});

test('legacy sessions stay inspectable and invalid task membership is rejected', () => {
  const legacy = projectExecutionGraph({ sessionId: SESSION, ops: linearFixture() });
  const current = taskSession('session:current', 'task:current', 60, true);
  assert.ok(groupExecutionGraphsByTask([legacy, current]).some(graph => graph.digest === legacy.digest));
  const { digest, ...body } = current;
  body.taskScopes = [{ taskId: 'task:current', nodeIds: ['node:missing'], transcriptIds: [] }];
  const malformed = { ...body, digest: `sha256:${createHash('sha256').update(canonical(body)).digest('hex')}` };
  assert.deepEqual(normalizeExecutionGraphs([malformed]), []);
});

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
