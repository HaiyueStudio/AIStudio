import assert from 'node:assert/strict';
import { GAME_AUTHORING_TOOL_DEFINITIONS, ToolBatchScheduler, normalizeToolBatchRequest } from '../packages/game-authoring-tools/dist/index.js';

const delayMs = 90;
const calls = [
  { toolCallId: 'call:measure-scene', toolId: 'scene.query' },
  { toolCallId: 'call:measure-diagnostics', toolId: 'diagnostics.query' },
  { toolCallId: 'call:measure-assets', toolId: 'asset.search' },
];
const request = normalizeToolBatchRequest({ id: 'batch:measure-g06', sessionId: 'session:measure-g06', turnId: 'turn:measure-g06', calls, maxConcurrency: 3, maxResultBytes: 1024 * 1024, createdAt: '2026-09-01T00:00:00.000Z' }, GAME_AUTHORING_TOOL_DEFINITIONS);
const body = async (node) => { await new Promise((resolve) => setTimeout(resolve, delayMs)); return { status: 'completed', value: { toolCallId: node.toolCallId } }; };

const serialStarted = performance.now();
for (const node of request.nodes) await body(node);
const serialWallTimeMs = performance.now() - serialStarted;

const batchStarted = performance.now();
const execution = await new ToolBatchScheduler().execute(request, body);
const batchWallTimeMs = performance.now() - batchStarted;

const measurement = Object.freeze({
  schemaVersion: 1,
  scenario: 'three-independent-observations',
  measurement: 'local-protocol-fixture',
  serial: Object.freeze({ modelCalls: 3, toolWaitMs: Math.round(serialWallTimeMs), wallTimeMs: Math.round(serialWallTimeMs) }),
  batch: Object.freeze({ modelCalls: 1, toolWaitMs: Math.round(batchWallTimeMs), wallTimeMs: Math.round(batchWallTimeMs), maxConcurrencyObserved: execution.summary.maxConcurrencyObserved }),
  resultOrder: execution.outcomes.map((outcome) => outcome.node.toolCallId),
});

assert.equal(measurement.batch.modelCalls, 1);
assert.equal(measurement.serial.modelCalls, 3);
assert.equal(measurement.batch.maxConcurrencyObserved, 3);
assert.ok(batchWallTimeMs < serialWallTimeMs * 0.7, `Batch ${batchWallTimeMs.toFixed(1)}ms did not improve on serial ${serialWallTimeMs.toFixed(1)}ms.`);
assert.deepEqual(measurement.resultOrder, calls.map((call) => call.toolCallId));
console.log(`[m13-g06-metrics] ${JSON.stringify(measurement)}`);
