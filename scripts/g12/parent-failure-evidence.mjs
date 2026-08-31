import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EvidenceCollector, contentDigest, evaluateCase, loadEvaluationAssets } from '../../evals/src/index.mjs';

const PLACEHOLDER_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

/** Crash-safe, fail-closed evidence when an Electron child cannot run its own finalizer. */
export async function preserveParentFailureEvidence(input) {
  const assets = await loadEvaluationAssets();
  const testCase = assets.suite.cases.find((entry) => entry.genre === input.genre);
  const oracleCase = assets.oracle.cases.find((entry) => entry.caseId === testCase.id);
  const project = await readJson(path.join(input.caseRoot, 'project', '.haiyue-project.json')).catch(() => null);
  const projectDigest = contentDigest(project ?? { runId: input.runId, genre: input.genre, unavailable: true });
  const screenshotPath = path.join(input.caseRoot, 'partial-screenshot.png');
  await writeFile(screenshotPath, PLACEHOLDER_PNG);
  const screenshotDigest = sha256(PLACEHOLDER_PNG);
  const collector = new EvidenceCollector({
    runId: input.runId, caseId: testCase.id, projectDigest,
    seed: assets.suite.sharedEnvironment.seed, viewport: assets.suite.sharedEnvironment.viewport,
    maxObservationBytes: assets.suite.sharedBudgets.maxObservationBytes,
  });
  collector.collectAll([
    { type: 'state', tick: 0, signals: { 'failure.present': true, 'failure.parentTimeout': input.timedOut } },
    { type: 'screenshot', tick: 0, signals: { 'visual.pngCaptured': false, 'failure.forensicCapture': true }, media: { mediaType: 'image/png', digest: screenshotDigest, width: 1, height: 1, semanticAnalyzerVersion: 'failure-parent-placeholder-fail-closed' } },
    { type: 'log', tick: 0, signals: { 'runtime.unhandledErrors': 0, 'failure.present': true } },
    { type: 'lifecycle', tick: 0, signals: { 'residue.count': 0, 'failure.present': true } },
  ]);
  const evidenceManifest = collector.manifest();
  const evaluator = evaluateCase({ testCase, oracleCase, evidenceManifest });
  const suffix = createHash('sha256').update(`${input.runId}\0parent-failure`).digest('hex').slice(0, 24);
  const taskId = `task:g12-parent-failure:${suffix}`;
  const usageRecord = Object.freeze({
    schemaVersion: 2, id: `usage:unreported:${suffix}`, taskId,
    sessionId: `session:unreported:${suffix}`, turnId: `turn:unreported:${suffix}`,
    inputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null,
    toolInputBytes: 0, toolOutputBytes: 0, wallTimeMs: elapsed(input.startedAt, input.completedAt), providerRequestDigest: null, final: true,
  });
  const costRecord = Object.freeze({
    schemaVersion: 2, id: `cost:unreported:${suffix}`, usageRecordId: usageRecord.id,
    pricingCatalogId: null, pricingCatalogVersion: null, effectiveAt: null, currency: null,
    amountMicros: null, status: 'unknown', formula: null,
  });
  const scripts = Array.isArray(project?.document?.scripts) ? project.document.scripts : [];
  const partial = {
    schemaVersion: 1, matrixId: input.matrixId, evidenceClass: input.evidenceClass, revisions: input.revisions,
    runId: input.runId, backend: input.backend, genre: input.genre, caseId: testCase.id, terminal: 'failed',
    error: { code: input.errorCode, message: 'The parent watchdog terminated the case before the Electron child could finalize evidence.' },
    timedOut: input.timedOut, exitCode: input.exitCode, taskId, accounting: null,
    usageRecords: [usageRecord], costRecords: [costRecord], cache: null,
    preservedProject: { saved: project !== null, projectId: project?.projectId ?? null, projectDigest, scriptCount: scripts.filter((entry) => entry?.enabled !== false).length },
    preview: { snapshot: null, observationDigest: null, screenshot: { digest: screenshotDigest, width: 1, height: 1, path: 'partial-screenshot.png', captureKind: 'placeholder-fail-closed' } },
    evidenceManifest, evaluator, startedAt: input.startedAt, completedAt: input.completedAt,
  };
  await atomicJson(path.join(input.caseRoot, 'partial-evidence.json'), partial);
  return partial;
}

function elapsed(startedAt, completedAt) { const value = Date.parse(completedAt) - Date.parse(startedAt); return Number.isFinite(value) && value >= 0 ? value : 0; }
function sha256(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function atomicJson(file, value) { await mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); await rename(temporary, file); }
