import test from 'node:test';
import assert from 'node:assert/strict';
import { officialFixture } from './fixtures/official-tools.mjs';
import { response } from './fixtures/messages.mjs';
import { harnessToolName } from '../dist/harness-agent.js';

const input = { sessionId: 'session:official', model: 'deepseek-flash', reasoningEffort: 'off', maxTokens: 1024, tools: [], prompt: 'Read official evidence.', lastConfirmedOpId: 'op:official' };
const execution = (id = 'call:official') => ({ callId: id, sessionId: input.sessionId, turnId: 'turn:official', toolId: 'official.fixture.read', arguments: { query: 'evidence' } });

test('native schemas are hidden; only selected Studio wrappers reach the model and execute the full official pipeline once', async t => {
  const f = await officialFixture(); t.after(() => f.owner.dispose());
  const tools = [f.binding.definition]; let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); requests++;
    assert.deepEqual(body.tools.map(tool => tool.name), [harnessToolName(tools[0].id, 0)]);
    return response(requests === 1 ? { calls: [{ id: 'call:official', name: body.tools[0].name, arguments: { query: 'evidence' } }] } : { text: 'Done.' });
  });
  const events = [];
  for await (const event of f.transport.start({ ...input, tools })) {
    events.push(event);
    if (event.type !== 'tool-request') continue;
    assert.equal(f.stats.bodies, 0, 'Body waits for Host authorization.');
    const call = { ...execution(), turnId: event.turnId };
    const value = await f.port.execute(call, new AbortController().signal);
    assert.deepEqual(value, { value: 'evidence' });
    await assert.rejects(f.port.execute(call, new AbortController().signal), /call-consumed/);
    await f.transport.submitToolResult(event.toolCallId, { status: 'completed', value });
  }
  assert.equal(events.at(-1).status, 'completed');
  assert.deepEqual(f.stats, { bodies: 1, results: 1, around: 1, post: 1 });
  assert.equal(requests, 2);
});

test('raw, unknown, nested and schema-drift dispatch cannot bypass the Host', async t => {
  let nested;
  const f = await officialFixture({ async execute(_args, exec, ctx) {
    nested = await ctx.tools.execute({ callId: 'call:nested', name: 'fixture_read', arguments: { query: 'recursive' }, agent: exec.agent, signal: exec.signal });
    return { value: 'outer' };
  } }); t.after(() => f.owner.dispose());
  await f.transport.openSession(input);
  const raw = await f.ctx.tools.execute({ callId: 'call:raw', name: 'fixture_read', arguments: { query: 'raw' }, signal: new AbortController().signal });
  assert.equal(raw.isError, true); assert.equal(f.stats.bodies, 0);
  await f.port.execute(execution(), new AbortController().signal);
  assert.equal(nested.isError, true); assert.equal(f.stats.bodies, 1);
  await assert.rejects(f.port.execute({ ...execution('call:invalid'), arguments: { query: 'x', policy: 'allow' } }, new AbortController().signal), /arguments-invalid/);
  f.unregister();
  await assert.rejects(f.port.execute(execution('call:drift'), new AbortController().signal), /schema-drift/);
});

for (const action of ['cancel', 'closeSession', 'dispose']) test(`${action} drains official work and prevents late success`, { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(); let drained = false;
  const f = await officialFixture({ async execute(_args, exec) {
    entered.resolve();
    await new Promise(resolve => { if (exec.signal.aborted) resolve(); else exec.signal.addEventListener('abort', resolve, { once: true }); });
    await new Promise(resolve => setTimeout(resolve, 10)); drained = true;
    return { value: 'late' };
  } }); t.after(() => f.owner.dispose());
  await f.transport.openSession(input);
  const rejected = assert.rejects(f.port.execute(execution(), new AbortController().signal), /cancelled|disposed/);
  await entered.promise;
  if (action === 'dispose') await f.owner.dispose(); else await f.transport[action](input.sessionId);
  await rejected; assert.equal(drained, true);
  assert.equal(f.stats.bodies, 1);
});

test('official pre/post policies remain authoritative and errors expose no raw provider diagnostics', async t => {
  const f = await officialFixture(); t.after(() => f.owner.dispose());
  await f.transport.openSession(input);
  const reject = f.ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'fixture_read' ? { kind: 'deny', reason: 'Bearer SECRET_CANARY' } : next(), { global: true });
  await assert.rejects(f.port.execute(execution('call:pre-denied'), new AbortController().signal), error => error.message === 'official.execution-failed');
  assert.equal(f.stats.bodies, 0); reject();
  f.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'fixture_read' ? { kind: 'block', reason: 'Bearer SECRET_CANARY' } : next(), { global: true });
  await assert.rejects(f.port.execute(execution('call:post-denied'), new AbortController().signal), error => error.message === 'official.execution-failed');
  assert.equal(f.stats.bodies, 1); assert.equal(f.stats.results, 2);
});

test('nested Studio wrappers from official pre-policy are rejected before they can wait on the Host', async t => {
  const f = await officialFixture(); t.after(() => f.owner.dispose());
  const wrapper = { id: 'scene.query', description: 'Studio read', inputSchema: { type: 'object' } };
  await f.transport.openSession({ ...input, tools: [wrapper] });
  let nested;
  f.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'fixture_read') nested = await f.ctx.tools.execute({ callId: 'call:pre-nested', name: harnessToolName(wrapper.id, 0), arguments: {}, agent: exec.agent, signal: exec.signal });
    return next();
  }, { global: true });
  await f.port.execute(execution(), new AbortController().signal);
  assert.equal(nested.isError, true);
  assert.match(nested.error.message, /official.nested-call-denied/);
  assert.equal(f.stats.bodies, 1);
});

test('oversized native output reports completed execution with a bounded receipt', async t => {
 const f=await officialFixture({async execute(){return {value:'x'.repeat(8000)};}});t.after(()=>f.owner.dispose());
 await f.transport.openSession(input);const receipts=[];let previewSource;
 await assert.rejects(f.port.execute(execution(),new AbortController().signal,async (value,source)=>{receipts.push(value);previewSource=source;}),/result-too-large/);
 assert.equal(f.stats.bodies,1);assert.equal(receipts.length,1);assert.equal(receipts[0].execution,'completed');
 assert.equal(receipts[0].delivery,'unavailable');assert.equal(receipts[0].preview,undefined);assert.equal(previewSource.value.length,8000);
});

test('native policy receipts distinguish preflight refusal from uncertain post-execution effects', async t => {
 const f=await officialFixture();t.after(()=>f.owner.dispose());await f.transport.openSession(input);
 const receipts=[];const report=async value=>{receipts.push(value);};
 const off=f.ctx.on('tools/pre-execute',async(exec,next)=>exec.name==='fixture_read'?{kind:'deny',reason:'blocked'}:next(),{global:true});
 await assert.rejects(f.port.execute(execution('call:pre-receipt'),new AbortController().signal,report));off();
 assert.equal(receipts[0].execution,'not-started');assert.equal(f.stats.bodies,0);
 f.ctx.on('tools/post-execute',async(exec,result,next)=>exec.name==='fixture_read'?{kind:'block',reason:'blocked'}:next(),{global:true});
 await assert.rejects(f.port.execute(execution('call:post-receipt'),new AbortController().signal,report));
 assert.equal(receipts[1].execution,'unknown');assert.equal(f.stats.bodies,1);
});

test('P1 browser model schemas omit unsupported destinations but retain native drift schema', async () => {
 const {createHarnessExtendedTools}=await import('../dist/extended-tools.js');
 for(const backend of ['playwright','chrome-devtools']) {
  const provider=createHarnessExtendedTools({browser:{backend}});
  for(const definition of provider.definitions) {
   assert.equal(definition.inputSchema.additionalProperties,false);
   for(const key of ['filename','filePath','initScript']) assert.equal(definition.inputSchema.properties[key],undefined);
  }
 }
});
