import assert from 'node:assert/strict';
import test from 'node:test';
import { G12_SEMANTIC_DRIVER_IDS, G12_SEMANTIC_REPLAY_ACTIONS, createG12SemanticDriverRegistry, executeG12SemanticDriver } from '../src/index.mjs';

test('reviewed semantic registry exactly covers every hidden replay action', () => {
  assert.deepEqual(G12_SEMANTIC_DRIVER_IDS, [...G12_SEMANTIC_REPLAY_ACTIONS]);
  const registry = createG12SemanticDriverRegistry();
  assert.ok(Object.values(registry).every((entry) => entry.version === '1.0.0' && Number.isSafeInteger(entry.maxTicks) && entry.maxTicks > 0));
});

test('every semantic driver executes bounded real preview-control operations', async () => {
  const registry = createG12SemanticDriverRegistry();
  for (const driverId of G12_SEMANTIC_DRIVER_IDS) {
    const control = previewControl();
    const result = await executeG12SemanticDriver(registry, driverId, control, parameters(driverId));
    assert.ok(result.inputs > 0, `${driverId} issued no input`);
    assert.ok(result.ticksConsumed > 0 && result.ticksConsumed <= result.maxTicks, `${driverId} exceeded tick budget`);
    assert.equal(control.events.every((event) => event.tick > 5 && event.source === 'synthetic'), true, `${driverId} emitted invalid input`);
  }
});

test('semantic pointer drivers consume only normalized, exact-role replay targets', async () => {
  const control = previewControl([
    { driverId: 'scripted-swap', role: 'from', kind: 'creates-match', x: 0.11, y: 0.22 },
    { driverId: 'scripted-swap', role: 'to', kind: 'creates-match', x: 0.33, y: 0.44 },
  ]);
  await executeG12SemanticDriver(createG12SemanticDriverRegistry(), 'scripted-swap', control, { kind: 'creates-match' });
  const pointers = control.events.filter((event) => event.kind === 'pointer');
  assert.deepEqual([pointers[0].x, pointers[0].y, pointers.at(-1).x, pointers.at(-1).y], [0.11, 0.22, 0.33, 0.44]);
});

test('semantic drivers fail closed for missing registration and tick-budget overflow', async () => {
  await assert.rejects(() => executeG12SemanticDriver({}, 'scripted-swap', previewControl(), {}), (error) => error.code === 'g12.semantic-driver-missing');
  const registry = { 'scripted-swap': { id: 'scripted-swap', maxTicks: 1, async run(session) { await session.action('Space', 2); } } };
  await assert.rejects(() => executeG12SemanticDriver(registry, 'scripted-swap', previewControl(), {}), (error) => error.code === 'g12.semantic-driver-budget-exceeded');
});

function previewControl(replayTargets = []) {
  let tick = 5;
  const events = [];
  const observation = () => ({ tick, value: { gameplay: [{ scriptId: 'script:test', entityId: 'entity:test', id: 'game', value: { replayTargets } }] } });
  return {
    events,
    async inspect() { return observation(); },
    async input(event) { events.push(event); return observation(); },
    async step(count) { tick += count; return observation(); },
  };
}

function parameters(driverId) {
  if (driverId === 'scripted-swap') return { kind: 'creates-match' };
  if (driverId === 'scripted-repeat-valid-swaps') return { count: 2 };
  if (driverId === 'scripted-drag-piece') return { destination: 'near-correct-slot' };
  if (driverId === 'scripted-follow-centerline') return { durationTicks: 60 };
  if (driverId === 'scripted-aim-and-fire' || driverId === 'scripted-fire-at-covered-enemy') return { shots: 2 };
  return {};
}
