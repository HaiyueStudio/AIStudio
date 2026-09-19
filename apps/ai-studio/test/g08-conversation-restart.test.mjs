import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { ConversationProjector } from '@haiyue/ai-studio-shell';
import { StudioConversationHost } from '@haiyue/ai-studio-agent-orchestration';
import { TaskAccountingRegistry, UsageLedgerStore } from '@haiyue/ai-studio-agent-runtime';

const backendId = 'backend:g08-restart';
const sessionId = 'session:g08-restart';
const turnId = 'turn:g08-restart';

test('durable conversation artifacts reproduce the same final projection after an app restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g08-restart-'));
  try {
    const firstLog = await openLog(root);
    const firstHost = new StudioConversationHost({ runtime: runtimeFixture(), tools: toolsFixture(), operationLog: firstLog });
    await firstHost.initialize();
    await firstHost.dispatch({ type: 'conversation/send', backendId, prompt: 'Build a neutral fixture game.' });
    await waitFor(() => firstHost.replay().busy === false);
    const live = new ConversationProjector().reset(firstHost.replay()).nodes;
    assert.ok(live.some((node) => node.kind === 'text' && node.content.text === 'Restart-safe response.'), JSON.stringify(live));
    await firstHost.dispose();
    await firstLog.close();

    const reopenedLog = await openLog(root);
    const restartedHost = new StudioConversationHost({ runtime: runtimeFixture(), tools: toolsFixture(), operationLog: reopenedLog });
    await restartedHost.initialize();
    const replayed = new ConversationProjector().reset(restartedHost.replay()).nodes;
    const restartedBusy = restartedHost.replay().busy;
    await restartedHost.dispose();
    await reopenedLog.close();
    assert.deepEqual(replayed, live);
    assert.equal(restartedBusy, false);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('secret-shaped conversation text is redacted before durable artifacts reach disk', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'haiyue-g08-secret-'));
  const canary = 'sk-G08SecretCanary123456789';
  try {
    const log = await openLog(root);
    const host = new StudioConversationHost({ runtime: runtimeFixture(canary), tools: toolsFixture(), operationLog: log });
    await host.initialize();
    await host.dispatch({ type: 'conversation/send', backendId, prompt: `Do not persist ${canary}` });
    await waitFor(() => host.replay().busy === false);
    await host.dispose();
    await log.close();
    assert.doesNotMatch(await readTree(root), new RegExp(canary, 'u'));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

function runtimeFixture(response = 'Restart-safe response.') {
  const backend = {
    descriptor: { id: backendId, kind: 'harness-api-key', protocolVersion: 'fixture', capabilities: {} },
    async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture', description: 'fixture', reasoningEfforts: ['low'], defaultReasoningEffort: 'low', maxOutputTokens: 4096, isDefault: true }] }; },
    async status() { return { state: 'ready', authMode: 'api-key', rateLimits: [] }; },
    async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async submitToolResult() {}, async answerQuestion() {}, async resolveBackendApproval() {}, async dispose() {},
  };
  return {
    context: { prompts: { profile: { id: 'prompt:g08', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, modules: [] } }, async prepare({ request }) { return { prompt: request, promptDigest: `sha256:${'b'.repeat(64)}`, promptProfile: this.prompts.profile, contextArtifactIds: [], contextDigest: `sha256:${'c'.repeat(64)}`, cache: { localArtifactHits: 0, localArtifactMisses: 0, deltaReuseBytes: 0, providerCacheEligibleBytes: 0, providerReportedHitTokens: null } }; }, async commit() {} },
    registry: { descriptors: () => [backend.descriptor], get: () => backend },
    accounting: new TaskAccountingRegistry(new UsageLedgerStore()),
    turns: { async *start() { yield event('status', { status: 'running' }); yield event('conversation-node', { status: 'streaming', delta: response }); yield event('completed', { status: 'completed' }); }, async *resume() {}, async cancel() {}, async recordToolResult() {} },
  };
}

function toolsFixture() { return { definitions: () => [] }; }
function event(kind, payload) { return { schemaVersion: 1, backendId, sessionId, turnId, kind, payload }; }
function openLog(root) { return OperationLog.open({ rootDirectory: root, appVersion: 'g08-test', flushPolicy: 'always' }); }
async function readTree(root) { const values = []; for (const entry of await readdir(root, { withFileTypes: true })) { const target = path.join(root, entry.name); if (entry.isDirectory()) values.push(await readTree(target)); else values.push(await readFile(target, 'utf8')); } return values.join('\n'); }
async function waitFor(predicate) { for (let index = 0; index < 200; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error('Timed out waiting for G08 fixture state.'); }
