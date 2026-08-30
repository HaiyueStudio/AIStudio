import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OperationLog } from '@haiyue/ai-studio-operation-log';
import { PromptContextRuntime, PromptModuleRegistry, UsageLedger } from '../dist/index.js';

const backendId = 'backend:context-fixture';
const conversationKey = 'conversation:context-fixture';
const taskId = 'task:context-fixture';
const tools = Object.freeze([{ id: 'project.snapshot', description: 'Read bounded project identity and revision.', inputSchema: { type: 'object', additionalProperties: false } }]);

test('prompt profile is deterministic, versioned and genre neutral', () => {
  const first = new PromptModuleRegistry().profile;
  const second = new PromptModuleRegistry().profile;
  assert.deepEqual(first, second);
  assert.equal(first.id, 'prompt:game-authoring-general');
  assert.equal(first.version, '3.0.0');
  assert.deepEqual(first.modules.map(({ id, version, layer }) => ({ id, version, layer })), [
    { id: 'prompt.policy.safe-authoring', version: '1.0.0', layer: 'policy' },
    { id: 'prompt.tools.structured-effects', version: '1.0.0', layer: 'tool-contract' },
    { id: 'prompt.workflow.general-authoring', version: '1.0.0', layer: 'workflow' },
  ]);
  const production = first.modules.map((entry) => entry.content).join('\n').toLowerCase();
  for (const genrePatch of ['snake', 'snakebody', 'tetris', 'match-3', 'platformer', 'racing', 'shooter', '贪吃蛇', '俄罗斯方块', '消消乐']) assert.doesNotMatch(production, new RegExp(escapeRegExp(genrePatch), 'iu'));
  assert.equal(first.digest, 'sha256:1a419fd0f5827490fda8e4b69218fbc9e27263171ab29a2fa4006d9013b58f1b');
});

test('same revision reuses a live session by reference, changed revision sends only a delta, and restart rebuilds the same summary/context digest', async () => {
  const fixture = await openFixture();
  try {
    const runtime = new PromptContextRuntime(fixture.log); await runtime.initialize();
    const project1 = project(7, 'SCRIPT_FULL_MARKER_ALPHA', [{ id: 'entity:one', name: 'One' }]);
    const first = await runtime.prepare({ conversationKey, backendId, taskId, request: 'Add keyboard input and verify movement.', tools, project: project1 });
    assert.equal(first.reusedSessionId, null);
    assert.ok(first.contextArtifactIds.length >= 4);
    assert.match(first.prompt, /SCRIPT_FULL_MARKER_ALPHA/);
    for (const id of first.contextArtifactIds) assert.equal((await fixture.log.readArtifact(id)).id, id);
    const unapproved = await fixture.log.putArtifact({ arbitrary: 'not model approved' });
    await assert.rejects(runtime.assertReadable([unapproved.id]), (error) => error.code === 'context.artifact-not-approved');

    await runtime.commit({ conversationKey, backendId, taskId, sessionId: 'session:context-one', turnId: 'turn:context-one', projectId: project1.projectId,
      goals: ['Add keyboard input and verify movement.'], decisions: ['Use explicit input state.'], toolFacts: ['project.snapshot: revision 7'], acceptance: ['Movement replay is required.'], blockers: [] });

    const same = await runtime.prepare({ conversationKey, backendId, taskId: 'task:context-second', request: 'Continue the same input task.', tools, project: project1 });
    assert.equal(same.reusedSessionId, 'session:context-one');
    assert.match(same.prompt, /"transmission":"reference-only"/);
    assert.doesNotMatch(same.prompt, /Read bounded project identity and revision/u, 'unchanged tool metadata is referenced rather than retransmitted');
    assert.ok(Buffer.byteLength(same.prompt) < Buffer.byteLength(first.prompt));
    assert.doesNotMatch(same.prompt, /SCRIPT_FULL_MARKER_ALPHA/);
    assert.ok(same.cache.localArtifactHits >= 3);

    const project2 = project(8, 'SCRIPT_FULL_MARKER_ALPHA', [{ id: 'entity:one', name: 'One' }, { id: 'entity:two', name: 'Two' }]);
    const delta = await runtime.prepare({ conversationKey, backendId, taskId: 'task:context-third', request: 'Continue the same input task.', tools, project: project2 });
    assert.match(delta.prompt, /"kind":"document-delta"/);
    assert.match(delta.prompt, /"fromRevision":7/);
    assert.match(delta.prompt, /"toRevision":8/);
    assert.doesNotMatch(delta.prompt, /SCRIPT_FULL_MARKER_ALPHA/);
    assert.doesNotMatch(delta.prompt, /project\.snapshot: revision 7/);
    assert.match(delta.prompt, /prior revision-bound tool facts and acceptance were invalidated/);
    assert.ok(delta.cache.deltaReuseBytes > 0);

    await runtime.commit({ conversationKey, backendId, taskId: 'task:context-third', sessionId: 'session:context-one', turnId: 'turn:context-three', projectId: project2.projectId,
      goals: ['Continue the same input task.'], decisions: [], toolFacts: ['scene.list-entities: revision 8'], acceptance: [], blockers: [] });
    const beforeRestart = await runtime.prepare({ conversationKey, backendId, taskId: 'task:before-restart', request: 'Continue the same input task.', tools, project: project2 });
    await fixture.log.close();

    const reopened = await OperationLog.open({ rootDirectory: fixture.root, appVersion: 'test' });
    const restored = new PromptContextRuntime(reopened); await restored.initialize();
    const afterRestart = await restored.prepare({ conversationKey, backendId, taskId: 'task:after-restart', request: 'Continue the same input task.', tools, project: project2 });
    assert.equal(afterRestart.reusedSessionId, null, 'provider sessions are process-live, not falsely restored');
    assert.equal(afterRestart.contextDigest, beforeRestart.contextDigest);
    assert.deepEqual(afterRestart.contextArtifactIds, beforeRestart.contextArtifactIds);
    assert.match(afterRestart.prompt, /scene\.list-entities: revision 8/);
    assert.match(afterRestart.prompt, /SCRIPT_FULL_MARKER_ALPHA/, 'a new provider session receives the full current manifest');
    await reopened.close();
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('restart rebuilds context metadata and conversation indexes through bounded sequence windows', async () => {
  const fixture = await openFixture({ maxQueryScan: 5 });
  try {
    const runtime = new PromptContextRuntime(fixture.log);
    const prepared = await runtime.prepare({ conversationKey, backendId, taskId, request: 'Build bounded restart context.', tools, project: null });
    await runtime.commit({ conversationKey, backendId, taskId, sessionId: 'session:bounded-rebuild', turnId: 'turn:bounded-rebuild', projectId: null,
      goals: ['bounded rebuild survives restart'], decisions: [], toolFacts: [], acceptance: [], blockers: [] });
    for (let index = 0; index < 20; index += 1) {
      await fixture.log.append({ kind: 'test/rebuild-filler', severity: 'debug', source: 'test:prompt-context', payload: { index } });
    }
    await fixture.log.close();

    const reopened = await OperationLog.open({ rootDirectory: fixture.root, appVersion: 'test', maxQueryScan: 5 });
    const restored = new PromptContextRuntime(reopened);
    await restored.initialize();
    await restored.assertReadable(prepared.contextArtifactIds);
    const next = await restored.prepare({ conversationKey, backendId, taskId: 'task:bounded-rebuild-next', request: 'Continue.', tools, project: null });
    assert.match(next.prompt, /bounded rebuild survives restart/u);
    await reopened.close();
  } finally { await fixture.log.close().catch(() => undefined); await rm(fixture.root, { recursive: true, force: true }); }
});

test('secret canaries are absent from artifacts, summaries, prompt logs and exported bug bundles', async () => {
  const fixture = await openFixture();
  const bundleRoot = await mkdtemp(path.join(tmpdir(), 'haiyue-context-bundle-'));
  try {
    const runtime = new PromptContextRuntime(fixture.log);
    const canary = 'SECRET_CANARY';
    const prepared = await runtime.prepare({ conversationKey, backendId, taskId, request: `Keep ${canary} out of model context.`, tools, project: project(1, `const credential = '${canary}';`, []) });
    assert.doesNotMatch(prepared.prompt, new RegExp(canary));
    await runtime.commit({ conversationKey, backendId, taskId, sessionId: 'session:secret', turnId: 'turn:secret', projectId: 'project:context-fixture', goals: [`Do not expose ${canary}.`], decisions: [], toolFacts: [], acceptance: [], blockers: [] });
    await fixture.log.flush();
    const bundle = await fixture.log.exportBugBundle({ destinationRoot: bundleRoot, query: { limit: 200, traverseCorrelation: false }, artifactIds: prepared.contextArtifactIds,
      versions: { app: 'test', schema: 'test', upstream: {} } });
    assert.doesNotMatch(await readTree(fixture.root), new RegExp(canary));
    assert.doesNotMatch(await readTree(bundle.directory), new RegExp(canary));
  } finally { await fixture.log.close().catch(() => undefined); await rm(fixture.root, { recursive: true, force: true }); await rm(bundleRoot, { recursive: true, force: true }); }
});

test('usage ledger distinguishes provider cache eligibility from reported cache evidence', () => {
  const base = { taskId, sessionId: 'session:usage-context', turnId: 'turn:usage-context', providerRequestDigest: null, startedAtMs: 0,
    contextCache: { localArtifactHits: 3, localArtifactMisses: 1, deltaReuseBytes: 100, providerCacheEligibleBytes: 500, providerReportedHitTokens: null } };
  const unknown = new UsageLedger(base);
  unknown.reconcile({ eventId: 'usage:unknown', sequence: 1, mode: 'delta', inputTokens: 10, outputTokens: 1, observedAtMs: 1 });
  assert.equal(unknown.snapshot().record.contextCache.providerReportedHitTokens, null);
  const reported = new UsageLedger({ ...base, turnId: 'turn:usage-reported' });
  reported.reconcile({ eventId: 'usage:reported', sequence: 1, mode: 'delta', inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, observedAtMs: 1 });
  assert.equal(reported.snapshot().record.contextCache.providerReportedHitTokens, 0);
});

test('summary compaction keeps bounded visible facts and ignores hidden-reasoning-shaped input', async () => {
  const fixture = await openFixture();
  try {
    const runtime = new PromptContextRuntime(fixture.log);
    await runtime.commit({ conversationKey, backendId, taskId, sessionId: 'session:summary', turnId: 'turn:summary', projectId: null,
      goals: Array.from({ length: 20 }, (_, index) => `visible goal ${index}`), decisions: ['visible decision'], toolFacts: [], acceptance: [], blockers: [], hiddenReasoning: 'private rationale must not persist' });
    const prepared = await runtime.prepare({ conversationKey, backendId, taskId: 'task:summary-next', request: 'Continue.', tools, project: null });
    assert.doesNotMatch(prepared.prompt, /visible goal [0-7](?:\D|$)/u);
    assert.match(prepared.prompt, /visible goal 19/);
    assert.match(prepared.prompt, /visible decision/);
    assert.doesNotMatch(await readTree(fixture.root), /private rationale|hiddenReasoning/iu);
  } finally { await fixture.log.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('all seven canonical game requests use one profile without cross-genre prompt leakage', async () => {
  const suite = JSON.parse(await readFile(new URL('../../../evals/suites/game-agent-evaluation-v1.json', import.meta.url), 'utf8'));
  assert.equal(suite.cases.length, 7);
  const fixture = await openFixture();
  try {
    const runtime = new PromptContextRuntime(fixture.log);
    const prepared = [];
    for (const [index, item] of suite.cases.entries()) prepared.push(await runtime.prepare({ conversationKey: `conversation:genre:${index}`, backendId, taskId: `task:genre:${index}`, request: item.request, tools, project: null }));
    assert.equal(new Set(prepared.map((item) => item.promptProfile.digest)).size, 1);
    for (let index = 0; index < prepared.length; index += 1) {
      const value = prepared[index]; const request = suite.cases[index].request;
      assert.ok(value.contextArtifactIds.length >= 4);
      assert.match(value.prompt, new RegExp(`${escapeRegExp(request)}$`, 'u'));
      for (let other = 0; other < suite.cases.length; other += 1) if (other !== index) assert.doesNotMatch(value.prompt, new RegExp(escapeRegExp(suite.cases[other].request), 'u'));
    }
  } finally { await fixture.log.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

function project(revision, scriptText, entities) {
  return Object.freeze({ projectId: 'project:context-fixture', documentId: 'document:context-fixture', revision, manifest: Object.freeze({
    schemaVersion: 1, project: { id: 'project:context-fixture', revision }, scene: { revision, entities }, scripts: { resources: [{ id: 'script:fixture', textRevision: 1, text: scriptText }] },
  }) });
}
async function openFixture(overrides = {}) { const root = await mkdtemp(path.join(tmpdir(), 'haiyue-prompt-context-')); return { root, log: await OperationLog.open({ rootDirectory: root, appVersion: 'test', ...overrides }) }; }
async function readTree(root) { const values = []; for (const entry of await readdir(root, { withFileTypes: true })) { const target = path.join(root, entry.name); if (entry.isDirectory()) values.push(await readTree(target)); else values.push(await readFile(target, 'utf8').catch(() => '')); } return values.join('\n'); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
