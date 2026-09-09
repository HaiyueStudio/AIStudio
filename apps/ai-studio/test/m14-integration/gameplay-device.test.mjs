import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import electron from 'electron';
import { behaviorFixture } from '../../../../packages/game-authoring-tools/test/behavior-fixture.mjs';
import { createWorkspaceBehaviorPorts } from '../../dist/behavior-adapters.js';
import { ProjectBehaviorController } from '@haiyue/ai-studio-agent-orchestration';
import { PreviewAuthorizationService, playRuntimeConfigFromScene } from '@haiyue/ai-studio-script-preview';

const corpus = JSON.parse(await readFile(new URL('../logic-m12-fixtures.json', import.meta.url), 'utf8'));
const replays = JSON.parse(await readFile(new URL('./gameplay-replays.json', import.meta.url), 'utf8'));
const output = fileURLToPath(new URL('./test-output/gameplay/', import.meta.url));
for (const original of corpus.cases) test(`G09 ${original.genre} acceptance copy: fixed inputs and real source-bound event flows`, { timeout: 100000 }, async t => {
  const fixture = structuredClone(original), migrations = [];
  if (fixture.genre === 'falling-blocks') {
    const script = fixture.document.scripts[0], before = script.digest;
    script.source = script.source.replace(/\b(wasPressed|isPressed)\((?=['"])/gu, 'api.input.$1(');
    script.digest = `sha256:${createHash('sha256').update(script.source).digest('hex')}`; script.textRevision++;
    migrations.push({ kind: 'obsolete-input-globals-to-public-api', before, after: script.digest, reason: 'Preserved source declares globals which the actual runtime does not define; only the isolated G09 copy uses the public API.' });
  }
  const f = await behaviorFixture({ noSource: true }); let behavior;
  const authorization = new PreviewAuthorizationService(f.projectScripts, f.validator, f.operationLog, Date.now, () => playRuntimeConfigFromScene(f.scene.snapshot()));
  t.after(async () => { authorization.dispose(); await behavior?.dispose(); await f.close(); });
  const projectRoot = path.join(f.directory, 'preserved'); await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, '.haiyue-project.json'), JSON.stringify({ schemaVersion: 2, projectId: fixture.projectId, name: `Preserved ${fixture.genre}`, document: fixture.document }));
  await f.workspace.openProject(projectRoot);
  behavior = new ProjectBehaviorController(createWorkspaceBehaviorPorts(f.workspace, f.operationLog));
  const state = await behavior.refresh(), before = JSON.stringify(f.workspace.gameSnapshot()), runs = [];
  for (let round = 0; round < 2; round++) {
    const proposed = await authorization.prepare(), grant = await authorization.decide(proposed.id, true), plan = authorization.consume(grant.id);
    const runtime = await behavior.preparePlay(plan, { taskId: 'task:g09-replay', turnId: `turn:g09-replay-${round}` });
    runs.push({ scene: f.scene.snapshot(), plan, behavior: runtime, assets: [] });
  }
  await mkdir(output, { recursive: true });
  const diagnostics = path.join(output, 'diagnostics'); await mkdir(diagnostics, { recursive: true });
  await rename(path.join(output, `${fixture.genre}-failure.json`), path.join(diagnostics, `${fixture.genre}-${Date.now()}-failure.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const input = path.join(f.directory, 'input.json');
  await writeFile(input, JSON.stringify({ genre: fixture.genre, provenance: fixture.provenance, migrations, script: fixture.document.scripts[0], baselineTick: replays.baselineTick, namedFlows: replays.namedFlows[fixture.genre], stateFlows: replays.stateFlows[fixture.genre] ?? [], replay: replays.cases[fixture.genre], manifest: state.manifest, runs }));
  const env = { ...process.env, HAIYUE_G09_INPUT: input, HAIYUE_G09_OUTPUT: output, HAIYUE_G09_USER_DATA: path.join(f.directory, 'electron') };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DEEPSEEK_API_KEY', 'HAIYUE_STUDIO_DEEPSEEK_SECRET']) delete env[name];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [fileURLToPath(new URL('./gameplay-main.mjs', import.meta.url))], { env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let text = ''; const timer = setTimeout(() => child.kill(), 85000);
    child.stdout.on('data', b => text += b); child.stderr.on('data', b => text += b);
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve({ code, text }); });
  });
  await writeFile(path.join(output, `${fixture.genre}.log`), result.text);
  assert.equal(result.code, 0, result.text);
  const report = JSON.parse(await readFile(path.join(output, `${fixture.genre}.json`), 'utf8'));
  for (const round of report.rounds) {
    const captured = await behavior.capturePlay(round.capture);
    const reference = captured.artifacts.findLast(a => a.kind === 'trace'); assert.ok(reference);
    const stored = await behavior.readArtifact('trace', reference.artifactId); assert.ok(stored.value.trace.events.length);
    for (const flow of round.flows) {
      const location = await behavior.locateNode(state.manifest.digest, flow.nodeId);
      assert.equal(location.target.source.kind, 'script');
      assert.equal(location.target.source.digest, fixture.document.scripts[0].digest);
      flow.location = location;
    }
  }
  assert.equal(JSON.stringify(f.workspace.gameSnapshot()), before);
  report.documentUnchanged = true; await writeFile(path.join(output, `${fixture.genre}.json`), JSON.stringify(report, null, 2));
});
