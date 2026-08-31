import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import electronPath from 'electron';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:\/)/u, '$1')), '..', '..');
const values = Object.fromEntries(process.argv.slice(2).filter((entry) => entry.startsWith('--') && entry.includes('=')).map((entry) => { const index = entry.indexOf('='); return [entry.slice(2, index), entry.slice(index + 1)]; }));
const evidenceClass = one(values['evidence-class'] ?? 'formal', ['formal', 'preflight'], 'evidence-class');
const backends = list(values.backends ?? 'harness,codex', ['harness', 'codex'], 'backends');
const genres = list(values.genres ?? 'snake,match-3,falling-blocks,jigsaw,platformer,racing,shooter', ['snake', 'match-3', 'falling-blocks', 'jigsaw', 'platformer', 'racing', 'shooter'], 'genres');
const output = path.resolve(values.output ?? path.join(root, 'evals', 'evidence', 'g12', 'runs'));
const dryRun = values['dry-run'] === 'true'; const resume = values.resume !== 'false'; const retryFailed = values['retry-failed'] === 'true';
assertContained(output, path.join(root, 'evals', 'evidence', 'g12'));
const revisions = revisionSet();
if (evidenceClass === 'formal') for (const [name, entry] of Object.entries(revisions)) if (!entry.clean) throw new Error(`g12.formal-revision-dirty:${name}`);
if (backends.includes('harness') && !process.env.HAIYUE_STUDIO_DEEPSEEK_SECRET) throw new Error('DeepSeek credential is unavailable.');
const matrixId = values['matrix-id'] ?? `matrix-${revisions.aistudio.revision.slice(0, 12)}`;
const checkpointPath = path.join(output, `${matrixId}.checkpoint.json`);
const checkpoint = resume ? await readJson(checkpointPath).catch(() => null) : null;
const results = Array.isArray(checkpoint?.results) ? [...checkpoint.results] : [];
const tasks = backends.flatMap((backend) => genres.map((genre) => ({ backend, genre }))).filter((task) => {
  const prior = results.find((entry) => entry.backend === task.backend && entry.genre === task.genre);
  return !prior || (retryFailed && prior.status !== 'pass');
});
console.log(`[g12-real-matrix] ${JSON.stringify({ matrixId, evidenceClass, revisions, requested: backends.length * genres.length, remaining: tasks.length, dryRun, retryFailed })}`);
if (dryRun) process.exit(0);

for (const task of tasks) {
  const startedAt = new Date().toISOString();
  const runId = `g12-${task.backend}-${task.genre}-${randomUUID()}`;
  const caseRoot = path.join(output, revisions.aistudio.revision.slice(0, 12), task.backend, task.genre, runId);
  await mkdir(caseRoot, { recursive: true });
  await atomicJson(path.join(caseRoot, 'parent-start.json'), { schemaVersion: 1, matrixId, evidenceClass, revisions, runId, backend: task.backend, genre: task.genre, startedAt });
  const child = await runCase(task, runId);
  const parsed = parseCase(child.output);
  const status = child.code === 0 && parsed?.evaluation === 'pass' && parsed?.terminal === 'completed' ? 'pass' : 'failed';
  const errorCode = parsed?.errorCode ?? (child.timedOut ? 'g12.case-parent-timeout' : parsed ? null : 'g12.child-missing-terminal-record');
  if (status === 'failed' && !parsed) {
    const completedAt = new Date().toISOString();
    const partial = { schemaVersion: 1, matrixId, evidenceClass, revisions, runId, backend: task.backend, genre: task.genre, terminal: 'failed', error: { code: errorCode }, timedOut: child.timedOut, exitCode: child.code, accounting: null, usageRecords: [], costRecords: [], cache: null, preservedArtifacts: { projectPath: path.relative(root, path.join(caseRoot, 'project')).replaceAll('\\', '/'), runtimePath: path.relative(root, path.join(caseRoot, 'runtime')).replaceAll('\\', '/') }, evaluator: { status: 'not-run', reason: errorCode }, startedAt, completedAt };
    await atomicJson(path.join(caseRoot, 'partial-evidence.json'), partial);
    await atomicJson(path.join(caseRoot, 'failure.json'), { schemaVersion: 1, matrixId, evidenceClass, revisions, runId, backend: task.backend, genre: task.genre, code: errorCode, timedOut: child.timedOut, exitCode: child.code, startedAt, completedAt, outputDigest: digest(child.output) });
    await atomicJson(path.join(caseRoot, 'checkpoint.json'), { schemaVersion: 1, runId, backend: task.backend, genre: task.genre, status: 'failed-infrastructure', errorCode, partialEvidenceDigest: digest(JSON.stringify(partial)), partialEvidencePath: path.relative(root, path.join(caseRoot, 'partial-evidence.json')).replaceAll('\\', '/') });
  }
  const entry = { backend: task.backend, genre: task.genre, status, startedAt, completedAt: new Date().toISOString(), exitCode: child.code, timedOut: child.timedOut, errorCode, runId: parsed?.runId ?? runId, caseRoot: parsed?.caseRoot ?? caseRoot, evaluation: parsed?.evaluation ?? null, passed: parsed?.passed ?? null, required: parsed?.required ?? null, outputTail: child.output.slice(-4_000) };
  const prior = results.findIndex((value) => value.backend === task.backend && value.genre === task.genre); if (prior >= 0) results.splice(prior, 1, entry); else results.push(entry);
  await atomicJson(checkpointPath, { schemaVersion: 1, matrixId, evidenceClass, revisions, updatedAt: new Date().toISOString(), results });
  console.log(`[g12-real-matrix-case] ${JSON.stringify({ backend: task.backend, genre: task.genre, status, exitCode: child.code, evaluation: entry.evaluation })}`);
}
const complete = results.filter((entry) => backends.includes(entry.backend) && genres.includes(entry.genre) && entry.status === 'pass').length;
console.log(`[g12-real-matrix-complete] ${JSON.stringify({ matrixId, complete, total: backends.length * genres.length, checkpointPath })}`);
if (complete !== backends.length * genres.length) process.exitCode = 1;

function runCase(task, runId) { return new Promise((resolve, reject) => { const script = path.join(root, 'scripts', 'g12', 'real-cold-case-electron.mjs'); const args = [script, `--backend=${task.backend}`, `--genre=${task.genre}`, `--run-id=${runId}`, `--evidence-class=${evidenceClass}`, `--output=${output}`, ...(values.reasoning ? [`--reasoning=${values.reasoning}`] : []), ...(values.model ? [`--model=${values.model}`] : [])]; const child = spawn(electronPath, args, { cwd: root, env: { ...process.env, HAIYUE_G12_ALLOW_REAL: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let outputText = ''; let timedOut = false; let settled = false; const timeoutMs = positiveInteger(values['case-timeout-ms'] ?? String(16 * 60_000), 'case-timeout-ms'); const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs); child.stdout.on('data', (value) => { outputText += value; process.stdout.write(value); }); child.stderr.on('data', (value) => { outputText += value; process.stderr.write(value); }); child.once('error', (cause) => { if (settled) return; settled = true; clearTimeout(timer); reject(cause); }); child.once('exit', (code) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code: code ?? 1, output: outputText, timedOut }); }); }); }
function parseCase(outputText) { const matches = [...outputText.matchAll(/^\[g12-real-case\] (\{.*\})$/gmu)]; if (!matches.length) return null; try { return JSON.parse(matches.at(-1)[1]); } catch { return null; } }
function revisionSet() { const repositories = { aistudio: root, engine: path.resolve(root, '..', 'Engine'), milestones: path.resolve(root, '..', 'milestones') }; return Object.fromEntries(Object.entries(repositories).map(([name, directory]) => [name, { revision: git(directory, ['rev-parse', 'HEAD']), clean: git(directory, ['status', '--porcelain']) === '' }])); }
function git(directory, args) { const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); }
function one(value, allowed, name) { if (!allowed.includes(value)) throw new Error(`--${name} must be ${allowed.join(' or ')}.`); return value; }
function list(value, allowed, name) { const result = [...new Set(value.split(',').filter(Boolean))]; if (!result.length || result.some((entry) => !allowed.includes(entry))) throw new Error(`--${name} contains an unsupported value.`); return result; }
function positiveInteger(value, name) { const result = Number(value); if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`--${name} must be a positive integer.`); return result; }
function digest(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function assertContained(candidate, parent) { const resolved = path.resolve(candidate), base = path.resolve(parent); if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new Error(`Path escapes ${base}: ${resolved}`); }
async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function atomicJson(file, value) { await mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); await rename(temporary, file); }
