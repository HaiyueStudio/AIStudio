import { asStableId, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import { canonicalStringify } from '@haiyue/ai-studio-operation-log';
import { GameToolProtocolError, type GameToolDefinition } from '../types.js';

/** A stable transport entry, not an editor effect. Resolve it before policy and scheduling. */
export const MODEL_TOOL_INVOKE_DEFINITION = Object.freeze({
  id: asStableId('studio.tool.invoke'),
  description: 'Call a registered Studio tool discovered by tool.search(includeSchemas=true) when it is absent from the supplied native tools. Copy the exact toolId and toolVersion from the search invocation, and supply arguments matching its inputSchema. Studio applies the target tool\'s validation, effects, risk, plan approval, exact authorization, revision checks and task budget. This entry grants no additional capabilities and cannot call itself, shell, filesystem, network or unregistered tools.',
  inputSchema: Object.freeze({
    type: 'object', additionalProperties: false, required: ['toolId', 'toolVersion', 'arguments'],
    properties: {
      toolId: { type: 'string', minLength: 3, maxLength: 128 },
      toolVersion: { type: 'string', minLength: 1, maxLength: 32 },
      arguments: { type: 'object', maxProperties: 256 },
    },
  }) as JsonObject,
});

export interface ModelToolInvocation {
  readonly toolId: StableId;
  readonly toolVersion: string;
  readonly arguments: JsonObject;
}

/** The active editor registry is the allowlist; model-provided policy/schema fields are never used. */
export function resolveModelToolInvocation(value: unknown, definitions: readonly GameToolDefinition[]): ModelToolInvocation {
  if (!isRecord(value) || Object.keys(value).length !== 3
    || Object.keys(value).some((key) => !['toolId', 'toolVersion', 'arguments'].includes(key))
    || typeof value.toolId !== 'string' || value.toolId.length < 3 || value.toolId.length > 128
    || typeof value.toolVersion !== 'string' || value.toolVersion.length < 1 || value.toolVersion.length > 32
    || !isRecord(value.arguments) || Object.keys(value.arguments).length > 256) {
    throw new GameToolProtocolError('tool.invocation-invalid', 'Use { toolId, toolVersion, arguments } from tool.search; policy fields cannot be supplied.');
  }
  const definition = definitions.find((entry) => entry.id === value.toolId && entry.id !== MODEL_TOOL_INVOKE_DEFINITION.id);
  if (!definition) throw new GameToolProtocolError('tool.not-found', 'The requested invocation target is not in the active Studio tool registry.');
  if (definition.version !== value.toolVersion) throw new GameToolProtocolError('tool.version-mismatch', 'The invocation version is stale. Search for the current tool schema before retrying.', true);
  let serialized: string;
  try { serialized = canonicalStringify(value.arguments as JsonObject); }
  catch { throw new GameToolProtocolError('tool.invocation-invalid', 'Invocation arguments must be bounded JSON.'); }
  if (Buffer.byteLength(serialized) > 512 * 1024) throw new GameToolProtocolError('tool.invocation-invalid', 'Invocation arguments exceed the 512 KiB limit.');
  return Object.freeze({ toolId: definition.id, toolVersion: definition.version, arguments: Object.freeze(JSON.parse(serialized)) as JsonObject });
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
