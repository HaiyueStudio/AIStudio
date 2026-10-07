import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { isOfficialToolBindingV1, type OfficialToolReceiptV1, type OfficialToolBindingV1, type OfficialToolProviderV1, type OfficialToolExecutionV1, type JsonObject } from '@haiyue/ai-studio-contracts';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { validateJsonSchemaValue, type ToolExecutionToken } from '@deepseek-ai/dsh-tools';

export interface OfficialToolLifecycle { release(): void; cancelSession(id: string): Promise<void>; }

const owners = new WeakMap<OfficialToolProviderV1, OfficialToolGateway>();
const executions = new AsyncLocalStorage<OfficialToolExecutionV1>();
/** Bridge-private provenance for official service adapters. */
export function currentOfficialExecution(): OfficialToolExecutionV1 | undefined { return executions.getStore(); }
type NativePreparation = (call: OfficialToolExecutionV1, agent: Agent, signal: AbortSignal) => Promise<void>;
export function prepareOfficialNative(port: OfficialToolProviderV1, prepare: NativePreparation): void {
  const gateway = owners.get(port);
  if (!gateway) throw failure('official.provider-invalid');
  const previous = gateway.prepare;
  gateway.prepare = async (call, agent, signal) => { await previous?.(call, agent, signal); signal.throwIfAborted(); await prepare(call, agent, signal); };
}

/** A main-process capability port. Only the existing Host tool runtime receives it. */
export function createHarnessOfficialToolProvider(values: readonly OfficialToolBindingV1[], nativeParameters: Readonly<Record<string, JsonObject>> = {}): OfficialToolProviderV1 {
  const gateway = new OfficialToolGateway(values, nativeParameters);
  const port: OfficialToolProviderV1 = Object.freeze({ definitions: Object.freeze(gateway.bindings.map(b => b.definition)), execute: gateway.execute.bind(gateway) });
  owners.set(port, gateway);
  return port;
}

/** Internal bridge composition; never expose Cordis or Agent through the public provider port. */
export function bindOfficialTools(port: OfficialToolProviderV1, context: Context, agent: (sessionId: string) => Agent | undefined, studioNames: (sessionId: string) => ReadonlySet<string>): OfficialToolLifecycle {
  const gateway = owners.get(port);
  if (!gateway) throw failure('official.provider-invalid');
  return gateway.bind(context, agent, studioNames);
}

class OfficialToolGateway {
  prepare?: NativePreparation;
  readonly bindings: readonly OfficialToolBindingV1[];
  private binding?: { context: Context; agent: (id: string) => Agent | undefined };
  private readonly tickets = new Map<string, { call: OfficialToolExecutionV1; name: string; digest: string; agent: Agent; token?: ToolExecutionToken; started: boolean }>();
  private consumed = new WeakMap<Agent, Set<string>>();
  private readonly nested = new AsyncLocalStorage<boolean>();
  private readonly active = new Map<AbortController, string>();
  private readonly draining = new Map<Promise<unknown>, string>();
  constructor(values: readonly OfficialToolBindingV1[], private readonly nativeParameters: Readonly<Record<string, JsonObject>>) {
    if (!Array.isArray(values) || values.length > 64 || values.some(v => !isOfficialToolBindingV1(v))) throw failure('official.binding-invalid');
    this.bindings = freeze(JSON.parse(JSON.stringify(values)));
    if (new Set(values.map(v => v.definition.id)).size !== values.length || new Set(values.map(v => v.nativeName)).size !== values.length) throw failure('official.binding-duplicate');
  }
  bind(context: Context, agent: (id: string) => Agent | undefined, studioNames: (id: string) => ReadonlySet<string>): OfficialToolLifecycle {
    if (this.binding) throw failure('official.provider-already-bound');
    this.prepare = undefined; // Readiness hooks belong to this owner, never a previous profile activation.
    this.binding = { context, agent };
    // This guard is monotonic: pre-execute policies cannot allow an unapproved native call.
    context.tools.guard(exec => {
      if (exec.parent) return 'official.nested-call-denied';
      const ticket = this.tickets.get(String(exec.callId));
      if (ticket && ticket.agent === exec.agent && ticket.name === exec.name && ticket.digest === digest(exec.arguments) && (!ticket.token || ticket.token === exec.token)) { ticket.token = exec.token; return; }
      if (this.nested.getStore()) return 'official.nested-call-denied';
      if (exec.agent && studioNames(String(exec.agent.id)).has(exec.name)) return;
      return 'official.host-authorization-required';
    });
    context.on('tools/execute', async (exec, next) => {
      const ticket = this.tickets.get(String(exec.callId));
      if (!ticket) return next(); // Studio wrappers only; native calls without a ticket were denied by the guard.
      if (ticket.token !== exec.token || ticket.started) throw failure('official.ticket-consumed');
      ticket.started = true;
      return this.nested.run(true, next);
    });
    // Native plugin tools stay behind Studio's selected wrappers / discovery route.
    context.on('system-prompt/assemble', async (_assembly, input, next) => {
      const assembly = await next();
      if (!input.scope) return assembly;
      const names = studioNames(String('id' in input.scope ? input.scope.id : ''));
      return { ...assembly, tools: assembly.tools.filter(tool => names.has(tool.name)) };
    });
    context.effect(() => async () => {
      this.binding = undefined;
      for (const controller of this.active.keys()) controller.abort(failure('official.provider-disposed'));
      await Promise.allSettled([...this.draining.keys()]);
      this.tickets.clear(); this.consumed = new WeakMap(); this.nested.disable(); this.prepare = undefined;
    }, 'studio.official-tools.dispose');
    return { release: () => { this.binding = undefined; for (const controller of this.active.keys()) controller.abort(failure('official.provider-disposed')); }, cancelSession: async id => { for (const [controller, session] of this.active) if (session === id) controller.abort(failure('official.session-cancelled')); await Promise.allSettled([...this.draining].filter(([,session]) => session === id).map(([promise]) => promise)); } };
  }
  execute(call: OfficialToolExecutionV1, signal: AbortSignal, receipt?: (value: OfficialToolReceiptV1, previewSource?: unknown) => Promise<void>): Promise<JsonObject> {
    const promise = this.run(call, signal, receipt);
    this.draining.set(promise, call.sessionId);
    void promise.finally(() => this.draining.delete(promise)).catch(() => {});
    return promise;
  }
  private async run(call: OfficialToolExecutionV1, signal: AbortSignal, receipt?: (value: OfficialToolReceiptV1, previewSource?: unknown) => Promise<void>): Promise<JsonObject> {
    signal.throwIfAborted();
    const owner = this.binding, spec = this.bindings.find(b => b.definition.id === call.toolId);
    const agent = owner?.agent(call.sessionId);
    if (!owner || !agent || !spec) throw failure('official.provider-unavailable');
    const identity = JSON.stringify([call.sessionId, call.turnId, call.callId]);
    const consumed = this.consumed.get(agent) ?? new Set<string>();
    this.consumed.set(agent, consumed);
    if (consumed.has(identity)) throw failure('official.call-consumed');
    if (validateJsonSchemaValue(spec.definition.inputSchema, call.arguments).length) throw failure('official.arguments-invalid');
    consumed.add(identity);
    const id = `official:${randomUUID()}`;
    const controller = new AbortController(); this.active.set(controller, call.sessionId);
    const combined = AbortSignal.any([signal, controller.signal]);
    let reported = false;
    const report = async (value: OfficialToolReceiptV1, previewSource?: unknown) => { reported = true; await receipt?.(value, previewSource); };
    try {
      await this.prepare?.(call, agent, combined);
      combined.throwIfAborted();
      // Reconnect or replacement must not silently change approved schemas.
      const native = owner.context.tools.get(spec.nativeName, agent);
      if (!native || digest(native.parameters) !== digest(this.nativeParameters[spec.nativeName] ?? spec.definition.inputSchema) || digest(native.output.schema) !== digest(spec.definition.outputSchema)) throw failure('official.schema-drift');
      this.tickets.set(id, { call, agent, name: spec.nativeName, digest: digest(call.arguments), started: false });
      const result = await executions.run(call, () => this.nested.run(true, () => owner.context.tools.execute({ callId: ToolCallId(id), rootCallId: ToolCallId(call.callId), name: spec.nativeName, arguments: call.arguments, agent, signal: combined })));
      const reason: OfficialToolReceiptV1['reason'] = combined.aborted ? 'cancelled' : result.isError ? 'provider-error'
        : result.additionalContexts?.length || result.concludesTurn || result.content.some(b => b.type !== 'text') ? 'unsupported-result'
        : !result.value || typeof result.value !== 'object' || Array.isArray(result.value) ? 'invalid-result'
        : Buffer.byteLength(JSON.stringify(result.value)) > spec.definition.maxResultBytes ? 'oversized-result' : 'none';
      const execution = result.isError ? (this.tickets.get(id)?.started ? 'unknown' : 'not-started') : 'completed';
      // Persist a bounded receipt even if cancellation arrived after the provider finished.
      // Rendered text loses field boundaries. Only the Host may turn structured
      // values into a bounded preview after applying its redaction policy.
      await report({ schemaVersion: 1, execution, delivery: reason === 'none' ? 'available' : 'unavailable', reason }, reason !== 'none' && !result.isError ? result.value : undefined);
      combined.throwIfAborted();
      if (result.isError) throw failure('official.execution-failed');
      if (reason !== 'none') throw failure(reason === 'oversized-result' ? 'official.result-too-large' : reason === 'unsupported-result' ? 'official.result-unsupported' : 'official.result-invalid');
      return result.value as JsonObject;
    } catch (cause) {
      if (!reported) await report({ schemaVersion: 1, execution: this.tickets.get(id)?.started ? 'unknown' : 'not-started', delivery: 'unavailable', reason: combined.aborted ? 'cancelled' : 'provider-error' });
      throw cause;
    } finally { this.tickets.delete(id); this.active.delete(controller); }
  }
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b))) : v)).digest('hex'); }
function failure(code: string): Error { return Object.assign(new Error(code), { code }); }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
