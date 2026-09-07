import assert from 'node:assert/strict';

/** Provider edges are simulated; backend adapters, context, budget, host and durable replay are real. */
export class ProviderFixture {
  constructor(kind) {
    this.kind = kind; this.sessionId = `session:discovery-${kind}`; this.turnId = `turn:discovery-${kind}`;
    this.queue = new AsyncQueue(); this.lines = this.queue; this.pending = new Map(); this.toolIds = []; this.wireNames = new Map(); this.starts = 0;
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
  }
  launch() {
    this.starts += 1;
    setImmediate(async () => {
      try { await this.program((id, toolId, args) => this.requestTool(id, toolId, args)); this.finished = true; }
      catch (error) { this.error = error; }
      this.finish();
    });
  }
  requestTool(id, toolId, args) {
    assert.ok(this.toolIds.includes(toolId), `provider cannot call unregistered native tool ${toolId}`);
    const result = new Promise(resolve => this.pending.set(id, resolve));
    if (this.kind === 'harness') this.queue.push({ type: 'tool-request', sessionId: this.sessionId, turnId: this.turnId, toolCallId: id, toolId, arguments: args });
    else this.queue.push(JSON.stringify({ id, method: 'item/tool/call', params: { threadId: this.sessionId, turnId: this.turnId, callId: id, tool: this.wireNames.get(toolId), arguments: args } }));
    return result;
  }
  resolveTool(id, result) { const resolve = this.pending.get(id); assert.ok(resolve, `unexpected provider result ${id}`); this.pending.delete(id); resolve(result); }
  finish() {
    if (this.kind === 'harness') { this.queue.push({ type: 'turn-end', sessionId: this.sessionId, turnId: this.turnId, status: this.error ? 'failed' : 'completed', finishReason: this.error ? 'error' : 'stop' }); this.queue.close(); }
    else this.notify('turn/completed', { threadId: this.sessionId, turn: { id: this.turnId, status: this.error ? 'failed' : 'completed', error: null } });
  }
  harnessTransport() {
    const fixture = this;
    const capabilities = { maxInputTokens: null, nativeCompaction: false, parallelToolCalls: false, codeMode: false, providerUsage: 'reported', providerCache: 'reported', nativeCompactionTransport: 'unavailable', nativeCompactionMirror: 'fallback-required', diagnostic: { code: 'harness.compaction-driver-unavailable', message: 'Unavailable in fixture' } };
    return { upstream: { tag: 'dsh-v0.1.0-rc.7', commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca' }, configured: async () => true,
      modelCatalog: () => [{ id: 'deepseek-v4-flash', name: 'Fixture', description: 'Fixture', maxTokens: 384000 }], sessionCapabilities: () => capabilities,
      confirmSessionBoundary: async () => {}, inspectSession: async () => ({ state: 'available', sessionId: fixture.sessionId, model: 'deepseek-v4-flash', lastConfirmedOpId: null }),
      async *start(input) { fixture.toolIds = input.tools.map(tool => tool.id); yield { type: 'turn-start', sessionId: fixture.sessionId, turnId: fixture.turnId }; fixture.launch(); yield* fixture.queue; },
      submitToolResult: async (id, result) => fixture.resolveTool(id, result), cancel: async () => fixture.finish(), dispose: async () => fixture.queue.close(),
    };
  }
  async write(line) {
    const frame = JSON.parse(line);
    if (!frame.method) {
      if (frame.error) { this.error = new Error(frame.error.message); this.finish(); return; }
      this.resolveTool(frame.id, JSON.parse(frame.result.contentItems[0].text)); return;
    }
    if (!('id' in frame)) return;
    switch (frame.method) {
      case 'initialize': this.result(frame.id, {}); break;
      case 'account/read': this.result(frame.id, { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: false }); break;
      case 'account/rateLimits/read': this.result(frame.id, { rateLimits: null }); break;
      case 'model/list': this.result(frame.id, { data: [{ model: 'gpt-5.6-sol', displayName: 'Fixture', isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] }); break;
      case 'thread/start':
        for (const tool of frame.params.dynamicTools) { const id = tool.description.split('Studio tool id: ').at(-1); this.toolIds.push(id); this.wireNames.set(id, tool.name); }
        this.result(frame.id, { thread: { id: this.sessionId } }); break;
      case 'turn/start': this.result(frame.id, { turn: { id: this.turnId } }); this.launch(); break;
      case 'thread/read': this.result(frame.id, { thread: { id: this.sessionId, canAcceptDirectInput: true } }); break;
      case 'thread/unsubscribe': this.result(frame.id, { status: 'notLoaded' }); break;
      case 'turn/interrupt': this.result(frame.id, {}); this.finish(); break;
      default: throw new Error(`Unexpected RPC ${frame.method}`);
    }
  }
  result(id, result) { this.queue.push(JSON.stringify({ id, result })); }
  notify(method, params) { this.queue.push(JSON.stringify({ method, params })); }
  async dispose() { this.queue.close(); this.resolveExit({ code: 0, signal: null }); }
}

class AsyncQueue {
  values = []; readers = []; closed = false;
  push(value) { const reader = this.readers.shift(); if (reader) reader({ value, done: false }); else this.values.push(value); }
  close() { this.closed = true; for (const reader of this.readers.splice(0)) reader({ done: true }); }
  [Symbol.asyncIterator]() { return this; }
  next() { if (this.values.length) return Promise.resolve({ value: this.values.shift(), done: false }); if (this.closed) return Promise.resolve({ done: true }); return new Promise(resolve => this.readers.push(resolve)); }
}
export function nodes(host) { return host.replay().events.map(event => event.node); }
export async function waitFor(predicate) { for (let count = 0; count < 1500; count += 1) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Timed out waiting for discovery integration'); }
