import type { HYTabs, HYTabChangeDetail } from '@haiyue/ui/tabs';
import { DEFAULT_RESOURCE_QUERY, EMPTY_RESOURCE_PANEL, RESOURCE_ACTION_LABELS, RESOURCE_KIND_LABELS, RESOURCE_PRIMARY_CATEGORIES, resourceActions, resourceCategoryLabel, resourceUsageLabel, type ResourcePanelData, type ResourcePanelIntent, type ResourcePanelItem, type ResourcePanelQuery } from './model.js';

export type ResourceThumbnailRenderer = (canvas: HTMLCanvasElement, item: ResourcePanelItem, signal: AbortSignal) => void | Promise<void>;

/** No tools or filesystem: bounded projections in, typed intents out. */
export class ResourceExplorerPanel {
  readonly root: HTMLElement;
  private data = EMPTY_RESOURCE_PANEL;
  private selected: string | null = null;
  private busy = false;
  private closed = false;
  private generation = 0;
  private message = '';
  private usageOffset = 0;
  private assignmentUsage: string | null = null;
  private readonly lifetime = new AbortController();
  private renderScope = new AbortController();
  constructor(private readonly document: Document, parent: HTMLElement, private readonly dispatch: (intent: ResourcePanelIntent) => void | Promise<void>, private readonly thumbnail?: ResourceThumbnailRenderer) {
    this.root = document.createElement('section'); this.root.className = 'resource-explorer'; this.root.setAttribute('aria-label', '项目资源');
    // Fixed product markup; all project data uses textContent or option.value.
    this.root.innerHTML = `<header class="resource-header"><h2>项目资源</h2><button type="button" data-resource="refresh">刷新</button><button type="button" data-resource="cancel" hidden>取消</button></header>
<p data-resource="status" role="status" aria-live="polite"></p><p data-resource="error" role="alert" hidden></p>
<hy-tabs data-resource="tabs" class="resource-tabs" aria-label="资源分类"><div data-resource="content" slot="Geometry">
<form data-resource="filters"><div class="resource-searchbar"><input data-resource="search" type="search" aria-label="搜索资源" maxlength="256" placeholder="搜索几何体…"><button type="submit">搜索</button><button type="button" data-resource="import" hidden>导入项目资源</button></div>
<details class="resource-more" data-resource="more"><summary>更多筛选</summary><div class="resource-filters"><label>分类<select data-resource="category"></select></label><label>种类<select data-resource="kind"></select></label><label>状态<select data-resource="availability"></select></label><label class="resource-unused"><input data-resource="unused" type="checkbox">仅未使用的文件资产</label><label data-resource="import-options">导入类型<select data-resource="import-kind"></select></label></div></details></form>
<div class="resource-columns"><section aria-label="资源列表"><div class="resource-list-heading"><p data-resource="count"></p><div class="resource-toolbar" data-resource="pagination"><button type="button" data-resource="first">首页</button><button type="button" data-resource="next">下一页</button></div></div><ul data-resource="list" class="resource-list"></ul></section><section data-resource="detail" class="resource-detail" aria-label="资源详情" tabindex="-1" hidden></section></div>
</div></hy-tabs>`;
    parent.append(this.root);
    this.options('kind', [['', '全部种类'], ...Object.entries(RESOURCE_KIND_LABELS)]);
    this.options('availability', [['', '全部状态'], ['available', '可用'], ['unavailable', '不可用']]);
    this.options('import-kind', [['texture', '纹理'], ['model', '模型'], ['audio', '音频'], ['animation', '动画']]);
    this.options('category', [['', '全部分类'], ...RESOURCE_PRIMARY_CATEGORIES.map(value => [value, resourceCategoryLabel(value)] as [string, string])]);
    this.get<HTMLSelectElement>('category').value = DEFAULT_RESOURCE_QUERY.category!;
    this.syncCategory();
    const on = (key: string, event: string, run: (event: Event) => void) => this.get(key).addEventListener(event, run, { signal: this.lifetime.signal });
    on('filters', 'submit', event => { event.preventDefault(); this.syncCategory(); this.send({ type: 'query', query: this.query() }); });
    for (const key of ['category', 'kind', 'availability', 'unused']) on(key, 'change', () => { this.syncCategory(); this.send({ type: 'query', query: this.query() }); });
    on('tabs', 'tab-change', event => {
      const value = (event as CustomEvent<HYTabChangeDetail>).detail.value;
      if (this.busy || this.data.state === 'loading') { this.syncCategory(); return; }
      this.get<HTMLSelectElement>('category').value = value === 'all' ? '' : value;
      // A category switch starts at page one with no invisible filters from another tab.
      for (const key of ['kind', 'availability']) this.get<HTMLSelectElement>(key).value = '';
      this.get<HTMLInputElement>('unused').checked = false;
      this.selected = null; this.assignmentUsage = null; this.usageOffset = 0;
      this.syncCategory(); this.send({ type: 'query', query: this.query() });
    });
    on('refresh', 'click', () => this.send({ type: 'refresh', query: this.query() }));
    on('cancel', 'click', () => this.send({ type: 'cancel' }));
    on('first', 'click', () => this.send({ type: 'query', query: this.query() }));
    on('next', 'click', () => { if (this.data.nextCursor) this.send({ type: 'query', query: { ...this.query(), cursor: this.data.nextCursor } }); });
    on('import', 'click', () => { if (this.data.viewToken) this.send({ type: 'import', viewToken: this.data.viewToken, kind: this.get<HTMLSelectElement>('import-kind').value as 'texture' | 'model' | 'audio' | 'animation' }); });
    this.render();
  }
  update(data: ResourcePanelData): void {
    if (this.closed) return;
    if (data.items.length > 100 || data.categories.length > 128 || data.items.some(item => item.locations.length > 1000 || item.metadata.length > 32)) throw Error('Resource panel projection exceeds display budget.');
    if (data.projectKey !== this.data.projectKey) {
      this.generation++; this.busy = false; this.selected = null; this.usageOffset = 0; this.assignmentUsage = null; this.message = '';
      this.get<HTMLInputElement>('search').value = ''; this.get<HTMLInputElement>('unused').checked = false;
      for (const key of ['kind', 'availability']) this.get<HTMLSelectElement>(key).value = '';
      this.get<HTMLSelectElement>('category').value = DEFAULT_RESOURCE_QUERY.category!;
      this.get<HTMLDetailsElement>('more').open = false;
    }
    this.data = data;
    const category = this.get<HTMLSelectElement>('category').value;
    const categories = [...new Set([...RESOURCE_PRIMARY_CATEGORIES, ...data.categories, ...(category ? [category] : [])])];
    this.options('category', [['', '全部分类'], ...categories.map(value => [value, resourceCategoryLabel(value)] as [string, string])]);
    this.get<HTMLSelectElement>('category').value = category;
    this.syncCategory();
    if (!data.items.some(item => item.entry.catalogEntryId === this.selected)) { this.selected = null; this.usageOffset = 0; }
    this.render();
  }
  dispose(): void { if (this.closed) return; this.closed = true; this.generation++; this.lifetime.abort(); this.renderScope.abort(); this.root.remove(); }
  private get<T extends HTMLElement = HTMLElement>(key: string): T { return this.root.querySelector<T>(`[data-resource="${key}"]`)!; }
  private options(key: string, rows: readonly (readonly [string, string])[]): void {
    this.get(key).replaceChildren(...rows.map(([value, label]) => { const option = this.document.createElement('option'); option.value = value; option.textContent = label; return option; }));
  }
  private syncCategory(): void {
    const category = this.get<HTMLSelectElement>('category').value, tabs = this.get<HYTabs>('tabs');
    const options = RESOURCE_PRIMARY_CATEGORIES.map(value => ({ value: String(value), label: resourceCategoryLabel(value) }));
    if (!options.some(option => option.value === category)) options.push({ value: category || 'all', label: category ? resourceCategoryLabel(category) : '全部资源' });
    if (JSON.stringify(tabs.options) !== JSON.stringify(options)) tabs.options = options;
    tabs.value = category || 'all'; this.get('content').slot = tabs.value;
    this.get<HTMLInputElement>('search').placeholder = `搜索${category ? resourceCategoryLabel(category) : '资源'}…`;
    const kind = ({ Texture: 'texture', Model: 'model', Audio: 'audio', Animation: 'animation', Lighting: 'texture' } as Record<string, string>)[category];
    if (kind) this.get<HTMLSelectElement>('import-kind').value = kind;
    this.get('import').hidden = Boolean(category && !kind);
    this.get('import').textContent = kind ? `导入${resourceCategoryLabel(kind === 'texture' ? 'Texture' : category)}` : '导入项目资源';
    this.get('import-options').hidden = Boolean(category);
  }
  private query(): ResourcePanelQuery {
    const text = this.get<HTMLInputElement>('search').value, category = this.get<HTMLSelectElement>('category').value;
    const kind = this.get<HTMLSelectElement>('kind').value as ResourcePanelQuery['kind'], status = this.get<HTMLSelectElement>('availability').value as ResourcePanelQuery['status'];
    return { limit: 25, ...(text ? { text } : {}), ...(category ? { category } : {}), ...(kind ? { kind } : {}), ...(status ? { status } : {}), ...(this.get<HTMLInputElement>('unused').checked ? { unused: true } : {}) };
  }
  private send(intent: ResourcePanelIntent): void {
    if (this.closed || this.busy && intent.type !== 'cancel') return;
    const generation = ++this.generation;
    this.busy = intent.type !== 'cancel'; this.message = intent.type === 'cancel' ? '操作已取消。' : ''; this.controls();
    Promise.resolve().then(() => { if (!this.closed && generation === this.generation) return this.dispatch(intent); }).catch(() => {
      if (!this.closed && generation === this.generation) this.message = '操作未完成，请检查资源状态或刷新后重试。';
    }).finally(() => { if (!this.closed && generation === this.generation) { this.busy = false; this.controls(); } });
  }
  private render(): void {
    const active = this.document.activeElement as HTMLElement | null, focused = active?.dataset.resourceEntry, detailFocus = active?.dataset.resourceFocus;
    this.renderScope.abort(); this.renderScope = new AbortController();
    const list = this.get('list'); list.replaceChildren();
    for (const item of this.data.items) {
      const entry = item.entry, li = this.document.createElement('li'), button = this.document.createElement('button'); button.type = 'button'; button.dataset.resourceEntry = entry.catalogEntryId;
      button.setAttribute('aria-pressed', String(entry.catalogEntryId === this.selected));
      const canvas = this.document.createElement('canvas'); canvas.width = 128; canvas.height = 128; canvas.className = 'resource-thumbnail'; canvas.setAttribute('aria-hidden', 'true');
      const label = entry.kind === 'asset' ? entry.label.split('/').at(-1) || entry.label : entry.label;
      button.title = entry.label; button.setAttribute('aria-label', label);
      button.append(canvas, this.node('strong', label));
      const context = canvas.getContext('2d');
      if (context) { context.fillStyle = '#9cafce'; context.font = '32px system-ui'; context.textAlign = 'center'; context.fillText(entry.category === 'Script' ? '{ }' : '◇', 64, 76); }
      const signal = this.renderScope.signal;
      if (this.thumbnail) void Promise.resolve().then(() => { if (!signal.aborted) return this.thumbnail!(canvas, item, signal); }).catch(() => { if (!signal.aborted) canvas.title = '缩略图暂不可用'; });
      button.addEventListener('click', () => { if (this.selected !== entry.catalogEntryId) this.assignmentUsage = null; this.selected = entry.catalogEntryId; this.usageOffset = 0; this.render(); }, { signal: this.renderScope.signal });
      li.append(button); list.append(li);
    }
    if (!this.data.items.length) list.append(this.node('li', this.data.projectKey ? '当前分类还没有项目资源。创建或导入后会显示在这里。' : '打开项目后查看对应资源。', 'resource-empty'));
    this.get('count').textContent = `共 ${this.data.total} 条 · 本页 ${this.data.items.length} 条`;
    this.renderDetail(); this.controls();
    if (focused) [...list.querySelectorAll<HTMLButtonElement>('button')].find(button => button.dataset.resourceEntry === focused)?.focus({ preventScroll: true });
    else if (detailFocus) {
      const next = [...this.get('detail').querySelectorAll<HTMLButtonElement>('button')].find(button => button.dataset.resourceFocus === detailFocus);
      (next && !next.disabled ? next : this.get('detail')).focus({ preventScroll: true });
    }
  }
  private renderDetail(): void {
    const detail = this.get('detail'), item = this.data.items.find(row => row.entry.catalogEntryId === this.selected);
    detail.hidden = !item; this.root.classList.toggle('has-resource-selection', Boolean(item));
    detail.replaceChildren();
    if (!item) { detail.append(this.node('h3', '选择资源查看详情'), this.node('p', '文件资产、模板、预设和实例分别保留原有身份与操作。')); return; }
    const entry = item.entry;
    detail.append(this.button('关闭详情', () => { this.selected = null; this.render(); [...this.get('list').querySelectorAll<HTMLButtonElement>('button')].find(button => button.dataset.resourceEntry === entry.catalogEntryId)?.focus(); }), this.node('h3', entry.label), this.node('p', resourceUsageLabel(entry)));
    const sourceLabels: Record<string, string> = { 'controlled-manifest': '项目受控资产清单', registry: '组件注册表', 'project-record': '项目记录', document: '项目文档', unsupported: '尚无持久化支持' };
    const healthLabels: Record<string, string> = { registered: '已登记，文件尚未检查', verified: '已核验', missing: '文件缺失或不可读', invalid: '资源校验失败', unavailable: '尚不可用' };
    detail.append(this.node('p', `来源：${sourceLabels[entry.source] ?? '未知来源'} · ${healthLabels[item.health] ?? '未知状态'}`));
    for (const diagnostic of item.diagnostics) detail.append(this.node('p', diagnostic, 'resource-diagnostic'));
    const identity = this.document.createElement('details'); identity.append(this.node('summary', '身份与版本'), this.node('pre', JSON.stringify(entry.ref, null, 2))); detail.append(identity);
    const metadata = this.document.createElement('dl');
    for (const row of item.metadata) metadata.append(this.node('dt', row.label), this.node('dd', row.value)); detail.append(metadata);
    if (item.configuration !== null) { const config = this.document.createElement('details'); config.append(this.node('summary', '当前配置'), this.node('pre', item.configuration)); detail.append(config); }
    detail.append(this.node('p', entry.dependencies.status === 'known' ? `已知依赖：${entry.dependencies.items.length} 项` : `依赖：${entry.dependencies.reason}`));
    const needsTarget = item.target === 'entity' || resourceActions(item).includes('asset.assign');
    if (needsTarget) {
      detail.append(this.node('p', this.data.target ? `目标实体：${this.data.target.label}` : '请先在场景中选择目标实体。'));
      detail.append(this.button('选择目标实体', () => this.send({ type: 'select-target' })));
    }
    let usage: HTMLSelectElement | null = null;
    if (item.assignments.length) {
      const label = this.node('label', '分配用途'); usage = this.document.createElement('select'); usage.dataset.resource = 'assignment';
      for (const value of item.assignments) { const option = this.document.createElement('option'); option.value = value; option.textContent = assignmentLabel(value); usage.append(option); }
      if (this.assignmentUsage && item.assignments.includes(this.assignmentUsage)) usage.value = this.assignmentUsage;
      else if (entry.category === 'Lighting' && item.assignments.includes('texture.environment-diffuse')) usage.value = 'texture.environment-diffuse';
      usage.addEventListener('change', () => { this.assignmentUsage = usage!.value; }, { signal: this.renderScope.signal });
      label.append(usage); detail.append(label);
    }
    const actions = this.node('div', '', 'resource-toolbar');
    for (const action of resourceActions(item)) {
      const targetRequired = action === 'asset.assign' || (action === 'template.create' || action === 'preset.apply') && item.target === 'entity';
      const button = this.button(RESOURCE_ACTION_LABELS[action], () => {
        if (!this.data.viewToken) return;
        this.send({ type: 'action', viewToken: this.data.viewToken, entry, action, ...(targetRequired && this.data.target ? { targetEntityId: this.data.target.entityId } : {}), ...(action === 'asset.assign' && usage ? { usage: usage.value } : {}) });
      });
      button.dataset.resourceAction = action; button.dataset.unavailable = String(targetRequired && !this.data.target || action === 'asset.assign' && !item.assignments.length); actions.append(button);
    }
    detail.append(actions);
    if (!resourceActions(item).length) detail.append(this.node('p', '当前没有可执行操作。'));
    detail.append(this.node('h4', '已知使用位置'));
    if (!item.locations.length) detail.append(this.node('p', entry.usage.status === 'known' ? '没有已登记使用位置。' : '尚无可证明的使用位置；这不表示未使用。'));
    for (const location of item.locations.slice(this.usageOffset, this.usageOffset + 20)) {
      detail.append(this.button(`${location.label} · ${location.field}`, () => { if (this.data.viewToken) this.send({ type: 'locate-use', viewToken: this.data.viewToken, entry, ref: location.ref, field: location.field }); }));
    }
    if (item.locations.length > 20) {
      detail.append(this.node('p', `使用位置 ${this.usageOffset + 1}–${Math.min(item.locations.length, this.usageOffset + 20)} / ${item.locations.length}`));
      if (this.usageOffset) detail.append(this.button('上一组使用位置', () => { this.usageOffset -= 20; this.render(); this.get('detail').focus(); }));
      if (this.usageOffset + 20 < item.locations.length) detail.append(this.button('下一组使用位置', () => { this.usageOffset += 20; this.render(); this.get('detail').focus(); }));
    }
  }
  private controls(): void {
    const loading = this.busy || this.data.state === 'loading';
    this.root.setAttribute('aria-busy', String(loading));
    this.get('status').textContent = this.message || (loading ? '正在处理资源…' : this.data.state === 'error' ? '资源读取失败，请刷新重试。' : this.data.projectKey ? '' : '尚未打开项目。');
    this.get('status').hidden = !this.get('status').textContent;
    this.get('cancel').hidden = !loading;
    this.get('pagination').hidden = !this.data.nextCursor && this.data.total <= this.data.items.length;
    this.get('error').textContent = this.data.diagnostics.join('\n'); this.get('error').hidden = !this.data.diagnostics.length;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('button')) {
      const key = button.dataset.resource;
      button.disabled = key === 'cancel' ? !loading : loading || button.dataset.unavailable === 'true' || (!this.data.viewToken && ['import', 'next'].includes(key ?? '')) || key === 'next' && !this.data.nextCursor;
    }
    for (const control of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')) control.disabled = loading;
  }
  private node<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className?: string): HTMLElementTagNameMap[K] {
    const node = this.document.createElement(tag); node.textContent = text; if (className) node.className = className; return node;
  }
  private button(label: string, run: () => void): HTMLButtonElement { const button = this.node('button', label); button.type = 'button'; button.dataset.resourceFocus = label; button.addEventListener('click', run, { signal: this.renderScope.signal }); return button; }
}
function assignmentLabel(value: string): string {
  return ({ 'texture.environment-diffuse': '环境漫反射', 'texture.environment-specular': '环境镜面反射', 'texture.base-color': '基础颜色', 'texture.metallic-roughness': '金属度 / 粗糙度', 'texture.normal': '法线', 'texture.occlusion': '环境遮蔽', 'texture.emissive': '自发光', model: '模型', audio: '音频', animation: '动画' } as Record<string, string>)[value] ?? value;
}
