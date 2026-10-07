import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Worker, MessageChannel } from 'node:worker_threads';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { StagehandClientCreateConfigSchema, ClientLLMSchema, localBrowser } from '@browserbasehq/stagehand';
import { patchWorker } from './patch-worker.mjs';
import { inferenceGateway } from './host-gateway.mjs';
import { clientModel } from './client-model.mjs';
const manifest = JSON.parse(await readFile(new URL('./upstream-review.json', import.meta.url), 'utf8'));
const upstream = await readFile(new URL('./native-worker.js.txt', import.meta.url), 'utf8');
const usage = { inputTokens: 101, outputTokens: 7, totalTokens: 108, cachedInputTokens: 30, reasoningTokens: 2 };
const response = data => ({ role: 'assistant', content: { type: 'text', text: JSON.stringify(data) }, outputFormat: 'json_schema', structuredContent: data, usage });
const prompt = { messages: [{ role: 'user', content: { type: 'text', text: 'fixture' } }], responseFormat: { type: 'json_schema', name: 'Fixture', schema: { type: 'object' } } };

test('installed SDK artifacts match reviewed release hashes', async () => {
  const base = new URL('../', import.meta.resolve('@browserbasehq/stagehand'));
  for (const [path, expected] of Object.entries(manifest.sdkFiles)) {
    assert.equal(createHash('sha256').update(await readFile(new URL(path, base))).digest('hex'), expected, path);
  }
});

test('fixed SDK exposes ClientLLM and rejects obsolete v3 llmClient; patch rejects source drift', () => {
  assert.equal(StagehandClientCreateConfigSchema.safeParse({ model: { generate: async () => response({}) } }).success, true);
  assert.equal(StagehandClientCreateConfigSchema.safeParse({ llmClient: { generate: async () => response({}) } }).success, false);
  assert.throws(() => patchWorker(upstream + '\n', manifest.workerSha256), /worker-drift/);
  assert.match(patchWorker(upstream, manifest.workerSha256), /model: clientModel\(config.inferencePort\)/);
});

test('host rejects unowned/oversized requests and missing usage never becomes zero', async () => {
  const { port1, port2 } = new MessageChannel(); const receipts = []; let generated = 0;
  const gate = inferenceGateway(port1, { maxInputBytes: 1024, admit: async () => ({ generate: async () => { generated++; return { ...response({}), usage: undefined }; }, settle: async r => receipts.push(r) }) });
  const model = ClientLLMSchema.parse(clientModel(port2));
  try {
    await assert.rejects(model.generate(prompt), /inference-unavailable/); assert.equal(generated, 0);
    await assert.rejects(gate.run('oversized', new AbortController().signal, () => model.generate({ ...prompt, systemPrompt: 'x'.repeat(2048) })), /inference-unavailable/); assert.equal(generated, 0);
    await assert.rejects(gate.run('missing', new AbortController().signal, () => model.generate(prompt)), /inference-unavailable/);
    assert.equal(receipts.length, 1); assert.equal(receipts[0].usage, null); assert.equal(receipts[0].status, 'failed');
  } finally { await gate.close(); port2.close(); }
});

test('invalid response and output overrun keep actual usage in failure settlement', async () => {
  for (const change of [{ role: 'invalid' }, { usage: { ...usage, outputTokens: 65, totalTokens: 166 } }]) {
    const { port1, port2 } = new MessageChannel(); const receipts = [];
    const gate = inferenceGateway(port1, { maxOutputTokens: 64, admit: async () => ({ generate: async () => ({ ...response({}), ...change }), settle: async r => receipts.push(r) }) });
    try {
      await assert.rejects(gate.run('invalid', new AbortController().signal, () => clientModel(port2).generate(prompt)), /inference-unavailable/);
      assert.equal(receipts.length, 1); assert.equal(receipts[0].status, 'failed'); assert.ok(receipts[0].usage);
    } finally { await gate.close(); port2.close(); }
  }
});

test('patched official Worker + real extension route inference to Host, retain usage and drain cancellation', { timeout: 120000 }, async t => {
  const chrome = process.env.STAGEHAND_PROBE_CHROME;
  assert.ok(chrome, 'Set STAGEHAND_PROBE_CHROME to a reviewed Chrome for Testing executable.');
  const fixture = createServer((req, res) => { req.resume(); res.end(req.url === '/v1/traces' ? '{}' : '<html><body><h1>Stagehand fixture</h1><button onclick="this.textContent=\'Clicked\'">Check</button></body></html>'); });
  await new Promise(r => fixture.listen(0, '127.0.0.1', r));
  const portFinder = createServer(); await new Promise(r => portFinder.listen(0, '127.0.0.1', r));
  const chromePort = portFinder.address().port; await new Promise(r => portFinder.close(r));
  let browser, worker, gate;
  const requests = [], receipts = []; let mode = 'success', entered, release;
  const workerFile = new URL('./patched-worker.mjs', import.meta.url);
  await writeFile(workerFile, patchWorker(upstream, manifest.workerSha256));
  const { port1, port2 } = new MessageChannel();
  try {
    browser = await localBrowser.launch({ executablePath: chrome, port: chromePort, headless: true, args: ['--disable-background-networking'], acceptDownloads: false });
    gate = inferenceGateway(port1, { maxRequests: 2, maxOutputTokens: 64, admit: async (request, signal) => {
      if (mode === 'deny') throw new Error('fixture.budget-denied');
      requests.push(request);
      return { generate: async (params, options) => {
        assert.equal(options.signal, signal); assert.equal(options.maxOutputTokens, 64);
        assert.equal(params.maxTokens, undefined); assert.equal(params.signal, undefined);
        const name = params.responseFormat.name;
        if (mode === 'cancel') { entered(); await new Promise(r => { release = r; }); }
        if (mode === 'second-fails' && name === 'Metadata') throw new Error('private provider details must not cross Worker');
        let data;
        if (name === 'Observation') data = { elements: [] };
        else if (name === 'Extraction') data = { title: 'Stagehand fixture' };
        else if (name === 'Metadata') data = { completed: true, progress: 'done' };
        else if (name === 'Act') {
          const text = JSON.stringify(params.messages);
          const id = /\[(\d+-\d+)\][^\n]*?button[^\n]*?Check/.exec(text)?.[1];
          assert.ok(id, 'button id must come from actual accessibility snapshot');
          data = { action: { elementId: id, description: 'Check', method: 'click', arguments: [] }, twoStep: false };
        } else assert.fail(`Unexpected inference ${name}`);
        return response(data);
      }, settle: async r => receipts.push(r) };
    } });
    worker = new Worker(workerFile, { workerData: { inferencePort: port2, traceEndpoint: `http://127.0.0.1:${fixture.address().port}/v1/traces`, mode: 'attach', cdpEndpoint: `http://127.0.0.1:${chromePort}`, headless: true, operationTimeoutMs: 10000, shutdownGraceMs: 1000 }, transferList: [port2] });
    const rpc = (method, args = {}) => new Promise((resolve, reject) => {
      const { port1: reply, port2: remote } = new MessageChannel();
      const timer = setTimeout(() => finish(new Error('probe.rpc-timeout')), 15000);
      const fail = () => finish(new Error('probe.worker-exit'));
      const finish = (error, value) => { clearTimeout(timer); reply.close(); worker.off('exit', fail); worker.off('error', fail); error ? reject(error) : resolve(value); };
      worker.once('exit', fail); worker.once('error', fail);
      reply.once('message', r => finish(r.ok ? null : new Error(r.error), r.value));
      worker.postMessage({ method, args, reply: remote }, [remote]);
    });
    const run = (id, method, args, signal = new AbortController().signal) => gate.run(id, signal, () => rpc(method, args));
    const unpack = r => JSON.parse(r.content[0].text);
    await rpc('ready');
    await run('navigate', 'navigate', { url: `http://127.0.0.1:${fixture.address().port}/` });
    await t.test('observe and extract traverse SDK/extension/Worker/Host; aggregate equals individual requests', async () => {
      const observed = unpack(await run('observe', 'observe', { instruction: 'Find buttons' }));
      assert.equal(observed.metadata.usage.inputTokens, 101);
      const extracted = unpack(await run('extract', 'extract', { instruction: 'Read title', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }));
      assert.equal(extracted.metadata.usage.inputTokens, 202); assert.equal(extracted.metadata.usage.cachedInputTokens, 60);
      assert.equal(receipts.length, 3); assert.equal(receipts.reduce((n,r) => n+r.usage.outputTokens,0), 21);
      assert.equal(new Set(requests.map(r => r.requestId)).size, 3);
    });
    await t.test('act uses the same callback and performs a real click', async () => {
      const result = unpack(await run('act', 'act', { instruction: 'Click Check' })); assert.equal(result.data.success, true);
    });
    await t.test('denied admission and forged per-call model cannot bypass Host', async () => {
      const count = requests.length; mode = 'deny';
      await assert.rejects(run('deny', 'observe', { instruction: 'Find buttons' }));
      await assert.rejects(run('override', 'observe', { instruction: 'Find buttons', model: { modelName: 'openai/gpt-4.1', apiKey: 'fixture' } }));
      assert.equal(requests.length, count); mode = 'success';
    });
    await t.test('per-operation request cap bounds repeated internal inference', async () => {
      const count = receipts.length;
      await assert.rejects(gate.run('limit', new AbortController().signal, async () => { for (let i=0;i<3;i++) await rpc('observe',{instruction:'Find buttons'}); }));
      assert.equal(receipts.length-count, 2);
    });
    await t.test('failure of extract second request preserves first request usage and unknown receipt', async () => {
      mode = 'second-fails'; const count = receipts.length;
      await assert.rejects(run('partial', 'extract', { instruction: 'Read title', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }), error => !error.message.includes('private provider'));
      const tail = receipts.slice(count); assert.equal(tail.length, 2); assert.deepEqual(tail[0].usage, usage); assert.equal(tail[1].usage, null); mode = 'success';
    });
    await t.test('cancel uses Host signal, rejects concurrent owner, waits for late provider usage', async () => {
      mode = 'cancel'; let start; const started = new Promise(r => start = r); entered = start;
      const controller = new AbortController(); const count = receipts.length;
      let finished = false;
      const operation = assert.rejects(run('cancel', 'observe', { instruction: 'Find buttons' }, controller.signal)).finally(() => finished = true);
      await started; controller.abort();
      await assert.rejects(run('other', 'observe', { instruction: 'Find buttons' }), /operation-unavailable/);
      await new Promise(r => setImmediate(r)); assert.equal(finished, false); assert.equal(receipts.length, count);
      release(); await operation;
      assert.deepEqual(receipts.at(-1).usage, usage); assert.equal(receipts.at(-1).status, 'cancelled'); mode = 'success';
    });
    await rpc('close');
  } finally {
    release?.(); await gate?.close(); await worker?.terminate(); await browser?.close();
    await new Promise(r => fixture.close(r));
  }
});
