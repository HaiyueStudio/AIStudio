import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const readJson = async (relative) => JSON.parse(await read(relative));
const implementationBinding = 'm13-g04-2026-09-01';
const contractBinding = 'm13-g01-2026-09-01';

const contractIndex = await readJson('config/contracts/m13-contract-index.json');
assert.equal(contractIndex.bindingId, contractBinding);
assert.ok(contractIndex.nestedTypes.includes('BackendSessionBindingV1'));

const runtime = await read('packages/agent-runtime/src/backends/runtime.ts');
const cache = await read('packages/agent-runtime/src/backends/cache.ts');
const types = await read('packages/agent-runtime/src/backends/types.ts');
const rootEntry = await read('packages/agent-runtime/src/index.ts');
const harnessBridge = await read('packages/harness-bridge/src/harness-agent.ts');
const harnessBackend = await read('packages/agent-backends/src/harness-backend.ts');
const codexBackend = await read('packages/agent-backends/src/codex-backend.ts');
const runtimeTests = await read('packages/agent-runtime/test/g04-backend-session.test.mjs');
const backendTests = await read('packages/agent-backends/test/backends.test.mjs');
const appTest = await read('apps/ai-studio/test/backend-session-process-reload.test.mjs');

for (const phrase of ['checkpoint-replay-required', 'provider-unavailable', 'backend.detached', 'backend.remote-boundary-mismatch', 'lastConfirmedOpId', 'compactionSummarizer', 'nativeCompactionMirror', 'Promise.all(this.tails.values())']) assert.match(runtime, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), `runtime invariant missing ${phrase}`);
for (const phrase of ['localCas', 'provider-usage', 'provider-capability', "'unknown' as const", 'providerCacheEligibleBytes']) assert.match(cache, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), `cache invariant missing ${phrase}`);
for (const phrase of ['nativeCompactionTransport', 'nativeCompactionMirror', 'BackendRemoteSessionInspectionV1']) assert.match(types, new RegExp(phrase, 'u'));
assert.match(rootEntry, /readonly backendSessions: BackendSessionRuntime/u);
assert.match(rootEntry, /isBackendSessionAdapter\(backend\)/u);
assert.match(rootEntry, /await backendSessions\.dispose\(\)/u);

assert.match(harnessBridge, /maxInputTokens: null/u);
assert.match(harnessBridge, /no authoritative input Context Window/u);
assert.match(harnessBridge, /nativeCompaction: false/u);
assert.match(codexBackend, /thread\/read/u);
assert.match(codexBackend, /thread\/unsubscribe/u);
assert.match(codexBackend, /thread\/compact\/start returns no auditable summary/u);
assert.match(codexBackend, /nativeCompaction: false/u);
assert.doesNotMatch(codexBackend, /request\('thread\/compact\/start'/u, 'unsafe Codex native compaction must not be invoked');
assert.match(harnessBackend, /implements AgentBackend, BackendSessionAdapter/u);
assert.match(codexBackend, /implements AgentBackend, BackendSessionAdapter/u);
assert.doesNotMatch(`${runtime}\n${cache}\n${types}`, /@deepseek|@openai|cordis|dsh-agent/iu, 'provider types leaked into provider-neutral Backend Session runtime');

for (const phrase of ['new, resume, boundary confirmation', 'remote missing or boundary mismatch', 'provider disconnect', 'provider capacity evidence', 'failed remote rebuild', 'native compaction summaries', 'cache evidence', 'disposal rejects late']) assert.match(runtimeTests, new RegExp(phrase, 'iu'), `G04 runtime test missing ${phrase}`);
assert.match(backendTests, /honest Harness\/Codex capacity, boundary and compaction capabilities/u);
assert.match(backendTests, /unsafe hidden provider compaction must not run/u);
assert.match(appTest, /main process reload rebinds missing Harness\/Codex remotes/u);
assert.match(appTest, /parallelToolCalls, false/u);
assert.match(appTest, /parallelToolCalls, true/u);

for (const document of ['docs/architecture/m13-backend-session-adapters.md', 'docs/evidence/m13-g04-verification.md']) {
  const body = await read(document); assert.match(body, new RegExp(implementationBinding, 'u')); assert.match(body, new RegExp(contractBinding, 'u'));
}

console.log(`[m13-g04] runtimeScenarios=8 backendScenarios=2 appReload=1 binding=${implementationBinding}`);
