import {
  STUDIO_PROFILE_SCHEMA_VERSION,
  asStableId,
  createStudioServiceToken,
  defineStudioPlugin,
  type JsonObject,
  type JsonValue,
  type StableId,
  type StudioCapabilityRequirement,
  type StudioDiagnostic,
  type StudioPluginDefinition,
  type StudioProfileDefinition,
  type StudioResolvedProfile,
  type StudioResolvedProfileRow,
} from '@haiyue/ai-studio-contracts';
import {
  EditorDocumentHost,
  EditorHistoryService,
  EditorProjectSessionState,
  EditorSelectionService,
  EditorTaskCoordinator,
} from '@haiyue/editor-platform';

export * from '@haiyue/ai-studio-contracts';

export class StudioProfileResolutionError extends Error {
  readonly diagnostics: readonly StudioDiagnostic[];

  constructor(diagnostics: readonly StudioDiagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('\n'));
    this.name = 'StudioProfileResolutionError';
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

export function resolveStudioProfile(
  profile: StudioProfileDefinition,
  catalog: readonly StudioPluginDefinition[],
): StudioResolvedProfile {
  if (profile.schemaVersion !== STUDIO_PROFILE_SCHEMA_VERSION) throw new TypeError(`Unsupported profile schema ${profile.schemaVersion}.`);
  asStableId(profile.id, 'profile id');
  const diagnostics: StudioDiagnostic[] = [];
  const definitions = new Map<string, StudioPluginDefinition>();
  for (const definition of catalog) {
    const id = definition.manifest.id;
    if (definitions.has(id)) diagnostics.push(failure('STUDIO_PLUGIN_DUPLICATE', `Plugin ${id} appears more than once in the catalog.`, id));
    definitions.set(id, definition);
  }

  const rows: Array<{ id: StableId; pluginId: StableId; config: JsonObject; sourceBundleId: StableId; sourceIndex: number }> = [];
  const rowIds = new Set<string>();
  const pluginIds = new Set<string>();
  let sourceIndex = 0;
  for (const bundle of profile.bundles) {
    asStableId(bundle.id, 'bundle id');
    for (const row of bundle.rows) {
      if (!row.enabled) continue;
      if (rowIds.has(row.id)) diagnostics.push(failure('STUDIO_PROFILE_ROW_DUPLICATE', `Profile row ${row.id} is duplicated.`, row.pluginId));
      if (pluginIds.has(row.pluginId)) diagnostics.push(failure('STUDIO_PROFILE_PLUGIN_DUPLICATE', `Plugin ${row.pluginId} has multiple enabled rows.`, row.pluginId));
      rowIds.add(row.id);
      pluginIds.add(row.pluginId);
      rows.push({ id: row.id, pluginId: row.pluginId, config: cloneObject(row.config ?? {}), sourceBundleId: bundle.id, sourceIndex: sourceIndex++ });
    }
  }

  for (const patch of profile.patches) {
    const row = rows.find((candidate) => candidate.pluginId === patch.pluginId);
    if (!row) {
      diagnostics.push(failure('STUDIO_PROFILE_PATCH_TARGET_MISSING', `Config patch targets missing plugin ${patch.pluginId}.`, patch.pluginId));
      continue;
    }
    row.config = mergeJson(row.config, patch.config);
  }

  const providers = new Map<string, { row: (typeof rows)[number]; version: string }>();
  for (const row of rows) {
    const definition = definitions.get(row.pluginId);
    if (!definition) {
      diagnostics.push(failure('STUDIO_PROFILE_PLUGIN_MISSING', `Profile references unknown plugin ${row.pluginId}.`, row.pluginId));
      continue;
    }
    for (const capability of definition.manifest.provides) {
      const existing = providers.get(capability.id);
      if (existing) {
        diagnostics.push(failure(
          'STUDIO_CAPABILITY_AMBIGUOUS',
          `Capability ${capability.id} is provided by both ${existing.row.pluginId} and ${row.pluginId}.`,
          row.pluginId,
          capability.id,
        ));
      } else {
        providers.set(capability.id, { row, version: capability.version });
      }
    }
  }

  const dependencies = new Map<string, Set<string>>(rows.map((row) => [row.pluginId, new Set<string>()]));
  for (const row of rows) {
    const definition = definitions.get(row.pluginId);
    if (!definition) continue;
    for (const requirement of definition.manifest.required) {
      const provider = providers.get(requirement.id);
      if (!provider) {
        diagnostics.push(failure('STUDIO_CAPABILITY_REQUIRED_MISSING', `${row.pluginId} requires ${requirement.id}@${requirement.version}.`, row.pluginId, requirement.id));
      } else if (!satisfiesVersion(provider.version, requirement.version)) {
        diagnostics.push(failure('STUDIO_CAPABILITY_VERSION_MISMATCH', `${row.pluginId} requires ${requirement.id}@${requirement.version}, got ${provider.version}.`, row.pluginId, requirement.id));
      } else if (provider.row.pluginId !== row.pluginId) {
        dependencies.get(row.pluginId)?.add(provider.row.pluginId);
      }
    }
    for (const requirement of definition.manifest.optional) {
      const provider = providers.get(requirement.id);
      if (!provider) {
        diagnostics.push(warning('STUDIO_CAPABILITY_OPTIONAL_MISSING', `${row.pluginId} will run without optional ${requirement.id}@${requirement.version}.`, row.pluginId, requirement.id));
      } else if (!satisfiesVersion(provider.version, requirement.version)) {
        diagnostics.push(warning('STUDIO_CAPABILITY_OPTIONAL_VERSION_MISMATCH', `${row.pluginId} cannot use ${requirement.id}@${provider.version}; expected ${requirement.version}.`, row.pluginId, requirement.id));
      } else if (provider.row.pluginId !== row.pluginId) {
        dependencies.get(row.pluginId)?.add(provider.row.pluginId);
      }
    }
  }

  const fatal = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (fatal.length > 0) throw new StudioProfileResolutionError(diagnostics);
  const ordered = topologicalOrder(rows, dependencies, diagnostics);
  const resolvedRows: StudioResolvedProfileRow[] = ordered.map((row, activationIndex) => Object.freeze({
    id: row.id,
    pluginId: row.pluginId,
    config: deepFreeze(row.config),
    sourceBundleId: row.sourceBundleId,
    activationIndex,
  }));
  const dumpValue = { schemaVersion: 1, id: profile.id, rows: resolvedRows.map(({ activationIndex: _ignored, ...row }) => row) };
  return Object.freeze({
    schemaVersion: 1,
    id: profile.id,
    rows: Object.freeze(resolvedRows),
    configDump: canonicalJson(dumpValue),
    diagnostics: Object.freeze(diagnostics),
  });
}

function topologicalOrder<T extends { pluginId: StableId; sourceIndex: number }>(
  rows: readonly T[],
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  diagnostics: StudioDiagnostic[],
): T[] {
  const remaining = new Map(rows.map((row) => [row.pluginId, new Set(dependencies.get(row.pluginId) ?? [])]));
  const result: T[] = [];
  while (remaining.size > 0) {
    const ready = rows
      .filter((row) => remaining.has(row.pluginId) && remaining.get(row.pluginId)?.size === 0)
      .sort((left, right) => left.sourceIndex - right.sourceIndex || left.pluginId.localeCompare(right.pluginId));
    if (ready.length === 0) {
      const cycle = [...remaining.keys()].sort();
      diagnostics.push(failure('STUDIO_CAPABILITY_DEPENDENCY_CYCLE', `Capability dependency cycle: ${cycle.join(' -> ')}.`, cycle[0] as StableId));
      throw new StudioProfileResolutionError(diagnostics);
    }
    for (const row of ready) {
      remaining.delete(row.pluginId);
      result.push(row);
      for (const values of remaining.values()) values.delete(row.pluginId);
    }
  }
  return result;
}

export function satisfiesVersion(actual: string, requirement: string): boolean {
  const parsedActual = parseVersion(actual);
  if (!parsedActual) return false;
  if (requirement === '*' || actual === requirement) return true;
  if (requirement.startsWith('^')) {
    const minimum = parseVersion(requirement.slice(1));
    return Boolean(minimum && parsedActual[0] === minimum[0] && compareVersion(parsedActual, minimum) >= 0);
  }
  const range = requirement.match(/^>=(\d+\.\d+\.\d+)\s+<(\d+\.\d+\.\d+)$/);
  if (range) {
    const minimum = parseVersion(range[1]);
    const maximum = parseVersion(range[2]);
    return Boolean(minimum && maximum && compareVersion(parsedActual, minimum) >= 0 && compareVersion(parsedActual, maximum) < 0);
  }
  return false;
}

function parseVersion(value: string): readonly [number, number, number] | null {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function failure(code: string, message: string, pluginId?: StableId, capabilityId?: StableId): StudioDiagnostic {
  return Object.freeze({ code, severity: 'error', message, ...(pluginId ? { pluginId } : {}), ...(capabilityId ? { capabilityId } : {}) });
}

function warning(code: string, message: string, pluginId?: StableId, capabilityId?: StableId): StudioDiagnostic {
  return Object.freeze({ code, severity: 'warning', message, ...(pluginId ? { pluginId } : {}), ...(capabilityId ? { capabilityId } : {}) });
}

function mergeJson(base: JsonObject, patch: JsonObject): JsonObject {
  const result: Record<string, JsonValue> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    result[key] = isObject(current) && isObject(value) ? mergeJson(current, value) : cloneJson(value);
  }
  return result;
}

function cloneObject(value: JsonObject): JsonObject { return cloneJson(value) as JsonObject; }
function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)]));
  return value;
}
function isObject(value: unknown): value is JsonObject { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function deepFreeze<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) for (const item of value as readonly JsonValue[]) deepFreeze(item);
  else if (isObject(value)) for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, normalize(child)]));
    return input;
  };
  return JSON.stringify(normalize(value));
}

export const editorFoundationTokens = Object.freeze({
  documents: createStudioServiceToken<EditorDocumentHost>('editor.documents'),
  history: createStudioServiceToken<EditorHistoryService>('editor.history'),
  selection: createStudioServiceToken<EditorSelectionService>('editor.selection'),
  tasks: createStudioServiceToken<EditorTaskCoordinator>('editor.tasks'),
  projectSession: createStudioServiceToken<EditorProjectSessionState>('editor.project-session'),
});

export function createEditorFoundationProviderPlugin(): StudioPluginDefinition {
  return defineStudioPlugin<JsonObject>({
    manifest: {
      schemaVersion: 1,
      id: asStableId('studio.editor-foundations'),
      version: '0.1.0',
      apiVersion: '1.0',
      required: [],
      optional: [],
      provides: [
        { id: asStableId('editor.document'), version: '0.1.0' },
        { id: asStableId('editor.history'), version: '0.1.0' },
        { id: asStableId('editor.selection'), version: '0.1.0' },
        { id: asStableId('editor.tasks'), version: '0.1.0' },
        { id: asStableId('editor.project-session'), version: '0.1.0' },
      ],
      contributions: [],
      activationPolicy: 'required',
    },
    validateConfig(value) {
      if (!isObject(value) || Object.keys(value).length > 0) throw new TypeError('Editor foundation config must be an empty object.');
      return Object.freeze({});
    },
    activate(context) {
      const resources = {
        documents: new EditorDocumentHost(),
        history: new EditorHistoryService(),
        selection: new EditorSelectionService(),
        tasks: new EditorTaskCoordinator(),
        projectSession: new EditorProjectSessionState(),
      };
      context.effects.own('editor-foundations.dispose', async () => {
        await resources.tasks.dispose();
        await resources.documents.dispose();
        resources.selection.dispose();
        resources.history.dispose();
        resources.projectSession.dispose();
      });
      context.services.provide(editorFoundationTokens.documents, resources.documents);
      context.services.provide(editorFoundationTokens.history, resources.history);
      context.services.provide(editorFoundationTokens.selection, resources.selection);
      context.services.provide(editorFoundationTokens.tasks, resources.tasks);
      context.services.provide(editorFoundationTokens.projectSession, resources.projectSession);
    },
  });
}

export function optionalCapabilityState(
  requirements: readonly StudioCapabilityRequirement[],
  available: ReadonlyMap<string, string>,
): Readonly<Record<string, boolean>> {
  return Object.freeze(Object.fromEntries(requirements.map((requirement) => [
    requirement.id,
    available.has(requirement.id) && satisfiesVersion(available.get(requirement.id) ?? '', requirement.version),
  ])));
}
