import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DurableSessionRuntime } from '@haiyue/ai-studio-agent-runtime';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { projectExecutionGraph } from '@haiyue/ai-studio-shell';
import { migrateLegacySessions } from '@haiyue/ai-studio-agent-orchestration';

const sessionId = 'session:g11-legacy';
const turnId = 'turn:g11-legacy';

test('legacy projections migrate once into a lossless Surface and replay-stable Graph without repeating mutations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g11-legacy-'));
  const log = await OperationLog.open({ rootDirectory: root, appVersion: 'g11-legacy-test', flushPolicy: 'always' });
  const sessions = new DurableSessionRuntime(log);
  try {
    const input = {
      sessions,
      operationLog: log,
      nodes: [legacyTextNode()],
      taskRuns: [legacyTaskRun()],
      project: { projectId: 'project:g11-legacy', documentId: 'document:g11-legacy' },
    };
    const first = await migrateLegacySessions(input);
    assert.deepEqual(first.migrated, [sessionId]);
    assert.deepEqual(first.failed, []);

    const snapshot = await sessions.replay(sessionId);
    assert.deepEqual(snapshot.transcript.map((entry) => [entry.role, entry.content]), [
      ['user', 'Build a restart-safe puzzle.'],
      ['assistant', 'The puzzle scene and validation evidence are ready.'],
    ]);
    const completion = snapshot.ops.find((op) => op.payload.reason === 'legacy-migration-completed');
    assert.equal(completion?.payload.mutationReplayCount, 0);
    assert.ok(completion?.artifactRefs.length === 1);
    const source = await log.readArtifact(completion.artifactRefs[0]);
    assert.equal(source.value.mutationReplayCount, 0);
    assert.equal(source.value.taskRuns[0].timeline[0].title, 'Author puzzle');
    const beforeGraph = projectExecutionGraph({ sessionId, activeGoal: snapshot.session.activeGoal, status: snapshot.session.status, ops: snapshot.ops, transcript: snapshot.transcript });

    const second = await migrateLegacySessions(input);
    assert.deepEqual(second.alreadyDurable, [sessionId]);
    const replayed = await sessions.replay(sessionId);
    assert.equal(replayed.ops.length, snapshot.ops.length, 'migration must be idempotent');
    assert.equal(replayed.surface.digest, snapshot.surface.digest);
    const afterGraph = projectExecutionGraph({ sessionId, activeGoal: replayed.session.activeGoal, status: replayed.session.status, ops: replayed.ops, transcript: replayed.transcript });
    assert.equal(afterGraph.digest, beforeGraph.digest);
    assert.equal(replayed.ops.filter((op) => op.kind === 'document.committed' || op.kind.startsWith('tool.')).length, 0, 'historical mutations must never be replayed');
  } finally {
    await sessions.dispose();
    await log.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function legacyTextNode() {
  return {
    schemaVersion: 1,
    id: 'node:g11-legacy-text',
    kind: 'text',
    knownKind: 'text',
    status: 'completed',
    createdAt: '2026-08-30T00:00:05.000Z',
    provenance: { backendId: 'backend:g11-legacy', sessionId, turnId },
    content: { role: 'assistant', text: 'The puzzle scene and validation evidence are ready.' },
    payloadTruncated: false,
  };
}

function legacyTaskRun() {
  return {
    schemaVersion: 1,
    revision: 4,
    taskId: 'task:g11-legacy',
    title: 'Puzzle migration fixture',
    requestSummary: 'Build a restart-safe puzzle.',
    status: 'completed',
    phase: 'complete',
    startedAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:06.000Z',
    backendId: 'backend:g11-legacy',
    sessionId,
    turnId,
    model: { id: 'legacy-model', reasoningEffort: 'high', outputTokenLimit: 8192 },
    promptProfile: { id: 'prompt:g11-legacy', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` },
    documentRevision: 9,
    repairIteration: 0,
    repairLimit: 2,
    acceptance: [],
    evidence: [],
    timeline: [{ id: 'timeline:g11-legacy', at: '2026-08-30T00:00:03.000Z', phase: 'editing', status: 'complete', title: 'Author puzzle', detail: 'Committed revision 9.', turnId, toolCallId: null, playId: null, tick: null }],
    terminalDiagnostic: null,
    resumable: false,
  };
}
