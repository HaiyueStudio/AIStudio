import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalStringify, sha256, type ConversationOperationLog } from '@haiyue/ai-studio-operation-log';
import { asStableId, type AgentTurnConfigV2, type JsonObject } from '@haiyue/ai-studio-contracts';
import type { AgentRuntimeService } from '@haiyue/ai-studio-agent-runtime';
import { createRuntimeSubtaskPort, type SubtaskOptions } from '@haiyue/ai-studio-agent-orchestration';

/** Bind measured admission to the installed code, including dirty local builds, not just a Git label. */
export async function parallelBuildIdentity(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && /\.(?:js|json)$/.test(entry.name)) { hash.update(path.relative(root,file)); hash.update(await readFile(file)); }
    }
  }
  hash.update(await readFile(path.join(root,'package-lock.json')));
  await visit(path.join(root,'apps/ai-studio/dist'));
  for (const entry of (await readdir(path.join(root,'packages'), {withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) if (entry.isDirectory()) await visit(path.join(root,'packages',entry.name,'dist'));
  return `sha256:${hash.digest('hex')}`;
}
/** Only a device-local, bounded evidence bundle is admitted. The model cannot supply paths or activate it. */
export async function loadParallelQualification(file: string, sourceRevision: string): Promise<{ reason: string; create?: (runtime: AgentRuntimeService, log: ConversationOperationLog, config: AgentTurnConfigV2, facts: SubtaskOptions['facts']) => SubtaskOptions }> {
  let bundle: Record<string, unknown>;
  try { if ((await stat(file)).size > 256 * 1024) throw new Error(); bundle = JSON.parse(await readFile(file,'utf8')); }
  catch { return {reason:'qualification-bundle-unavailable'}; }
  if (!bundle || Object.keys(bundle).sort().join(',') !== 'artifacts,cohort,expiresAt,reportRef,schemaVersion,sourceRevision' || bundle.schemaVersion !== 1 || bundle.sourceRevision !== sourceRevision
    || bundle.cohort !== 'independent-artifact-research-v1' || typeof bundle.reportRef !== 'string'
    || !Number.isSafeInteger(bundle.expiresAt) || Number(bundle.expiresAt) <= Date.now() || !Array.isArray(bundle.artifacts) || bundle.artifacts.length > 2048) return {reason:'qualification-bundle-invalid-or-stale'};
  const values = new Map<string, JsonObject>();
  for (const entry of bundle.artifacts) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'ref,value' || typeof entry.ref !== 'string' || !entry.value || typeof entry.value !== 'object' || Array.isArray(entry.value)
      || entry.ref !== `artifact:sha256:${sha256(canonicalStringify(entry.value))}` || values.has(entry.ref)) return {reason:'qualification-artifact-invalid'};
    values.set(entry.ref,entry.value);
  }
  if (!values.has(bundle.reportRef)) return {reason:'qualification-report-missing'};
  const reportRef = bundle.reportRef, cohort = bundle.cohort, expiresAt = Number(bundle.expiresAt);
  return {reason:'qualification-required-per-plan', create(runtime, log, config, facts) {
    const backend = runtime.registry.get(asStableId(config.backendId));
    // This capability check is provider-neutral; only the registered adapter owns backend shutdown.
    if (!('detach' in backend) || typeof backend.detach !== 'function') throw new Error('parallel.detach-unavailable');
    const detach = backend.detach.bind(backend) as (id: string) => Promise<void>;
    let retained: Promise<void> | undefined;
    const retain = () => retained ??= (async () => {
      const snapshot = { schemaVersion: 1, sourceRevision, cohort, reportRef, expiresAt, artifacts: [...values].map(([ref,value]) => ({ref,value})) };
      const artifact = await log.putArtifact(snapshot, {schemaVersion:'parallel-qualification-bundle/1'});
      if (artifact.digest !== sha256(canonicalStringify(snapshot))) throw new Error('parallel.evidence-redacted');
      await log.append({kind:'agent/parallel-evidence',severity:'info',source:asStableId('studio.parallel'),correlation:{},payload:{artifactId:artifact.id,reportRef},artifactRefs:[artifact.id]});
    })();
    return { enabled: true, port: createRuntimeSubtaskPort(runtime, asStableId(config.backendId), config, detach), facts,
      caps: { inputTokens: 8192, outputTokens: 2048, estimatedCostMicros: 100_000, wallTimeMs: 60_000 },
      qualify: async () => { if (Date.now() >= expiresAt) return null; await retain(); return reportRef; },
      qualification: { sourceRevision, cohortFor: () => cohort, async load(ref, signal) {
        signal.throwIfAborted(); if (Date.now() >= expiresAt) throw new Error('parallel.qualification-expired');
        await retain(); signal.throwIfAborted();
        const value = values.get(ref); if (!value) throw new Error('parallel.evidence-missing');
        // Values are bounded, digest-checked members of the retained immutable bundle.
        return structuredClone(value);
      } },
    };
  } };
}
