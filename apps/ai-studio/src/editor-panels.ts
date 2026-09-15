import type { EditorLocationV1, JsonObject, JsonValue } from '@haiyue/ai-studio-contracts';
import { AdvancedStudioPanel, type AdvancedStudioSource } from '@haiyue/ai-studio-shell/advanced';
import { ResourceExplorerPanel, DEFAULT_RESOURCE_QUERY, EMPTY_RESOURCE_PANEL, type ResourcePanelData, type ResourcePanelIntent } from '@haiyue/ai-studio-shell/resources';
import type { IntentWorkspace } from '@haiyue/ai-studio-shell';
import type { StudioIpcMethod } from './ipc.js';
import { ResourceThumbnails } from './resource-thumbnails.js';
import type { HYDrawer } from '@haiyue/ui/drawer';

export interface EditorPanelPorts {
  invoke(channel: StudioIpcMethod, payload?: JsonObject, signal?: AbortSignal): Promise<JsonObject>;
  refreshProject(): Promise<void>;
  acceptSelection(id: string | null): void;
  locate(location: EditorLocationV1): Promise<void>;
  projection(): JsonObject | null;
  preview(value: unknown | null): void;
  status(message: string): void;
}

/** Browser composition only: immutable projections, public lazy mount and IPC. */
export class IntegratedEditorPanels {
  private readonly lifetime = new AbortController();
  private readonly advanced: AdvancedStudioPanel;
  private readonly resources: ResourceExplorerPanel;
  private readonly thumbnails: ResourceThumbnails;
  private readonly observer: MutationObserver;
  private source: AdvancedStudioSource | null = null;
  private resourceData: ResourcePanelData = EMPTY_RESOURCE_PANEL;
  private query: JsonObject = { ...DEFAULT_RESOURCE_QUERY };
  private request: AbortController | null = null;
  private resourceRequest: AbortController | null = null;
  private opened = false;
  private advancedGeneration = 0;
  private advancedClosing: Promise<void> = Promise.resolve();
  private disposed = false;
  private projectionFrame = 0;
  private importDialog: HTMLDialogElement | null = null;
  private importRequest: AbortController | null = null;
  constructor(private readonly document: Document, workspace: IntentWorkspace, private readonly ports: EditorPanelPorts) {
    const host = document.createElement('div'); host.id = 'studio-advanced-panel';
    workspace.installAdvancedInspector(host);
    const resourceHost = document.createElement('div'); resourceHost.id = 'studio-resource-panel'; workspace.installResourceExplorer(resourceHost);
    this.thumbnails = new ResourceThumbnails(document, (assetId, signal) => ports.invoke('asset/read', { assetId }, signal));
    this.resources = new ResourceExplorerPanel(document, resourceHost, intent => this.resourceIntent(intent), (canvas, item, signal) => this.thumbnails.render(canvas, item, signal));
    this.advanced = new AdvancedStudioPanel({ host, viewportHost: document.getElementById('viewport-panel')!, source: () => {
      if (!this.source) throw Error('editor.projection-unavailable'); return this.source;
    }, load: () => import('@haiyue/editor-shell/advanced-authoring'),
    dispatch: async (intent, signal) => {
      const result = await ports.invoke('editor/advanced-intent', { intent: intent as unknown as JsonObject }, signal);
      if (intent.type === 'select') ports.acceptSelection(intent.reference?.id ?? null);
      if (intent.type === 'author' || intent.type === 'undo' || intent.type === 'redo') await ports.refreshProject();
      else await this.refresh(false);
      if (typeof result.focusEntityId === 'string') this.reveal(result.focusEntityId);
    }, preview: value => ports.preview(value) });
    const drawer = document.getElementById('workspace-advanced') as HYDrawer;
    drawer.setAttribute('aria-busy', 'false');
    this.observer = new MutationObserver(() => {
      const open = drawer.open && !document.getElementById('workspace-manual-inspect')!.hidden;
      if (open === this.opened) return;
      this.opened = open;
      const generation = ++this.advancedGeneration;
      const current = () => !this.disposed && generation === this.advancedGeneration;
      drawer.setAttribute('aria-busy', 'true');
      if (open) void this.advancedClosing.then(async () => {
        if (!current()) return;
        await this.refresh(false);
        if (current()) await this.advanced.open();
      }).catch(error => { if (current()) ports.status(String(error)); })
        .finally(() => { if (current()) drawer.setAttribute('aria-busy', 'false'); });
      else {
        this.request?.abort(); this.advanced.close();
        // A later open must not race the previous close's asynchronous cancellation.
        this.advancedClosing = this.advancedClosing.then(async () => {
          if (!this.disposed) await ports.invoke('editor/cancel');
        }).catch(error => { if (current()) ports.status(String(error)); })
          .finally(() => { if (current()) drawer.setAttribute('aria-busy', 'false'); });
      }
    });
    this.observer.observe(drawer, { attributes: true, subtree: true, attributeFilter: ['open', 'hidden'] });
    const canvas = document.getElementById('viewport')!;
    for (const event of ['pointermove', 'pointerup', 'wheel']) canvas.addEventListener(event, () => this.refreshProjection(), { signal: this.lifetime.signal });
    document.defaultView!.addEventListener('resize', () => this.refreshProjection(), { signal: this.lifetime.signal });
  }
  async refresh(includeResources = true): Promise<void> {
    if (this.disposed) return;
    this.request?.abort(); const task = new AbortController(); this.request = task;
    try {
      const data = await this.ports.invoke('editor/advanced', {}, task.signal) as unknown as AdvancedStudioSource;
      if (task.signal.aborted || this.disposed) return;
      if (this.source?.epoch !== data.epoch) { this.advanced.close(); this.resourceRequest?.abort(); this.query = { ...DEFAULT_RESOURCE_QUERY }; this.resourceData = EMPTY_RESOURCE_PANEL; this.thumbnails.setProject(null); this.resources.update(EMPTY_RESOURCE_PANEL); this.importDialog?.close(); }
      this.source = { ...data, projection: this.ports.projection() };
      if (this.opened) await this.advanced.open();
      if (includeResources) await this.refreshResources();
    } catch (error) { if (!task.signal.aborted && !this.disposed) throw error; }
    finally { if (this.request === task) this.request = null; }
  }
  reveal(id: string): void { if (this.source?.document) this.advanced.reveal({ kind: 'scene-entity', id, documentId: this.source.document.id }); }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.lifetime.abort(); this.observer.disconnect();
    this.request?.abort(); this.resourceRequest?.abort(); cancelAnimationFrame(this.projectionFrame); this.advanced.dispose(); this.resources.dispose(); this.thumbnails.dispose();
    this.importRequest?.abort(); this.importRequest = null; this.importDialog?.remove(); this.importDialog = null; this.source = null; this.resourceData = EMPTY_RESOURCE_PANEL;
  }
  private refreshProjection(): void {
    if (!this.opened || this.projectionFrame) return;
    this.projectionFrame = requestAnimationFrame(() => {
      this.projectionFrame = 0;
      if (this.source && this.opened && !this.disposed) { this.source = { ...this.source, projection: this.ports.projection() }; this.advanced.update(); }
    });
  }
  private async refreshResources(): Promise<void> {
    this.resourceRequest?.abort(); const task = new AbortController(); this.resourceRequest = task;
    this.resources.update({ ...this.resourceData, state: 'loading', nextCursor: null, viewToken: null, diagnostics: [] });
    try {
      const data = await this.ports.invoke('editor/resources', this.query, task.signal) as unknown as ResourcePanelData;
      if (task.signal.aborted || this.disposed) return;
      this.resourceData = data; this.thumbnails.setProject(data.projectKey); this.resources.update(data);
    } catch (error) { if (!task.signal.aborted && !this.disposed) { this.resources.update({ ...this.resourceData, nextCursor: null, viewToken: null, state: 'error', diagnostics: ['资源读取失败，请刷新重试。'] }); throw error; } }
    finally { if (this.resourceRequest === task) this.resourceRequest = null; }
  }
  private async resourceIntent(intent: ResourcePanelIntent): Promise<void> {
    if (intent.type === 'cancel') { this.resourceRequest?.abort(); await this.ports.invoke('editor/cancel'); return; }
    if (intent.type === 'import') { this.openImport(intent); return; }
    if (intent.type === 'query' || intent.type === 'refresh') { this.query = intent.query as unknown as JsonObject; await this.refreshResources(); return; }
    if (intent.type === 'select-target') { await this.refreshResources(); return; }
    const result = await this.ports.invoke('editor/resource-intent', { intent: intent as unknown as JsonObject }, this.lifetime.signal);
    if (result.kind === 'location') await this.ports.locate(result.location as unknown as EditorLocationV1);
    else if (result.kind === 'workflow') await this.ports.refreshProject();
    else await this.refreshResources();
  }
  private openImport(intent: Extract<ResourcePanelIntent, { type: 'import' }>): void {
    this.importRequest?.abort(); this.importDialog?.close();
    const dialog = this.document.createElement('dialog'); this.importDialog = dialog; dialog.className = 'studio-resource-import'; dialog.setAttribute('aria-labelledby', 'resource-import-title');
    dialog.innerHTML = `<h2 id="resource-import-title">导入项目资源</h2><p>填写已经放入项目目录的文件信息。格式、许可、文件大小与解码预算由现有资源工作流检查。</p><form method="dialog"><label>项目内相对路径<input name="projectPath" required maxlength="512" placeholder="assets/example.png"></label><label>媒体类型<input name="mimeType" required maxlength="128"></label><label>许可<select name="license"><option value="project-owned">项目自有</option><option value="cc0">CC0</option><option value="cc-by-4.0">CC BY 4.0</option></select></label><label>来源说明<input name="provenance" required maxlength="512"></label><label>解码后字节预算<input name="decodedBytes" type="number" min="1" max="134217728" required></label><label>纹理宽度（像素）<input name="width" type="number" min="1" max="8192"></label><label>纹理高度（像素）<input name="height" type="number" min="1" max="8192"></label><p role="alert"></p><button type="button" data-import-cancel>取消</button><button type="submit">检查并申请导入</button></form>`;
    const form = dialog.querySelector('form')!;
    (form.elements.namedItem('mimeType') as HTMLInputElement).value = ({ texture: 'image/png', model: 'model/gltf-binary', audio: 'audio/wav', animation: 'application/vnd.haiyue.animation+json' })[intent.kind];
    for (const name of ['width', 'height']) { const input = form.elements.namedItem(name) as HTMLInputElement; input.required = intent.kind === 'texture'; input.closest('label')!.hidden = intent.kind !== 'texture'; }
    dialog.querySelector('[data-import-cancel]')!.addEventListener('click', () => dialog.close(), { signal: this.lifetime.signal });
    form.addEventListener('submit', event => { event.preventDefault();
      const values = new FormData(form), details: Record<string, JsonValue> = { kind: intent.kind };
      for (const name of ['projectPath', 'mimeType', 'license', 'provenance']) details[name] = String(values.get(name) ?? '').trim();
      details.decodedBytes = Number(values.get('decodedBytes'));
      if (intent.kind === 'texture') { details.width = Number(values.get('width')); details.height = Number(values.get('height')); }
      const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!; submit.disabled = true;
      this.importRequest?.abort(); const task = new AbortController(); this.importRequest = task;
      void this.ports.invoke('editor/resource-import', { viewToken: intent.viewToken, details }, AbortSignal.any([task.signal, this.lifetime.signal])).then(async () => {
        if (task.signal.aborted || this.disposed) return;
        dialog.close(); await this.ports.refreshProject();
      }).catch(() => { if (!task.signal.aborted && !this.disposed) form.querySelector('[role="alert"]')!.textContent = '导入未完成。请核对文件、格式、来源及预算；项目变化后请关闭并重新导入。'; }).finally(() => { if (this.importRequest === task) this.importRequest = null; submit.disabled = false; });
    }, { signal: this.lifetime.signal });
    dialog.addEventListener('close', () => { if (this.importDialog === dialog) { this.importRequest?.abort(); this.importDialog = null; } dialog.remove(); }, { once: true });
    this.document.body.append(dialog); dialog.showModal();
  }
}
