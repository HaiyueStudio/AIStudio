import test from 'node:test';
import assert from 'node:assert/strict';
import { behaviorFixture, call } from './behavior-fixture.mjs';
import { officialBinding } from '../../studio-contracts/test/fixtures/official-binding.mjs';
import { classifyToolConcurrency, resolveModelToolInvocation } from '../dist/index.js';

async function fixture(t, effect = 'observe', execute = async () => ({ value: 'evidence' }), runtimeOptions = {}) {
  let bodies = 0;
  const definition = officialBinding(effect).definition;
  const f = await behaviorFixture({ runtimeOptions: { officialTools: { definitions: [definition], async execute(input, signal, receipt) { bodies++; return execute(input, signal, receipt); } }, ...runtimeOptions } });
  t.after(f.close);
  return Object.assign(f, { definition, bodies: () => bodies, prepare: id => f.runtime.prepare(call(id, definition.id, { query: 'evidence' })) });
}

test('official tools share discovery, exact schema/version validation, preparation, approval and durable results', async t => {
  const f = await fixture(t, 'external-side-effect');
  const revision = f.workspace.snapshot().document.revision;
  const search = await f.runtime.prepare(call('call:search', 'tool.search', { text: f.definition.id, includeSchemas: true }));
  const matches = (await f.runtime.execute(search.id)).value.matches;
  assert.equal(matches[0].id, f.definition.id);
  assert.equal(matches[0].requiresApproval, true);
  assert.equal(resolveModelToolInvocation({ toolId: f.definition.id, toolVersion: '1.0.0', arguments: { query: 'evidence' } }, f.runtime.definitions()).toolId, f.definition.id);
  assert.equal(classifyToolConcurrency(f.definition, {}).executionClass, 'unknown-exclusive');
  const prepared = await f.prepare('call:official-allow');
  await assert.rejects(f.runtime.execute(prepared.id), /approval/i); assert.equal(f.bodies(), 0);
  await assert.rejects(f.runtime.decide(prepared.approvalId, 'allow-always'), /allow-once|one|reversible/i);
  await f.runtime.decide(prepared.approvalId, 'allow-once');
  const running = f.runtime.execute(prepared.id);
  await assert.rejects(f.runtime.execute(prepared.id), /already executing/);
  const result = await running;
  assert.equal(result.status, 'completed'); assert.equal(f.bodies(), 1);
  assert.equal(f.workspace.snapshot().document.revision, revision); assert.equal(result.historyLabel, undefined);
  assert.equal((await f.operationLog.query({ kinds: ['tool/execution-completed'], limit: 20 })).events.filter(e => e.payload.toolId === f.definition.id).length, 1);
});

for (const decision of ['reject','cancel']) test(`official ${decision} never reaches provider and cannot be reused`, async t => {
  const f = await fixture(t, 'external-side-effect'); const p = await f.prepare(`call:${decision}`);
  await f.runtime.decide(p.approvalId, decision);
  assert.equal((await f.runtime.execute(p.id)).status, decision === 'cancel' ? 'cancelled' : 'rejected');
  assert.equal(f.bodies(), 0); await assert.rejects(f.runtime.execute(p.id), /missing|consumed/);
});

test('official exact authorization becomes stale after document change and cannot join a Document transaction', async t => {
  const f = await fixture(t, 'external-side-effect'); const p = await f.prepare('call:stale');
  await f.runtime.decide(p.approvalId, 'allow-once');
  await assert.rejects(f.runtime.executeTransaction({ sessionId: p.sessionId, turnId: p.turnId, batchId: 'batch:official', preparationIds: [p.id] }), /not a reversible/);
  const edit = await f.runtime.prepare(call('call:edit', 'entity.create', { baseRevision: p.baseRevision, kind: 'empty', name: 'Changed' }));
  if (edit.approvalId) await f.runtime.decide(edit.approvalId, 'allow-once'); await f.runtime.execute(edit.id);
  await assert.rejects(f.runtime.execute(p.id), /changed after preparation/); assert.equal(f.bodies(), 0);
});

for (const action of ['cancel','timeout','dispose']) test(`official ${action} drains the provider without late success`, async t => {
  const entered = Promise.withResolvers(); let drained = false;
  const f = await fixture(t, 'observe', async (_call, signal) => {
    entered.resolve(); await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    await new Promise(resolve => setTimeout(resolve, 10)); drained = true; return { value: 'late' };
  }, action === 'timeout' ? { timeoutCeilingMs: 1000 } : {});
  const p = await f.prepare(`call:${action}`);
  const rejected = assert.rejects(f.runtime.execute(p.id), /cancel|timeout|exceeded|disposed/i);
  await entered.promise;
  if (action === 'cancel') await f.runtime.cancel(p.callId);
  if (action === 'dispose') await f.runtime.dispose();
  await rejected; assert.equal(drained, true);
  assert.equal((await f.operationLog.query({ kinds: ['tool/execution-completed'], limit: 20 })).events.filter(e => e.payload.toolId === f.definition.id).length, 0);
});

test('official schemas reject forged policy/credentials; outputs are bounded and redacted before delivery', async t => {
  const f = await fixture(t, 'observe', async () => ({ value: 'safe', authorization: 'SECRET_CANARY' }));
  await assert.rejects(f.runtime.prepare(call('call:forged', f.definition.id, { query: 'x', allow: true })), /arguments-invalid/);
  await assert.rejects(f.runtime.prepare(call('call:secret', f.definition.id, { query: 'Bearer SECRET_CANARY' })), /credentials-forbidden/);
  const p = await f.prepare('call:redact'); const r = await f.runtime.execute(p.id);
  assert.equal(r.value.authorization, '[REDACTED]');
  assert.equal(f.bodies(), 1);
});

test('cancelling an official call while queued prevents its body after the prior operation drains', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, 'external-side-effect', async () => { entered.resolve(); await release.promise; return { value: 'first' }; });
  t.after(() => release.resolve());
  const one = await f.prepare('call:queue-one'), two = await f.prepare('call:queue-two');
  await f.runtime.decide(one.approvalId, 'allow-once'); await f.runtime.decide(two.approvalId, 'allow-once');
  const first = f.runtime.execute(one.id); await entered.promise;
  const second = f.runtime.execute(two.id);
  await f.runtime.cancel(two.callId); release.resolve();
  await first; assert.equal((await second).status, 'cancelled'); assert.equal(f.bodies(), 1);
});

test('official log failure releases acquired effect locks without executing the provider', async t => {
  const f = await fixture(t, 'external-side-effect'); const p = await f.prepare('call:log-failure');
  await f.runtime.decide(p.approvalId, 'allow-once');
  const append = f.operationLog.append.bind(f.operationLog);
  t.mock.method(f.operationLog, 'append', async (event, ...args) => { if (event.kind === 'tool/effect-lock-acquired') throw new Error('fixture disk failure'); return append(event,...args); });
  await assert.rejects(f.runtime.execute(p.id), /Log rejected/);
  assert.equal(f.bodies(), 0); assert.equal(f.runtime.snapshot().effectLocks.heldOwners, 0);
});

for (const mode of ['large','error']) test(`official ${mode} output fails safely before model-visible completion`, async t => {
  const f = await fixture(t, 'observe', async () => { if (mode === 'error') throw new Error('Bearer SECRET_CANARY'); return { value: 'x'.repeat(5000) }; });
  const p = await f.prepare(`call:${mode}`);
  await assert.rejects(f.runtime.execute(p.id), /official\.(?:execution-failed|result-invalid)/);
  const logs = await f.operationLog.query({ kinds: ['tool/execution-failed'], limit: 20 });
  assert.doesNotMatch(JSON.stringify(logs), /SECRET_CANARY/);
});

test('official results reject non-JSON values instead of silently converting or dropping them', async t => {
  const f = await fixture(t, 'observe', async () => ({ value: 'evidence', omitted: undefined }));
  const p = await f.prepare('call:non-json');
  await assert.rejects(f.runtime.execute(p.id), /official.result-invalid/);
});

test('official provider failure envelopes become failed Host executions, not completed calls', async t => {
  const f=await fixture(t,'observe',async()=>({value:'',status:'error',code:'WEB_PROVIDER_ERROR'}));
  const p=await f.prepare('call:official-error-envelope');await assert.rejects(f.runtime.execute(p.id),error=>error.code==='WEB_PROVIDER_ERROR');
});

for (const message of ['ReferenceError: missingValue is not defined\n    at scratch.js:1', 'Bearer SECRET_CANARY']) test(`script error diagnostics are bounded and redacted: ${message.startsWith('Bearer') ? 'secret' : 'repairable error'}`, async t => {
  const f = await fixture(t, 'observe', async () => ({ value: '', status: 'error', code: 'official.node.execution-error', message }));
  const p = await f.prepare('call:script-error');
  await assert.rejects(f.runtime.execute(p.id), error => {
    assert.equal(error.code, 'official.node.execution-error');
    assert.doesNotMatch(error.message, /SECRET_CANARY|scratch.js/);
    assert.match(error.message, message.startsWith('Bearer') ? /REDACTED/ : /missingValue is not defined/);
    return true;
  });
});

test('reviewed MCP Draft 2020 schema accepts valid calls and rejects additional arguments', async t => {
  const d=officialBinding().definition;
  const definition={...d,inputSchema:{...d.inputSchema,$schema:'https://json-schema.org/draft/2020-12/schema'}};
  const f=await behaviorFixture({runtimeOptions:{officialTools:{definitions:[definition],async execute(){return {value:'bounded'};}}}});t.after(f.close);
  await assert.rejects(f.runtime.prepare(call('call:invalid-draft',definition.id,{query:'test',filename:'/tmp/no'})),/arguments-invalid/);
  const p=await f.runtime.prepare(call('call:valid-draft',definition.id,{query:'test'}));assert.equal((await f.runtime.execute(p.id)).status,'completed');
});

for (const mode of ['oversized','unsupported','unknown','cancelled']) test(`uncertain external receipt survives recreation and blocks repeat (${mode})`, async t => {
  const { OfficialToolAdapter } = await import('../dist/official-tools.js');
  const controller = new AbortController();
  const f = await fixture(t, 'external-side-effect', async (_input, _signal, receipt) => {
    if (mode === 'oversized') return { value: 'Bearer SECRET_CANARY ' + 'x'.repeat(6000) };
    if (mode === 'unknown') throw new Error('Bearer SECRET_CANARY');
    await receipt({ schemaVersion: 1, execution: 'completed', delivery: 'unavailable', reason: mode === 'cancelled' ? 'cancelled' : 'unsupported-result', preview: 'untrusted rendered text' }, {value:'Created resource 42',authorization:'opaque-provider-value'});
    if (mode === 'cancelled') controller.abort(new Error('cancelled'));
    throw new Error('unsupported output');
  });
  const p = await f.prepare('call:effect-first'); await f.runtime.decide(p.approvalId, 'allow-once');
  await assert.rejects(f.runtime.execute(p.id, controller.signal), error => {
    if (mode === 'cancelled') return /cancel/.test(error.message);
    assert.equal(error.code, 'official.result-unavailable');assert.equal(error.retryable, false);
    assert.ok(error.details.executionReceipt.artifactRef);assert.doesNotMatch(JSON.stringify(error.details), /SECRET_CANARY/);return true;
  });
  const events = (await f.operationLog.query({ kinds: ['official/execution-receipt'], limit: 20 })).events;
  assert.equal(events.length, 1); assert.equal(events[0].payload.receipt.execution, mode === 'unknown' ? 'unknown' : 'completed');
  const artifact = await f.operationLog.readArtifact(events[0].artifactRefs[0]);
  assert.doesNotMatch(JSON.stringify(artifact), /SECRET_CANARY/);
  if (mode !== 'unknown') assert.ok(artifact.value.preview.length <= 8192);
  const adapter = new OfficialToolAdapter({ definitions: [f.definition], async execute() { throw new Error('must not dispatch'); } }, [], f.operationLog);
  await assert.rejects(adapter.execute(f.definition, call('call:effect-retry', f.definition.id, {query:'evidence'}), {query:'evidence'}, new AbortController().signal), error => error.code === 'official.execution-outcome-unresolved');
  assert.equal(f.bodies(), 1);
});

test('successful external calls can be deliberately repeated, and not-started receipts release the guard', async t => {
 const f=await fixture(t,'external-side-effect',async(_input,_signal,receipt)=>{
  if(f.bodies()===1){await receipt({schemaVersion:1,execution:'not-started',delivery:'unavailable',reason:'provider-error'});throw new Error('preflight denied');}
  return {value:'done'};
 });
 for(let i=0;i<3;i++){
  const p=await f.prepare(`call:repeat-${i}`);await f.runtime.decide(p.approvalId,'allow-once');
  if(i===0)await assert.rejects(f.runtime.execute(p.id),/official.execution-failed/);else assert.equal((await f.runtime.execute(p.id)).status,'completed');
 }
 assert.equal(f.bodies(),3);
});

test('a warm receipt index observes subsequently imported unresolved project history', async t => {
 const f=await fixture(t,'external-side-effect');
 const first=await f.prepare('call:warm-index');await f.runtime.decide(first.approvalId,'allow-once');await f.runtime.execute(first.id);
 const dispatched=(await f.operationLog.query({kinds:['official/execution-dispatched'],limit:20})).events[0];
 await f.operationLog.append({kind:'official/execution-dispatched',severity:'info',source:'studio.game-tools',correlation:{...dispatched.correlation,toolCallId:'call:imported-effect'},payload:{...dispatched.payload,receipt:{schemaVersion:1,execution:'unknown',delivery:'unavailable',reason:'provider-error',callId:'call:imported-effect',retryable:false}}});
 const repeat=await f.prepare('call:after-import');await f.runtime.decide(repeat.approvalId,'allow-once');
 await assert.rejects(f.runtime.execute(repeat.id),error=>error.code==='official.execution-outcome-unresolved');assert.equal(f.bodies(),1);
});

test('receipt previews redact original credential keys and configured fields before flattening', async t => {
 const definition={...officialBinding('external-side-effect').definition,redactedFields:['/privateData']};
 const f=await behaviorFixture({runtimeOptions:{officialTools:{definitions:[definition],async execute(_call,_signal,receipt){
  await receipt({schemaVersion:1,execution:'completed',delivery:'unavailable',reason:'oversized-result',preview:'password: opaque-password-value'},
    {value:'Created 42',password:'opaque-password-value',privateData:'opaque-configured-value'});
  throw new Error('output too large');
 }}}});t.after(f.close);
 const p=await f.runtime.prepare(call('call:redacted-receipt',definition.id,{query:'evidence'}));await f.runtime.decide(p.approvalId,'allow-once');
 await assert.rejects(f.runtime.execute(p.id),error=>error.code==='official.result-unavailable');
 const events=(await f.operationLog.query({kinds:['official/execution-receipt'],limit:20})).events;
 assert.doesNotMatch(JSON.stringify(events),/opaque-password-value|opaque-configured-value/);
 const artifact=await f.operationLog.readArtifact(events[0].artifactRefs[0]);
 assert.match(artifact.value.preview,/Created 42/);assert.doesNotMatch(JSON.stringify(artifact),/opaque-password-value|opaque-configured-value/);
});
