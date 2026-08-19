import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { asStableId } from '@haiyue/ai-studio-contracts';
import { OperationLog } from '../dist/index.js';

test('deterministic POC workload stays inside diagnostic latency and growth budgets', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-operation-perf-'));
  let tick = 0;
  const log = await OperationLog.open({
    rootDirectory: root,
    appVersion: '0.0.0-perf',
    clock: () => new Date(1_777_000_000_000 + tick++),
    eventId: (sequence) => asStableId(`event:perf:${sequence}`),
  });
  const appendLatency = [];
  for (let index = 0; index < 200; index += 1) {
    const started = performance.now();
    await log.append({
      kind: 'fixture/performance', severity: 'info', source: asStableId('studio.performance'),
      correlation: { sessionId: asStableId('session:performance') }, payload: { index, message: 'bounded fixture' },
    });
    appendLatency.push(performance.now() - started);
  }
  const queryStarted = performance.now();
  const page = await log.query({ sessionId: asStableId('session:performance'), limit: 200, traverseCorrelation: false });
  const queryMs = performance.now() - queryStarted;
  const flushStarted = performance.now();
  await log.flush();
  const flushMs = performance.now() - flushStarted;
  const status = log.status();
  await log.close();
  const recoveryStarted = performance.now();
  const reopened = await OperationLog.open({ rootDirectory: root, appVersion: '0.0.0-perf' });
  const recoveryMs = performance.now() - recoveryStarted;
  await reopened.close();
  const p95 = percentile(appendLatency, 0.95);
  t.diagnostic(JSON.stringify({ appendP95Ms: p95, flushMs, queryMs, recoveryMs, journalBytes: status.bytes, retainedFileHandles: status.retainedFileHandles, retainedEvents: page.events.length }));
  assert.ok(p95 < 250, `append P95 ${p95}ms exceeded 250ms`);
  assert.ok(queryMs < 250, `query ${queryMs}ms exceeded 250ms`);
  assert.ok(flushMs < 250, `flush ${flushMs}ms exceeded 250ms`);
  assert.ok(recoveryMs < 1500, `recovery ${recoveryMs}ms exceeded 1500ms`);
  assert.ok(status.bytes < 1_000_000, `journal growth ${status.bytes} bytes exceeded fixture budget`);
  assert.equal(status.retainedFileHandles, 0);
});

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}
