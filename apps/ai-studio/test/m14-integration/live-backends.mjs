import assert from 'node:assert/strict';
import { mkdir, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CodexAppServerBackend, HarnessApiKeyBackend } from '@haiyue/ai-studio-agent-backends';
import { AgentGameAuthoringCoordinator } from '@haiyue/ai-studio-game-authoring-tools';
import { createHarnessStudioRoot } from '@haiyue/ai-studio-harness-bridge';
import { createPinnedHarnessAgentTransport } from '@haiyue/ai-studio-harness-bridge/agent';
import { behaviorFixture } from '../../../../packages/game-authoring-tools/test/behavior-fixture.mjs';
import { createWorkspaceBehaviorPorts } from '../../dist/behavior-adapters.js';
import { collectPackages, inputBinding } from '../../../../scripts/m14-capability-census.mjs';

if (process.env.HAIYUE_M14_ALLOW_REAL !== '1') throw Error('M14 online verification requires HAIYUE_M14_ALLOW_REAL=1.');
const probe = process.argv.includes('--probe'), output = new URL(`./test-output/${probe ? 'live-probe' : 'live'}/`, import.meta.url);
const secret = process.env.HAIYUE_STUDIO_DEEPSEEK_SECRET || process.env.DEEPSEEK_API_KEY;
delete process.env.HAIYUE_STUDIO_DEEPSEEK_SECRET; delete process.env.DEEPSEEK_API_KEY;
if (!secret) throw Error('DeepSeek credential is unavailable.');
const before = await inputBinding(await collectPackages());
await mkdir(output, { recursive: true });
const reports = [];
const digest = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
for (const kind of ['harness', 'codex']) {
  const owner = createHarnessStudioRoot(); let source;
  const f = await behaviorFixture({ declarative: true, script: 'if (time > 0.1) { api.debug.log("integration event"); }', runtimeOptions: { behaviorSource: signal => source.readSource(signal) } });
  source = createWorkspaceBehaviorPorts(f.workspace, f.operationLog);
  const backend = kind === 'harness'
    ? new HarnessApiKeyBackend({ transport: await createPinnedHarnessAgentTransport({ owner, resolveApiKey: async () => secret }), clearApiKey: async () => {} })
    : new CodexAppServerBackend();
  const calls = [], approvals = []; let coordinator;
  const started = performance.now();
  try {
    const status = await backend.status(); assert.equal(status.state, 'ready', `${kind} backend is not ready`);
    const catalog = await backend.modelCatalog(), model = catalog.models.find(m => m.isDefault) ?? catalog.models[0]; assert.ok(model);
    console.log(`[m14-live] ${kind} ready; model ${model.id}`);
    const config = { schemaVersion: 2, backendId: backend.descriptor.id, model: model.id,
      reasoningEffort: model.reasoningEfforts.includes('low') ? 'low' : model.defaultReasoningEffort,
      outputTokenLimit: Math.min(8192, model.maxOutputTokens), taskBudgetId: 'budget:m14-integration',
      promptProfile: { id: 'prompt:m14-integration', version: '1.0.0', digest: digest('m14-integration/1') },
      requestedCapabilities: ['agent.model-config', 'agent.usage', 'agent.cache', 'agent.context'] };
    coordinator = new AgentGameAuthoringCoordinator(f.runtime, { request: async (preparation, approval) => {
      assert.equal(preparation.toolId, 'entity.rename'); assert.equal(preparation.baseRevision, f.workspace.gameSnapshot().revision);
      approvals.push({ preparationId: preparation.id, approvalId: approval.approvalId, argumentsDigest: approval.argumentsDigest, previewDigest: approval.previewDigest, baseRevision: approval.baseRevision }); return 'allow-once';
    } }, undefined, { maxToolRequests: 20, maxRepeatedToolRequests: 3, maxNoProgressToolRequests: 18, maxModelToolResultBytes: 48 * 1024,
      modelToolIds: ['project.snapshot', 'tool.search', 'studio.tool.invoke', 'entity.rename'] });
    const prompt = 'Perform this bounded editor integration task using only Studio tools. Read the current project and find its Controller entity. Discover behavior.query and asset.dependencies with tool.search, then invoke both through studio.tool.invoke using their returned schemas and the current document revision. Rename the Controller to Integrated Controller through entity.rename. Read the project again and query behavior again at the new exact revision. Summarize which behavior comes from script and which from components or adapters; keep unknown relationships explicit. Do not create entities, change scripts, start Play, use shell, or access external resources. Complete the actual tool calls before giving the summary.';
    const result = await coordinator.run(backend, { taskId: 'task:m14-integration', config, prompt }, event => {
      if (event.kind === 'tool-request') calls.push({ toolId: event.payload.toolId, arguments: event.payload.arguments });
    }, AbortSignal.timeout(240_000));
    assert.equal(result.terminal, 'completed', JSON.stringify(result.diagnostics));
    for (const id of ['project.snapshot', 'tool.search', 'behavior.query', 'asset.dependencies', 'entity.rename']) assert.ok(result.results.some(r => r.toolId === id && r.status === 'completed'), `${kind} did not execute ${id}`);
    assert.ok(calls.some(c => c.toolId === 'studio.tool.invoke' && c.arguments?.toolId === 'behavior.query'));
    assert.equal(f.workspace.gameSnapshot().entities.find(e => e.id === f.entityId).name, 'Integrated Controller');
    assert.equal(approvals.length, 1);
    const behaviorResults = result.results.filter(r => r.toolId === 'behavior.query'); assert.ok(behaviorResults.length >= 2);
    assert.notEqual(behaviorResults[0].afterRevision, behaviorResults.at(-1).afterRevision);
    await f.workspace.save(); await f.operationLog.flush();
    const report = { backend: kind, transport: 'real-online', model: model.id, inputDigest: before.digest, durationMs: Math.round(performance.now() - started), calls, approvals, result };
    reports.push(report); await writeFile(new URL(`${kind}.json`, output), JSON.stringify(report, null, 2) + '\n');
    await cp(path.join(f.directory, 'log'), new URL(`${kind}-journal/`, output), { recursive: true });
    console.log(`[m14-live] ${kind}: ${result.results.length} results; exact rename and discovered behavior/resource invocation passed`);
  } finally { coordinator?.dispose(); await backend.dispose(); await owner.dispose(); await source.reader.dispose(); await f.close(); }
}
if (!probe) assert.equal((await inputBinding(await collectPackages())).digest, before.digest, 'Source changed during online verification.');
await writeFile(new URL('checks.json', output), JSON.stringify({ schemaVersion: 1, evidenceClass: probe ? 'diagnostic' : 'current-frozen-integration', inputDigest: before.digest, verifiedAt: new Date().toISOString(), passed: reports.length, reports: reports.map(r => ({ backend: r.backend, model: r.model, durationMs: r.durationMs, file: `${r.backend}.json` })) }, null, 2) + '\n');
