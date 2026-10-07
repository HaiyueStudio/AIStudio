// Validation prototype: this is NOT mounted in the product. A real admit implementation
// must use the existing Tool Host, TaskAccount/UsageLedger and durable request receipts.
import { MessagePort } from 'node:worker_threads';
import { ClientLLMSchema } from '@browserbasehq/stagehand';

export function inferenceGateway(port, { admit, maxRequests = 4, maxInputBytes = 131072, maxOutputTokens = 1024 }) {
  let active, closed = false;
  const pending = new Set();
  const validated = ClientLLMSchema.parse({ generate: async params => {
    const owner = active;
    if (!owner || closed) throw new Error('stagehand.operation-unowned');
    owner.controller.signal.throwIfAborted();
    if (++owner.ordinal > maxRequests) throw new Error('stagehand.request-limit');
    const inputBytes = Buffer.byteLength(JSON.stringify(params));
    if (inputBytes > maxInputBytes) throw new Error('stagehand.input-limit');
    const request = Object.freeze({ callId: owner.callId, requestId: `${owner.callId}:${owner.ordinal}`, inputBytes, maxOutputTokens });
    const permit = await admit(request, owner.controller.signal);
    let usage = null, status = 'failed';
    try {
      owner.controller.signal.throwIfAborted();
      const result = await permit.generate(params, { signal: owner.controller.signal, maxOutputTokens });
      // Missing usage is unknown, even though the SDK's operation aggregate defaults it to 0.
      const u = result?.usage;
      if (u && ['inputTokens', 'outputTokens', 'totalTokens'].every(k => Number.isSafeInteger(u[k]) && u[k] >= 0)
        && u.totalTokens === u.inputTokens + u.outputTokens
        && ['cachedInputTokens','reasoningTokens'].every(k => u[k] === undefined || Number.isSafeInteger(u[k]) && u[k] >= 0)
        && (u.cachedInputTokens ?? 0) <= u.inputTokens && (u.reasoningTokens ?? 0) <= u.outputTokens) usage = u;
      if (!usage) throw new Error('stagehand.usage-unavailable');
      if (usage.outputTokens > maxOutputTokens) throw new Error('stagehand.output-limit-exceeded');
      owner.controller.signal.throwIfAborted();
      const checked = await ClientLLMSchema.parse({ generate: async () => result }).generate(params);
      status = 'completed';
      return checked;
    } finally {
      if (owner.controller.signal.aborted) status = 'cancelled';
      // This happens after the provider finishes, including a late result after cancellation.
      await permit.settle({ requestId: request.requestId, usage, status });
    }
  } });
  const receive = raw => {
    if (!(raw?.reply instanceof MessagePort)) return;
    const task = (async () => {
      try { raw.reply.postMessage({ ok: true, value: await validated.generate(raw.params) }); }
      catch { raw.reply.postMessage({ ok: false }); }
      finally { raw.reply.close(); }
    })();
    pending.add(task); task.catch(() => {}).finally(() => pending.delete(task));
  };
  port.on('message', receive);
  return {
    async run(callId, signal, operation) {
      if (closed || active) throw new Error('stagehand.operation-unavailable');
      signal.throwIfAborted();
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal.addEventListener('abort', cancel, { once: true });
      active = { callId, controller, ordinal: 0 };
      try { return await operation(); }
      finally {
        controller.abort();
        await Promise.allSettled([...pending]);
        signal.removeEventListener('abort', cancel); active = undefined;
      }
    },
    async close() {
      closed = true; active?.controller.abort();
      await Promise.allSettled([...pending]); port.off('message', receive); port.close();
    },
  };
}
