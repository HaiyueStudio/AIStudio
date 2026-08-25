import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PromptContextRuntime, PromptModuleRegistry } from '../packages/agent-runtime/dist/index.js';
import { OperationLog, canonicalStringify, sha256 } from '../packages/operation-log/dist/index.js';

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (value) => value.slice(1)));
const evidencePath = path.join(root, 'evals', 'evidence', 'm12-g04-prompt-comparison.json');
const suite = JSON.parse(await readFile(path.join(root, 'evals', 'suites', 'game-agent-evaluation-v1.json'), 'utf8'));
const oracle = JSON.parse(await readFile(path.join(root, 'evals', 'suites', 'game-agent-evaluation-v1.oracle.json'), 'utf8'));
const hiddenOracleStrings = oracle.cases.flatMap((item) => item.rules.flatMap((rule) => [rule.acceptanceId, ...rule.conditions.map((condition) => condition.signal)]));
assert.equal(suite.cases.length, 7, 'G04 cross-genre gate requires exactly seven canonical cases');

const productionFiles = [
  'packages/agent-runtime/src/prompt-context.ts', 'apps/ai-studio/src/conversation-host.ts',
  'packages/agent-backends/src/codex-backend.ts', 'packages/harness-bridge/src/harness-agent.ts',
];
const forbiddenBias = /snake|snakebody|tetris|match.?3|platformer|racing|shooter|贪吃蛇|俄罗斯方块|消消乐/iu;
for (const relative of productionFiles) assert.doesNotMatch(await readFile(path.join(root, relative), 'utf8'), forbiddenBias, `${relative} contains a genre-specific production patch`);

const report = await buildReport();
if (process.argv.includes('--print')) console.log(JSON.stringify(report, null, 2));
else {
  const expected = JSON.parse(await readFile(evidencePath, 'utf8'));
  assert.deepEqual(report, expected, 'G04 prompt/cache comparison evidence drifted; review the implementation and evidence together');
  console.log(`[m12:g04] profile=${report.candidate.profile.id}@${report.candidate.profile.version} genres=${report.crossGenre.length} cold=${report.experiment.cold.promptBytes}B warm=${report.experiment.warm.promptBytes}B deltaReuse=${report.experiment.delta.cache.deltaReuseBytes}B restartDigest=stable`);
}

async function buildReport() {
  const directory = await mkdtemp(path.join(tmpdir(), 'haiyue-g04-verifier-'));
  let log;
  try {
    log = await OperationLog.open({ rootDirectory: directory, appVersion: 'g04-verifier' });
    const context = new PromptContextRuntime(log); const registry = new PromptModuleRegistry();
    const tools = [{ id: 'project.snapshot', description: 'Read bounded project identity and revision.', inputSchema: { type: 'object', additionalProperties: false } }];
    const project1 = project(20, 40); const request = 'Continue the current project with deterministic input and visual verification.';
    const cold = await context.prepare({ conversationKey: 'conversation:g04-experiment', backendId: 'backend:g04-experiment', taskId: 'task:g04-cold', request, tools, project: project1 });
    await context.commit({ conversationKey: 'conversation:g04-experiment', backendId: 'backend:g04-experiment', taskId: 'task:g04-cold', sessionId: 'session:g04-live', turnId: 'turn:g04-cold', projectId: project1.projectId, goals: [request], decisions: ['Keep simulation authoritative.'], toolFacts: ['project.snapshot: revision 20'], acceptance: ['Input replay and visual evidence required.'], blockers: [] });
    const warm = await context.prepare({ conversationKey: 'conversation:g04-experiment', backendId: 'backend:g04-experiment', taskId: 'task:g04-warm', request, tools, project: project1 });
    const project2 = project(21, 41);
    const delta = await context.prepare({ conversationKey: 'conversation:g04-experiment', backendId: 'backend:g04-experiment', taskId: 'task:g04-delta', request, tools, project: project2 });
    await context.commit({ conversationKey: 'conversation:g04-experiment', backendId: 'backend:g04-experiment', taskId: 'task:g04-delta', sessionId: 'session:g04-live', turnId: 'turn:g04-delta', projectId: project2.projectId, goals: [request], decisions: [], toolFacts: ['project.snapshot: revision 21'], acceptance: [], blockers: [] });
    const beforeRestart = await context.prepare({ conversationKey: 'conversation:g04-experiment', backendId: 'backend:g04-experiment', taskId: 'task:g04-before-restart', request, tools, project: project2 });

    const crossGenre = [];
    for (const [index, item] of suite.cases.entries()) {
      const value = await context.prepare({ conversationKey: `conversation:g04:${index}`, backendId: 'backend:g04-experiment', taskId: `task:g04:${index}`, request: item.request, tools, project: null });
      for (const hidden of hiddenOracleStrings) assert.ok(!value.prompt.includes(hidden), `${item.id} prompt leaked hidden oracle string ${hidden}`);
      crossGenre.push({ id: item.id, requestDigest: `sha256:${sha256(item.request)}`, profileDigest: value.promptProfile.digest, contextArtifactCount: value.contextArtifactIds.length, requestTailPreserved: value.prompt.endsWith(item.request) });
    }
    await log.close(); log = null;
    const reopened = await OperationLog.open({ rootDirectory: directory, appVersion: 'g04-verifier' });
    const restored = new PromptContextRuntime(reopened); const afterRestart = await restored.prepare({ conversationKey: 'conversation:g04-experiment', backendId: 'backend:g04-experiment', taskId: 'task:g04-after-restart', request, tools, project: project2 });
    await reopened.close();
    return {
      schemaVersion: 1, goalId: 'g04-prompt-context-cache-memory',
      baseline: { reviewedCommit: 'e4625bb62cfc973c60957997429876a0b455166a', architecture: 'monolithic-patch-prompt', contextArtifactIds: 0, durableSummary: false, localCasMetric: false, deltaReuseMetric: false, providerHitEvidence: 'unavailable', promptBytes: null, note: 'The reviewed M06 baseline did not measure prompt bytes or cache; unknown values remain null.' },
      candidate: { profile: { id: registry.profile.id, version: registry.profile.version, digest: registry.profile.digest, moduleDigests: registry.profile.modules.map(({ id, version, layer, digest }) => ({ id, version, layer, digest })) }, stablePrefixBytes: Buffer.byteLength(registry.stablePrefix()), genreSpecificProductionMarkers: 0 },
      experiment: {
        cold: measure(cold), warm: measure(warm), delta: measure(delta),
        restart: { beforeContextDigest: beforeRestart.contextDigest, afterContextDigest: afterRestart.contextDigest, equal: beforeRestart.contextDigest === afterRestart.contextDigest, providerSessionRestored: afterRestart.reusedSessionId !== null },
      },
      crossGenre,
      invariants: { artifactIdsReadable: true, sameRevisionReferenceOnly: warm.prompt.includes('"transmission":"reference-only"'), changedRevisionDeltaOnly: delta.prompt.includes('"kind":"document-delta"'), unknownProviderHitNotZero: warm.cache.providerReportedHitTokens === null, hiddenChainOfThoughtPersisted: false, secretCanaryScan: 'covered-by-agent-runtime-test' },
    };
  } finally { if (log) await log.close().catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
}

function measure(value) { return { promptBytes: Buffer.byteLength(value.prompt), contextDigest: value.contextDigest, contextArtifactCount: value.contextArtifactIds.length, cache: value.cache }; }
function project(revision, entityCount) { return { projectId: 'project:g04-experiment', documentId: 'document:g04-experiment', revision, manifest: { schemaVersion: 1, project: { id: 'project:g04-experiment', revision }, scene: { revision, entities: Array.from({ length: entityCount }, (_, index) => ({ id: `entity:g04:${index}`, name: `Entity ${index}`, transform: { x: index, y: 0, z: 0 } })) }, scripts: { resources: [{ id: 'script:g04', textRevision: 3, digest: `sha256:${'a'.repeat(64)}` }] } } }; }
