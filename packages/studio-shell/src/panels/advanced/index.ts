import type { EditorSelectionReference } from '@haiyue/editor-plugin-sdk';
import { adaptAdvancedStudioIntent, invalid, isAdvancedStudioCurrent, json, projectAdvancedStudio, stamp, type AdvancedStudioIntent, type AdvancedStudioSource } from './model.js';
export * from './model.js';

/** Lifecycle facade only. Editor owns the versioned presentation contract. G09 supplies its public package loader. */
interface Mount { update(input: unknown): void; reveal(reference: EditorSelectionReference): boolean; cancel(): void; dispose(): void; }
interface Module { ADVANCED_AUTHORING_API_VERSION: 1; parseAdvancedAuthoringView(input: unknown): unknown; mountAdvancedAuthoring(options: unknown, signal: AbortSignal): Promise<unknown>; }
export interface AdvancedStudioPanelOptions {
  readonly host: HTMLElement;
  readonly viewportHost: HTMLElement;
  readonly source: () => AdvancedStudioSource;
  readonly load: (signal: AbortSignal) => Promise<unknown>;
  /** Owner must recheck stamp immediately before committing through the existing services. */
  readonly dispatch: (intent: AdvancedStudioIntent, signal: AbortSignal) => void | Promise<void>;
  readonly preview: (value: unknown | null) => void;
}
function moduleValue(input: unknown): Module {
  if (!input || typeof input !== 'object') return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of ['ADVANCED_AUTHORING_API_VERSION','parseAdvancedAuthoringView','mountAdvancedAuthoring']) if (!descriptors[key] || !('value' in descriptors[key])) return invalid();
  if (descriptors.ADVANCED_AUTHORING_API_VERSION!.value !== 1 || typeof descriptors.parseAdvancedAuthoringView!.value !== 'function' || typeof descriptors.mountAdvancedAuthoring!.value !== 'function') return invalid();
  return input as Module;
}
function mountValue(input: unknown): Mount {
  if (!input || typeof input !== 'object' || ['update','reveal','cancel','dispose'].some(key => typeof (input as Record<string, unknown>)[key] !== 'function')) return invalid();
  return input as Mount;
}

/** Open/close is retryable. Dispose is final. No lazy result may revive a closed panel. */
export class AdvancedStudioPanel {
  private mount: Mount | null = null;
  private module: Module | null = null;
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private disposed = false;
  constructor(private readonly options: AdvancedStudioPanelOptions) {}
  open(): Promise<void> {
    if (this.disposed) return Promise.reject(Error('advanced-studio.disposed'));
    if (this.mount) { this.update(); return Promise.resolve(); }
    if (this.pending) return this.pending;
    const controller = new AbortController(), generation = ++this.generation; this.controller = controller;
    const owner = this.options.source(), epoch = owner.epoch, documentId = owner.document?.id;
    const alive = () => !this.disposed && generation === this.generation && !controller.signal.aborted;
    const current = () => alive() && this.options.source().epoch === epoch && this.options.source().document?.id === documentId;
    this.pending = (async () => {
      const module = moduleValue(await this.options.load(controller.signal)); if (!current()) return;
      const initial = module.parseAdvancedAuthoringView(projectAdvancedStudio(this.options.source()));
      const mounted = await module.mountAdvancedAuthoring({ host:this.options.host, viewportHost:this.options.viewportHost, initial,
        dispatch: async (input: unknown, signal: AbortSignal) => {
          if (!alive() || signal.aborted) return invalid();
          const source = this.options.source(), intent = adaptAdvancedStudioIntent(input,source);
          const combined = AbortSignal.any([controller.signal,signal]);
          if ('stamp' in intent && !isAdvancedStudioCurrent(this.options.source(),intent.stamp)) return invalid();
          await this.options.dispatch(intent,combined);
          if (alive() && !combined.aborted) this.update();
        },
        preview: (input: unknown) => {
          if (!alive()) return;
          if (input === null) { try { this.options.preview(null); } catch { /* Cleanup remains deterministic. */ } return; }
          const value = json(input), source = this.options.source();
          // A preview has exactly the same bound changes as a commit, but emits no authoring intent.
          adaptAdvancedStudioIntent({ type:'transform', ...value as object }, source);
          const expected = stamp(source); if (isAdvancedStudioCurrent(this.options.source(),expected)) this.options.preview(value);
        },
      },controller.signal);
      let mount: Mount;
      try { mount = mountValue(mounted); } catch (error) { if (mounted && typeof (mounted as Mount).dispose === 'function') (mounted as Mount).dispose(); throw error; }
      if (!current()) { mount.dispose(); return; }
      this.module = module; this.mount = mount; this.update();
    })().catch(error => { if (generation === this.generation) this.close(); throw error; }).finally(() => { if (generation === this.generation) this.pending = null; });
    return this.pending;
  }
  update(): void { if (!this.disposed && this.mount && this.module) this.mount.update(this.module.parseAdvancedAuthoringView(projectAdvancedStudio(this.options.source()))); }
  reveal(reference: EditorSelectionReference): boolean { return !this.disposed && Boolean(this.mount?.reveal(reference)); }
  cancel(): void { if (this.mount) this.mount.cancel(); else this.close(); }
  close(): void { this.generation++; this.controller?.abort(); this.controller = null; this.pending = null; const mount = this.mount; this.mount = null; this.module = null; try { mount?.dispose(); } finally { try { this.options.preview(null); } catch { /* Presentation cleanup. */ } } }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.close(); }
}
