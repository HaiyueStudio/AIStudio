import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/(.:\/)/u, '$1'));

test('real cold matrix runner enumerates independent backend/genre cases and checkpoints each result', async () => {
  const source = await readFile(path.join(root, 'scripts', 'g12', 'run-real-cold-matrix.mjs'), 'utf8');
  assert.match(source, /backends\.flatMap\(\(backend\) => genres\.map/u);
  assert.match(source, /await atomicJson\(checkpointPath/u);
  assert.match(source, /g12\.formal-revision-dirty/u);
  assert.match(source, /status === 'pass'/u);
  const result = spawnSync(process.execPath, ['scripts/g12/run-real-cold-matrix.mjs', '--evidence-class=preflight', '--dry-run=true', '--backends=codex', '--genres=snake'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"requested":1.*"remaining":1.*"dryRun":true/u);
});

test('real case runner separates model-visible request from hidden replay and persists all evidence classes', async () => {
  const source = await readFile(path.join(root, 'scripts', 'g12', 'real-cold-case-electron.mjs'), 'utf8');
  assert.match(source, /const prompt = `\$\{testCase\.request\}/u);
  assert.doesNotMatch(source.match(/const prompt = ([\s\S]*?);\n    const controller/u)?.[1] ?? '', /oracleCase|inputReplay|acceptance/u);
  assert.match(source, /compileG12ReplayProgram\(testCase\.inputReplay/u);
  assert.match(source, /usageRecords.*costRecords.*cache:/su);
  for (const type of ['state', 'event-trace', 'input-replay', 'screenshot', 'performance', 'lifecycle', 'log']) assert.match(source, new RegExp(`type: '${type}'`, 'u'));
  assert.match(source, /evaluation = evaluateCase/u);
});
