import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { isOfficialToolBindingV1, type OfficialToolProviderV1, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import { redactObject } from '@haiyue/ai-studio-operation-log';
import { GameToolProtocolError, type GameToolCall, type GameToolDefinition, type GameToolPreview } from './types.js';

/** Handlers added to the existing catalog/runtime; this adapter owns no approval or scheduler. */
export class OfficialToolAdapter {
  readonly definitions: readonly GameToolDefinition[];
  private readonly validators = new Map<string, { input: ValidateFunction; output: ValidateFunction }>();
  constructor(private readonly provider: OfficialToolProviderV1, builtins: readonly GameToolDefinition[]) {
    if (!provider || typeof provider.execute !== 'function' || !Array.isArray(provider.definitions) || provider.definitions.length > 64) throw invalid('official.provider-invalid');
    const ids = new Set(builtins.map(d => String(d.id)));
    const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
    const ajv2020 = new Ajv2020({ strict: false, allErrors: false, validateFormats: false });
    this.definitions = Object.freeze(provider.definitions.map(definition => {
      if (!isOfficialToolBindingV1({ schemaVersion: 1, providerId: 'provider:host', nativeName: 'validate', definition }) || ids.has(definition.id)) throw invalid('official.definition-invalid');
      ids.add(definition.id);
      const copy = freeze(JSON.parse(JSON.stringify(definition))) as GameToolDefinition;
      const compiler = copy.inputSchema.$schema === 'https://json-schema.org/draft/2020-12/schema' ? ajv2020 : ajv;
      this.validators.set(copy.id, { input: compiler.compile(copy.inputSchema), output: compiler.compile(copy.outputSchema) });
      return copy;
    }));
  }
  has(id: StableId): boolean { return this.validators.has(id); }
  arguments(definition: GameToolDefinition, args: JsonObject): JsonObject {
    const serialized = JSON.stringify(args);
    if (Buffer.byteLength(serialized) > 65536) throw invalid('official.arguments-too-large');
    const copy = JSON.parse(serialized) as JsonObject;
    if (!this.validators.get(definition.id)!.input(copy)) throw invalid('official.arguments-invalid');
    if (redactObject(copy).redactedFields.length) throw invalid('official.credentials-forbidden');
    return freeze(copy);
  }
  preview(definition: GameToolDefinition, args: JsonObject): GameToolPreview {
    return Object.freeze({ title: definition.title, target: definition.id, summary: definition.effect === 'observe' ? 'Read using the configured official provider.' : 'Execute one approved official-provider operation. External effects are not Document undo operations.', diff: JSON.stringify(redactObject(args, { fields: definition.redactedFields }).value).slice(0, 8192) });
  }
  async execute(definition: GameToolDefinition, call: GameToolCall, args: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    signal.throwIfAborted();
    try {
      const raw: unknown = await this.provider.execute({ callId: call.id, sessionId: call.sessionId, turnId: call.turnId, toolId: definition.id, arguments: args }, signal);
      signal.throwIfAborted();
      if (!jsonValue(raw)) throw invalid('official.result-invalid');
      const serialized = JSON.stringify(raw);
      if (!serialized || Buffer.byteLength(serialized) > definition.maxResultBytes || !raw || typeof raw !== 'object' || Array.isArray(raw) || !this.validators.get(definition.id)!.output(raw)) throw invalid('official.result-invalid');
      const result = redactObject(JSON.parse(serialized) as JsonObject, { fields: definition.redactedFields }).value;
      if (!this.validators.get(definition.id)!.output(result)) throw invalid('official.redacted-result-invalid');
      if (result.status === 'error' || result.status === 'unavailable') {
        const code = typeof result.code === 'string' && /^(?:official\.[a-z0-9.-]+|WEB_[A-Z_]+)$/.test(result.code) ? result.code : 'official.execution-failed';
        // Script errors need a bounded, redacted explanation so the next attempt can fix the code.
        const detail = code.startsWith('official.node.') && typeof result.message === 'string' ? result.message.split('\n')[0]!.slice(0, 512) : '';
        throw new GameToolProtocolError(code, detail ? `${code}: ${detail}` : code);
      }
      return freeze(result);
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      if (cause instanceof GameToolProtocolError) throw cause;
      // Provider diagnostics can contain URLs with credentials, headers or process output.
      throw invalid('official.execution-failed');
    }
  }
}
function invalid(code: string): GameToolProtocolError { return new GameToolProtocolError(code, code); }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => jsonValue(item, depth + 1));
  return !!value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.entries(value).every(([key, child]) => !['__proto__','constructor','prototype'].includes(key) && jsonValue(child, depth + 1));
}
