import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeBehavior, instrumentBehaviorScripts, createBehaviorRuntimePlan, BehaviorRuntimeRecorder, sealBehaviorRuntimeCapture } from '@haiyue/ai-studio-script-preview';
import { makeInput } from '../../../packages/script-preview/test/behavior-fixtures.mjs';
import { PlaySimulation } from '../dist/play-simulation.js';

test('actual fixed-step replay aligns branch events and invalidates clock reversal before another Play generation', () => {
  const input = makeInput({ script: "if (api.input.isDown('ArrowUp')) api.seen.push(time);" });
  const manifest = analyzeBehavior(input), program = instrumentBehaviorScripts(input, manifest)[0];
  const replay = { schemaVersion: 1, tickRateHz: 60, seed: 'logic-replay', events: [
    { tick: 2, order: 0, kind: 'action', source: 'keyboard', action: 'ArrowUp', phase: 'down' },
    { tick: 4, order: 1, kind: 'action', source: 'keyboard', action: 'ArrowUp', phase: 'up' },
  ] };
  const captures = [];
  for (let generation = 1; generation <= 2; generation++) {
    const plan = createBehaviorRuntimePlan(input, manifest, { playId: `play:replay-${generation}`, generation, scripts: [{ scriptId: program.scriptId, emittedText: program.originalEmittedText }] });
    const recorder = new BehaviorRuntimeRecorder(plan), seen = [];
    const run = recorder.compiler(() => program.scriptId)(program.originalEmittedText, { component: {}, sourceUrl: 'replay.js' });
    const simulation = new PlaySimulation({ seed: replay.seed, onTick: step => { recorder.beginTick(step.tick, 0); run(null, null, null, step.timeMs, step.deltaMs, null, { input: { isDown: code => simulation.input.isPressed(code) }, seen }); } });
    simulation.loadReplay(replay); simulation.pause(); simulation.step(5);
    assert.equal(seen.length, 2);
    const called = manifest.nodes.find(node => node.kind === 'call' && input.document.scripts[0].source.slice(node.source.range.start, node.source.range.end) === 'api.seen.push(time)');
    assert.deepEqual(recorder.snapshot().events.filter(event => event.nodeId === called.id && event.kind === 'node-enter').map(event => event.tick), [2, 3]);
    captures.push(sealBehaviorRuntimeCapture(plan, manifest, recorder.snapshot(), { id: `observation:replay-${generation}`, taskId: 'task:replay', turnId: 'turn:replay', capturedAt: '2026-09-07T00:00:00Z', viewport: null, device: null, producerVersion: '0.0.0' }).artifact);
    recorder.close('clock-reset'); const ended = recorder.snapshot(); simulation.loadReplay(replay); simulation.step(5);
    assert.deepEqual(recorder.snapshot(), ended, 'old callbacks cannot enter a new clock epoch');
  }
  assert.notEqual(captures[0].trace.playId, captures[1].trace.playId);
  assert.equal(captures[0].trace.manifestDigest, captures[1].trace.manifestDigest);
  const events = trace => trace.events.map(({ durationMicros, ...event }) => event);
  assert.deepEqual(events(captures[0].trace), events(captures[1].trace));
});
