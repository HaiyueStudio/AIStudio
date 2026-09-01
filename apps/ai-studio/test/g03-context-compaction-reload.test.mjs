import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ContextCompactionRuntime, ContextFrameRuntime, DurableSessionRuntime } from '@haiyue/ai-studio-agent-runtime';
import { OperationLog } from '@haiyue/ai-studio-operation-log';

test('main process reload rebuilds completed compaction, full Transcript and exact ContextFrame from Session truth', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g03-app-reload-'));
  try {
    const log = await openLog(root);
    const sessions = new DurableSessionRuntime(log);
    const session = await sessions.create({ id: 'session:g03-app', projectId: 'project:g03-app', documentId: 'document:g03-app', activeGoal: 'Preserve reload truth.', taskBudgetId: null });
    await session.bindBackend(binding());
    await session.appendMessage({ role: 'assistant', content: 'TOKENS:2500 old project facts.', projectRevision: 11 });
    await session.appendMessage({ role: 'assistant', content: 'TOKENS:2500 old tool evidence.', projectRevision: 11 });
    await session.appendMessage({ role: 'assistant', content: 'TOKENS:2500 old validation.', projectRevision: 11 });
    await session.appendMessage({ role: 'user', content: 'TOKENS:500 current request.', projectRevision: 11 });
    const compactor = createCompactor(log, sessions);
    const completed = await compactor.compact(session.id, { reason: 'automatic-threshold', backendBindingId: 'binding:g03-app', reservedOutputTokens: 0, reservedSafetyTokens: 0, providerUsedInputTokens: 8_000, pinnedFacts: [{ kind: 'acceptance', content: 'Reload must preserve exact context.' }] });
    assert.equal(completed.status, 'completed');
    const frames = new ContextFrameRuntime(log, sessions, compactor, { estimator });
    const captured = await frames.capture({ id: 'context-frame:g03-app', sessionId: session.id, turnId: 'turn:g03-app', backendBindingId: 'binding:g03-app', projectRevision: 11, reservedOutputTokens: 0, reservedSafetyTokens: 0 });
    const before = await session.snapshot();
    await compactor.dispose(); frames.dispose(); await sessions.dispose(); await log.close();

    const reopenedLog = await openLog(root);
    const reopenedSessions = new DurableSessionRuntime(reopenedLog);
    const reopenedCompactor = createCompactor(reopenedLog, reopenedSessions);
    const reopenedFrames = new ContextFrameRuntime(reopenedLog, reopenedSessions, undefined, { estimator });
    const after = await reopenedSessions.replay(session.id);
    assert.equal(after.surface.digest, before.surface.digest);
    assert.deepEqual(after.transcript, before.transcript);
    assert.equal((await reopenedCompactor.history(session.id)).at(-1).phase, 'completed');
    const frame = await reopenedFrames.assertReadable(captured.artifactId);
    assert.equal(frame.surfaceGeneration, after.surface.generation);
    assert.equal(frame.compaction.id, completed.compactionId);
    await reopenedCompactor.dispose(); reopenedFrames.dispose(); await reopenedSessions.dispose(); await reopenedLog.close();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

const estimator = { estimate(text) { const match = /TOKENS:(\d+)/u.exec(text); return match ? Number(match[1]) : Math.max(1, Math.ceil(text.length / 4)); } };
function createCompactor(log, sessions) { return new ContextCompactionRuntime(log, sessions, async ({ targetSummaryTokens }) => ({ summary: `TOKENS:${targetSummaryTokens} durable app summary.` }), { estimator }); }
function binding() { return { bindingId: 'binding:g03-app', backendId: 'backend:g03-app', provider: 'provider:g03', model: 'model:g03-10k', remoteSessionId: 'remote:g03-app', generation: 1, status: 'active', capabilities: { maxInputTokens: 10_000, nativeCompaction: true, parallelToolCalls: true, codeMode: true, providerUsage: 'reported', providerCache: 'reported' }, lastConfirmedOpId: null }; }
function openLog(root) { return OperationLog.open({ rootDirectory: root, appVersion: 'g03-app-test', flushPolicy: 'always' }); }
