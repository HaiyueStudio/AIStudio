import { readFile, readdir } from 'node:fs/promises';
import type { ProjectWorkspace } from '@haiyue/ai-studio-editor-plugins';
import type { ProjectBehaviorPorts } from '@haiyue/ai-studio-agent-orchestration';
import { ProjectBehaviorHistory, canonicalStringify, sha256, type ConversationOperationLog } from '@haiyue/ai-studio-operation-log';
import { BehaviorReadService, DEFAULT_BEHAVIOR_CONFIG, createBehaviorSourceBinding, parseBehaviorContract, validateBehaviorArtifact, createBehaviorRuntimePlan, sealBehaviorRuntimeCapture, assertBehaviorCaptureProgress, associateBehaviorTrace } from '@haiyue/ai-studio-script-preview';

/** Platform-only provenance reads and composition. The existing workspace owns
 * documents/registry; the existing project journal imports and replicates artifacts. */
export function createWorkspaceBehaviorPorts(workspace: ProjectWorkspace, log: ConversationOperationLog): ProjectBehaviorPorts {
  let provenance: ReturnType<typeof loadRuntimeProvenance> | null = null;
  return {
    current: () => { const p = workspace.snapshot().document; return p ? { projectId: p.projectId, documentId: p.documentId, revision: p.revision } : null; },
    async readSource(signal) {
      if (signal.aborted) throw new Error('behavior.cancelled');
      provenance ??= loadRuntimeProvenance();
      const runtime = await provenance;
      if (signal.aborted) throw new Error('behavior.cancelled');
      const project = workspace.snapshot().document; if (!project) throw new Error('behavior.project-unavailable');
      const registry = workspace.componentRegistry.snapshot();
      const ids = [...new Set(registry.definitions.flatMap(d => d.runtimeAdapter ? [d.runtimeAdapter] : []))];
      return { schemaVersion: 1, projectId: project.projectId, document: workspace.gameSnapshot(),
        registry: { version: runtime.registryVersion, definitions: registry.definitions }, config: DEFAULT_BEHAVIOR_CONFIG,
        // This identifies registry-to-bundle provenance only. The graph retains
        // unknown adapter internals until real runtime observations exist.
        adapters: ids.map(id => ({ id, version: runtime.appVersion, digest: `sha256:${sha256(canonicalStringify({ id, bundle: runtime.digest }))}` })),
      };
    },
    validateSource: input => parseBehaviorContract('behavior-analysis-input', input), bindSource: createBehaviorSourceBinding,
    validateLocation: input => parseBehaviorContract('editor-location', input), reader: new BehaviorReadService(),
    history: new ProjectBehaviorHistory({ log, validate: validateBehaviorArtifact }),
    runtime: { prepare: createBehaviorRuntimePlan, capture: sealBehaviorRuntimeCapture, assertProgress: assertBehaviorCaptureProgress, associate: associateBehaviorTrace },
    producerVersion: '0.0.0',
  };
}

async function loadRuntimeProvenance(): Promise<Readonly<{ appVersion: string; registryVersion: string; digest: string }>> {
  const packageVersion = async (url: URL) => {
    const p: unknown = JSON.parse(await readFile(url, 'utf8'));
    if (!p || typeof p !== 'object' || !('version' in p) || typeof p.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(p.version)) throw new Error('behavior.runtime-version');
    return p.version;
  };
  const [appVersion, registryVersion, engineVersion, chunks] = await Promise.all([
    packageVersion(new URL('../package.json', import.meta.url)),
    packageVersion(new URL('../package.json', import.meta.resolve('@haiyue/ai-studio-editor-plugins'))),
    packageVersion(new URL('../package.json', import.meta.resolve('@haiyue/engine'))),
    readdir(new URL('./chunks/', import.meta.url), { withFileTypes: true }),
  ]);
  const names = ['preview-runtime.js', ...chunks.filter(entry => entry.isFile() && /^[\w.-]+\.js$/u.test(entry.name)).map(entry => `chunks/${entry.name}`)].sort();
  if (names.length > 256) throw new Error('behavior.runtime-provenance-budget');
  let bytes = 0;
  const files = [];
  for (const name of names) {
    const data = await readFile(new URL(name, import.meta.url)); bytes += data.byteLength;
    if (bytes > 64 * 1024 * 1024) throw new Error('behavior.runtime-provenance-budget');
    files.push({ name, digest: sha256(data) });
  }
  return { appVersion, registryVersion, digest: `sha256:${sha256(canonicalStringify({ appVersion, registryVersion, engineVersion, files }))}` };
}
