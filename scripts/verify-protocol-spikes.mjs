import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(path.join(root, 'config', 'contracts', 'fixtures', 'determinism.json'), 'utf8'));

function normalizeHarness(raw) {
  if (raw.type === 'turn/start') return { kind: 'status', status: 'running', sessionId: raw.sessionId, turnId: raw.turnId };
  if (raw.type === 'tool/call') return { kind: 'tool-request', sessionId: raw.sessionId, turnId: raw.turnId, toolCallId: raw.callId, toolId: raw.tool };
  if (raw.type === 'tool/result') return { kind: 'tool-result', sessionId: raw.sessionId, turnId: raw.turnId, toolCallId: raw.callId, result: raw.result };
  if (raw.type === 'turn/end') return { kind: 'completed', status: raw.status, sessionId: raw.sessionId, turnId: raw.turnId };
  throw new Error(`unsupported Harness event ${raw.type}`);
}

function normalizeCodex(raw) {
  if (raw.method === 'turn/started') return { kind: 'status', status: 'running', sessionId: raw.params.threadId, turnId: raw.params.turnId };
  if (raw.method === 'dynamicToolCall') return { kind: 'tool-request', sessionId: raw.params.threadId, turnId: raw.params.turnId, toolCallId: raw.params.callId, toolId: raw.params.tool };
  if (raw.method === 'dynamicToolCall/result') return { kind: 'tool-result', sessionId: raw.params.threadId, turnId: raw.params.turnId, toolCallId: raw.params.callId, result: raw.params.result };
  if (raw.method === 'turn/completed') return { kind: 'completed', status: raw.params.status, sessionId: raw.params.threadId, turnId: raw.params.turnId };
  throw new Error(`unsupported Codex event ${raw.method}`);
}

function createRawProtocol(kind, cancelled) {
  const sessionId = fixture.ids.session;
  const turnId = fixture.ids.turn;
  const callId = fixture.ids.toolCall;
  if (kind === 'harness') {
    return [
      { type: 'turn/start', sessionId, turnId },
      { type: 'tool/call', sessionId, turnId, callId, tool: fixture.toolId },
      ...(cancelled ? [] : [{ type: 'tool/result', sessionId, turnId, callId, result: { revision: 0 } }]),
      { type: 'turn/end', sessionId, turnId, status: cancelled ? 'cancelled' : 'completed' },
    ];
  }
  return [
    { method: 'turn/started', params: { threadId: sessionId, turnId } },
    { method: 'dynamicToolCall', params: { threadId: sessionId, turnId, callId, tool: fixture.toolId } },
    ...(cancelled ? [] : [{ method: 'dynamicToolCall/result', params: { threadId: sessionId, turnId, callId, result: { revision: 0 } } }]),
    { method: 'turn/completed', params: { threadId: sessionId, turnId, status: cancelled ? 'cancelled' : 'completed' } },
  ];
}

class FakeBackendScope {
  activeTurns = 0;
  disposeCount = 0;
  documentWrites = 0;
  disposed = false;

  run(kind, cancelled) {
    assert.equal(this.disposed, false);
    this.activeTurns += 1;
    try {
      const normalize = kind === 'harness' ? normalizeHarness : normalizeCodex;
      return createRawProtocol(kind, cancelled).map(normalize);
    } finally {
      this.activeTurns -= 1;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeCount += 1;
    this.activeTurns = 0;
  }
}

for (const cancelled of [false, true]) {
  const harness = new FakeBackendScope();
  const codex = new FakeBackendScope();
  assert.deepEqual(harness.run('harness', cancelled), codex.run('codex', cancelled));
  for (const backend of [harness, codex]) {
    assert.equal(backend.activeTurns, 0);
    assert.equal(backend.documentWrites, 0);
    backend.dispose();
    backend.dispose();
    assert.equal(backend.disposeCount, 1);
  }
}

assert.throws(() => normalizeHarness({ type: 'document/mutate', world: {} }), /unsupported Harness event/);
assert.throws(() => normalizeCodex({ method: 'shell/exec', params: {} }), /unsupported Codex event/);
assert.equal(new Date(fixture.clockStart).toISOString(), fixture.clockStart);
assert.equal(fixture.clockStepMilliseconds, 1);
console.log('[spike] Harness and Codex fake tool/cancel flows normalize identically; teardown is idempotent; Document writes=0');
