import { parseAgentExperience, parseExperienceDraft, parseExperienceLibrary, type AgentExperienceAdoptionV1, type AgentExperienceDraftV1, type AgentExperienceV1, type StableId } from '@haiyue/ai-studio-contracts';
import { parseExperienceArchive, type AgentExperienceArchiveChangeV1, parseExperienceReuseState, type AgentExperienceReuseChangeV1 } from '@haiyue/ai-studio-contracts';

export interface AgentExperiencePort {
  archiveList?(projectId: StableId, signal: AbortSignal, cursor?: string): Promise<unknown>;
  archive?(input: AgentExperienceArchiveChangeV1, signal: AbortSignal): Promise<unknown>;
  setReuse?(input: AgentExperienceReuseChangeV1, signal: AbortSignal): Promise<unknown>;
  list(projectId: StableId, signal: AbortSignal): Promise<unknown>;
  adopt(input: AgentExperienceAdoptionV1, signal: AbortSignal): Promise<unknown>;
  update(projectId: StableId, experience: AgentExperienceV1, draft: AgentExperienceDraftV1, enabled: boolean, signal: AbortSignal): Promise<unknown>;
}
export class AgentExperiencePanel {
  private readonly abort = new AbortController();
  private busy = false;
  private saving = false;
  private reuseSaving = false;
  private editingDraft = false;
  private loadGeneration = 0;
  constructor(private readonly root: HTMLElement, private readonly projectId: StableId, private readonly port: AgentExperiencePort, private readonly onEdit: (value: boolean) => void, private readonly openSource: (taskId: StableId) => void) { void this.load(); }
  setBusy(busy: boolean): void { this.busy = busy; this.buttons(); }
  refresh(): void { if (!this.abort.signal.aborted && !this.saving && !this.reuseSaving) void this.load(); }
  dispose(): void { this.abort.abort(); }
  private async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    try {
      const raw = await this.port.list(this.projectId,this.abort.signal); if (this.abort.signal.aborted || generation !== this.loadGeneration) return;
      if (!object(raw) || raw.projectId !== this.projectId) throw new Error('经验不属于当前项目。');
      const library = parseExperienceLibrary({schemaVersion:raw.schemaVersion,projectId:raw.projectId,revision:raw.revision,entries:raw.entries});
      if (raw.publishedEntries !== undefined && (!Array.isArray(raw.publishedEntries) || raw.publishedEntries.length > 100)) throw new Error('已发布经验数据无效。');
      const published = (raw.publishedEntries ?? [] as unknown[]) as unknown[];
      const visibleEntries = [...library.entries,...published.map(value => { const entry = parseAgentExperience(value); if (entry.projectId !== this.projectId || library.entries.some(e => e.id === entry.id)) throw new Error('已发布经验来源不一致。'); return entry; })];
      if (new Set(visibleEntries.map(e => e.id)).size !== visibleEntries.length) throw new Error('经验重复。');
      const details = el(this.root,'details'); details.dataset.experienceLibrary = '';
      details.append(el(this.root,'summary',`项目经验${raw.versioned ? '草稿库' : ''} · ${visibleEntries.filter(e => e.enabled).length} 条启用 / ${visibleEntries.length} 条`),el(this.root,'p',raw.versioned ? '已启用版本发布。这里的修改保存在草稿库，需要生成候选、验证并发布后才会用于任务。正在使用的内容请查看下方生效版本。' : '在下方复盘发现中点击“整理为经验”，填写适用条件与关键词并确认启用。只用于本项目后续相关任务，每次最多引用 3 条；不替代当前需求和审批。'));
      if (typeof raw.error === 'string') details.append(el(this.root,'p',raw.error));
      if (!visibleEntries.length) details.append(el(this.root,'p','还没有确认的经验。'));
      for (const entry of [...visibleEntries].reverse()) {
        const section = el(this.root,'section'); section.className = 'agent-review-finding'; section.dataset.experienceId = entry.id;
        section.append(el(this.root,'h4',`${entry.title} · ${entry.enabled ? '已启用' : '已停用'}`),el(this.root,'p',`适用条件：${entry.condition}`),el(this.root,'p',`关键词：${entry.keywords.join('、')}`),el(this.root,'p',matchingDescription(entry)),el(this.root,'p',entry.recommendation));
        if (!library.entries.some(e => e.id === entry.id)) section.append(el(this.root,'p','来自已发布的 AI 候选；编辑后保存到草稿库，归档会立即停止后续引用。'));
        const source = button(this.root,'查看来源复盘',() => this.openSource(entry.source.taskId));
        const provenance = el(this.root,'details'); provenance.append(el(this.root,'summary','来源与证据'),el(this.root,'p',`任务 ${entry.source.taskId} · ${entry.source.findingSource === 'rules' ? '规则分析' : 'AI 深度复盘'} · 原始发现：${entry.source.finding.title}`),el(this.root,'p',`证据：${entry.source.finding.recordIds.join('、')}`),el(this.root,'p',`复盘摘要 ${entry.source.reviewDigest}`));
        const uses = Array.isArray(raw.uses) ? raw.uses.filter(u => object(u) && Array.isArray(u.experienceIds) && u.experienceIds.includes(entry.id)) : [];
        const history = el(this.root,'details'); history.append(el(this.root,'summary',`最近引用记录 · ${uses.length}`),el(this.root,'p','以下记录表示已准备到任务上下文，不代表模型已执行，也不代表效果已经验证。'));
        for (const use of uses.slice(0,10)) if (object(use)) history.append(el(this.root,'p',`${String(use.at)} · ${String(use.taskId)}`));
        const controls = el(this.root,'div'); controls.className = 'agent-history-toolbar'; const formHost = el(this.root,'div');
        const status = el(this.root,'p'); status.setAttribute('role','status');
        const save = async (draft: AgentExperienceDraftV1, enabled: boolean) => {
          if (this.busy || this.saving) throw new Error('请等待当前任务或保存操作结束。');
          this.saving = true; this.editing(true); this.buttons();
          try { const value = parseAgentExperience(await this.port.update(this.projectId,entry,draft,enabled,this.abort.signal)); if (value.id !== entry.id || value.projectId !== this.projectId) throw new Error('经验更新不属于当前项目。'); }
          finally { this.saving = false; this.buttons(); }
        };
        const toggle = button(this.root,entry.enabled ? '停用' : '重新启用',() => {
          void save(draftOf(entry),!entry.enabled).then(async () => { this.editing(false); await this.load(); const d = this.root.querySelector('details'); if (d) d.open = true; }).catch(e => { if (!this.abort.signal.aborted) { this.editing(false); status.textContent = message(e); } });
        }); toggle.dataset.experienceAction = '';
        const edit = button(this.root,'编辑经验',() => {
          if (this.busy || this.saving) return; this.editing(true);
          formHost.replaceChildren(experienceForm(this.root,draftOf(entry),async draft => { await save(draft,entry.enabled); this.editing(false); await this.load(); const d = this.root.querySelector('details'); if (d) d.open = true; },() => { formHost.replaceChildren(); this.editing(false); }));
        }); edit.dataset.experienceAction = '';
        controls.append(source,edit,toggle);
        if (this.port.archive) {
          const archive = button(this.root,'归档经验',() => void this.changeArchive(entry,library.revision,'archive',status));
          archive.dataset.experienceAction = ''; controls.append(archive);
        } section.append(controls,provenance,history,status,formHost); details.append(section);
      }
      const reuse = this.port.setReuse ? this.reuseControl(raw) : null;
      this.root.replaceChildren(...(reuse ? [reuse,details] : [details]),...(this.port.archiveList && this.port.archive ? [this.archivePanel(Number(raw.archivedCount ?? 0))] : [])); this.buttons();
    } catch (cause) { if (!this.abort.signal.aborted && generation === this.loadGeneration) this.root.replaceChildren(el(this.root,'p',message(cause))); }
  }
  private async changeArchive(entry: AgentExperienceV1, libraryRevision: number, action: 'archive' | 'restore', status: HTMLElement): Promise<void> {
    if (this.busy || this.saving || this.editingDraft) { status.textContent = '请先完成当前任务或经验编辑。'; return; }
    this.saving = true; this.editing(true); this.buttons(); status.textContent = action === 'archive' ? '正在归档…' : '正在恢复…';
    try {
      const result = parseAgentExperience(await this.port.archive!({schemaVersion:1,projectId:this.projectId,id:entry.id,expectedRevision:entry.revision,libraryRevision,action},this.abort.signal));
      if (this.abort.signal.aborted) return;
      if (result.projectId !== this.projectId || result.id !== entry.id) throw new Error('归档结果不属于当前项目。');
      this.saving = false; this.editing(false); await this.load();
      const details = this.root.querySelector<HTMLDetailsElement>(action === 'archive' ? '[data-experience-archive]' : '[data-experience-library]'); if (details) details.open = true;
    } catch (cause) { if (!this.abort.signal.aborted) status.textContent = message(cause); }
    finally { this.saving = false; if (!this.abort.signal.aborted) { this.editing(false); this.buttons(); } }
  }
  private archivePanel(total: number): HTMLElement {
    const details = el(this.root,'details'); details.dataset.experienceArchive = '';
    details.append(el(this.root,'summary','经验归档 · '+total+' 条'),el(this.root,'p','归档释放经验库名额，并从后续经验匹配中排除。内容与来源长期保存在项目中；已有发布记录保持原样。恢复后按当前生效版本及暂停开关匹配。'));
    const body = el(this.root,'div'); details.append(body); let loaded = false, generation = 0; const previous: (string | undefined)[] = [];
    const page = async (cursor?: string) => {
      const owner = ++generation; body.textContent = '正在读取归档…';
      try {
        const value = await this.port.archiveList!(this.projectId,this.abort.signal,cursor);
        if (this.abort.signal.aborted || owner !== generation || !this.root.contains(details)) return;
        if (!object(value) || value.projectId !== this.projectId || !Number.isSafeInteger(value.revision) || !Array.isArray(value.records) || value.records.length > 20 || !Number.isSafeInteger(value.total) || !(value.nextCursor === null || typeof value.nextCursor === 'string')) throw new Error('归档列表格式无效。');
        body.replaceChildren(el(this.root,'p','共 '+value.total+' 条归档，本页 '+value.records.length+' 条。'));
        for (const raw of value.records) {
          if (!object(raw) || typeof raw.id !== 'string') throw new Error('归档列表格式无效。');
          const section = el(this.root,'details'); section.className = 'agent-history-record'; section.dataset.archivedExperience = raw.id;
          if (typeof raw.error === 'string') { section.append(el(this.root,'summary','归档读取失败'),el(this.root,'p',raw.error)); body.append(section); continue; }
          const archive = parseExperienceArchive(raw.archive), entry = archive.experience;
          if (archive.projectId !== this.projectId || entry.id !== raw.id) throw new Error('归档不属于当前项目。');
          const status = el(this.root,'p'); status.setAttribute('role','status');
          const restore = button(this.root,'恢复到经验库',() => void this.changeArchive(entry,Number(value.revision),'restore',status)); restore.dataset.experienceAction = '';
          section.append(el(this.root,'summary',entry.title),el(this.root,'p','归档时间：'+archive.archivedAt),el(this.root,'p','适用条件：'+entry.condition),el(this.root,'p','关键词：'+entry.keywords.join('、')),el(this.root,'p',entry.recommendation),button(this.root,'查看来源复盘',() => this.openSource(entry.source.taskId)),restore,status); body.append(section);
        }
        const nav = el(this.root,'div'); nav.className = 'agent-history-toolbar';
        const back = button(this.root,'上一页',() => void page(previous.pop())); back.disabled = !previous.length;
        const next = button(this.root,'下一页',() => { previous.push(cursor); void page(value.nextCursor as string); }); next.disabled = value.nextCursor === null;
        nav.append(back,next,button(this.root,'返回第一页',() => { previous.length = 0; void page(); })); body.append(nav); this.buttons();
      } catch (cause) { if (!this.abort.signal.aborted && owner === generation && this.root.contains(details)) body.replaceChildren(el(this.root,'p',message(cause)),button(this.root,'返回第一页',() => { previous.length = 0; void page(); })); }
    };
    details.addEventListener('toggle',() => { if (details.open && !loaded) { loaded = true; void page(); } }); return details;
  }
  private editing(value: boolean): void { this.editingDraft = value; this.onEdit(value || this.saving || this.reuseSaving); }
  private reuseControl(raw: Record<string,unknown>): HTMLElement {
    let state = parseExperienceReuseState(raw.reuse); if (state.projectId !== this.projectId) throw new Error('经验复用状态不属于当前项目。');
    const section = el(this.root,'section'); section.dataset.experienceReuse = '';
    const label = el(this.root,'strong'), status = el(this.root,'p'); status.setAttribute('role','status');
    const update = () => { label.textContent = raw.reuseError ? '经验复用已停止（记录异常）' : state.paused ? '经验复用已暂停' : '经验复用已开启'; toggle.textContent = state.paused ? '恢复经验复用' : '立即暂停经验复用'; toggle.setAttribute('aria-pressed',String(state.paused)); toggle.disabled = this.reuseSaving || typeof raw.reuseError === 'string'; };
    const toggle = button(this.root,'',() => {
      if (this.reuseSaving || raw.reuseError || this.abort.signal.aborted) return;
      const paused = !state.paused;
      this.reuseSaving = true; this.loadGeneration++; this.editing(this.editingDraft); update(); status.textContent = '正在保存经验复用状态…';
      void this.port.setReuse!({schemaVersion:1,projectId:this.projectId,expectedRevision:state.revision,paused},this.abort.signal).then(raw => {
        if (this.abort.signal.aborted || !this.root.contains(section)) return;
        const next = parseExperienceReuseState(raw); if (next.projectId !== this.projectId || next.paused !== paused || next.revision <= state.revision) throw new Error('经验复用状态返回异常，请刷新确认。');
        state = next; status.textContent = paused ? '已保存。从下一回合起停止引用项目经验。' : '已保存。从下一回合起恢复经验匹配。';
      }).catch(cause => { if (!this.abort.signal.aborted && this.root.contains(section)) status.textContent = message(cause); })
        .finally(() => { this.reuseSaving = false; if (!this.abort.signal.aborted) { this.editing(this.editingDraft); update(); } });
    });
    toggle.dataset.experienceReuseToggle = ''; update();
    const toolbar = el(this.root,'div'); toolbar.className = 'agent-history-toolbar'; toolbar.append(label,toggle);
    section.append(toolbar,el(this.root,'p','任务运行中也可暂停，下一回合生效。当前已发送给模型的经验无法撤回；草稿、发布版本和验证用例会保留。此开关仅影响当前项目，重启后保持。'),status);
    if (typeof raw.reuseError === 'string') status.textContent = raw.reuseError;
    return section;
  }
  private buttons(): void { for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-experience-action]')) b.disabled = this.busy || this.saving; }
}

export function experienceForm(root: HTMLElement, draft: AgentExperienceDraftV1, save: (draft: AgentExperienceDraftV1) => Promise<void>, close: () => void, note = '请核对适用范围与来源证据。已启用版本发布的项目，保存后还需生成候选并发布。'): HTMLFormElement {
  const form = el(root,'form'); form.className = 'agent-experience-form';
  const field = (label: string, value: string, max: number, multiline = false) => {
    const wrapper = el(root,'label',label); const input = multiline ? el(root,'textarea') : el(root,'input');
    input.value = value; input.required = true; input.maxLength = max; input.setAttribute('aria-label',label); if (input instanceof HTMLTextAreaElement) input.rows = 3;
    wrapper.append(input); form.append(wrapper); return input;
  };
  const title = field('经验标题',draft.title,200), condition = field('适用条件',draft.condition,800,true), keywords = field('匹配关键词（逗号分隔，至少一个）',draft.keywords.join(', '),500), recommendation = field('经验建议',draft.recommendation,2000,true);
  keywords.placeholder = '例如：棋盘, 旋转, scene.create';
  const minimum = field('至少命中几个关键词',String(draft.matching?.minimumMatches ?? 1),2) as HTMLInputElement;
  minimum.type = 'number'; minimum.min = '1'; minimum.max = '12'; minimum.step = '1';
  const required = field('必须出现的关键词（可留空，来自上方关键词）',draft.matching?.requiredKeywords.join(', ') ?? '',500);
  const excluded = field('排除词（可留空，逗号分隔）',draft.matching?.excludedKeywords.join(', ') ?? '',500);
  required.required = false; excluded.required = false;
  form.append(el(root,'p','适用条件用于说明，实际触发由关键词规则决定。必须词需全部出现；排除词优先。相同位置的重叠词只计一次，明确表示“不需要”的词不计入命中。英文按完整词或短语匹配，中文按短语匹配。'));
  const status = el(root,'p'); status.setAttribute('role','status');
  const submit = el(root,'button','确认保存'); submit.type = 'submit'; submit.dataset.experienceAction = '';
  const cancel = button(root,'取消',close);
  form.append(el(root,'p',note),submit,cancel,status);
  let saving = false;
  form.addEventListener('submit',event => {
    event.preventDefault(); if (saving || submit.disabled) return;
    let value: AgentExperienceDraftV1;
    const terms = (text: string) => [...new Set(text.split(/[,，、\n]/u).map(k => k.trim()).filter(Boolean))];
    const matching = {schemaVersion:1,minimumMatches:Number(minimum.value),requiredKeywords:terms(required.value),excludedKeywords:terms(excluded.value)};
    try { value = parseExperienceDraft({title:title.value.trim(),condition:condition.value.trim(),recommendation:recommendation.value.trim(),keywords:terms(keywords.value),...(draft.matching || matching.minimumMatches !== 1 || matching.requiredKeywords.length || matching.excludedKeywords.length ? {matching} : {})}); }
    catch { status.textContent = '请检查关键词规则：每个词 2–40 字，最多 12 个且不能重复；命中数不得超出关键词数量；必须词需来自关键词，排除词不能与关键词相同。内容不能包含敏感信息。'; return; }
    saving = true; submit.disabled = true; cancel.disabled = true;
    void save(value).catch(cause => { status.textContent = message(cause); }).finally(() => { saving = false; submit.disabled = false; cancel.disabled = false; });
  });
  return form;
}
export function matchingDescription(e: AgentExperienceDraftV1): string { return `触发：至少命中 ${e.matching?.minimumMatches ?? 1} 个独立关键词；必须包含：${e.matching?.requiredKeywords.join('、') || '无'}；排除：${e.matching?.excludedKeywords.join('、') || '无'}`; }
function draftOf(e: AgentExperienceV1): AgentExperienceDraftV1 { return {title:e.title,condition:e.condition,keywords:e.keywords,recommendation:e.recommendation,...(e.matching ? {matching:e.matching} : {})}; }
function el<K extends keyof HTMLElementTagNameMap>(root: HTMLElement, tag: K, text?: string): HTMLElementTagNameMap[K] { const node = root.ownerDocument.createElement(tag); if (text !== undefined) node.textContent = text; return node; }
function button(root: HTMLElement, text: string, action: () => void): HTMLButtonElement { const b = el(root,'button',text); b.type = 'button'; b.addEventListener('click',action); return b; }
function object(v: unknown): v is Record<string,unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function message(e: unknown): string { return e instanceof Error ? e.message : '经验操作失败。'; }
