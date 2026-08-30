import { randomUUID } from 'node:crypto';
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
const dryRun = values['dry-run'] === 'true'; const resume = values.resume !== 'false';
assertContained(output, path.join(root, 'evals', 'evidence', 'g12'));
const revisions = revisionSet();
if (evidenceClass === 'formal') for (const [name, entry] of Object.entries(revisions)) if (!entry.clean) throw new Error(`g12.formal-revision-dirty:${name}`);
if (backends.includes('harness') && !process.env.HAIYUE_STUDIO_DEEPSEEK_SECRET) throw new Error('DeepSeek credential is unavailable.');
const matrixId = values['matrix-id'] ?? `matrix-${revisions.aistudio.revision.slice(0, 12)}`;
const checkpointPath = path.join(output, `${matrixId}.checkpoint.json`);
const checkpoint = resume ? await readJson(checkpointPath).catch(() => null) : null;
const results = Array.isArray(checkpoint?.results) ? [...checkpoint.results] : [];
const tasks = backends.flatMap((backend) => genres.map((genre) => ({ backend, genre }))).filter((task) => !results.some((entry) => entry.backend === task.backend && entry.genre === task.genre && entry.status === 'pass'));
console.log(`[g12-real-matrix] ${JSON.stringify({ matrixId, evidenceClass, revisions, requested: backends.length * genres.length, remaining: tasks.length, dryRun })}`);
if (dryRun) process.exit(0);

for (const task of tasks) {
  const startedAt = new Date().toISOString();
  const child = await runCase(task);
  const parsed = parseCase(child.output);
  const status = child.code === 0 && parsed?.evaluation === 'pass' && parsed?.terminal === 'completed' ? 'pass' : 'failed';
  const entry = { backend: task.backend, genre: task.genre, status, startedAt, completedAt: new Date().toISOString(), exitCode: child.code, runId: parsed?.runId ?? null, caseRoot: parsed?.caseRoot ?? null, evaluation: parsed?.evaluation ?? null, passed: parsed?.passed ?? null, required: parsed?.required ?? null, outputTail: child.output.slice(-4_000) };
  const prior = results.findIndex((value) => value.backend === task.backend && value.genre === task.genre); if (prior >= 0) results.splice(prior, 1, entry); else results.push(entry);
  await atomicJson(checkpointPath, { schemaVersion: 1, matrixId, evidenceClass, revisions, updatedAt: new Date().toISOString(), results });
  console.log(`[g12-real-matrix-case] ${JSON.stringify({ backend: task.backend, genre: task.genre, status, exitCode: child.code, evaluation: entry.evaluation })}`);
}
const complete = results.filter((entry) => backends.includes(entry.backend) && genres.includes(entry.genre) && entry.status === 'pass').length;
console.log(`[g12-real-matrix-complete] ${JSON.stringify({ matrixId, complete, total: backends.length * genres.length, checkpointPath })}`);
if (complete !== backends.length * genres.length) process.exitCode = 1;

function runCase(task) { return new Promise((resolve, reject) => { const script = path.join(root, 'scripts', 'g12', 'real-cold-case-electron.mjs'); const args = [script, `--backend=${task.backend}`, `--genre=${task.genre}`, `--evidence-class=${evidenceClass}`, `--output=${output}`, ...(values.reasoning ? [`--reasoning=${values.reasoning}`] : []), ...(values.model ? [`--model=${values.model}`] : [])]; const child = spawn(electronPath, args, { cwd: root, env: { ...process.env, HAIYUE_G12_ALLOW_REAL: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let outputText = ''; child.stdout.on('data', (value) => { outputText += value; process.stdout.write(value); }); child.stderr.on('data', (value) => { outputText += value; process.stderr.write(value); }); child.once('error', reject); child.once('exit', (code) => resolve({ code: code ?? 1, output: outputText })); }); }
function parseCase(outputText) { const matches = [...outputText.matchAll(/^\[g12-real-case\] (\{.*\})$/gmu)]; if (!matches.length) return null; try { return JSON.parse(matches.at(-1)[1]); } catch { return null; } }
function revisionSet() { const repositories = { aistudio: root, engine: path.resolve(root, '..', 'Engine'), milestones: path.resolve(root, '..', 'milestones') }; return Object.fromEntries(Object.entries(repositories).map(([name, directory]) => [name, { revision: git(directory, ['rev-parse', 'HEAD']), clean: git(directory, ['status', '--porcelain']) === '' }])); }
function git(directory, args) { const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); }
function one(value, allowed, name) { if (!allowed.includes(value)) throw new Error(`--${name} must be ${allowed.join(' or ')}.`); return value; }
function list(value, allowed, name) { const result = [...new Set(value.split(',').filter(Boolean))]; if (!result.length || result.some((entry) => !allowed.includes(entry))) throw new Error(`--${name} contains an unsupported value.`); return result; }
function assertContained(candidate, parent) { const resolved = path.resolve(candidate), base = path.resolve(parent); if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new Error(`Path escapes ${base}: ${resolved}`); }
async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function atomicJson(file, value) { await mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); await rename(temporary, file); }
