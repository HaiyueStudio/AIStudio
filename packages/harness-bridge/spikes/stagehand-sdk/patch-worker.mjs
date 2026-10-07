// Patch only the fixed, reviewed rc.2 worker. Drift must trigger a fresh review.
import { createHash } from 'node:crypto';
export function patchWorker(source, expectedSha256) {
  if (createHash('sha256').update(source).digest('hex') !== expectedSha256) throw new Error('stagehand.worker-drift');
  const replaceOnce = (from, to) => {
    if (source.split(from).length !== 2) throw new Error('stagehand.patch-anchor-drift');
    source = source.replace(from, to);
  };
  source = 'import { clientModel } from "./client-model.mjs";\n' + source;
  // The probe is client-only; no native credential route or silent fallback remains.
  replaceOnce('\t\tmodel: config.model,\n\t\tlogging: { level: "off" }', '\t\tmodel: clientModel(config.inferencePort),\n\t\tcache: false,\n\t\ttelemetry: { traces: { endpoint: config.traceEndpoint, headers: {} } },\n\t\tlogging: { level: "off" }');
  replaceOnce('\tmodel: stagehandModelSchema,', '\tinferencePort: z.instanceof(MessagePort),\n\ttraceEndpoint: z.url(),');
  // This utility is used only for an unreachable closed-union guard. Avoid installing
  // another DSH closure in the isolated probe; preserve throw behavior locally.
  replaceOnce('import { assertNever } from "@deepseek-ai/dsh-util-values";', 'const assertNever = () => { throw new Error("stagehand.unsupported-operation"); };');
  return source;
}
