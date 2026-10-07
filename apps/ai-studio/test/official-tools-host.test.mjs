import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { officialFixture, officialBinding } from '../../../packages/harness-bridge/test/fixtures/official-tools.mjs';
import { response, results, resultText } from '../../../packages/harness-bridge/test/fixtures/messages.mjs';
import { behaviorFixture } from '../../../packages/game-authoring-tools/test/behavior-fixture.mjs';
import { HarnessApiKeyBackend } from '@haiyue/ai-studio-agent-backends';
import { AgentBackendRegistry, AgentTurnRuntime, DurableSessionRuntime, PromptContextRuntime, TaskAccountingRegistry } from '@haiyue/ai-studio-agent-runtime';
import { StudioConversationHost } from '@haiyue/ai-studio-agent-orchestration';
import { normalizeConversationNode } from '@haiyue/ai-studio-shell/conversation';

for (const mode of ['read','approve','reject','budget','cancel','auxiliary','auxiliary-budget','deduplicate','deduplicate-off','oversized']) test(`official native tool through real Host: ${mode}`, { timeout: 30000 }, async t => {
  const entered = Promise.withResolvers(); let drained = false;
  const deduplicate = mode.startsWith('deduplicate');
  const external = ['approve','reject','oversized'].includes(mode);
  const toolId = deduplicate ? 'official.web.fetch' : mode.startsWith('auxiliary') ? 'official.web.search' : 'official.fixture.read';
  const binding = officialBinding(external ? 'external-side-effect' : 'observe'); binding.definition.id = toolId; if (deduplicate) binding.definition.maxResultBytes = 65536;
  const bridge = await officialFixture({ binding, async execute(args, exec) {
    entered.resolve();
    if (mode === 'cancel') {
      await new Promise(resolve => { if (exec.signal.aborted) resolve(); else exec.signal.addEventListener('abort', resolve, { once: true }); });
      await delay(10); drained = true;
    }
    if (mode === 'oversized') return { value: 'Created resource 42; Bearer SECRET_CANARY ' + 'x'.repeat(6000) };
    return deduplicate ? { value: args.query, status:'completed',url:'https://example.com',content:'bounded evidence '.repeat(900),retrievedAt:'2026-10-06',untrusted:true } : { value: args.query };
  } });
  const f = await behaviorFixture({ runtimeOptions: { officialTools: bridge.port } });
  const log = f.operationLog, backend = new HarnessApiKeyBackend({ transport: bridge.transport, clearApiKey: async () => {} });
  const registry = new AgentBackendRegistry(); registry.register(backend);
  const context = new PromptContextRuntime(log), sessions = new DurableSessionRuntime(log), turns = new AgentTurnRuntime(registry, log, context, sessions);
  const accounting = new TaskAccountingRegistry(turns.usage);
  const host = new StudioConversationHost({ runtime: { registry, turns, context, sessions, usage: turns.usage, accounting: accounting }, tools: f.runtime, operationLog: log, compactToolResults: mode !== 'deduplicate-off',
    isProjectOpen: () => true, projectContext: () => { const d = f.workspace.snapshot().document; return { projectId: d.projectId, documentId: d.documentId, revision: d.revision, manifest: {} }; } });
  t.after(async () => { await host.dispose(); await turns.dispose(); await sessions.dispose(); await bridge.owner.dispose(); await f.close(); });
  let requests = 0, finalResult, provenance;
  const originalRevision = f.workspace.snapshot().document.revision;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); requests++;
    assert.ok(body.tools.every(tool => tool.name !== 'fixture_read'));
    if (requests > 2) {
      finalResult = JSON.parse(resultText(results(body).at(-1)));
      if (deduplicate) {
        const first=JSON.parse(resultText(results(body).at(-2)));
        if (mode==='deduplicate') {
          assert.equal(first.projection,'artifact-summary');
          assert.ok(['artifact-summary','retained-reference'].includes(finalResult.projection));
          const [raw, original]=await Promise.all([log.readArtifact(finalResult.artifactRef.id),log.readArtifact(first.artifactRef.id)]);
          assert.equal(raw.value.value.content,original.value.value.content);
          assert.equal(raw.value.value.content,'bounded evidence '.repeat(900));
          assert.ok(JSON.stringify(first).length < JSON.stringify(raw.value).length/2);
          const page=await host.resultArtifacts.read({artifactId:first.artifactRef.id,offset:0,length:128},host.resultScope(host.active.sessionId,host.active.turnId));
          assert.equal(page.nextOffset,128);
        } else { assert.ok(first.value.content);assert.equal(finalResult.value.content,first.value.content); }
      }
      return response({ text: 'Bounded operation finished.' });
    }
    let id, args;
    if (requests === 1) {
      id = external ? 'studio.plan.propose' : 'tool.search';
      args = external ? { title: 'Official operation', summary: 'One approved external action', assemblies: [], items: [{ label: 'Official operation', details: 'Use the reviewed provider once.' }] } : { text: toolId, includeSchemas: true };
    } else {
      id = 'studio.tool.invoke'; args = { toolId, toolVersion: '1.0.0', arguments: { query: 'evidence' } };
    }
    const tool = body.tools.find(tool => tool.description.endsWith(`Studio tool id: ${id}`)); assert.ok(tool, id);
    return response({ calls: [{ id: `call:official-${requests}`, name: tool.name, arguments: args }, ...(deduplicate && requests===2 ? [{id:'call:official-duplicate',name:tool.name,arguments:args}] : [])] });
  });
  await host.initialize();
  const budget = mode === 'budget' ? { ...host.settings().budget, enforcement: 'hard', limits: { ...host.settings().budget.limits, toolCalls: 1 } } : mode === 'auxiliary-budget' ? { ...host.settings().budget, enforcement: 'hard', limits: { ...host.settings().budget.limits, outputTokens: 1024 } } : host.settings().budget;
  await host.dispatch({ type: 'agent/configure', budget, backendId: backend.descriptor.id, model: 'deepseek-flash', reasoningEffort: 'off', outputTokenLimit: 8192 });
  await host.dispatch({ type: 'conversation/send', backendId: backend.descriptor.id, prompt: external ? 'Perform the official external fixture action with my approval.' : 'Search for and read official.fixture.read; do not edit the project.' });
  const decisions = new Set(); let cancelled = false;
  const end = Date.now() + 15000;
  while (host.replay().busy && Date.now() < end) {
    const nodes = host.replay().events.map(e => e.node);
    for (const node of nodes) {
      if (decisions.has(node.id) || node.status !== 'pending') continue;
      if (node.kind === 'plan') { decisions.add(node.id); await host.dispatch({ type: 'conversation/accept-plan', nodeId: node.id, acceptedItemIds: node.content.items.map(item => item.id), mode: 'approve' }); }
      if (node.kind === 'question' && mode === 'budget') { decisions.add(node.id); await host.dispatch({ type: 'conversation/answer-question', nodeId: node.id, answer: { optionIds: [node.content.options.find(o => o.id.includes('budget-stop')).id] } }); }
      if (node.kind === 'approval') {
        decisions.add(node.id); assert.equal(bridge.stats.bodies, 0);
        assert.equal(normalizeConversationNode(node).content.effect, 'external-side-effect');
        provenance = node.provenance;
        await host.dispatch({ type: 'conversation/resolve-approval', approvalId: node.content.approvalId, decision: mode === 'reject' ? 'reject' : 'allow-once' });
      }
    }
    if (mode === 'cancel' && bridge.stats.bodies && !cancelled) { cancelled = true; const p = nodes.find(n => n.kind === 'tool-call' && n.content.toolId === toolId).provenance; await host.dispatch({ type: 'conversation/cancel', backendId: p.backendId, sessionId: p.sessionId, turnId: p.turnId }); }
    await delay(5);
  }
  assert.equal(host.replay().busy, false, JSON.stringify(host.replay().events.slice(-5)));
  assert.equal(bridge.stats.bodies, ['reject','budget','auxiliary-budget'].includes(mode) ? 0 : mode==='deduplicate-off' ? 2 : 1, JSON.stringify(host.replay().events.slice(-8)));
  assert.equal(f.workspace.snapshot().document.revision, originalRevision);
  const facts = (await log.query({ kinds: ['tool/call-received','tool/execution-completed','tool/execution-skipped','tool/execution-failed','approval/allow-once','approval/reject'], limit: 100 })).events.filter(e => e.payload.toolId === toolId);
  if (mode === 'auxiliary') { assert.equal(accounting.snapshots().at(-1).cost.status, 'unknown'); assert.match(accounting.snapshots().at(-1).cost.explanation, /Auxiliary/); }
  if (mode === 'budget') assert.equal(facts.length, 0, 'Budget rejection precedes tool preparation.');
  else if (mode === 'auxiliary-budget') { assert.equal(facts.filter(e => e.kind === 'tool/execution-completed').length, 0); assert.equal(finalResult.status, 'cancelled'); }
  else {
    assert.equal(facts.filter(e => e.kind === 'tool/call-received').length, mode==='deduplicate-off' ? 2 : 1);
    const received = facts.find(e => e.kind === 'tool/call-received'); provenance ??= received.correlation;
    const replay = await (await sessions.open(provenance.sessionId)).snapshot();
    const started = replay.ops.filter(op => op.kind === 'tool.started' && op.payload.toolId === toolId);
    assert.equal(started.length, deduplicate ? 2 : 1);
    assert.equal(replay.ops.filter(op => op.kind === 'document.committed').length, 0);
    if (mode === 'cancel') { assert.equal(drained, true); assert.equal(facts.filter(e => e.kind === 'tool/execution-completed').length, 0); }
    else if (mode === 'oversized') {
      assert.equal(finalResult.status,'failed');assert.equal(finalResult.error.code,'official.result-unavailable');
      assert.equal(finalResult.error.retryable,false);const receipt=finalResult.error.details.executionReceipt;
      assert.equal(receipt.execution,'completed');assert.equal(receipt.delivery,'unavailable');assert.ok(receipt.artifactRef.id);
      assert.doesNotMatch(JSON.stringify(finalResult),/SECRET_CANARY/);
      assert.equal(facts.filter(e=>e.kind==='tool/execution-completed').length,0);
      assert.ok((await log.readArtifact(receipt.artifactRef.id)).value.preview);
    } else assert.equal(finalResult.status, mode === 'reject' ? 'rejected' : 'completed', JSON.stringify(finalResult));
  }
});
