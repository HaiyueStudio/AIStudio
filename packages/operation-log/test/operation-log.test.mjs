import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asStableId } from '@haiyue/ai-studio-contracts';
import {
  OperationLog,
  OperationLogError,
  canonicalStringify,
  createOperationLogPlugin,
  sha256,
  verifyBugBundle,
} from '../dist/index.js';

const source = asStableId('studio.test');
const sessionId = asStableId('session:test');

async function tempRoot(name) {
  return mkdtemp(path.join(tmpdir(), `haiyue-${name}-`));
}

function options(root, overrides = {}) {
  return {
    rootDirectory: root,
    appVersion: '0.0.0-test',
    clock: () => new Date('2026-08-19T00:00:00.000Z'),
    eventId: (sequence) => asStableId(`event:test:${sequence}`),
    ...overrides,
  };
}

function event(index, overrides = {}) {
  return {
    kind: 'document/command-committed',
    severity: 'info',
    source,
    correlation: { sessionId, commandId: asStableId(`command:${index}`) },
    payload: { index, revision: index + 1 },
    ...overrides,
  };
}

const allQuery = { limit: 200, traverseCorrelation: false };

test('concurrent append is monotonic and restart replay equals the live projection', async () => {
  const root = await tempRoot('operation-restart');
  const log = await OperationLog.open(options(root));
  const appended = await Promise.all(Array.from({ length: 40 }, (_, index) => log.append(event(index))));
  assert.deepEqual(appended.map((item) => item.sequence), Array.from({ length: 40 }, (_, index) => index));
  const live = await log.query(allQuery);
  await log.close();
  const reopened = await OperationLog.open(options(root));
  const replayed = await reopened.query(allQuery);
  assert.deepEqual(replayed.events, live.events);
  assert.equal(reopened.status().retainedFromSequence, 0);
  assert.equal(reopened.status().nextSequence, 40);
  await reopened.close();
});

test('sequence windows keep large retained journals within the query scan budget', async () => {
  const root = await tempRoot('operation-query-window');
  const log = await OperationLog.open(options(root, { maxQueryScan: 3 }));
  for (let index = 0; index < 6; index += 1) await log.append(event(index));

  await assert.rejects(log.query(allQuery), hasCode('query-scan-budget-exceeded'));
  const tail = await log.query({ ...allQuery, afterSequence: 2 });
  assert.equal(tail.scanned, 3);
  assert.deepEqual(tail.events.map((item) => item.sequence), [3, 4, 5]);
  const middle = await log.query({ ...allQuery, afterSequence: 0, beforeSequence: 4 });
  assert.equal(middle.scanned, 3);
  assert.deepEqual(middle.events.map((item) => item.sequence), [1, 2, 3]);
  await log.close();
});

test('exact approval and tool lookups use bounded indexes across large journals and restart', async () => {
  const root = await tempRoot('exact-approval-query');
  let log = await OperationLog.open(options(root, { maxQueryScan: 3 }));
  try {
    for (let i = 0; i < 20; i++) await log.append(event(i));
    for (let i = 0; i < 3; i++) await log.append(event(20 + i, { kind: 'conversation/approval-grant-consumed', correlation: { approvalId: 'approval:target', toolCallId: 'call:target', projectId: 'project:target' } }));
    for (const restart of [false, true]) {
      if (restart) { await log.close(); log = await OperationLog.open(options(root, { maxQueryScan: 3 })); }
      const query = { approvalId: 'approval:target', kinds: ['conversation/approval-grant-consumed'], limit: 1, traverseCorrelation: false };
      const first = await log.query(query);
      assert.equal(first.scanned, 3); assert.deepEqual(first.events.map(e => e.sequence), [20]);
      const second = await log.query({ ...query, cursor: first.nextCursor });
      assert.equal(second.scanned, 2); assert.deepEqual(second.events.map(e => e.sequence), [21]);
      assert.equal((await log.query({ ...query, approvalId: 'approval:missing' })).scanned, 0);
      assert.equal((await log.query({ toolCallId: 'call:target', limit: 10, traverseCorrelation: false })).events.length, 3);
      assert.equal((await log.query({ ...query, projectId: 'project:other' })).events.length, 0);
      assert.equal((await log.query({ ...query, beforeSequence: 21 })).scanned, 1);
      await assert.rejects(log.query(allQuery), hasCode('query-scan-budget-exceeded'));
      await assert.rejects(log.query({ ...query, traverseCorrelation: true }), hasCode('query-scan-budget-exceeded'));
    }
  } finally { await log.close(); }
});

test('source redaction, taint, immutable artifacts and bug bundle contain no secret canary', async () => {
  const root = await tempRoot('operation-redaction');
  const bundles = await tempRoot('operation-bundles');
  const log = await OperationLog.open(options(root));
  const artifact = await log.putArtifact({
    script: 'const visible = true;',
    environment: { API_KEY: 'API_KEY_CANARY-12345678' },
    marked: 'CODEX_TOKEN_CANARY-12345678',
  }, {}, { taintedFields: ['/marked'] });
  const repeated = await log.putArtifactDetailed({
    script: 'const visible = true;',
    environment: { API_KEY: 'API_KEY_CANARY-12345678' },
    marked: 'CODEX_TOKEN_CANARY-12345678',
  }, {}, { taintedFields: ['/marked'] });
  assert.equal(repeated.localHit, true);
  assert.equal(repeated.reference.id, artifact.id);
  const persisted = await log.append(event(0, {
    payload: {
      apiKey: 'SECRET_CANARY-12345678',
      headers: { Authorization: 'Bearer abcdefghijklmnop' },
      scriptText: 'safe prefix CODEX_TOKEN_CANARY-12345678',
      result: 'ok',
    },
    redaction: { taintedFields: ['/scriptText'] },
    artifactRefs: [artifact.id],
  }));
  assert.equal(persisted.payload.apiKey, '[REDACTED]');
  assert.equal(persisted.payload.headers.Authorization, '[REDACTED]');
  assert.equal(persisted.payload.scriptText, '[REDACTED]');
  assert.ok(persisted.redactedFields.length >= 3);
  const bundle = await log.exportBugBundle({
    destinationRoot: bundles,
    query: allQuery,
    artifactIds: [artifact.id],
    versions: { app: '0.0.0-test', schema: 'operation-event/1', upstream: { harness: '0.1.0-rc.7' } },
  });
  const verified = await verifyBugBundle(bundle.directory, {
    forbiddenCanaries: ['SECRET_CANARY', 'CODEX_TOKEN_CANARY', 'API_KEY_CANARY', 'Bearer abcdef'],
  });
  assert.equal(verified.contentDigest, bundle.contentDigest);
  assert.equal(verified.eventCount, 1);
  assert.equal(verified.artifactCount, 1);
  assert.ok(verified.correlationIds.includes(sessionId));
  const diskText = await readTreeText(root);
  const bundleText = await readTreeText(bundle.directory);
  for (const canary of ['SECRET_CANARY', 'CODEX_TOKEN_CANARY', 'API_KEY_CANARY', 'Bearer abcdef']) {
    assert.doesNotMatch(diskText, new RegExp(canary));
    assert.doesNotMatch(bundleText, new RegExp(canary));
  }
  assert.match(bundleText, /contentDigest/);
  await log.close();
});

test('offline bug bundle verification rejects artifact tampering', async () => {
  const root = await tempRoot('operation-bundle-tamper');
  const bundles = await tempRoot('operation-bundle-tamper-out');
  const log = await OperationLog.open(options(root));
  const artifact = await log.putArtifact({ diagnostic: 'safe' });
  await log.append(event(0, { artifactRefs: [artifact.id] }));
  const bundle = await log.exportBugBundle({
    destinationRoot: bundles, query: allQuery, artifactIds: [artifact.id],
    versions: { app: '0.0.0-test', schema: 'operation-event/1', upstream: {} },
  });
  const artifactFile = bundle.files.find((entry) => entry.path.startsWith('artifacts/'));
  assert.ok(artifactFile);
  await appendFile(path.join(bundle.directory, ...artifactFile.path.split('/')), 'tampered');
  await assert.rejects(verifyBugBundle(bundle.directory), (error) => {
    assert.equal(error.code, 'bundle.verify-file-digest'); return true;
  });
  await log.close();
});

test('artifact references are persist-before-reference and approved reads are capability bounded', async () => {
  const root = await tempRoot('operation-artifact');
  const log = await OperationLog.open(options(root));
  const missing = asStableId(`artifact:sha256:${'0'.repeat(64)}`);
  await assert.rejects(log.append(event(0, { artifactRefs: [missing] })), hasCode('artifact-missing'));
  const artifact = await log.putArtifact({ diagnostic: 'safe' });
  const denied = log.diagnosticsService();
  await assert.rejects(denied.readApprovedArtifact(artifact.id), hasCode('artifact-not-approved'));
  const allowed = log.diagnosticsService(new Set([artifact.id]));
  assert.deepEqual((await allowed.readApprovedArtifact(artifact.id)).value, { diagnostic: 'safe' });
  await log.close();
});

test('partial crash tail is quarantined, reported and recovered without losing committed events', async () => {
  const root = await tempRoot('operation-partial');
  const log = await OperationLog.open(options(root));
  await log.append(event(0));
  await log.close();
  const segment = path.join(root, 'journal', 'segment-000001.jsonl');
  await appendFile(segment, '{"recordVersion":1,"event":');
  const recovered = await OperationLog.open(options(root));
  assert.equal(recovered.status().health, 'recovered');
  assert.equal(recovered.status().eventCount, 1);
  assert.equal(recovered.status().allowsMutation, true);
  assert.ok(recovered.status().diagnostics.some((item) => item.code === 'partial-tail'));
  assert.equal((await readdir(path.join(root, 'quarantine'))).length, 1);
  await recovered.append(event(1));
  await recovered.close();
});

test('derived index failure stays writable and the journal rebuilds the projection on restart', async () => {
  const root = await tempRoot('operation-index-recovery');
  const log = await OperationLog.open(options(root, {
    faultInjector(point) { if (point === 'before-index-write') throw new Error('injected index replacement failure'); },
  }));
  assert.equal(log.status().health, 'recovered');
  assert.equal(log.status().allowsMutation, true);
  assert.ok(log.status().diagnostics.some((item) => item.code === 'index-rebuild-failed'));
  await log.append(event(0));
  await log.close();

  const reopened = await OperationLog.open(options(root));
  assert.equal(reopened.status().eventCount, 1);
  assert.equal(reopened.status().allowsMutation, true);
  assert.deepEqual((await reopened.query(allQuery)).events.map((item) => item.sequence), [0]);
  await reopened.close();
});

test('derived index checkpoints are amortized instead of rewriting the full projection per event', async () => {
  const root = await tempRoot('operation-index-checkpoint');
  let indexWrites = 0;
  const log = await OperationLog.open(options(root, {
    faultInjector(point) { if (point === 'before-index-write') indexWrites += 1; },
  }));
  for (let index = 0; index < 31; index += 1) await log.append(event(index));
  assert.equal(indexWrites, 1);
  await log.append(event(31));
  assert.equal(indexWrites, 2);
  await log.close();
  assert.equal(indexWrites, 2);
});

test('checksum mismatch is isolated and fails closed for future protected operations', async () => {
  const root = await tempRoot('operation-checksum');
  const log = await OperationLog.open(options(root));
  await log.append(event(0));
  await log.close();
  const segment = path.join(root, 'journal', 'segment-000001.jsonl');
  const record = JSON.parse((await readFile(segment, 'utf8')).trim());
  record.event.payload.revision = 999;
  await writeFile(segment, `${JSON.stringify(record)}\n`);
  const recovered = await OperationLog.open(options(root));
  assert.equal(recovered.status().health, 'degraded');
  assert.equal(recovered.status().allowsMutation, false);
  assert.ok(recovered.status().diagnostics.some((item) => item.code === 'checksum-mismatch'));
  await assert.rejects(recovered.append(event(1)), hasCode('log-unavailable'));
  await recovered.close();
});

test('cancel, oversized payload and injected disk-full produce structured failures', async () => {
  const root = await tempRoot('operation-faults');
  let failWrites = false;
  const log = await OperationLog.open(options(root, {
    maxPayloadBytes: 128,
    faultInjector(point) {
      if (failWrites && point === 'before-journal-write') {
        const error = new Error('disk full');
        error.code = 'ENOSPC';
        throw error;
      }
    },
  }));
  const controller = new AbortController();
  controller.abort('test');
  await assert.rejects(log.append(event(0), { signal: controller.signal }), hasCode('append-cancelled'));
  await assert.rejects(log.append(event(0, { payload: { text: 'x'.repeat(256) } })), hasCode('payload-too-large'));
  failWrites = true;
  await assert.rejects(log.append(event(0)), hasCode('journal-write-failed'));
  assert.equal(log.status().health, 'backpressure');
  assert.equal(log.status().allowsRuntimeStart, false);
  await log.close();
});

test('rotation and quota retire complete segments while preserving monotonic restart', async () => {
  const root = await tempRoot('operation-rotation');
  const log = await OperationLog.open(options(root, {
    maxSegmentBytes: 750,
    maxTotalBytes: 1900,
    retentionSegments: 2,
  }));
  for (let index = 0; index < 12; index += 1) await log.append(event(index, { payload: { index, text: 'x'.repeat(80) } }));
  assert.ok(log.status().segmentCount <= 2);
  assert.ok(log.status().eventCount < 12);
  assert.equal((await log.query({ commandId: 'command:0', limit: 1, traverseCorrelation: false })).scanned, 0);
  assert.equal((await log.query({ commandId: 'command:11', limit: 1, traverseCorrelation: false })).events.length, 1);
  const next = log.status().nextSequence;
  await log.close();
  const reopened = await OperationLog.open(options(root, { maxSegmentBytes: 750, maxTotalBytes: 1900, retentionSegments: 2 }));
  assert.equal(reopened.status().nextSequence, next);
  const firstRetained = (await reopened.query(allQuery)).events[0].sequence;
  assert.ok(firstRetained > 0);
  assert.equal(reopened.status().retainedFromSequence, firstRetained);
  await reopened.close();
});

test('legacy schema migrates on read and bounded correlation traversal plus cursors are deterministic', async () => {
  const root = await tempRoot('operation-legacy');
  await mkdir(path.join(root, 'journal'), { recursive: true });
  const legacy = {
    recordVersion: 0,
    event: {
      schemaVersion: 1,
      eventId: 'event:legacy:0', sequence: 0, timestamp: '2026-08-19T00:00:00.000Z',
      kind: 'agent/turn-started', severity: 'info', source: 'studio.test',
      correlation: { sessionId: 'session:test', turnId: 'turn:test' }, payload: { migrated: true }, redactedFields: [],
    },
  };
  await writeFile(path.join(root, 'journal', 'segment-000001.jsonl'), `${JSON.stringify(legacy)}\n`);
  const log = await OperationLog.open(options(root));
  assert.equal((await log.query(allQuery)).events[0].provenance.schemaVersion, 'operation-event/0');
  await log.append(event(1, { correlation: { sessionId, turnId: asStableId('turn:test'), toolCallId: asStableId('tool:test') } }));
  await log.append(event(2, { correlation: { toolCallId: asStableId('tool:test'), entityId: asStableId('entity:test') } }));
  const traversed = await log.query({ turnId: asStableId('turn:test'), limit: 10, traverseCorrelation: true });
  assert.deepEqual(traversed.events.map((item) => item.sequence), [0, 1, 2]);
  const first = await log.query({ limit: 1, traverseCorrelation: false });
  const second = await log.query({ limit: 1, traverseCorrelation: false, cursor: first.nextCursor });
  assert.equal(first.events[0].sequence, 0);
  assert.equal(second.events[0].sequence, 1);
  await assert.rejects(log.query({ limit: 201, traverseCorrelation: false }), hasCode('query-limit-invalid'));
  await assert.rejects(log.query({ limit: 1, traverseCorrelation: false, cursor: `${first.nextCursor}bad` }), hasCode('query-cursor-invalid'));
  await log.close();
});

test('plugin manifest exposes only the headless service seam', () => {
  const plugin = createOperationLogPlugin();
  assert.deepEqual(plugin.manifest.provides, [{ id: 'studio.operation-log', version: '1.0.0' }]);
  assert.equal(plugin.manifest.contributions.length, 0);
  assert.throws(() => plugin.validateConfig({ rootDirectory: 1 }), /requires rootDirectory/);
});

function hasCode(code) {
  return (error) => {
    assert.ok(error instanceof OperationLogError);
    assert.equal(error.code, code);
    return true;
  };
}

async function readTreeText(root) {
  const chunks = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else chunks.push(await readFile(target, 'utf8'));
    }
  }
  await walk(root);
  return chunks.join('\n');
}

test('project queries isolate scan budgets, correlation traversal, cursors, status and exported events across restart', async () => {
  const root = await tempRoot('project-log-isolation');
  let log = await OperationLog.open(options(root, { maxQueryScan: 4, maxTotalBytes: 1_000_000 }));
  const a = 'project:a'; const b = 'project:b';
  try {
    for (let i = 0; i < 20; i++) await log.append(event(i, { correlation: { projectId: a, pluginId: 'plugin:shared' } }));
    await log.append(event(20, { kind: 'agent/session-op', correlation: { sessionId: 'session:b' }, payload: { sessionOp: { kind: 'session.created', payload: { projectId: b } } } }));
    const implicit = await log.append(event(21, { correlation: { sessionId: 'session:b', pluginId: 'plugin:shared' } }));
    assert.equal(implicit.correlation.projectId, b, 'new session events persist their project identity');
    await log.append(event(22, { correlation: {}, payload: { message: 'legacy app-only log' } }));
    const query = { ...allQuery, projectId: b, pluginId: 'plugin:shared', traverseCorrelation: true, limit: 1 };
    const first = await log.query(query);
    assert.equal(first.scanned, 2);
    assert.equal(first.events[0].correlation.projectId, b);
    assert.ok(first.nextCursor);
    await assert.rejects(log.query({ ...query, projectId: a, cursor: first.nextCursor }), /cursor/i);
    const second = await log.query({ ...query, cursor: first.nextCursor });
    assert.equal(second.events.length, 1);
    assert.ok(second.events.every(item => item.correlation.projectId === b));
    assert.equal((await log.logViewer({ ...allQuery, projectId: b })).status.eventCount, 2);
    assert.equal(log.projectStatus(null).eventCount, 0);
    assert.deepEqual((await log.query({ ...allQuery, projectId: 'project:new-unsaved' })).events, []);
    const bundle = await log.exportBugBundle({ destinationRoot: await tempRoot('project-log-bundle'), query: { ...allQuery, projectId: b }, versions: { app: 'test', schema: '1', upstream: {} } });
    const exported = (await readFile(path.join(bundle.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(exported.length, 2); assert.ok(exported.every(item => item.correlation.projectId === b));
    await log.close(); log = await OperationLog.open(options(root, { maxQueryScan: 4 }));
    assert.equal((await log.query({ ...allQuery, projectId: b })).events.length, 2);
    assert.equal((await log.query({ ...allQuery, projectId: 'project:new-unsaved' })).scanned, 0);
  } finally { await log.close(); }
});

test('legacy session-only rows get an isolated project index without rewriting their durable journal', async () => {
  const root = await tempRoot('legacy-project-log');
  let log = await OperationLog.open(options(root));
  await log.append(event(0, { kind: 'agent/session-op', correlation: { sessionId: 'session:legacy' }, payload: { sessionOp: { kind: 'session.created', payload: { projectId: 'project:legacy' } } } }));
  await log.append(event(1, { correlation: { sessionId: 'session:legacy' } }));
  await log.append(event(2, { correlation: {} }));
  await log.close();
  const segment = path.join(root, 'journal', 'segment-000001.jsonl');
  const legacy = (await readFile(segment, 'utf8')).trim().split('\n').map(line => {
    const { event } = JSON.parse(line); delete event.correlation.projectId;
    const record = { recordVersion: 1, event };
    return canonicalStringify({ ...record, checksum: sha256(canonicalStringify(record)) });
  }).join('\n') + '\n';
  await writeFile(segment, legacy);
  log = await OperationLog.open(options(root, { maxQueryScan: 2 }));
  try {
    const page = await log.query({ ...allQuery, projectId: 'project:legacy' });
    assert.deepEqual(page.events.map(item => item.sequence), [0, 1]);
    assert.equal(page.scanned, 2);
    assert.deepEqual((await log.query({ ...allQuery, projectId: 'project:new' })).events, []);
    assert.equal(await readFile(segment, 'utf8'), legacy);
  } finally { await log.close(); }
});
