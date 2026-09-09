import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentHistoryViewer, normalizeHistoryPage } from '../dist/index.js';

const record = (projectId, id) => ({ schemaVersion: 1, projectId, id, kind: 'tool-result', status: 'completed', sessionId: 'session:test', turnId: 'turn:test', toolId: 'scene.query', startedAt: '2026-09-06T12:00:00.000Z', finishedAt: '2026-09-06T12:00:00.037Z', durationMs: 37, dataArtifactId: `artifact:sha256:${'a'.repeat(64)}` });
const page = (projectId, id, nextCursor = null) => ({ schemaVersion: 1, projectId, records: [record(projectId, id)], total: nextCursor ? 2 : 1, nextCursor, storage: 'project' });

test('history projection rejects unknown versions, foreign records, secret metadata and invalid durations', () => {
  const valid = page('project:a', 'record:a'); assert.equal(normalizeHistoryPage(valid).records[0].id, 'record:a');
  for (const invalid of [{ ...valid, schemaVersion: 99 }, { ...valid, records: [record('project:b', 'record:b')] }, { ...valid, records: [{ ...valid.records[0], durationMs: -1 }] }, { ...valid, records: [{ ...valid.records[0], apiKey: 'fixture-secret' }] }]) assert.throws(() => normalizeHistoryPage(invalid));
});

test('a delayed response from the previous project cannot repopulate the current history view', async () => {
  const root = dom(); let releaseA; let signalA;
  const viewer = new AgentHistoryViewer(root, {
    query(projectId, _cursor, signal) { if (projectId === 'project:a') { signalA = signal; return new Promise(resolve => { releaseA = resolve; }); } return Promise.resolve(page(projectId, 'record:b')); },
    async detail() { throw new Error('not opened'); },
  });
  viewer.setProject('project:a'); viewer.setProject('project:b'); await settled();
  assert.equal(signalA.aborted, true); assert.ok(find(root, node => node.dataset.recordId === 'record:b'));
  releaseA(page('project:a', 'record:a')); await settled();
  assert.equal(find(root, node => node.dataset.recordId === 'record:a'), null);
  viewer.setProject(null); assert.match(root.textContent, /打开项目/); assert.equal(find(root, node => node.dataset.recordId), null);
  viewer.dispose();
});

test('history pages and expanded details display types, timing and complete parameters/results as plain text', async () => {
  const root = dom(); const requests = []; const payload = '<img src=x onerror=alert(1)>'.repeat(400);
  const viewer = new AgentHistoryViewer(root, {
    async query(projectId, cursor) { requests.push(cursor); return cursor ? page(projectId, 'record:second') : page(projectId, 'record:first', 'cursor:next'); },
    async detail(projectId, id) { return { schemaVersion: 1, projectId, record: record(projectId, id), data: { parameters: { text: payload }, result: { value: 42 } } }; },
  });
  viewer.setProject('project:a'); await settled();
  const first = find(root, node => node.dataset.recordId === 'record:first'); first.open = true; first.fire('toggle'); await settled();
  assert.match(first.textContent, /tool-result.*scene.query/); assert.match(first.textContent, /37 ms/);
  assert.ok(first.textContent.includes(payload)); assert.match(first.textContent, /"value": 42/); assert.equal(find(first, node => node.tag === 'img'), null);
  find(root, node => node.tag === 'button' && node.textContent === '下一页').fire('click'); await settled();
  assert.ok(find(root, node => node.dataset.recordId === 'record:second')); assert.deepEqual(requests, [undefined, 'cursor:next']);
  find(root, node => node.tag === 'button' && node.textContent === '上一页').fire('click'); await settled();
  assert.ok(find(root, node => node.dataset.recordId === 'record:first')); viewer.dispose();
});

test('cancelled tool history distinguishes preserved confirmation pauses from actual cancellations without rewriting raw data', async () => {
  const root = dom(); const requests = [];
  const records = ['tool-call', 'tool-result', 'tool-result'].map((kind, index) => ({ ...record('project:a', `record:${index}`), kind, status: 'cancelled', toolId: 'studio.plan.propose' }));
  const viewer = new AgentHistoryViewer(root, {
    async query(projectId) { return { ...page(projectId, 'record:0'), records, total: records.length }; },
    async detail(projectId, id) {
      requests.push(id);
      return { schemaVersion: 1, projectId, record: records.find(record => record.id === id), data: { result: { status: 'cancelled', value: id === 'record:2' ? { code: 'tool.cancelled' } : { code: 'barrier.waiting-user', preserved: true, barrierKind: 'plan-review' } } } };
    },
  });
  viewer.setProject('project:a'); await settled();
  for (const id of ['record:0', 'record:1']) {
    const item = find(root, node => node.dataset.recordId === id);
    assert.match(find(item, node => node.tag === 'summary').textContent, /已挂起（等待确认）/);
    item.open = true; item.fire('toggle'); await settled();
    assert.match(item.textContent, /进度已保存/); assert.match(item.textContent, /"status": "cancelled"/);
  }
  assert.match(find(find(root, node => node.dataset.recordId === 'record:2'), node => node.tag === 'summary').textContent, /已取消/);
  assert.equal(requests.length, 3); viewer.dispose();
});

test('cancelled history detail from a previous project is discarded and failed reads can retry on expansion', async () => {
  const root = dom(); let releaseOld; let oldSignal; let attempts = 0;
  const viewer = new AgentHistoryViewer(root, {
    async query(projectId) { const result = page(projectId, `record:${projectId}`); return { ...result, records: [{ ...result.records[0], status: 'cancelled' }] }; },
    detail(projectId, id, signal) {
      if (projectId === 'project:a') { oldSignal = signal; return new Promise(resolve => { releaseOld = resolve; }); }
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('Read temporarily unavailable')) : Promise.resolve({ schemaVersion: 1, projectId, record: record(projectId, id), data: { result: { status: 'cancelled', value: { code: 'barrier.waiting-user', preserved: true } } } });
    },
  });
  viewer.setProject('project:a'); await settled(); viewer.setProject('project:b'); await settled();
  releaseOld({ schemaVersion: 1, projectId: 'project:a', record: record('project:a', 'record:project:a'), data: { result: 'old result' } }); await settled();
  assert.equal(oldSignal.aborted, true); assert.equal(root.textContent.includes('old result'), false);
  const item = find(root, node => node.dataset.recordId === 'record:project:b');
  assert.match(item.textContent, /Read temporarily unavailable/);
  item.open = true; item.fire('toggle'); await settled();
  assert.equal(attempts, 2); assert.match(item.textContent, /已挂起（等待确认）/); viewer.dispose();
});

function dom() {
  const document = { createElement: tag => new Element(tag) };
  class Element {
    constructor(tag) { this.tag = tag; this.ownerDocument = document; this.children = []; this.dataset = {}; this.events = new Map(); this.text = ''; }
    set textContent(value) { this.text = value ?? ''; this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.text = ''; this.children = nodes; }
    addEventListener(type, callback) { this.events.set(type, callback); }
    fire(type) { this.events.get(type)?.(); }
  }
  return new Element('root');
}
function find(node, predicate) { if (predicate(node)) return node; for (const child of node.children) { const result = find(child, predicate); if (result) return result; } return null; }
async function settled() { await new Promise(resolve => setImmediate(resolve)); }
