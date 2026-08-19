import test from 'node:test';
import assert from 'node:assert/strict';
import { LogViewerController } from '../dist/index.js';

const digest = `sha256:${'c'.repeat(64)}`;

test('log filters are bounded, pages dedupe, and copied summaries exclude raw payloads', async () => {
  const port = fakeLogPort([
    page([summary(1), { ...summary(2), payload: { secret: 'CANARY' } }], 'cursor:next'),
    page([summary(2), summary(3)]),
  ]);
  const viewer = new LogViewerController(port);
  await viewer.setFilters({ severity: ['error', 'error'], kinds: ['agent/turn', '<invalid>'], sessionId: 'session:fixture', traverseCorrelation: true, pageSize: 999 });
  assert.deepEqual(port.queries[0], { severity: ['error'], kinds: ['agent/turn'], sessionId: 'session:fixture', limit: 200, traverseCorrelation: true });
  assert.deepEqual(viewer.snapshot().events.map((item) => item.sequence), [1, 2]);
  await viewer.loadMore();
  assert.deepEqual(viewer.snapshot().events.map((item) => item.sequence), [1, 2, 3]);
  viewer.toggleCorrelation('event:2');
  assert.deepEqual(viewer.snapshot().expandedEventIds, ['event:2']);
  await viewer.copySafeSummary('event:2');
  assert.doesNotMatch(port.copied, /CANARY|secret|"payload"\s*:/i);
  await viewer.exportBugBundle();
  assert.equal(port.intents[0].type, 'logs/export-bug-bundle');
  assert.equal(port.intents[0].query.cursor, undefined);
  viewer.dispose();
});

test('stale query results and late completion after dispose cannot write back', async () => {
  const first = deferred(); const second = deferred();
  const port = fakeLogPort([first.promise, second.promise]);
  const viewer = new LogViewerController(port);
  const old = viewer.refresh();
  const current = viewer.setFilters({ severity: ['warning'] });
  second.resolve(page([summary(20)]));
  await current;
  first.resolve(page([summary(10)]));
  await old;
  assert.deepEqual(viewer.snapshot().events.map((item) => item.sequence), [20]);

  const third = deferred(); port.responses.push(third.promise);
  const pending = viewer.refresh();
  viewer.dispose();
  third.resolve(page([summary(30)]));
  await pending;
  assert.equal(port.lastSignal.aborted, true);
  assert.throws(() => viewer.snapshot(), /disposed/);
});

function summary(sequence) { return { sequence, eventId: `event:${sequence}`, timestamp: '2026-08-19T00:00:00.000Z', kind: 'agent/turn', severity: 'error', source: 'studio.agent', correlation: { sessionId: 'session:fixture', turnId: 'turn:fixture' }, payloadDigest: digest, redactedFieldCount: 1 }; }
function page(events, nextCursor) { return { events, ...(nextCursor ? { nextCursor } : {}), status: { health: 'healthy', canPersist: true, diagnostics: [] } }; }
function fakeLogPort(responses) {
  return {
    responses: [...responses], queries: [], copied: '', intents: [], lastSignal: null,
    async query(query, signal) { this.queries.push(query); this.lastSignal = signal; const value = this.responses.shift(); return await value; },
    async copyText(value, signal) { assert.equal(signal.aborted, false); this.copied = value; },
    async dispatch(intent, signal) { assert.equal(signal.aborted, false); this.intents.push(intent); },
  };
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
