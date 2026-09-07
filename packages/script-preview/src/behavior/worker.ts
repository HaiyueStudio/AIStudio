import { parentPort } from 'node:worker_threads';
import { analyzeBehavior } from './analyzer.js';
import { BehaviorContractError } from './canonical.js';

if (!parentPort) throw new Error('behavior.worker-only');
parentPort.once('message', (input: unknown) => {
  try { parentPort!.postMessage({ ok: true, manifest: analyzeBehavior(input) }); }
  catch (error) { parentPort!.postMessage({ ok: false, code: error instanceof BehaviorContractError ? error.code : 'behavior.analysis-failed' }); }
  finally { parentPort!.close(); }
});
