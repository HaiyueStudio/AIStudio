// Experimental worker-side shim. No provider key or host function crosses workerData.
import { MessageChannel } from 'node:worker_threads';
export function clientModel(inferencePort) {
  return { generate: params => new Promise((resolve, reject) => {
    const { port1, port2 } = new MessageChannel();
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true; port1.close();
      error ? reject(new Error('stagehand.inference-unavailable')) : resolve(value);
    };
    port1.once('message', result => finish(result?.ok !== true, result?.value));
    port1.once('messageerror', () => finish(true));
    port1.once('close', () => finish(true));
    try { inferencePort.postMessage({ params, reply: port2 }, [port2]); }
    catch { port2.close(); finish(true); }
  }) };
}
