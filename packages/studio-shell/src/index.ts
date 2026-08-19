import type { EditorContributionKind } from '@haiyue/editor-plugin-sdk';
import type { EditorShellLayoutSnapshot } from '@haiyue/editor-shell';
import {
  asStableId,
  createStudioServiceToken,
  defineStudioPlugin,
  type JsonObject,
  type StableId,
  type StudioPluginDefinition,
} from '@haiyue/ai-studio-contracts';

export const STUDIO_PANEL_IDS = Object.freeze({
  hierarchy: asStableId('studio.panel.hierarchy'),
  viewport: asStableId('studio.panel.viewport'),
  inspector: asStableId('studio.panel.inspector'),
  script: asStableId('studio.panel.script'),
  chat: asStableId('studio.panel.chat'),
  logs: asStableId('studio.panel.logs'),
});

export type StudioPanelId = typeof STUDIO_PANEL_IDS[keyof typeof STUDIO_PANEL_IDS];

export interface StudioPanelDescriptor {
  readonly id: StudioPanelId;
  readonly editorKind: Extract<EditorContributionKind, 'panel'>;
  readonly title: string;
  readonly region: 'left' | 'center' | 'right' | 'bottom';
  readonly order: number;
  readonly placeholder: boolean;
}

export interface StudioWorkspaceLayoutReadModel extends EditorShellLayoutSnapshot {
  readonly panels: readonly StudioPanelDescriptor[];
  readonly loggingAvailable: boolean;
  readonly diagnosticBanner: string | null;
}

export interface StudioWorkspaceLayoutService {
  snapshot(): StudioWorkspaceLayoutReadModel;
  setLoggingState(available: boolean, diagnostic?: string): void;
  activatePanel(id: StudioPanelId): void;
  subscribe(listener: (snapshot: StudioWorkspaceLayoutReadModel) => void): Readonly<{ dispose(): void }>;
}

export const studioWorkspaceLayoutToken = createStudioServiceToken<StudioWorkspaceLayoutService>('studio.workspace-layout');
export const studioPanelContributionKind = asStableId('studio.contribution.panel');

export const DEFAULT_STUDIO_PANELS: readonly StudioPanelDescriptor[] = Object.freeze([
  panel(STUDIO_PANEL_IDS.hierarchy, 'Hierarchy', 'left', 10),
  panel(STUDIO_PANEL_IDS.viewport, 'Viewport', 'center', 10),
  panel(STUDIO_PANEL_IDS.inspector, 'Inspector', 'right', 10),
  panel(STUDIO_PANEL_IDS.script, 'Script', 'bottom', 10),
  panel(STUDIO_PANEL_IDS.chat, 'Chat', 'right', 20),
  panel(STUDIO_PANEL_IDS.logs, 'Logs', 'bottom', 20),
]);

export function createStudioWorkspaceLayoutPlugin(): StudioPluginDefinition<JsonObject> {
  return defineStudioPlugin({
    manifest: {
      schemaVersion: 1,
      id: asStableId('studio.workspace-layout.plugin'),
      version: '0.0.0',
      apiVersion: '1.0',
      required: [],
      optional: [],
      provides: [{ id: asStableId('studio.workspace-layout'), version: '1.0.0' }],
      contributions: [studioPanelContributionKind],
      activationPolicy: 'required',
    },
    validateConfig(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0) {
        throw new TypeError('Workspace layout config must be empty.');
      }
      return Object.freeze({});
    },
    activate(context) {
      const service = new WorkspaceLayoutService(DEFAULT_STUDIO_PANELS);
      context.effects.own('workspace-layout.dispose', () => service.dispose());
      context.services.provide(studioWorkspaceLayoutToken, service);
      for (const descriptor of DEFAULT_STUDIO_PANELS) {
        context.contributions.register({ id: descriptor.id, kind: studioPanelContributionKind, value: descriptor, priority: 100 - descriptor.order });
      }
    },
  });
}

class WorkspaceLayoutService implements StudioWorkspaceLayoutService {
  private revision = 0;
  private activePanelId: StudioPanelId | null = STUDIO_PANEL_IDS.viewport;
  private loggingAvailable = true;
  private diagnosticBanner: string | null = null;
  private listeners = new Set<(snapshot: StudioWorkspaceLayoutReadModel) => void>();
  private disposed = false;

  constructor(private readonly panels: readonly StudioPanelDescriptor[]) {}

  snapshot(): StudioWorkspaceLayoutReadModel {
    this.assertActive();
    return Object.freeze({
      revision: this.revision,
      activePanelId: this.activePanelId,
      hiddenPanelIds: Object.freeze([]),
      panels: this.panels,
      loggingAvailable: this.loggingAvailable,
      diagnosticBanner: this.diagnosticBanner,
    });
  }

  setLoggingState(available: boolean, diagnostic?: string): void {
    this.assertActive();
    this.loggingAvailable = available;
    this.diagnosticBanner = available ? null : diagnostic ?? 'Operation Log unavailable; editing and runtime actions are disabled.';
    this.revision += 1;
    this.emit();
  }

  activatePanel(id: StudioPanelId): void {
    this.assertActive();
    if (!this.panels.some((entry) => entry.id === id)) throw new Error(`Unknown Studio panel ${id}.`);
    this.activePanelId = id;
    this.revision += 1;
    this.emit();
  }

  subscribe(listener: (snapshot: StudioWorkspaceLayoutReadModel) => void): Readonly<{ dispose(): void }> {
    this.assertActive();
    this.listeners.add(listener);
    listener(this.snapshot());
    let active = true;
    return Object.freeze({ dispose: () => { if (active) { active = false; this.listeners.delete(listener); } } });
  }

  dispose(): void { if (!this.disposed) { this.disposed = true; this.listeners.clear(); } }
  private emit(): void { const snapshot = this.snapshot(); for (const listener of [...this.listeners]) listener(snapshot); }
  private assertActive(): void { if (this.disposed) throw new Error('Workspace layout is disposed.'); }
}

function panel(id: StableId, title: string, region: StudioPanelDescriptor['region'], order: number): StudioPanelDescriptor {
  return Object.freeze({ id: id as StudioPanelId, editorKind: 'panel', title, region, order, placeholder: true });
}
