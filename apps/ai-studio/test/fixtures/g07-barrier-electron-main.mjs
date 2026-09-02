import { app } from 'electron';
import { DurableSessionRuntime, TaskAccountingRegistry, UsageLedgerStore } from '@haiyue/ai-studio-agent-runtime';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import path from 'node:path';
import { StudioConversationHost } from '../../dist/conversation-host.js';

// This process exercises durable barrier recovery only and owns no BrowserWindow.
// Avoid coupling the restart invariant to availability of the host GPU sandbox.
app.disableHardwareAcceleration();

const root = process.env.HAIYUE_G07_BARRIER_ROOT;
const phase = process.env.HAIYUE_G07_BARRIER_PHASE;
if (!root || !['seed', 'recover'].includes(phase)) throw new Error('HAIYUE_G07_BARRIER_ROOT and a valid phase are required.');
if (process.env.HAIYUE_G07_USER_DATA) app.setPath('userData', process.env.HAIYUE_G07_USER_DATA);

const backendId = 'backend:g07-electron';
const sessionId = 'session:g07-electron';
const turnId = 'turn:g07-electron';
const barriers = Object.freeze([
  Object.freeze({ nodeId: 'node:g07-electron-script', approvalId: 'approval:g07-electron-script', toolCallId: 'call:g07-electron-script', toolId: 'script.apply', effect: 'trusted-code', target: 'script:g07-electron' }),
  Object.freeze({ nodeId: 'node:g07-electron-runtime', approvalId: 'approval:g07-electron-runtime', toolCallId: 'call:g07-electron-runtime', toolId: 'preview.start', effect: 'runtime-start', target: 'runtime:preview:g07-electron' }),
]);

let finished = false;
const deadline = setTimeout(() => finish(1, 'deadline exceeded'), 45_000);

app.whenReady().then(async () => {
  const log = await OperationLog.open({ rootDirectory: path.join(root, 'operation-log'), appVersion: 'g07-electron-test', flushPolicy: 'always' });
  const sessions = new DurableSessionRuntime(log);
  try {
    if (phase === 'seed') {
      const session = await sessions.create({ id: sessionId, projectId: 'project:g07-electron', documentId: 'document:g07-electron', activeGoal: 'recover trusted barriers', taskBudgetId: 'budget:g07-electron' });
      await session.append({ kind: 'turn.started', turnId, payload: {} });
      for (const barrier of barriers) {
        await session.append({ kind: 'approval.requested', turnId, nodeId: barrier.nodeId, projectRevision: 9, payload: { approvalId: barrier.approvalId, barrierKind: barrier.effect, expiresAt: null, toolId: barrier.toolId } });
        const node = conversationNode(barrier);
        const artifact = await log.putArtifact(node, { schemaVersion: 'conversation-node/1', backendId });
        await log.append({ kind: 'conversation/node-projected', severity: 'warning', source: 'studio.conversation-host', correlation: { sessionId, turnId, approvalId: barrier.approvalId }, payload: { nodeId: barrier.nodeId, nodeKind: 'approval', nodeStatus: 'pending', artifactId: artifact.id, artifactDigest: artifact.digest }, artifactRefs: [artifact.id] });
      }
      await session.checkpoint(); await session.dispose();
      finish(0, JSON.stringify({ seeded: barriers.length }));
      return;
    }

    const runtime = runtimeFixture(sessions);
    const host = new StudioConversationHost({ runtime, tools: { definitions: () => [] }, operationLog: log });
    await host.initialize();
    const pending = host.replay().events.map((event) => event.node).filter((node) => node.kind === 'approval' && node.status === 'pending');
    for (const barrier of barriers) {
      await host.dispatch({ type: 'conversation/resolve-approval', approvalId: barrier.approvalId, decision: 'allow-once' });
      await waitFor(() => host.replay().busy === false && host.replay().events.some((event) => event.node.id === barrier.nodeId && event.node.status === 'completed'));
    }
    const snapshot = await sessions.replay(sessionId);
    const resolved = host.replay().events.map((event) => event.node).filter((node) => barriers.some((barrier) => barrier.nodeId === node.id) && node.status === 'completed').length;
    const result = { pending: pending.length, resolved, resumeCalls: runtime.resumeCalls, unresolved: snapshot.recovery.unresolvedBarrierIds.length };
    await host.dispose(); finish(0, JSON.stringify(result));
  } finally {
    await sessions.dispose().catch(() => undefined); await log.close().catch(() => undefined);
  }
}).catch((cause) => finish(1, cause instanceof Error ? cause.stack ?? cause.message : String(cause)));

function conversationNode(barrier) {
  return { schemaVersion: 1, id: barrier.nodeId, kind: 'approval', status: 'pending', createdAt: '2026-09-01T00:00:00.000Z', provenance: { backendId, sessionId, turnId }, content: { approvalId: barrier.approvalId, toolCallId: barrier.toolCallId, toolId: barrier.toolId, toolVersion: '1.0.0', target: barrier.target, effect: barrier.effect, risk: 'high', argumentsSummary: `Authorize ${barrier.toolId}`, previewDiff: '', baseRevision: 9, argsDigest: `sha256:${'a'.repeat(64)}`, previewDigest: `sha256:${'b'.repeat(64)}`, scope: 'operation', decision: 'pending' } };
}

function runtimeFixture(sessions) {
  const usage = new UsageLedgerStore(); const accounting = new TaskAccountingRegistry(usage);
  const profile = { id: 'prompt:g07-electron', version: '1.0.0', digest: `sha256:${'c'.repeat(64)}`, modules: [] };
  const backend = { descriptor: { id: backendId, kind: 'codex-app-server', protocolVersion: 'fixture', capabilities: {} }, async modelCatalog() { return { schemaVersion: 1, backendId, protocolVersion: 'fixture', source: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture', description: 'Fixture', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 4096, isDefault: true }] }; }, async status() { return { state: 'ready', authMode: 'none', rateLimits: [] }; }, async authenticate() { return null; }, async logout() {}, async cancelTurn() {}, async dispose() {}, async answerQuestion() {}, async resolveBackendApproval() {}, async submitToolResult() {} };
  const runtime = { resumeCalls: 0, sessions, usage, accounting, registry: { descriptors: () => [backend.descriptor], get: () => backend }, context: { prompts: { profile }, async commit() {}, async prepare({ request }) { return { prompt: request, promptDigest: `sha256:${'d'.repeat(64)}`, promptProfile: profile, contextArtifactIds: [], contextDigest: `sha256:${'e'.repeat(64)}`, cache: { localArtifactHits: 0, localArtifactMisses: 0, deltaReuseBytes: 0, providerCacheEligibleBytes: 0, providerReportedHitTokens: null } }; } }, turns: { async *start() {}, async *resume() { runtime.resumeCalls += 1; yield { schemaVersion: 1, backendId, sessionId, turnId, kind: 'completed', payload: { status: 'completed' } }; }, async cancel() {}, async recordToolResult() {} } };
  return runtime;
}

async function waitFor(predicate) { for (let index = 0; index < 500; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error('Timed out waiting for recovered Electron barrier.'); }
function finish(code, message) { if (finished) return; finished = true; clearTimeout(deadline); process.stdout.write(`[g07-barrier-electron] ${message}\n`, () => app.exit(code)); }
