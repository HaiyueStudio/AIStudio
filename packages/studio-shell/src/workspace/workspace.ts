import type { HYTabs, HYTabChangeDetail } from '@haiyue/ui/tabs';
import type { BehaviorManifestV1, BehaviorNodeV1, BehaviorSourceV1, EditorLocationV1 } from '@haiyue/ai-studio-contracts';
import { workspaceText, type WorkspaceLanguage } from './copy.js';
import { loadWorkspacePreferences, saveWorkspacePreferences, workspaceSplitPreferenceKey, WORKSPACE_CATEGORIES, type WorkspaceCategory, type WorkspacePreferences } from './preferences.js';
import type { WorkspacePanelIntent, WorkspacePanelPort, WorkspacePanelSnapshot, WorkspacePreferenceStorage } from './ports.js';

const empty: WorkspacePanelSnapshot = { documentId: null, documentRevision: 0, entities: [], selectedEntityId: null, sourceBinding: null, behavior: null, catalog: null };
const kinds = ['asset', 'template', 'preset', 'instance'] as const;
const sourceKinds = ['script', 'declarative-component', 'runtime-adapter'] as const;

/** Owns presentation and DOM placement only. Existing controls retain their listeners and History routes. */
export class IntentWorkspace {
  private readonly lifetime = new AbortController();
  private readonly root: HTMLElement;
  private readonly dialog: HTMLDialogElement;
  private readonly parking: HTMLElement;
  private readonly launcher: HTMLButtonElement;
  private readonly modeLabel: HTMLLabelElement;
  private readonly panels: readonly HTMLElement[];
  private readonly workspace: HTMLElement;
  private readonly content: HTMLElement;
  private readonly authoring: HTMLElement;
  private readonly manual: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly assets: HTMLElement;
  private readonly resourceTabs: HTMLElement;
  private readonly script: HTMLElement;
  private readonly scriptHome: Node;
  private preferences: WorkspacePreferences;
  private language: WorkspaceLanguage = 'zh-CN';
  private advancedInspector: HTMLElement | null = null;
  private advancedViewport: HTMLElement | null = null;
  private snapshot: WorkspacePanelSnapshot = empty;
  private closed = false;
  private actionGeneration = 0;
  private kind = 'all';
  private returnFocus: HTMLElement | null = null;
  private readonly splitDefaults = new Map<HTMLElement, Record<string, string>>();

  constructor(private readonly document: Document, private readonly port: WorkspacePanelPort, private readonly storage?: WorkspacePreferenceStorage) {
    const get = <T extends HTMLElement>(id: string): T => {
      const node = document.getElementById(id); if (!node) throw new Error(`workspace.missing-element:${id}`); return node as T;
    };
    // Resolve every existing owner before moving any DOM; a missing seam preserves the classic workspace.
    this.workspace = get('workspace-split'); this.content = get('content-split'); this.authoring = get('authoring-split');
    this.manual = get('left-sidebar-split'); this.viewport = get('viewport-panel'); this.assets = get('assets-panel');
    this.resourceTabs = get('resource-tabs'); this.script = get('script-panel'); this.scriptHome = this.script.parentNode!;
    for (const split of [this.workspace, this.content]) this.splitDefaults.set(split, Object.fromEntries(['direction', 'min-first', 'min-second'].map(key => [key, split.getAttribute(key) ?? ''])));
    const settings = get('settings-dialog').querySelector('.settings-form'); if (!settings) throw new Error('workspace.settings-missing');
    this.preferences = loadWorkspacePreferences(storage);
    this.panels = [...this.resourceTabs.querySelectorAll<HTMLElement>(':scope > section[slot]')];
    this.root = document.createElement('aside'); this.root.id = 'intent-workspace'; this.root.className = 'panel intent-workspace';
    // Static app-owned markup only. All document/model strings below use textContent.
    this.root.innerHTML = `<hy-tabs id="workspace-tabs" data-ws-aria="workspace">
<section id="workspace-logic" slot="logic"><label class="workspace-label" for="workspace-search" data-ws="search"></label><input id="workspace-search" type="search" maxlength="128" autocomplete="off"><label class="workspace-label" for="workspace-entity" data-ws="entity"></label><select id="workspace-entity" size="6"></select><p id="workspace-entity-status" class="workspace-note" role="status"></p><div id="workspace-source-kinds" class="workspace-badges"></div><div class="workspace-manual-links"><button type="button" id="workspace-inspect" data-ws="manualInspect"></button><button type="button" id="workspace-script" data-ws="manualScript"></button></div><h2 data-ws="events"></h2><p id="workspace-behavior-status" class="workspace-note" role="status"></p><ul id="workspace-events" class="workspace-events"></ul><details id="workspace-source-details" hidden><summary data-ws="sourceDetails"></summary><p data-ws="sourceHint"></p><pre id="workspace-source-reference"></pre></details></section>
<section id="workspace-resources" slot="resources" hidden><div class="workspace-filters"><label><span data-ws="category"></span><select id="workspace-category"></select></label><label><span data-ws="kind"></span><select id="workspace-kind"></select></label></div><p id="workspace-catalog-status" class="workspace-note" role="status"></p><ul id="workspace-catalog" class="workspace-catalog"></ul><div id="workspace-existing-resources"></div></section></hy-tabs><p id="workspace-action-status" class="workspace-note" role="status"></p>`;
    this.dialog = document.createElement('dialog'); this.dialog.id = 'workspace-advanced'; this.dialog.setAttribute('aria-labelledby', 'workspace-advanced-title');
    const sourceHeading = document.createElement('h2'); sourceHeading.dataset.ws = 'sources';
    const sourceList = document.createElement('ul'); sourceList.id = 'workspace-sources'; sourceList.className = 'workspace-events';
    this.root.querySelector('#workspace-source-details')!.before(sourceHeading, sourceList);
    this.dialog.innerHTML = `<header><strong id="workspace-advanced-title" data-ws="advanced"></strong><button type="button" id="workspace-advanced-close" data-ws="close" autofocus></button></header><div class="workspace-tabs" role="tablist" data-ws-aria="advanced"><button type="button" id="workspace-inspect-tab" role="tab" aria-controls="workspace-manual-inspect" data-advanced="inspect" data-ws="inspect"></button><button type="button" id="workspace-script-tab" role="tab" aria-controls="workspace-manual-script" data-advanced="script" data-ws="script"></button></div><section id="workspace-manual-inspect" role="tabpanel" aria-labelledby="workspace-inspect-tab"></section><section id="workspace-manual-script" role="tabpanel" aria-labelledby="workspace-script-tab" hidden></section>`;
    this.parking = document.createElement('div'); this.parking.id = 'workspace-layout-parking'; this.parking.hidden = true;
    this.launcher = document.createElement('button'); this.launcher.id = 'workspace-advanced-button'; this.launcher.type = 'button'; this.launcher.dataset.ws = 'advanced'; this.launcher.setAttribute('aria-haspopup', 'dialog'); this.launcher.setAttribute('aria-controls', this.dialog.id);
    get('settings-button').before(this.launcher);
    this.modeLabel = document.createElement('label'); this.modeLabel.innerHTML = '<span data-ws="mode"></span><select id="workspace-mode"><option value="intent" data-ws="intent"></option><option value="classic" data-ws="classic"></option></select>';
    settings.append(this.modeLabel); document.body.append(this.dialog, this.parking); this.parking.append(this.root);
    const listen = (element: EventTarget, event: string, callback: EventListener) => element.addEventListener(event, callback, { signal: this.lifetime.signal });
    const tabs = this.get<HYTabs>('workspace-tabs');
    listen(tabs, 'tab-change', event => {
      if (event.target !== tabs) return;
      const value = (event as CustomEvent<HYTabChangeDetail>).detail?.value;
      if (value === 'logic' || value === 'resources') this.setTab(value);
    });
    this.keyboardTabs(this.dialog.querySelector('[role="tablist"]')!, '[data-advanced]', button => this.setAdvancedTab(button.dataset.advanced as 'inspect' | 'script'));
    for (const button of this.dialog.querySelectorAll<HTMLElement>('[data-advanced]')) listen(button, 'click', () => this.setAdvancedTab(button.dataset.advanced as 'inspect' | 'script'));
    listen(this.launcher, 'click', () => this.openAdvanced());
    listen(get('workspace-inspect'), 'click', () => this.openAdvanced('inspect'));
    listen(get('workspace-script'), 'click', () => this.openAdvanced('script'));
    listen(get('workspace-advanced-close'), 'click', () => this.dialog.close());
    listen(this.dialog, 'close', () => { this.applyLayout(); this.returnFocus?.focus(); this.returnFocus = null; });
    listen(get('workspace-mode'), 'change', () => this.setMode(get<HTMLSelectElement>('workspace-mode').value as 'intent' | 'classic'));
    listen(get('workspace-category'), 'change', () => { this.patch({ category: get<HTMLSelectElement>('workspace-category').value as WorkspaceCategory }); this.renderResources(); });
    listen(get('workspace-kind'), 'change', () => { this.kind = get<HTMLSelectElement>('workspace-kind').value; this.renderResources(); });
    listen(get('workspace-search'), 'input', () => this.renderEntities());
    listen(get('workspace-entity'), 'change', () => this.dispatch({ type: 'workspace/select-entity', entityId: get<HTMLSelectElement>('workspace-entity').value || null }));
    listen(document.defaultView!, 'resize', () => this.adaptWidth());
    this.setLanguage('zh-CN'); this.applyLayout(); this.setTab(this.preferences.tab);
    this.document.body.dataset.workspaceReady = 'true';
  }
  update(snapshot: WorkspacePanelSnapshot): void {
    if (this.closed) return;
    if (snapshot.entities.length > 10000 || snapshot.entities.some(entity => typeof entity.id !== 'string' || typeof entity.name !== 'string' || entity.name.length > 512 || entity.sources.some(kind => !sourceKinds.includes(kind))) || new Set(snapshot.entities.map(entity => entity.id)).size !== snapshot.entities.length) throw new Error('workspace.invalid-entity-projection');
    if (snapshot.documentId !== this.snapshot.documentId) {
      this.get<HTMLInputElement>('workspace-search').value = ''; this.kind = 'all'; this.get<HTMLSelectElement>('workspace-kind').value = 'all';
    }
    this.snapshot = snapshot;
    this.actionGeneration++;
    this.get('workspace-action-status').textContent = '';
    this.get('workspace-source-details').hidden = true;
    this.get('workspace-source-reference').textContent = '';
    this.renderEntities(); this.renderBehavior(); this.renderResources();
  }
  setLanguage(language: WorkspaceLanguage): void {
    if (this.closed) return;
    this.language = language;
    for (const owner of [this.root, this.dialog, this.modeLabel, this.launcher]) {
      const nodes = [owner, ...owner.querySelectorAll<HTMLElement>('[data-ws], [data-ws-aria]')];
      for (const node of nodes) {
        if (node.dataset.ws) node.textContent = this.text(node.dataset.ws as Parameters<typeof workspaceText>[1]);
        if (node.dataset.wsAria) node.setAttribute('aria-label', this.text(node.dataset.wsAria as Parameters<typeof workspaceText>[1]));
      }
    }
    this.get<HYTabs>('workspace-tabs').options = ['logic', 'resources'].map(value => ({ value, label: this.text(value as 'logic' | 'resources') }));
    this.fillSelect('workspace-category', WORKSPACE_CATEGORIES.map(value => [value, this.text(value)]), this.preferences.category);
    this.fillSelect('workspace-kind', [['all', this.text('allKinds')], ...kinds.map(value => [value, this.text(value)] as const)], this.kind);
    this.get<HTMLSelectElement>('workspace-mode').value = this.preferences.mode;
    this.renderEntities(); this.renderBehavior(); this.renderResources();
  }
  setMode(mode: 'intent' | 'classic'): void {
    if (this.closed || !['intent', 'classic'].includes(mode)) return;
    if (this.dialog.open) this.dialog.close();
    this.patch({ mode }); this.applyLayout(); this.get<HTMLSelectElement>('workspace-mode').value = mode;
  }
  setTab(tab: 'logic' | 'resources'): void {
    if (this.closed) return;
    this.patch({ tab });
    this.get<HYTabs>('workspace-tabs').value = tab;
    for (const name of ['logic', 'resources'] as const) this.get(`workspace-${name}`).hidden = name !== tab;
  }

  openAdvanced(tab: 'inspect' | 'script' = this.preferences.advancedTab): void {
    if (this.closed) return;
    this.returnFocus = this.document.activeElement as HTMLElement | null;
    this.move(this.manual, this.get('workspace-manual-inspect'));
    this.manual.hidden = this.advancedInspector !== null;
    this.move(this.script, this.get('workspace-manual-script'));
    this.setAdvancedTab(tab);
    if (!this.dialog.open) this.dialog.showModal();
  }
  closeAdvanced(): void { if (!this.closed && this.dialog.open) this.dialog.close(); }
  /** Public panel is installed by the application after the reviewed package is available. */
  installAdvancedInspector(host: HTMLElement): HTMLElement {
    if (this.closed || this.advancedInspector) throw new Error('workspace.advanced-already-mounted');
    this.advancedInspector = host;
    this.advancedViewport = this.document.createElement('div'); this.advancedViewport.id = 'workspace-advanced-viewport';
    this.get('workspace-manual-inspect').append(this.advancedViewport, host);
    this.dialog.dataset.publicAdvanced = 'true';
    return this.advancedViewport;
  }
  installResourceExplorer(host: HTMLElement): void {
    if (this.closed) return;
    for (const id of ['workspace-catalog-status', 'workspace-catalog', 'workspace-existing-resources']) this.get(id).hidden = true;
    this.get('workspace-resources').querySelector<HTMLElement>('.workspace-filters')!.hidden = true;
    this.get('workspace-resources').append(host);
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true; this.lifetime.abort(); if (this.dialog.open) this.dialog.close();
    this.applyLayout('classic'); this.scriptHome.appendChild(this.script); this.script.hidden = true; this.script.setAttribute('aria-hidden', 'true');
    this.root.remove(); this.dialog.remove(); this.parking.remove(); this.launcher.remove(); this.modeLabel.remove();
    delete this.document.body.dataset.workspaceReady; delete this.document.body.dataset.workspaceMode; delete this.document.body.dataset.workspaceNarrow;
  }
  private setAdvancedTab(tab: 'inspect' | 'script'): void {
    this.patch({ advancedTab: tab });
    for (const name of ['inspect', 'script'] as const) {
      const selected = name === tab, button = this.get(`workspace-${name}-tab`);
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      this.get(`workspace-manual-${name}`).hidden = !selected;
    }
    this.script.hidden = tab !== 'script'; this.script.setAttribute('aria-hidden', String(tab !== 'script'));
    if (this.advancedViewport && tab === 'inspect') this.move(this.viewport, this.advancedViewport);
  }
  private applyLayout(mode = this.preferences.mode): void {
    this.document.body.dataset.workspaceMode = mode;
    this.manual.hidden = this.dialog.open && this.advancedInspector !== null;
    if (mode === 'intent') {
      this.move(this.manual, this.get('workspace-manual-inspect')); this.move(this.authoring, this.parking);
      this.move(this.root, this.workspace, 'first'); this.move(this.viewport, this.content, 'first');
      this.move(this.assets, this.get('workspace-existing-resources')); this.resourceTabs.hidden = true;
      for (const panel of this.panels) this.move(panel, this.assets);
    } else {
      this.move(this.root, this.parking); this.move(this.manual, this.workspace, 'first');
      this.move(this.authoring, this.content, 'first'); this.move(this.viewport, this.authoring, 'first'); this.move(this.assets, this.authoring, 'second');
      for (const panel of this.panels) { panel.hidden = false; this.move(panel, this.resourceTabs, panel.dataset.workspaceCategory!); }
      this.resourceTabs.hidden = false;
    }
    if (!this.dialog.open) { this.script.hidden = true; this.script.setAttribute('aria-hidden', 'true'); }
    for (const split of [this.workspace, this.content, this.authoring, this.manual]) {
      const key = split.dataset.layoutKey; if (!key) continue;
      try {
        const value = this.storage?.getItem(workspaceSplitPreferenceKey(mode, key)) ?? this.storage?.getItem(workspaceSplitPreferenceKey('classic', key));
        if (value !== null && value !== undefined && value.trim() && Number.isFinite(Number(value))) split.setAttribute('ratio', String(Math.max(0.05, Math.min(0.95, Number(value)))));
      } catch { /* A storage failure must not disable the editor. */ }
    }
    this.adaptWidth(mode);
    this.renderResources();
  }
  private adaptWidth(mode = this.preferences.mode): void {
    const narrow = mode === 'intent' && (this.document.defaultView?.innerWidth ?? 1280) < 1000;
    this.document.body.dataset.workspaceNarrow = String(narrow);
    for (const [split, values] of this.splitDefaults) {
      for (const [key, value] of Object.entries(values)) split.setAttribute(key, narrow ? key === 'direction' ? 'vertical' : split === this.workspace ? key === 'min-first' ? '160' : '270' : key === 'min-first' ? '140' : '120' : value);
    }
  }
  private move(node: HTMLElement, parent: HTMLElement, slot?: string): void {
    if (node.parentNode !== parent) parent.append(node);
    if (slot) node.setAttribute('slot', slot); else node.removeAttribute('slot');
  }
  private renderEntities(): void {
    const select = this.get<HTMLSelectElement>('workspace-entity'), filter = this.get<HTMLInputElement>('workspace-search').value.trim().toLocaleLowerCase(this.language);
    const entities = this.snapshot.entities.filter(entity => !filter || entity.name.toLocaleLowerCase(this.language).includes(filter));
    const selected = entities.some(entity => entity.id === this.snapshot.selectedEntityId) ? this.snapshot.selectedEntityId : '';
    this.fillSelect('workspace-entity', [['', this.text('choose')], ...entities.map(entity => [entity.id, entity.name] as const)], selected ?? '');
    select.disabled = entities.length === 0;
    this.get('workspace-entity-status').textContent = !this.snapshot.entities.length ? this.text('noEntities') : !entities.length ? this.text('noMatches') : `${entities.length} / ${this.snapshot.entities.length}`;
    const entity = this.snapshot.entities.find(entity => entity.id === this.snapshot.selectedEntityId);
    this.get<HTMLButtonElement>('workspace-inspect').disabled = !entity;
    this.get<HTMLButtonElement>('workspace-script').disabled = !entity;
  }
  private currentManifest(): BehaviorManifestV1 | null {
    const { behavior, sourceBinding, documentId, documentRevision } = this.snapshot;
    return behavior?.schemaVersion === 1 && sourceBinding?.schemaVersion === 1 && sourceBinding.documentId === documentId && sourceBinding.documentRevision === documentRevision && behavior.binding.digest === sourceBinding.digest && behavior.binding.projectId === sourceBinding.projectId && behavior.binding.documentId === documentId && behavior.binding.documentRevision === documentRevision && behavior.nodes.length <= 2000 ? behavior : null;
  }
  private renderBehavior(): void {
    const entity = this.snapshot.entities.find(entity => entity.id === this.snapshot.selectedEntityId), manifest = this.currentManifest();
    const status = this.get('workspace-behavior-status'), list = this.get('workspace-events'), badges = this.get('workspace-source-kinds');
    list.replaceChildren(); badges.replaceChildren(); this.get('workspace-sources').replaceChildren();
    const sources = new Set<BehaviorSourceV1['kind']>(entity?.sources ?? []);
    for (const node of manifest?.nodes ?? []) if (node.source.entityId === entity?.id) sources.add(node.source.kind);
    for (const kind of sources) { const badge = this.document.createElement('span'); badge.className = 'workspace-badge'; badge.textContent = this.text(`source-${kind}`); badges.append(badge); }
    if (!entity) { status.textContent = this.text('choose'); return; }
    if (!manifest) { status.textContent = this.text(this.snapshot.behavior ? 'stale' : 'pending'); return; }
    const triggers = new Set(manifest.triggers);
    const nodes = manifest.nodes.filter(node => node.source.entityId === entity.id && triggers.has(node.id));
    status.textContent = manifest.truncation.truncated || nodes.length > 100 ? this.text('more') : !nodes.length ? this.text('noEvents') : this.text('established');
    for (const node of nodes.slice(0, 100)) this.appendSourceNode(list, node, manifest);
    const seen = new Set<string>();
    for (const node of manifest.nodes) {
      if (node.source.entityId !== entity.id) continue;
      const source = node.source;
      const key = source.kind === 'script' ? source.scriptId : source.kind === 'declarative-component' ? source.componentId : `${source.componentId}:${source.adapter.id}`;
      if (seen.has(key) || seen.size >= 100) continue;
      seen.add(key); this.appendSourceNode(this.get('workspace-sources'), node, manifest);
    }
  }
  private appendSourceNode(list: HTMLElement, node: BehaviorNodeV1, manifest: BehaviorManifestV1): void {
      const snapshot = this.snapshot;
      const row = this.document.createElement('li'), button = this.document.createElement('button'); button.type = 'button';
      button.dataset.sourceKind = node.source.kind;
      const label = this.document.createElement('strong'); label.textContent = node.label;
      const source = this.document.createElement('small'); source.textContent = `${this.text(`source-${node.source.kind}`)} · ${this.text(node.unknown ? 'unknown' : 'established')}`;
      button.append(label, source); button.setAttribute('aria-label', `${this.text('locate')}: ${node.label}`);
      button.addEventListener('click', () => {
        if (this.closed || this.snapshot !== snapshot || this.currentManifest()?.digest !== manifest.digest) return;
        const binding = manifest.binding;
        const location: EditorLocationV1 = { schemaVersion: 1, projectId: binding.projectId, documentId: binding.documentId, documentRevision: binding.documentRevision, sourceBindingDigest: binding.digest, target: { kind: 'behavior-node', manifestDigest: manifest.digest, nodeId: node.id, source: node.source } };
        this.showSource(node.source); this.dispatch({ type: 'workspace/locate', location });
      });
      row.append(button); list.append(row);
  }
  private showSource(source: BehaviorSourceV1): void {
    const detail = this.get<HTMLDetailsElement>('workspace-source-details'); detail.hidden = false; detail.open = true;
    this.get('workspace-source-reference').textContent = source.kind === 'script' ? `${source.path}:${source.range.startLine}:${source.range.startColumn}\n${source.scriptId}\n${source.digest}` : source.kind === 'declarative-component' ? `${source.componentType}@${source.componentVersion}\n${source.componentId}\n${source.field || '/'}` : `${source.adapter.id}@${source.adapter.version}\n${source.adapter.digest}\n${source.field}`;
  }
  private renderResources(): void {
    const category = this.preferences.category;
    for (const panel of this.panels) {
      if (!panel.dataset.workspaceCategory) panel.dataset.workspaceCategory = panel.getAttribute('slot') ?? '';
      if (this.preferences.mode === 'intent' && panel.parentElement === this.assets) panel.hidden = this.kind !== 'all' || (category !== 'all' && panel.dataset.workspaceCategory !== category);
    }
    const list = this.get('workspace-catalog'), status = this.get('workspace-catalog-status'); list.replaceChildren();
    const snapshot = this.snapshot, binding = snapshot.sourceBinding;
    if (!this.snapshot.catalog || !binding || binding.documentId !== this.snapshot.documentId || binding.documentRevision !== this.snapshot.documentRevision) { status.textContent = this.text(this.snapshot.catalog ? 'stale' : 'catalogPending'); return; }
    const entries = this.snapshot.catalog.filter(entry => entry.schemaVersion === 1 && (this.kind === 'all' || entry.kind === this.kind) && (category === 'all' || resourceCategory(entry.category) === category));
    status.textContent = !entries.length ? this.text('emptyCatalog') : entries.length > 100 ? this.text('more') : '';
    for (const entry of entries.slice(0, 100)) {
      const row = this.document.createElement('li'); row.dataset.kind = entry.kind;
      const heading = this.document.createElement('strong'); heading.textContent = entry.label;
      const badge = this.document.createElement('span'); badge.className = 'workspace-badge'; badge.textContent = this.text(entry.kind);
      row.append(heading, badge);
      for (const key of [entry.status === 'unavailable' ? 'unavailable' : null, entry.dependencies.status === 'unknown' ? 'dependenciesUnknown' : null, entry.usage.status === 'unknown' ? 'usageUnknown' : null, entry.unused === 'inapplicable' ? 'unusedInapplicable' : null] as const) if (key) { const text = this.document.createElement('small'); text.textContent = this.text(key); row.append(text); }
      if (entry.status === 'available') for (const intent of entry.intents) {
        const button = this.document.createElement('button'); button.type = 'button'; button.textContent = this.text(intent);
        button.addEventListener('click', () => { if (this.snapshot === snapshot && this.snapshot.sourceBinding?.digest === binding.digest) this.dispatch({ type: 'workspace/resource', entry, intent }); }); row.append(button);
      }
      list.append(row);
    }
  }
  private dispatch(intent: WorkspacePanelIntent): void {
    if (this.closed) return;
    const generation = ++this.actionGeneration;
    const failed = () => { if (!this.closed && generation === this.actionGeneration) this.get('workspace-action-status').textContent = this.text('failed'); };
    this.get('workspace-action-status').textContent = '';
    try { Promise.resolve(this.port.dispatch(intent)).catch(failed); }
    catch { failed(); }
  }
  private patch(patch: Partial<WorkspacePreferences>): void { this.preferences = Object.freeze({ ...this.preferences, ...patch }); saveWorkspacePreferences(this.storage, this.preferences); }
  private text(key: Parameters<typeof workspaceText>[1]): string { return workspaceText(this.language, key); }
  private get<T extends HTMLElement = HTMLElement>(id: string): T { return this.document.getElementById(id) as T; }
  private fillSelect(id: string, values: readonly (readonly [string, string])[], value: string): void {
    const select = this.get<HTMLSelectElement>(id), fragment = this.document.createDocumentFragment();
    for (const [id, label] of values) { const option = this.document.createElement('option'); option.value = id; option.textContent = label; fragment.append(option); }
    select.replaceChildren(fragment); select.value = value;
  }
  private keyboardTabs(root: Element, selector: string, activate: (button: HTMLElement) => void): void {
    root.addEventListener('keydown', ((event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...root.querySelectorAll<HTMLElement>(selector)], current = buttons.indexOf(event.target as HTMLElement); if (current < 0) return;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault(); activate(buttons[next]); buttons[next].focus();
    }) as EventListener, { signal: this.lifetime.signal });
  }
}
function resourceCategory(value: string): WorkspaceCategory {
  const name = value.toLowerCase();
  if (/light|灯光/u.test(name)) return 'lights'; if (/geometr|几何/u.test(name)) return 'geometry'; if (/material|材质/u.test(name)) return 'materials';
  if (/texture|纹理/u.test(name)) return 'textures'; if (/model|模型/u.test(name)) return 'models'; if (/script|脚本/u.test(name)) return 'scripts'; if (/scene|场景/u.test(name)) return 'scene'; return 'other';
}
