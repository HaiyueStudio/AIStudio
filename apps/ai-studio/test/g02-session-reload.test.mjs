import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DurableSessionRuntime } from '@haiyue/ai-studio-agent-runtime';
import { OperationLog } from '@haiyue/ai-studio-operation-log';

test('main-owned Session rebuild ignores stale renderer read models across renderer and process reload', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g02-app-reload-'));
  try {
    const log = await openLog(root);
    const runtime = new DurableSessionRuntime(log);
    const session = await runtime.create({ id: 'session:g02-app-reload', projectId: 'project:g02-app', documentId: 'document:g02-app', activeGoal: 'Keep durable history.', taskBudgetId: null });
    await session.appendMessage({ role: 'user', content: 'Durable user request.' });
    await session.appendMessage({ role: 'assistant', content: 'Durable assistant response.' });
    const first = await session.bindBackend({ bindingId: 'binding:g02-app', backendId: 'backend:harness', provider: 'deepseek', model: 'deepseek-chat', remoteSessionId: 'remote:g02-app', generation: 1, status: 'active', capabilities: { maxInputTokens: 131072, nativeCompaction: true, parallelToolCalls: true, codeMode: true, providerUsage: 'reported', providerCache: 'reported' }, lastConfirmedOpId: null });
    const staleRendererState = { surfaceDigest: `sha256:${'0'.repeat(64)}`, transcript: [] };

    const replacementRendererProjection = await session.snapshot();
    assert.notEqual(replacementRendererProjection.surface.digest, staleRendererState.surfaceDigest);
    assert.deepEqual(replacementRendererProjection.transcript.map((entry) => entry.content), ['Durable user request.', 'Durable assistant response.']);
    await runtime.dispose(); await log.close();

    const reopenedLog = await openLog(root);
    const restartedRuntime = new DurableSessionRuntime(reopenedLog);
    const restarted = await restartedRuntime.open(session.id);
    const afterProcessReload = await restarted.snapshot();
    assert.equal(afterProcessReload.surface.digest, first.surface.digest);
    assert.deepEqual(afterProcessReload.transcript, first.transcript);
    assert.deepEqual(afterProcessReload.session.backendBindings, first.session.backendBindings);
    await restartedRuntime.dispose(); await reopenedLog.close();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

function openLog(root) { return OperationLog.open({ rootDirectory: root, appVersion: 'g02-app-test', flushPolicy: 'always' }); }
