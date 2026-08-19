import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis';
import {
  asStableId,
  type JsonObject,
  type StableId,
  type StudioContribution,
  type StudioDiagnostic,
  type StudioDisposable,
  type StudioDisposer,
  type StudioEventEnvelope,
  type StudioKernelHost,
  type StudioKernelSnapshot,
  type StudioPluginActivationContext,
  type StudioPluginDefinition,
  type StudioPluginSnapshot,
  type StudioProfileDefinition,
  type StudioResolvedProfileRow,
  type StudioServiceToken,
} from '@haiyue/ai-studio-contracts';
import { optionalCapabilityState, resolveStudioProfile, satisfiesVersion } from '@haiyue/ai-studio-kernel';

export interface HarnessStudioRootOptions {
  readonly diagnostic?: (diagnostic: StudioDiagnostic) => void;
  readonly durableEvent?: (event: StudioEventEnvelope) => void;
  readonly liveEvent?: (event: StudioEventEnvelope) => void;
}

interface PluginTracker {
  readonly definition: StudioPluginDefinition;
  readonly row: StudioResolvedProfileRow;
  readonly services: Set<string>;
  readonly contributions: Set<string>;
  readonly listeners: Set<string>;
  readonly effects: Set<string>;
  readonly diagnostics: StudioDiagnostic[];
  optionalCapabilities: Readonly<Record<string, boolean>>;
  state: StudioPluginSnapshot['state'];
  fiber?: Fiber;
  ownerActive: boolean;
  abort?: AbortController;
}

interface ContributionEntry {
  readonly owner: PluginTracker;
  readonly contribution: StudioContribution;
}

interface StudioEventContext {
  on(
    event: 'studio/durable' | 'studio/live',
    listener: (event: StudioEventEnvelope) => void,
    options?: { readonly global?: boolean },
  ): () => unknown;
  emit(event: 'studio/durable' | 'studio/live', payload: StudioEventEnvelope): void;
}

export function createHarnessStudioRoot(options: HarnessStudioRootOptions = {}): StudioKernelHost {
  return new HarnessStudioRoot(options);
}

class HarnessStudioRoot implements StudioKernelHost {
  private readonly context = new Context();
  private readonly active = new Map<string, PluginTracker>();
  private readonly contributions = new Map<string, ContributionEntry>();
  private readonly diagnostics: StudioDiagnostic[] = [];
  private profileId: StableId | null = null;
  private resolvedDump: string | null = null;
  private generation = 0;
  private state: StudioKernelSnapshot['state'] = 'idle';
  private disposed = false;

  constructor(private readonly options: HarnessStudioRootOptions) {
    const events = studioEvents(this.context);
    if (options.durableEvent) events.on('studio/durable', options.durableEvent, { global: true });
    if (options.liveEvent) events.on('studio/live', options.liveEvent, { global: true });
  }

  async activate(profile: StudioProfileDefinition, catalog: readonly StudioPluginDefinition[]): Promise<void> {
    this.assertUsable();
    if (this.state !== 'idle' || this.active.size > 0) throw new Error('Studio root already has an active profile.');
    await this.activateInternal(profile, catalog);
  }

  async replace(profile: StudioProfileDefinition, catalog: readonly StudioPluginDefinition[]): Promise<void> {
    this.assertUsable();
    await this.disposeActivePlugins();
    this.profileId = null;
    this.resolvedDump = null;
    this.state = 'idle';
    await this.activateInternal(profile, catalog);
  }

  async disable(pluginId: StableId): Promise<void> {
    this.assertUsable();
    const tracker = this.active.get(pluginId);
    if (!tracker) return;
    const provided = new Set(tracker.definition.manifest.provides.map((capability) => capability.id));
    const dependents = [...this.active.values()]
      .filter((candidate) => candidate !== tracker && candidate.state !== 'disposed')
      .filter((candidate) => candidate.definition.manifest.required.some((requirement) => provided.has(requirement.id)))
      .map((candidate) => candidate.definition.manifest.id)
      .sort();
    if (dependents.length > 0) throw new Error(`Cannot disable ${pluginId}; active dependents: ${dependents.join(', ')}.`);
    await this.disposeTracker(tracker);
    this.active.delete(pluginId);
  }

  snapshot(): StudioKernelSnapshot {
    const plugins = [...this.active.values()]
      .sort((left, right) => left.row.activationIndex - right.row.activationIndex)
      .map((tracker) => this.pluginSnapshot(tracker));
    return Object.freeze({
      profileId: this.profileId,
      generation: this.generation,
      state: this.state,
      plugins: Object.freeze(plugins),
      diagnostics: Object.freeze([...this.diagnostics]),
      resources: Object.freeze({
        services: plugins.reduce((sum, plugin) => sum + plugin.serviceCount, 0),
        contributions: plugins.reduce((sum, plugin) => sum + plugin.contributionCount, 0),
        listeners: [...this.active.values()].reduce((sum, plugin) => sum + plugin.listeners.size, 0),
        effects: plugins.reduce((sum, plugin) => sum + plugin.effectCount, 0),
        fibers: [...this.active.values()].filter((plugin) => plugin.fiber?.uid != null).length,
      }),
    });
  }

  dumpResolvedProfile(): string | null { return this.resolvedDump; }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.state = 'disposing';
    await this.disposeActivePlugins();
    await this.context.fiber.dispose();
    this.profileId = null;
    this.resolvedDump = null;
    this.state = 'disposed';
  }

  private async activateInternal(profile: StudioProfileDefinition, catalog: readonly StudioPluginDefinition[]): Promise<void> {
    const resolved = resolveStudioProfile(profile, catalog);
    const definitions = new Map(catalog.map((definition) => [definition.manifest.id, definition]));
    const requiredProviders = requiredProviderIds(resolved.rows, definitions);
    this.state = 'activating';
    this.generation += 1;
    const generation = this.generation;
    this.profileId = resolved.id;
    this.resolvedDump = resolved.configDump;
    for (const diagnostic of resolved.diagnostics) this.report(diagnostic);
    try {
      for (const row of resolved.rows) {
        if (this.disposed || generation !== this.generation) throw new Error('Studio profile activation was superseded.');
        const definition = definitions.get(row.pluginId);
        if (!definition) throw new Error(`Resolved plugin ${row.pluginId} is absent from catalog.`);
        const tracker: PluginTracker = {
          definition, row,
          services: new Set(), contributions: new Set(), listeners: new Set(), effects: new Set(), diagnostics: [],
          optionalCapabilities: Object.freeze({}), state: 'installed', ownerActive: false,
        };
        this.active.set(row.pluginId, tracker);
        try {
          await this.activateTracker(tracker, row.config, generation);
        } catch (cause) {
          tracker.state = 'failed';
          this.reportFor(tracker, {
            code: 'STUDIO_PLUGIN_ACTIVATION_FAILED', severity: 'error',
            message: `Plugin ${row.pluginId} activation failed.`, pluginId: row.pluginId, cause,
          });
          await this.disposeTracker(tracker);
          if (definition.manifest.activationPolicy === 'required' || requiredProviders.has(row.pluginId)) throw cause;
        }
      }
      this.state = 'active';
    } catch (cause) {
      this.state = 'failed';
      await this.disposeActivePlugins();
      this.profileId = null;
      this.resolvedDump = null;
      throw cause;
    }
  }

  private async activateTracker(tracker: PluginTracker, rawConfig: JsonObject, generation: number): Promise<void> {
    tracker.state = 'loading';
    const plugin = this.cordisPlugin(tracker, generation);
    const fiber = this.context.plugin(plugin, rawConfig);
    tracker.fiber = fiber;
    await fiber;
    if (!tracker.ownerActive || generation !== this.generation || this.disposed) {
      await fiber.dispose();
      throw new Error(`Plugin ${tracker.definition.manifest.id} completed after its owner was invalidated.`);
    }
    tracker.state = Object.values(tracker.optionalCapabilities).some((available) => !available) ? 'degraded' : 'active';
  }

  private cordisPlugin(tracker: PluginTracker, generation: number): Plugin<JsonObject> {
    const definition = tracker.definition;
    const bridge = this;
    const callback = async (ctx: Context, config: JsonObject) => {
      const abort = new AbortController();
      tracker.abort = abort;
      tracker.ownerActive = true;
      ctx.effect(() => () => {
        tracker.ownerActive = false;
        abort.abort(new Error(`Plugin ${definition.manifest.id} owner disposed.`));
      }, `studio.owner(${definition.manifest.id})`);

      for (const capability of definition.manifest.provides) {
        bridge.provideTracked(ctx, tracker, capabilityServiceName(capability.id), Object.freeze({
          id: capability.id,
          version: capability.version,
          pluginId: definition.manifest.id,
        }));
      }
      const available = new Map<string, string>();
      for (const requirement of definition.manifest.optional) {
        const marker = ctx.get(capabilityServiceName(requirement.id), true) as { version?: string } | undefined;
        if (marker?.version) available.set(requirement.id, marker.version);
      }
      tracker.optionalCapabilities = optionalCapabilityState(definition.manifest.optional, available);
      for (const [capability, isAvailable] of Object.entries(tracker.optionalCapabilities)) {
        if (!isAvailable) bridge.reportFor(tracker, {
          code: 'STUDIO_PLUGIN_OPTIONAL_CAPABILITY_DEGRADED', severity: 'warning',
          message: `Plugin ${definition.manifest.id} activated without optional capability ${capability}.`,
          pluginId: definition.manifest.id, capabilityId: asStableId(capability),
        });
      }
      const activationContext = bridge.activationContext(ctx, tracker, generation, abort);
      const result = await definition.activate(activationContext, config);
      activationContext.owner.assertActive();
      if (result) activationContext.effects.own(`studio.plugin-result(${definition.manifest.id})`, result);
    };
    return {
      name: `studio:${definition.manifest.id}`,
      inject: definition.manifest.required.map((requirement) => capabilityServiceName(requirement.id)),
      Config: standardSchema(definition.validateConfig, definition.manifest.id),
      apply: callback,
    };
  }

  private activationContext(ctx: Context, tracker: PluginTracker, generation: number, abort: AbortController): StudioPluginActivationContext {
    const bridge = this;
    const owner = Object.freeze({
      id: asStableId(`owner:${tracker.definition.manifest.id}:${generation}`),
      generation,
      signal: abort.signal,
      get active() { return tracker.ownerActive && generation === bridge.generation && !bridge.disposed; },
      assertActive() {
        if (!this.active) throw new Error(`Owner ${this.id} is inactive.`);
      },
    });
    return Object.freeze({
      pluginId: tracker.definition.manifest.id,
      rowId: tracker.row.id,
      owner,
      services: Object.freeze({
        provide<T>(token: StudioServiceToken<T>, value: T): StudioDisposable {
          return bridge.provideTracked(ctx, tracker, serviceName(token), value);
        },
        get<T>(token: StudioServiceToken<T>): T {
          const value = ctx.get(serviceName(token), true) as T | undefined;
          if (value === undefined) throw new Error(`Required Studio service ${token.id} is unavailable.`);
          return value;
        },
        optional<T>(token: StudioServiceToken<T>): T | undefined { return ctx.get(serviceName(token), true) as T | undefined; },
        has<T>(token: StudioServiceToken<T>): boolean { return ctx.get(serviceName(token), true) !== undefined; },
      }),
      contributions: Object.freeze({
        register<T>(contribution: StudioContribution<T>): StudioDisposable {
          const key = `${contribution.kind}:${contribution.id}`;
          if (bridge.contributions.has(key)) throw new Error(`Contribution ${key} is already registered.`);
          const frozen = Object.freeze({ ...contribution });
          bridge.contributions.set(key, { owner: tracker, contribution: frozen });
          tracker.contributions.add(key);
          const raw = ctx.provide(contributionServiceName(contribution), frozen);
          return bridge.wrapDisposer(raw, () => {
            const current = bridge.contributions.get(key);
            if (current?.owner === tracker) bridge.contributions.delete(key);
            tracker.contributions.delete(key);
          });
        },
        list<T = unknown>(kind: StableId): readonly StudioContribution<T>[] {
          return Object.freeze([...bridge.contributions.values()]
            .filter((entry) => entry.contribution.kind === kind)
            .map((entry) => entry.contribution as StudioContribution<T>)
            .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id)));
        },
      }),
      effects: Object.freeze({
        own(label: string, disposer: StudioDisposer): StudioDisposable {
          const key = bridge.effectKey(tracker, label);
          tracker.effects.add(key);
          const raw = ctx.effect(() => async () => {
            try { await disposeValue(disposer); }
            finally { tracker.effects.delete(key); }
          }, label);
          return bridge.wrapDisposer(raw, () => tracker.effects.delete(key));
        },
        acquire(label: string, effect: () => StudioDisposer | Promise<StudioDisposer>): StudioDisposable {
          const key = bridge.effectKey(tracker, label);
          tracker.effects.add(key);
          const raw = ctx.effect(async () => {
            try {
              const disposer = await effect();
              return async () => {
                try { await disposeValue(disposer); }
                finally { tracker.effects.delete(key); }
              };
            } catch (cause) {
              tracker.effects.delete(key);
              throw cause;
            }
          }, label);
          return bridge.wrapDisposer(raw, () => tracker.effects.delete(key));
        },
        get activeCount() { return tracker.effects.size; },
      }),
      events: Object.freeze({
        emitDurable(event: StudioEventEnvelope): void { owner.assertActive(); studioEvents(ctx).emit('studio/durable', event); },
        emitLive(event: StudioEventEnvelope): void { owner.assertActive(); studioEvents(ctx).emit('studio/live', event); },
        onDurable(listener: (event: StudioEventEnvelope) => void): StudioDisposable {
          return bridge.trackListener(ctx, tracker, 'studio/durable', listener);
        },
        onLive(listener: (event: StudioEventEnvelope) => void): StudioDisposable {
          return bridge.trackListener(ctx, tracker, 'studio/live', listener);
        },
      }),
      optionalCapabilities: tracker.optionalCapabilities,
      report(diagnostic: StudioDiagnostic): void { bridge.reportFor(tracker, diagnostic); },
    });
  }

  private provideTracked(ctx: Context, tracker: PluginTracker, name: string, value: unknown): StudioDisposable {
    const raw = ctx.provide(name, value);
    tracker.services.add(name);
    return this.wrapDisposer(raw, () => tracker.services.delete(name));
  }

  private trackListener(
    ctx: Context,
    tracker: PluginTracker,
    event: 'studio/durable' | 'studio/live',
    listener: (event: StudioEventEnvelope) => void,
  ): StudioDisposable {
    const key = `${event}:${tracker.listeners.size + 1}`;
    tracker.listeners.add(key);
    const raw = studioEvents(ctx).on(event, listener);
    return this.wrapDisposer(raw, () => tracker.listeners.delete(key));
  }

  private wrapDisposer(raw: () => unknown, cleanup: () => void): StudioDisposable {
    let active = true;
    return Object.freeze({
      async dispose() {
        if (!active) return;
        active = false;
        cleanup();
        await raw();
      },
    });
  }

  private effectKey(tracker: PluginTracker, label: string): string { return `${label}:${tracker.effects.size + 1}`; }

  private reportFor(tracker: PluginTracker, diagnostic: StudioDiagnostic): void {
    const normalized = Object.freeze({ ...diagnostic, pluginId: diagnostic.pluginId ?? tracker.definition.manifest.id });
    tracker.diagnostics.push(normalized);
    this.report(normalized);
  }

  private report(diagnostic: StudioDiagnostic): void {
    const frozen = Object.freeze({ ...diagnostic });
    this.diagnostics.push(frozen);
    this.options.diagnostic?.(frozen);
  }

  private pluginSnapshot(tracker: PluginTracker): StudioPluginSnapshot {
    return Object.freeze({
      id: tracker.definition.manifest.id,
      rowId: tracker.row.id,
      version: tracker.definition.manifest.version,
      state: tracker.state,
      activationIndex: tracker.row.activationIndex,
      required: tracker.definition.manifest.required,
      optional: tracker.optionalCapabilities,
      provides: tracker.definition.manifest.provides,
      serviceCount: tracker.services.size,
      contributionCount: tracker.contributions.size,
      effectCount: tracker.fiber ? countEffects(tracker.fiber.getEffects()) : 0,
      diagnostics: Object.freeze([...tracker.diagnostics]),
    });
  }

  private async disposeTracker(tracker: PluginTracker): Promise<void> {
    if (tracker.state === 'disposed') return;
    tracker.state = 'disposing';
    tracker.ownerActive = false;
    tracker.abort?.abort(new Error(`Plugin ${tracker.definition.manifest.id} disposed.`));
    await tracker.fiber?.dispose();
    tracker.services.clear();
    for (const key of tracker.contributions) {
      if (this.contributions.get(key)?.owner === tracker) this.contributions.delete(key);
    }
    tracker.contributions.clear();
    tracker.listeners.clear();
    tracker.effects.clear();
    tracker.state = 'disposed';
  }

  private async disposeActivePlugins(): Promise<void> {
    const trackers = [...this.active.values()].sort((left, right) => right.row.activationIndex - left.row.activationIndex);
    const errors: unknown[] = [];
    for (const tracker of trackers) {
      try { await this.disposeTracker(tracker); }
      catch (cause) { errors.push(cause); }
    }
    this.active.clear();
    this.contributions.clear();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Multiple Studio plugins failed during disposal.');
  }

  private assertUsable(): void { if (this.disposed) throw new Error('Studio root is disposed.'); }
}

function studioEvents(context: Context): StudioEventContext {
  return context as unknown as StudioEventContext;
}

function requiredProviderIds(
  rows: readonly StudioResolvedProfileRow[],
  definitions: ReadonlyMap<string, StudioPluginDefinition>,
): ReadonlySet<string> {
  const providers = new Map<string, string>();
  for (const row of rows) for (const capability of definitions.get(row.pluginId)?.manifest.provides ?? []) providers.set(capability.id, row.pluginId);
  const result = new Set<string>();
  for (const row of rows) {
    for (const requirement of definitions.get(row.pluginId)?.manifest.required ?? []) {
      const provider = providers.get(requirement.id);
      if (provider) result.add(provider);
    }
  }
  return result;
}

function standardSchema<T extends JsonObject>(validate: (value: unknown) => T, pluginId: StableId) {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'haiyue-ai-studio',
      validate(value: unknown) {
        try { return { value: validate(value) }; }
        catch (cause) { return { issues: [{ message: `${pluginId}: ${cause instanceof Error ? cause.message : String(cause)}` }] }; }
      },
    },
  };
}

function capabilityServiceName(id: StableId): string { return `studio.capability.${id}`; }
function serviceName<T>(token: StudioServiceToken<T>): string { return `studio.service.${token.id}`; }
function contributionServiceName(contribution: StudioContribution): string { return `studio.contribution.${contribution.kind}.${contribution.id}`; }

async function disposeValue(disposer: StudioDisposer): Promise<void> {
  if (typeof disposer === 'function') await disposer();
  else await disposer.dispose();
}

function countEffects(effects: readonly { children: readonly unknown[] }[]): number {
  return effects.reduce((sum, effect) => sum + 1 + countEffects(effect.children as readonly { children: readonly unknown[] }[]), 0);
}


export function harnessBridgeUpstreamIdentity(): Readonly<{ cordis: '4.0.1'; harness: '0.1.0-rc.7' }> {
  return Object.freeze({ cordis: '4.0.1', harness: '0.1.0-rc.7' });
}
