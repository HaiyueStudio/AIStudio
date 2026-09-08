import type { BehaviorNodeV1 } from '@haiyue/ai-studio-contracts';
import type { DurableOperationEvent } from '@haiyue/ai-studio-operation-log';
import { layoutLogicGraph, projectLogicGraph, sourceLabel, type LogicArtifactReference, type LogicPanelData, type LogicPanelIntent } from './model.js';

/** Displays immutable read models and emits typed intents. DOM state is limited
 * to selection, paging, filtering, zoom and disclosure preferences. */
export class LogicExplorerPanel {
  readonly root: HTMLElement;
  private data: LogicPanelData = { documentId: null, documentRevision: 0, entityId: null, state: 'empty', diagnostic: null, manifest: null, explanation: null, trace: null, traceStatus: null, artifacts: [], playing: false };
  private language: 'en' | 'zh-CN' = 'zh-CN';
  private selected: string | null = null;
  private offset = 0;
  private eventOffset = 0;
  private historyCursor: string | null = null;
  private relatedCursor: string | undefined;
  private history: readonly LogicArtifactReference[] = [];
  private busy = false;
  private closed = false;
  private readonly lifetime = new AbortController();
  private readonly anchor: Comment;
  private readonly dialog: HTMLDialogElement;
  private returnFocus: HTMLElement | null = null;
  constructor(private readonly document: Document, parent: HTMLElement, private readonly dispatch: (intent: LogicPanelIntent) => void | Promise<void>) {
    this.root = document.createElement('section'); this.root.id = 'logic-explorer'; this.root.setAttribute('aria-label', '实体行为');
    // Only fixed product markup. All project/Agent text is assigned with textContent.
    this.root.innerHTML = `<div class="logic-toolbar"><button id="logic-refresh" type="button"></button><button id="logic-capture" type="button"></button><button id="logic-history" type="button"></button><button id="logic-cancel" type="button"></button></div>
<p id="logic-status" role="status" aria-live="polite"></p><div class="logic-filters"><label><span data-logic="group"></span><select id="logic-group"></select></label><label><span data-logic="search"></span><input id="logic-search" type="search" maxlength="128"></label></div>
<details id="logic-structure" open><summary data-logic="structure"></summary><p id="logic-legend"></p><div class="logic-toolbar"><label><span data-logic="zoom"></span><input id="logic-zoom" type="range" min="50" max="175" step="25" value="100"></label><button id="logic-previous" type="button">←</button><span id="logic-page"></span><button id="logic-next" type="button">→</button></div><div id="logic-canvas" tabindex="0"></div><p id="logic-relations"></p></details>
<section class="logic-selection"><p id="logic-node"></p><pre id="logic-source"></pre><div class="logic-toolbar"><button id="logic-explain" type="button"></button><button id="logic-locate" type="button"></button><button id="logic-related" type="button"></button></div><div id="logic-related-records"></div><button id="logic-related-next" type="button" hidden>→</button></section>
<details id="logic-explanation" open><summary data-logic="explanation"></summary><div id="logic-explanation-text"></div></details>
<details id="logic-trace" open><summary data-logic="trace"></summary><p id="logic-trace-status"></p><p id="logic-observation-time"></p><div class="logic-toolbar"><button id="logic-events-previous" type="button">←</button><span id="logic-events-page"></span><button id="logic-events-next" type="button">→</button></div><ol id="logic-events"></ol></details>
<details id="logic-records"><summary data-logic="records"></summary><ul id="logic-history-items"></ul><button id="logic-history-next" type="button"></button></details>`;
    this.anchor = document.createComment('logic-explorer-position'); parent.append(this.anchor, this.root);
    this.dialog = document.createElement('dialog'); this.dialog.id = 'logic-expanded'; this.dialog.setAttribute('aria-label', '行为结构与轨迹');
    const close = document.createElement('button'); close.id = 'logic-expanded-close'; close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '关闭 / Close');
    this.dialog.append(close); document.body.append(this.dialog);
    close.addEventListener('click', () => this.dialog.close(), { signal: this.lifetime.signal });
    this.dialog.addEventListener('close', () => { if (!this.dialog.open) this.restoreExpanded(); }, { signal: this.lifetime.signal });
    const expand = document.createElement('button'); expand.type = 'button'; expand.id = 'logic-expand'; expand.textContent = '↗'; expand.setAttribute('aria-label', '展开行为图 / Expand graph'); this.root.querySelector('.logic-toolbar')!.append(expand);
    expand.addEventListener('click', () => this.openExpanded(), { signal: this.lifetime.signal });
    const listen = (id: string, event: string, callback: () => void) => this.get(id).addEventListener(event, callback, { signal: this.lifetime.signal });
    for (const type of ['refresh','capture','history','cancel'] as const) listen(`logic-${type}`, 'click', () => this.send({ type }));
    listen('logic-history-next', 'click', () => { if (this.historyCursor) this.send({ type: 'history', cursor: this.historyCursor }); });
    listen('logic-group', 'change', () => { this.offset = 0; this.selected = this.get<HTMLSelectElement>('logic-group').value || null; this.render(); });
    listen('logic-search', 'input', () => { this.offset = 0; this.render(); });
    listen('logic-zoom', 'input', () => this.renderGraph());
    listen('logic-previous', 'click', () => { this.offset = Math.max(0, this.offset - 100); this.render(); });
    listen('logic-next', 'click', () => { this.offset += 100; this.render(); });
    listen('logic-events-previous', 'click', () => { this.eventOffset = Math.max(0, this.eventOffset - 100); this.renderTrace(); });
    listen('logic-events-next', 'click', () => { this.eventOffset += 100; this.renderTrace(); });
    listen('logic-explain', 'click', () => { if (this.selected && this.data.manifest) this.send({ type: 'explain', manifestDigest: this.data.manifest.digest, nodeIds: [this.selected], language: this.language }); });
    listen('logic-locate', 'click', () => { if (this.selected && this.data.manifest) this.send({ type: 'locate', manifestDigest: this.data.manifest.digest, nodeId: this.selected }); });
    listen('logic-related', 'click', () => this.requestRelated());
    listen('logic-related-next', 'click', () => this.requestRelated(this.relatedCursor));
    this.render();
  }
  update(data: LogicPanelData): void {
    if (this.closed) return;
    if (data.documentId !== this.data.documentId || data.entityId !== this.data.entityId || data.manifest?.digest !== this.data.manifest?.digest) {
      this.selected = null; this.offset = 0; this.eventOffset = 0; this.get<HTMLInputElement>('logic-search').value = ''; this.get<HTMLSelectElement>('logic-group').value = '';
      this.clearRelated();
    }
    if (data.documentId !== this.data.documentId) { this.history = []; this.historyCursor = null; }
    this.data = data; this.render();
  }
  setLanguage(language: 'en' | 'zh-CN'): void { this.language = language; this.render(); }
  setHistory(records: readonly LogicArtifactReference[], nextCursor: string | null = null): void { this.history = records.slice(0, 100); this.historyCursor = nextCursor; this.get<HTMLDetailsElement>('logic-records').open = true; this.renderHistory(); }
  setBusy(busy: boolean): void { this.busy = busy; this.root.setAttribute('aria-busy', String(busy)); this.renderControls(); }
  showDiagnostic(message: string): void { this.get('logic-status').textContent = message.slice(0, 512); }
  setRelated(nodeId: string, events: readonly DurableOperationEvent[], nextCursor?: string): void {
    if (this.closed || this.selected !== nodeId) return;
    const root = this.get('logic-related-records'); root.replaceChildren(); root.dataset.nodeId = nodeId; this.relatedCursor = nextCursor;
    const note = this.document.createElement('p'); note.textContent = this.text('以下是来源对象关联的真实记录；不表示它导致了某条执行路径。','Existing records linked to this source; association does not establish branch causation.'); root.append(note);
    for (const event of events.slice(0, 20)) {
      const row = this.document.createElement('details'), title = this.document.createElement('summary'), body = this.document.createElement('pre');
      title.textContent = `${event.kind} · ${event.timestamp}`;
      body.textContent = JSON.stringify({ eventId: event.eventId, correlation: event.correlation, evidence: event.artifactRefs, result: event.payload }, null, 2);
      row.append(title, body); root.append(row);
    }
    if (!events.length) note.textContent = this.text('未找到关联记录；不推断不存在的事务或证据。','No linked records found; no transaction or evidence is inferred.');
    this.get<HTMLButtonElement>('logic-related-next').hidden = !nextCursor;
  }
  private requestRelated(cursor?: string): void { if (this.selected && this.data.manifest) this.send({ type: 'related', manifestDigest: this.data.manifest.digest, nodeId: this.selected, ...(cursor ? { cursor } : {}) }); }
  private clearRelated(): void { this.get('logic-related-records').replaceChildren(); this.relatedCursor = undefined; this.get<HTMLButtonElement>('logic-related-next').hidden = true; }
  selectNode(nodeId: string): void { if (projectLogicGraph(this.data, { limit: 200 }).nodes.some(n => n.id === nodeId) || this.data.manifest?.nodes.some(n => n.id === nodeId && n.source.entityId === this.data.entityId)) { this.selected = nodeId; this.render(); } }
  openExpanded(): void { if (this.closed || this.dialog.open) return; this.returnFocus = this.document.activeElement as HTMLElement | null; this.dialog.append(this.root); this.dialog.showModal(); this.dialog.querySelector<HTMLButtonElement>('button')!.focus(); }
  closeExpanded(): void { if (this.dialog.open) { this.dialog.close(); this.restoreExpanded(); } }
  private restoreExpanded(): void { if (this.root.parentElement !== this.dialog) return; this.anchor.after(this.root); this.returnFocus?.focus(); }
  dispose(): void { if (this.closed) return; this.closed = true; this.lifetime.abort(); this.root.remove(); this.dialog.remove(); this.anchor.remove(); }
  private get<T extends HTMLElement = HTMLElement>(id: string): T { return this.root.querySelector<T>(`#${id}`)!; }
  private text(zh: string, en: string): string { return this.language === 'zh-CN' ? zh : en; }
  private send(intent: LogicPanelIntent): void { if (!this.closed) void Promise.resolve().then(() => this.dispatch(intent)).catch(() => this.showDiagnostic(this.text('操作未完成，请刷新或检查项目状态。', 'Request failed. Refresh or check the project state.'))); }
  private view() { return projectLogicGraph(this.data, { group: this.get<HTMLSelectElement>('logic-group').value, search: this.get<HTMLInputElement>('logic-search').value, offset: this.offset }); }
  private render(): void {
    if (this.closed) return;
    const labels: Record<string, [string,string]> = { group: ['事件分组','Event group'], search: ['搜索行为与来源','Search behavior and sources'], structure: ['行为结构','Behavior structure'], zoom: ['缩放','Zoom'], explanation: ['独立解释','Explanation'], trace: ['一次 Play 的轨迹','One Play trace'], records: ['项目记录','Project records'] };
    for (const element of this.root.querySelectorAll<HTMLElement>('[data-logic]')) { const label = labels[element.dataset.logic!]; element.textContent = this.text(...label); }
    const group = this.get<HTMLSelectElement>('logic-group'), previous = group.value, graph = this.view(); group.replaceChildren();
    const option = (value: string, label: string) => { const item = this.document.createElement('option'); item.value = value; item.textContent = label; group.append(item); };
    option('', this.text('全部行为','All behavior')); graph.groups.forEach(node => option(node.id, `${node.label} · ${sourceLabel(node)}`));
    if ([...group.options].some(item => item.value === previous)) group.value = previous;
    if (!this.selected || !this.data.manifest?.nodes.some(n => n.id === this.selected)) this.selected = graph.nodes[0]?.id ?? null;
    this.get('logic-status').textContent = this.data.diagnostic ? this.text('行为服务暂不可用，可重试。','Behavior service is unavailable. Retry.') : this.data.state === 'analyzing' ? this.text('正在分析结构…','Analyzing structure…') : !this.data.documentId ? this.text('打开项目后查看行为。','Open a project to inspect behavior.') : !this.data.manifest ? this.text('选择实体，然后加载行为结构。','Select an entity, then load its structure.') : !graph.current ? this.text('正在查看历史结构，来源跳转已停用。','Historical structure; source navigation is disabled.') : this.data.manifest.truncation.truncated ? this.text('结构已截断；未分析部分保持未知。','Structure truncated; omitted regions remain unknown.') : this.text('结构、解释和运行轨迹分别记录。','Structure, explanation and trace are independent records.');
    this.get('logic-legend').textContent = this.text('蓝：静态结构 · 绿：运行已观测 · 橙：未知。相邻位置不代表并行。','Blue: static · Green: observed · Orange: unknown. Placement does not establish concurrency.');
    this.renderGraph(); this.renderSelection(); this.renderExplanation(); this.renderTrace(); this.renderHistory(); this.renderControls();
  }
  private renderControls(): void {
    const graph = this.view();
    const labels = { refresh: ['加载结构','Load structure'], capture: ['读取本次轨迹','Read Play trace'], history: ['读取项目记录','Read project records'], cancel: ['取消分析','Cancel analysis'], explain: ['解释此节点','Explain node'], locate: ['回到来源','Go to source'], related: ['关联执行记录','Linked execution records'] };
    for (const [key, label] of Object.entries(labels)) this.get(`logic-${key}`).textContent = this.text(label[0], label[1]);
    this.get<HTMLButtonElement>('logic-refresh').disabled = this.busy || !this.data.documentId || this.data.playing;
    this.get<HTMLButtonElement>('logic-capture').disabled = this.busy || !this.data.playing;
    this.get<HTMLButtonElement>('logic-history').disabled = this.busy || !this.data.documentId;
    this.get<HTMLButtonElement>('logic-history-next').disabled = this.busy || !this.historyCursor;
    this.get<HTMLButtonElement>('logic-cancel').disabled = !this.busy || this.data.playing;
    for (const id of ['logic-explain','logic-locate','logic-related','logic-related-next']) this.get<HTMLButtonElement>(id).disabled = this.busy || !this.selected || !graph.current;
  }
  private renderGraph(): void {
    const graph = this.view(), root = this.get('logic-canvas'); root.replaceChildren();
    this.get('logic-page').textContent = `${graph.total ? this.offset + 1 : 0}–${Math.min(this.offset + 100, graph.total)} / ${graph.total}`;
    this.get<HTMLButtonElement>('logic-previous').disabled = this.offset === 0; this.get<HTMLButtonElement>('logic-next').disabled = this.offset + 100 >= graph.total;
    if (!graph.nodes.length) { root.textContent = this.text('此分组没有可显示的节点。','No nodes match this group.'); return; }
    const placed = layoutLogicGraph(graph.nodes, graph.edges), positions = new Map(placed.map(n => [n.node.id, n]));
    const width = Math.max(250, ...placed.map(p => p.x + 210)), height = Math.max(180, ...placed.map(p => p.y + 82)), zoom = Number(this.get<HTMLInputElement>('logic-zoom').value) / 100;
    const svg = this.document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('width', String(width * zoom)); svg.setAttribute('height', String(height * zoom)); svg.setAttribute('role','group'); svg.setAttribute('aria-label',this.text('有来源依据的行为结构图','Source-backed behavior graph'));
    const make = (tag: string, attributes: Record<string,string>, text?: string) => { const element = this.document.createElementNS('http://www.w3.org/2000/svg',tag); Object.entries(attributes).forEach(([key,value]) => element.setAttribute(key,value)); if (text !== undefined) element.textContent = text; return element; };
    const defs = make('defs', {}), marker = make('marker', { id: 'logic-arrow', viewBox: '0 0 10 10', refX: '10', refY: '5', markerWidth: '5', markerHeight: '5', orient: 'auto' }); marker.append(make('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#6c91b9' })); defs.append(marker); svg.append(defs);
    for (const edge of graph.edges) { const a = positions.get(edge.from)!, b = positions.get(edge.to)!; const line = make('path', { d: `M${a.x+190},${a.y+27} C${a.x+220},${a.y+27} ${b.x-25},${b.y+27} ${b.x},${b.y+27}`, class: `logic-edge ${edge.kind === 'concurrent' ? 'concurrent' : ''}`, 'data-edge-kind': edge.kind, 'marker-end': 'url(#logic-arrow)' }); line.append(make('title', {}, edge.kind)); svg.append(line); }
    const observed = new Set(graph.overlay ? this.data.trace!.trace.events.filter(event => event.nodeId).map(event => event.nodeId) : []);
    for (const item of placed) {
      const { node, x, y } = item, seen = observed.has(node.id), g = make('g', { transform: `translate(${x} ${y})`, role: 'button', tabindex: '0', class: `logic-graph-node ${node.unknown ? 'unknown' : 'static'} ${seen ? 'observed' : ''} ${node.id === this.selected ? 'selected' : ''}`, 'data-node-id': node.id, 'aria-label': `${node.label} · ${sourceLabel(node)}` });
      g.append(make('rect', { width: '190', height: '60', rx: '8' }), make('text', { x: '10', y: '22' }, node.label.slice(0, 24)), make('text', { x: '10', y: '43', class: 'logic-node-meta' }, `${seen ? this.text('已观测','Observed') : node.unknown ? this.text('未知','Unknown') : this.text('静态结构','Static')} · ${node.kind}`), make('title', {}, sourceLabel(node)));
      const select = () => { this.clearRelated(); this.selected = node.id; this.render(); this.root.querySelector<SVGElement>(`[data-node-id="${node.id}"]`)?.focus(); }; g.addEventListener('click', select); g.addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Enter' || (event as KeyboardEvent).key === ' ') { event.preventDefault(); select(); } }); svg.append(g);
    }
    root.append(svg);
    const counts = new Map<string,number>(); for (const edge of graph.edges) counts.set(edge.kind, (counts.get(edge.kind) ?? 0) + 1);
    this.get('logic-relations').textContent = [...counts].map(([kind,count]) => `${kind}: ${count}`).join(' · ');
  }
  private renderSelection(): void {
    const node = this.data.manifest?.nodes.find(node => node.id === this.selected);
    if (this.get('logic-related-records').dataset.nodeId !== this.selected) this.clearRelated();
    this.get('logic-node').textContent = node ? `${node.label} · ${node.kind}${node.unknown ? ` · ${node.unknown}` : ''}` : this.text('选择节点查看来源与解释。','Select a node to inspect its source and explanation.');
    this.get('logic-source').textContent = node ? sourceLabel(node) : '';
  }
  private renderExplanation(): void {
    const root = this.get('logic-explanation-text'); root.replaceChildren(); const explanation = this.data.explanation;
    if (!explanation) { root.textContent = this.text('解释独立加载，不改变结构。','Explanations load independently without changing structure.'); return; }
    const label = this.document.createElement('p'); label.textContent = `${explanation.language} · ${explanation.producer.kind}${explanation.manifestDigest !== this.data.manifest?.digest ? this.text(' · 历史结构',' · Historical structure') : ''}`; root.append(label);
    for (const entry of explanation.entries.slice(0,100)) { const p = this.document.createElement('p'); p.textContent = entry.text; p.dataset.explanationNode = entry.nodeId; root.append(p); }
  }
  private renderTrace(): void {
    const artifact = this.data.trace, root = this.get('logic-events'); root.replaceChildren();
    const graph = this.view(), events = artifact?.trace.events.filter(event => !this.data.entityId || event.entityId === this.data.entityId) ?? [];
    this.get('logic-trace-status').textContent = !artifact ? this.text('尚未读取轨迹。运行 Play 后可单独读取，停止时自动保存。','No trace loaded. Read it during Play; Stop saves it automatically.') : !graph.overlay ? this.text('历史版本轨迹，仅显示记录，不叠加当前结构。','Historical revision: records only, no overlay on current structure.') : `${this.data.traceStatus === 'current' ? this.text('当前 Play','Current Play') : this.text('已结束或历史 Play','Ended or historical Play')} · ${artifact.trace.playId}${artifact.trace.truncation.truncated ? this.text(` · 至少遗漏 ${artifact.trace.truncation.omittedAtLeast} 条`,` · At least ${artifact.trace.truncation.omittedAtLeast} omitted`) : ''}`;
    this.get('logic-observation-time').textContent = artifact ? `${artifact.observation.capturedAt} · tick ${artifact.observation.tick} / frame ${artifact.observation.frame}` : '';
    this.eventOffset = Math.min(this.eventOffset, Math.max(0, Math.floor((events.length - 1) / 100) * 100));
    this.get('logic-events-page').textContent = `${events.length ? this.eventOffset + 1 : 0}–${Math.min(this.eventOffset + 100,events.length)} / ${events.length}`;
    this.get<HTMLButtonElement>('logic-events-previous').disabled = this.eventOffset === 0; this.get<HTMLButtonElement>('logic-events-next').disabled = this.eventOffset + 100 >= events.length;
    for (const event of events.slice(this.eventOffset,this.eventOffset+100)) {
      const row = this.document.createElement('li'), title = this.document.createElement('button'); title.type = 'button';
      const node = graph.overlay ? this.data.manifest?.nodes.find(n => n.id === event.nodeId) : null;
      title.textContent = `#${event.sequence} · ${event.tick}/${event.frame} · ${event.kind === 'node-enter' ? this.text('到达表达式/入口','Reached expression/entry') : event.kind === 'node-exit' ? this.text('完成表达式','Expression completed') : event.kind} · ${node?.label ?? event.event ?? '—'}${event.durationMicros === null ? '' : ` · ${event.durationMicros} μs`}`;
      title.disabled = !node; title.addEventListener('click', () => { if (node) this.selectNode(node.id); }); row.append(title);
      if (event.stateDiff || event.error) { const detail = this.document.createElement('pre'); detail.textContent = event.error ?? JSON.stringify(event.stateDiff, null, 2); row.append(detail); } root.append(row);
    }
  }
  private renderHistory(): void {
    const root = this.get('logic-history-items'); root.replaceChildren(); const items = this.history.length ? this.history : this.data.artifacts;
    const next = this.get<HTMLButtonElement>('logic-history-next'); next.textContent = this.text('下一页记录','Next records'); next.disabled = this.busy || !this.historyCursor; next.hidden = !this.historyCursor;
    for (const reference of items.slice(-100).reverse()) {
      const row = this.document.createElement('li'), button = this.document.createElement('button'); button.type = 'button'; button.textContent = `${reference.kind} · r${reference.documentRevision} · ${reference.createdAt}`; button.dataset.artifactId = reference.artifactId;
      button.addEventListener('click', () => this.send({ type: 'read', kind: reference.kind, artifactId: reference.artifactId })); row.append(button); root.append(row);
    }
    if (!items.length) root.textContent = this.text('此项目尚无行为记录。','No behavior records in this project yet.');
  }
}
