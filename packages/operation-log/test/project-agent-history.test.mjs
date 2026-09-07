import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OperationLog, ProjectAgentHistory } from '../dist/index.js';
import { parseHistoryRecord } from '../dist/project-agent-history.js';

const time = '2026-09-06T12:00:00.000Z';
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-project-history-'));
  const source = await OperationLog.open({ rootDirectory: path.join(root, 'global'), appVersion: 'test' });
  const scopes = [];
  t.after(async () => { for (const scope of scopes.reverse()) await scope.dispose(); await source.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  async function open(projectId, directory = path.join(root, projectId.replaceAll(':', '-'), '.aistudio', 'agent'), log = source, storage = 'project') {
    const scope = await ProjectAgentHistory.open({ projectId, directory, source: log, storage }); scopes.push(scope); return scope;
  }
  return { root, source, open };
}
async function record(scope, projectId, id, parameters, result, durationMs = 37) {
  const data = await scope.log.putArtifact({ parameters, result });
  const record = { schemaVersion: 1, id, projectId, kind: 'tool-result', status: 'completed', sessionId: `session:${projectId}`, turnId: `turn:${projectId}`, toolId: 'entity.create', startedAt: time, finishedAt: '2026-09-06T12:00:00.037Z', durationMs, dataArtifactId: data.id };
  await scope.log.append({ kind: 'agent/execution-record', severity: 'info', source: 'studio.test', correlation: { sessionId: record.sessionId }, payload: { record }, artifactRefs: [data.id] });
  return record;
}

test('project records retain complete parameters/results, redact secrets, page by logical record and never mix projects', async t => {
  const { source, open } = await fixture(t);
  const a = await open('project:a'); const b = await open('project:b');
  const long = '完整结果'.repeat(1800);
  await record(a, 'project:a', 'record:a', { name: 'A-only', apiKey: 'fixture-private-value' }, { text: long });
  await record(a, 'project:a', 'record:a2', { revision: 2 }, { ok: true });
  await record(a, 'project:a', 'record:a2', { revision: 2 }, { ok: true, updated: true }, 41);
  await record(b, 'project:b', 'record:b', { name: 'B-only' }, { ok: true });
  const first = await a.query({ limit: 1 }); assert.equal(first.total, 2); assert.equal(first.records.length, 1); assert.ok(first.nextCursor);
  const next = await a.query({ limit: 1, cursor: first.nextCursor }); assert.equal(next.records.length, 1); assert.equal(next.nextCursor, null);
  assert.notEqual(first.records[0].id, next.records[0].id);
  const detail = await a.detail('record:a'); assert.equal(detail.data.result.text, long); assert.equal(detail.data.parameters.apiKey, '[REDACTED]'); assert.equal(detail.record.durationMs, 37);
  assert.deepEqual((await b.query()).records.map(item => item.id), ['record:b']);
  await assert.rejects(b.detail('record:a'), /does not belong/);
  await assert.rejects(b.query({ cursor: first.nextCursor }), /another project/);
  await a.dispose();
  await source.append({ kind: 'agent/late-result', source: 'studio.test', severity: 'info', correlation: { projectId: 'project:a', sessionId: 'session:project:a' }, payload: { result: 'late A only' } });
  assert.equal((await b.log.query({ kinds: ['agent/late-result'], limit: 10, traverseCorrelation: false })).events.length, 0);
});

test('project files reopen with an empty editor data directory and restore nested artifacts without duplicating events', async t => {
  const { root, source, open } = await fixture(t);
  const directory = path.join(root, 'original', '.aistudio', 'agent');
  const a = await open('project:portable', directory);
  const evidence = await source.putArtifact({ evidence: 'portable evidence' });
  await record(a, 'project:portable', 'record:portable', { version: 4 }, { artifactId: evidence.id });
  await a.flush(); await a.dispose();
  const copy = path.join(root, 'copied', '.aistudio', 'agent'); await cp(directory, copy, { recursive: true });
  const fresh = await OperationLog.open({ rootDirectory: path.join(root, 'fresh-editor'), appVersion: 'test' });
  t.after(() => fresh.close());
  const reopened = await open('project:portable', copy, fresh);
  assert.equal((await reopened.query()).total, 1);
  assert.equal((await reopened.detail('record:portable')).data.result.artifactId, evidence.id);
  assert.deepEqual((await fresh.readArtifact(evidence.id)).value, { evidence: 'portable evidence' });
  const before = fresh.status().eventCount;
  await reopened.dispose(); const repeated = await open('project:portable', copy, fresh);
  assert.equal((await repeated.query()).total, 1); assert.equal(fresh.status().eventCount, before);
  const manifest = JSON.parse(await readFile(path.join(copy, 'project-history.json'), 'utf8')); assert.equal(manifest.projectId, 'project:portable');
});

test('first save relocates an unsaved project archive while preserving its live log port', async t => {
  const { root, open } = await fixture(t);
  const history = await open('project:unsaved', path.join(root, 'cache'), undefined, 'unsaved');
  await record(history, 'project:unsaved', 'record:before-save', { phase: 'before' }, { ok: true });
  const log = history.log; const directory = path.join(root, 'saved', '.aistudio', 'agent');
  await history.relocate(directory);
  assert.equal(history.log, log); assert.equal((await history.query()).storage, 'project');
  await record(history, 'project:unsaved', 'record:after-save', { phase: 'after' }, { ok: true });
  await history.dispose();
  const restored = await open('project:unsaved', directory); assert.equal((await restored.query()).total, 2);
});

test('legacy project ownership is derived from durable Session identity, and unassigned global history stays unassigned', async t => {
  const { source, open } = await fixture(t);
  const artifact = await source.putArtifact({ schemaVersion: 1, id: 'node:legacy', kind: 'tool-result', status: 'completed', createdAt: time, provenance: { backendId: 'backend:test', sessionId: 'session:legacy', turnId: 'turn:legacy' }, content: { toolId: 'entity.create', details: 'old summary' } });
  await source.append({ kind: 'conversation/node-projected', severity: 'info', source: 'studio.test', correlation: { sessionId: 'session:legacy' }, payload: { nodeId: 'node:legacy' }, artifactRefs: [artifact.id] });
  await source.append({ kind: 'agent/session-op', severity: 'info', source: 'studio.session', correlation: { sessionId: 'session:legacy' }, payload: { sessionOp: { kind: 'session.created', payload: { projectId: 'project:legacy' } } } });
  await source.append({ kind: 'conversation/node-projected', severity: 'info', source: 'studio.test', correlation: {}, payload: { nodeId: 'node:unassigned' }, artifactRefs: [artifact.id] });
  const a = await open('project:legacy'); const b = await open('project:other');
  assert.equal((await a.query()).total, 1); assert.equal((await b.query()).total, 0);
  const detail = await a.detail('node:legacy'); assert.equal(detail.data.legacyRecord, true); assert.equal(detail.record.durationMs, null);
  assert.equal((await a.log.query({ kinds: ['conversation/node-projected'], limit: 10, traverseCorrelation: false })).events.length, 1);
});

test('unknown versions, malformed durations, secret-bearing metadata and foreign manifests fail closed', async t => {
  const { root, open } = await fixture(t);
  const scope = await open('project:valid');
  const valid = await record(scope, 'project:valid', 'record:valid', {}, {});
  assert.equal(parseHistoryRecord(valid).id, valid.id);
  for (const invalid of [{ ...valid, schemaVersion: 2 }, { ...valid, durationMs: -3 }, { ...valid, apiKey: 'fixture-secret' }, { ...valid, dataArtifactId: '../private.json' }]) assert.throws(() => parseHistoryRecord(invalid));
  const directory = path.join(root, 'bad-project');
  const bad = await open('project:bad', directory); await bad.dispose();
  await writeFile(path.join(directory, 'project-history.json'), JSON.stringify({ schemaVersion: 99, projectId: 'project:other' }));
  await assert.rejects(open('project:bad', directory), /manifest/);
});
