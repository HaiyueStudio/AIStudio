import { ExperienceEffectsPanel } from './effects.js';
import { asStableId, parseExperienceAutoStatus, parseAgentExperience, parseExperienceCases, parseExperienceOptimizationCommand, parseExperienceOptimizationState, parseExperienceValidation, type AgentExperienceV1, type ExperienceOptimizationCommandV1, type ExperienceOptimizationStateV1, type ExperienceReleaseV1, type StableId } from '@haiyue/ai-studio-contracts';
import { experienceForm, matchingDescription } from './experiences.js';

export interface AgentOptimizationPort {
  effects?(projectId: StableId, signal: AbortSignal, cursor?: string): Promise<unknown>;
  list(projectId: StableId, signal: AbortSignal, releaseId?: StableId, cursor?: string): Promise<unknown>;
  command(input: ExperienceOptimizationCommandV1, signal: AbortSignal): Promise<unknown>;
}
type Action = ExperienceOptimizationCommandV1 extends infer C ? C extends ExperienceOptimizationCommandV1 ? Omit<C,'schemaVersion'|'projectId'|'expectedRevision'> : never : never;
export class AgentOptimizationPanel {
  private readonly abort = new AbortController();
  private loadGeneration = 0;
  private effects: ExperienceEffectsPanel | null = null;
  private historyCursor: string | undefined;
  private readonly historyPrevious: (string | undefined)[] = [];
  private busy = false; private saving = false; private editing = false;
  private state: ExperienceOptimizationStateV1 | null = null;
  private entries: readonly AgentExperienceV1[] = [];
  private readonly status: HTMLElement;
  constructor(private readonly root: HTMLElement, private readonly projectId: StableId, private readonly port: AgentOptimizationPort, private readonly onEdit: (editing: boolean) => void, private readonly openSource?: (taskId: StableId) => void) {
    this.status = el(root,'p'); this.status.setAttribute('role','status'); void this.load();
  }
  setBusy(busy: boolean): void { this.busy = busy; this.buttons(); }
  dispose(): void { this.abort.abort(); this.effects?.dispose(); }
  private async load(cursor?: string, keepHistory = false): Promise<void> {
    const generation = ++this.loadGeneration;
    try { const raw = await this.port.list(this.projectId,this.abort.signal,undefined,cursor); if (generation !== this.loadGeneration) return; this.historyCursor = cursor; this.render(raw); if (cursor || keepHistory) { const history = this.root.querySelector<HTMLDetailsElement>('[data-optimization-releases]'); if (history) { history.open = true; const outer = this.root.querySelector<HTMLDetailsElement>('[data-optimizations]'); if (outer) outer.open = true; } } }
    catch (cause) { if (!this.abort.signal.aborted && generation === this.loadGeneration) this.root.replaceChildren(el(this.root,'p',message(cause)),button(this.root,'返回最新版本',() => { this.historyPrevious.length = 0; void this.load(); })); }
  }
  private render(raw: unknown): void {
    if (this.abort.signal.aborted) return;
    this.effects?.dispose(); this.effects = null;
    if (!object(raw)) throw new Error('优化版本数据无效。');
    const state = parseExperienceOptimizationState(raw.state); if (state.projectId !== this.projectId) throw new Error('优化版本不属于当前项目。');
    this.state = state; this.status.textContent = '';
    const open = this.root.querySelector('details')?.open ?? false;
    const details = el(this.root,'details'); details.dataset.optimizations = ''; details.open = open;
    const release = state.releases.find(r => r.id === state.activeReleaseId);
    details.append(el(this.root,'summary',`候选优化与发布 · ${release ? `生效 v${release.number}` : '尚未启用版本发布'}`),el(this.root,'p','将项目经验整理为候选版本，比较改动、验证后确认发布。发布仅影响后续回合；每次最多引用 3 条，不改变工具权限或审批规则。'));
    if (raw.automatic !== undefined && raw.automatic !== null) {
      const automatic = parseExperienceAutoStatus(raw.automatic);
      if (automatic.projectId !== this.projectId) throw new Error('自动整理状态不属于当前项目。');
      const labels = {idle:'等待新增证据',running:'正在整理',waiting:'等待审阅当前候选',completed:'候选已生成',none:'未发现新候选',failed:'未完成',cancelled:'已取消'};
      const panel = el(this.root,'section'); panel.dataset.automaticCandidate = ''; panel.setAttribute('role','status');
      panel.append(el(this.root,'strong','AI 自动整理 · ' + labels[automatic.status]),el(this.root,'p',automatic.summary));
      panel.append(el(this.root,'p','每份新增证据最多自动尝试一次，最多 3 条建议；独立单回合、90 秒。会使用当前模型额度，结果需审阅后验证发布。'));
      if (automatic.usageLabel) panel.append(el(this.root,'p',automatic.usageLabel));
      if (automatic.taskId && this.openSource) panel.append(button(this.root,'查看整理来源',() => this.openSource!(automatic.taskId!)));
      details.append(panel);
    }
    if (typeof raw.error === 'string') { details.append(el(this.root,'p',raw.error)); this.root.replaceChildren(details); return; }
    const active = entries(raw.activeEntries,this.projectId); this.entries = entries(raw.candidateEntries,this.projectId);
    const current = el(this.root,'details'); current.append(el(this.root,'summary',release ? `当前生效：v${release.number} · ${release.title}` : '当前正在使用的经验'));
    current.append(el(this.root,'p','此处保留版本原始内容。已归档的经验从实际匹配中排除；暂停开关优先。'));
    for (const entry of active) current.append(el(this.root,'p',describe(entry))); details.append(current);
    const candidate = state.candidate;
    if (!candidate) {
      const title = el(this.root,'input'); title.placeholder = '例如：减少重复读取和无效重试'; title.maxLength = 200; title.setAttribute('aria-label','候选版本名称');
      const create = this.action('生成候选版本',() => this.send({action:'create',title:title.value.trim() || '项目经验优化'}));
      details.append(el(this.root,'p',release ? '候选会保留已发布优化，合入草稿库的新改动，并继承项目回归用例。' : '首次生成会冻结当前经验为基线。从此，草稿修改需要发布才能生效。'),title,create);
      if (state.regressionCases) details.append(el(this.root,'p',`已保存 ${state.regressionCases.length} 条项目回归用例。放弃候选或回滚版本不会清空用例。`));
    } else {
      const header = el(this.root,'h4',`${candidate.title} · 候选修订 ${candidate.revision}`); details.append(header);
      const changes = this.entries.filter(e => JSON.stringify(content(e)) !== JSON.stringify(content(active.find(p => p.id === e.id))));
      details.append(el(this.root,'p',`与生效版本比较：${changes.length} 条经验有改动，${active.filter(e => !this.entries.some(next => next.id === e.id)).length} 条已移出候选。`));
      for (const entry of this.entries) {
        const before = active.find(e => e.id === entry.id), changed = changes.includes(entry);
        const item = el(this.root,'details'); item.className = 'agent-review-finding'; item.dataset.candidateExperience = entry.id;
        item.append(el(this.root,'summary',`${entry.title} · ${entry.enabled ? '启用' : '停用'}${changed ? ' · 已修改' : ''}`));
        item.append(el(this.root,'p',`生效版本：${before ? describe(before) : '无此经验'}`),el(this.root,'p',`候选版本：${describe(entry)}`));
        item.append(el(this.root,'p','来源发现：' + entry.source.finding.title),el(this.root,'p','证据：' + entry.source.finding.recordIds.join('、')));
        if (this.openSource) item.append(button(this.root,'查看来源复盘',() => this.openSource!(entry.source.taskId)));
        const formHost = el(this.root,'div');
        item.append(this.action('编辑候选经验',() => {
          this.edit(true);
          formHost.replaceChildren(experienceForm(this.root,{title:entry.title,condition:entry.condition,recommendation:entry.recommendation,keywords:entry.keywords,...(entry.matching ? {matching:entry.matching} : {})},draft => this.send({action:'edit',experienceId:entry.id,enabled:entry.enabled,draft}),() => { formHost.replaceChildren(); this.edit(false); },'只修改当前候选。编辑后需重新验证，再确认发布。'));
        }),this.action(entry.enabled ? '在候选中停用' : '在候选中启用',() => this.send({action:'edit',experienceId:entry.id,enabled:!entry.enabled,draft:{title:entry.title,condition:entry.condition,recommendation:entry.recommendation,keywords:entry.keywords,...(entry.matching ? {matching:entry.matching} : {})}})),formHost);
        details.append(item);
      }
      const tests = el(this.root,'details'); tests.dataset.optimizationTests = ''; tests.append(el(this.root,'summary',`验证用例 · ${candidate.cases.length}`));
      tests.append(el(this.root,'p','保存后作为项目回归用例供后续候选继承。经验停用或变更时，请检查原有预期；系统不会自动删除不再通过的用例。'));
      for (const c of candidate.cases) tests.append(el(this.root,'p',`${c.request} → ${c.expectedIds.map(id => this.entries.find(e => e.id === id)?.title ?? id).join('、') || '不引用经验'}`));
      const formHost = el(this.root,'div'); tests.append(this.action('填写验证用例',() => { this.edit(true); this.caseForm(formHost); }),formHost); details.append(tests);
      details.append(el(this.root,'p','验证使用固定匹配规则，不调用模型。至少填写正例和不应引用经验的反例，并覆盖改动的经验。通过仅代表来源与匹配检查通过，实际效果仍需任务验证。'));
      details.append(this.action('验证候选',() => this.send({action:'validate'})));
      if (candidate.validation) {
        details.append(this.validationReport(raw.evaluation,raw.comparison));
      }
      const publish = this.action('确认发布',() => this.send({action:'publish'})); publish.dataset.requiresValidation = ''; publish.dataset.validated = String(candidate.validation?.passed === true);
      details.append(publish,this.action('放弃当前候选',() => this.send({action:'discard'})));
    }
    let historyReleases = state.releases;
    if (object(raw.history) && Array.isArray(raw.history.releases)) {
      const rows = raw.history.releases;
      historyReleases = parseExperienceOptimizationState({schemaVersion:1,projectId:this.projectId,revision:0,activeReleaseId:object(rows.at(-1)) ? rows.at(-1).id : null,candidate:null,releases:rows}).releases;
    }
    if (state.releases.length) {
      const history = el(this.root,'details'); history.dataset.optimizationReleases = ''; history.append(el(this.root,'summary',`版本记录 · 共 ${object(raw.history) ? raw.history.total : state.releases.length} 个`));
      for (const item of [...historyReleases].reverse()) {
        const row = el(this.root,'div'); row.dataset.releaseId = item.id; row.append(el(this.root,'p',`v${item.number} · ${item.title} · ${item.createdAt}${item.id === state.activeReleaseId ? ' · 生效中' : ''}`));
        if (item.evaluationArtifactId) {
          const host = el(this.root,'div'); host.dataset.releaseReport = ''; host.hidden = true;
          let loaded = false;
          const show = button(this.root,'查看验证报告',() => {
            host.hidden = !host.hidden; show.textContent = host.hidden ? '查看验证报告' : '收起验证报告'; show.setAttribute('aria-expanded',String(!host.hidden));
            if (!loaded) { loaded = true; void this.loadReport(item,host).then(ok => { loaded = ok; }); }
          }); show.setAttribute('aria-expanded','false'); row.append(show,host);
        } else row.append(el(this.root,'p',item.kind === 'rollback' ? '此版本恢复初始基线，没有离线验证报告。' : '初始经验基线，没有离线验证报告。'));
        const uses = Array.isArray(raw.uses) ? raw.uses.filter(u => object(u) && u.releaseId === item.id && typeof u.taskId === 'string') : [];
        if (uses.length) {
          const citations = el(this.root,'details'); citations.append(el(this.root,'summary',`最近引用任务 · ${uses.length}`),el(this.root,'p','记录表示已准备到任务上下文，不代表模型执行效果。可结合对应任务复盘查看结果。'));
          for (const use of uses) if (object(use)) { const id = asStableId(use.taskId as string); const p = el(this.root,'p',`${String(use.at)} · ${id}`); if (this.openSource) p.append(button(this.root,'查看任务复盘',() => this.openSource!(id))); citations.append(p); }
          row.append(citations);
        }
        if (item.id !== state.activeReleaseId) { const b = this.action(`回滚至 v${item.number}`,() => this.send({action:'rollback',releaseId:item.id})); b.dataset.blockedByCandidate = String(!!candidate); row.append(b); }
        history.append(row);
      }
      if (object(raw.history)) {
        const page = raw.history;
        if (Array.isArray(page.errors)) for (const error of page.errors) if (object(error) && typeof error.message === 'string') history.append(el(this.root,'p',error.message));
        const back = this.action('较新版本',() => this.load(this.historyPrevious.pop(),true)); back.dataset.blockedByCandidate = String(!this.historyPrevious.length);
        const next = this.action('更早版本',() => { this.historyPrevious.push(this.historyCursor); return this.load(page.nextCursor as string,true); }); next.dataset.blockedByCandidate = String(typeof page.nextCursor !== 'string');
        history.append(back,next);
      }
      if (candidate) history.append(el(this.root,'p','回滚前需先放弃当前候选。')); details.append(history);
    }
    if (this.port.effects) { const host = el(this.root,'div'); details.append(host); this.effects = new ExperienceEffectsPanel(host,this.projectId,this.port.effects,this.openSource); }
    details.append(this.status); this.root.replaceChildren(details); this.buttons();
  }
  private caseForm(host: HTMLElement): void {
    const form = el(this.root,'form'); form.className = 'agent-experience-form'; const rows = el(this.root,'div');
    const add = (request = '', expectedIds: readonly StableId[] = [], id = asStableId(`case:${crypto.randomUUID()}`)) => {
      if (rows.children.length >= 24) return;
      const row = el(this.root,'fieldset'); row.dataset.caseId = id;
      const input = el(this.root,'textarea'); input.setAttribute('aria-label','验证请求'); input.placeholder = '输入一个代表性的任务需求'; input.value = request; input.required = true; input.maxLength = 2000; input.rows = 2;
      const select = el(this.root,'select'); select.multiple = true; select.size = Math.min(4,Math.max(2,this.entries.length)); select.setAttribute('aria-label','预期引用经验');
      for (const e of this.entries) { const option = el(this.root,'option',`${e.title}${e.enabled ? '' : '（已停用）'}`); option.value = e.id; option.selected = expectedIds.includes(e.id); select.append(option); }
      for (const missing of expectedIds.filter(id => !this.entries.some(e => e.id === id))) { const option = el(this.root,'option',`${missing}（已不在候选中）`); option.value = missing; option.selected = true; select.append(option); }
      row.append(input,el(this.root,'p','预期引用的经验（可多选；不选表示不应引用任何经验）'),select,button(this.root,'删除用例',() => row.remove())); rows.append(row);
    };
    for (const c of this.state!.candidate!.cases) add(c.request,c.expectedIds,c.id); if (!rows.children.length) { add(); add(); }
    const status = el(this.root,'p'); status.setAttribute('role','status'); const save = el(this.root,'button','保存验证用例'); save.type = 'submit'; save.dataset.optimizationAction = '';
    form.append(rows,button(this.root,'添加用例',() => add()),save,button(this.root,'取消',() => { host.replaceChildren(); this.edit(false); }),status);
    form.addEventListener('submit',event => {
      event.preventDefault(); if (this.busy || this.saving) return;
      try {
        const cases = parseExperienceCases([...rows.querySelectorAll<HTMLFieldSetElement>('fieldset')].map(row => ({id:row.dataset.caseId,request:row.querySelector('textarea')!.value.trim(),expectedIds:[...row.querySelector('select')!.selectedOptions].map(o => o.value)})));
        void this.send({action:'cases',cases}).catch(cause => { status.textContent = message(cause); });
      } catch (cause) { status.textContent = message(cause); }
    }); host.replaceChildren(form);
  }
  private async loadReport(release: ExperienceReleaseV1, host: HTMLElement): Promise<boolean> {
    host.textContent = '正在读取历史验证报告…';
    try {
      const raw = await this.port.list(this.projectId,this.abort.signal,release.id);
      if (this.abort.signal.aborted || !this.root.contains(host)) return false;
      if (!object(raw) || parseExperienceOptimizationState(raw.state).projectId !== this.projectId || !object(raw.releaseReport) || raw.releaseReport.releaseId !== release.id) throw new Error('历史验证报告不属于所选项目或版本。');
      if (typeof raw.releaseReport.error === 'string') throw new Error(raw.releaseReport.error);
      const report = parseExperienceValidation(raw.releaseReport.evaluation,raw.releaseReport.comparison);
      if (report.comparison.projectId !== this.projectId || report.comparison.candidateLibraryArtifactId !== release.libraryArtifactId) throw new Error('历史验证报告与所选版本不匹配。');
      host.replaceChildren(el(this.root,'p',release.kind === 'rollback' ? '这是恢复版本原有的验证报告；回滚没有重新运行验证。' : '这是发布当时保存的验证报告，不会按当前经验重新计算。'),this.validationReport(report.evaluation,report.comparison,true));
      return true;
    } catch (cause) { if (!this.abort.signal.aborted && this.root.contains(host)) host.textContent = message(cause); return false; }
  }
  private validationReport(evaluation: unknown, comparison: unknown, historical = false): HTMLElement {
    const report = parseExperienceValidation(evaluation,comparison), e = report.evaluation;
    if (report.comparison.projectId !== this.projectId) throw new Error('验证报告不属于当前项目。');
    const host = el(this.root,'section'); host.dataset.validationReport = '';
    host.append(el(this.root,'strong',`${historical ? '历史' : ''}离线验证${e.status === 'pass' ? '通过' : '未通过'}`),el(this.root,'p',`验证时间：${e.completedAt} · 验证器 ${e.evaluatorVersion} · 候选修订 ${report.comparison.candidateRevision}`),el(this.root,'p','仅检查来源、匹配规则和上下文大小，不代表实际任务效果。'));
    const checks = el(this.root,'details'); checks.append(el(this.root,'summary',`检查结果 · ${e.acceptanceResults.filter(r => r.status === 'pass').length}/${e.acceptanceResults.length} 通过`));
    const labels: Record<string,string> = {'acceptance:current':'版本一致性','acceptance:changed':'候选内容差异','acceptance:sources':'来源证据','acceptance:coverage':'用例覆盖'};
    for (const c of report.comparison.cases) labels[`acceptance:case-${c.id}`] = `用例：${c.request}`;
    for (const r of e.acceptanceResults) checks.append(el(this.root,'p',`${labels[r.acceptanceId] ?? r.acceptanceId}：${r.status === 'pass' ? '通过' : '未通过'}${r.diagnostic ? ` · ${r.diagnostic}` : ''}`)); host.append(checks);
    const table = el(this.root,'table'); table.className = 'agent-optimization-results';
    const head = el(this.root,'tr'); for (const title of ['用例与引用明细','旧版','候选','上下文大小']) head.append(el(this.root,'th',title)); table.append(head);
    for (const c of report.comparison.cases) {
      const row = el(this.root,'tr'), request = el(this.root,'td',c.request), ids = el(this.root,'details');
      ids.append(el(this.root,'summary','引用明细'),el(this.root,'p',`预期：${c.expectedIds.join('、') || '不引用经验'}`),el(this.root,'p',`旧版：${c.beforeIds.join('、') || '未引用'}`),el(this.root,'p',`候选：${c.afterIds.join('、') || '未引用'}`)); request.append(ids); row.append(request);
      for (const text of [c.beforePass ? '通过' : '未通过',c.afterPass ? '通过' : '未通过',`${c.beforeBytes} → ${c.afterBytes} B`]) row.append(el(this.root,'td',text)); table.append(row);
    }
    host.append(table); return host;
  }
  private async send(action: Action): Promise<void> {
    if (this.busy || this.saving || !this.state) throw new Error('请等待当前任务或操作结束。');
    const input = parseExperienceOptimizationCommand({schemaVersion:1,projectId:this.projectId,expectedRevision:this.state.revision,...action});
    this.loadGeneration++; this.historyCursor = undefined; this.historyPrevious.length = 0;
    this.saving = true; this.onEdit(true); this.buttons();
    try { const value = await this.port.command(input,this.abort.signal); if (!this.abort.signal.aborted) { this.edit(false); this.render(value); const d = this.root.querySelector('details'); if (d) d.open = true; } }
    finally { this.saving = false; this.onEdit(this.editing); this.buttons(); }
  }
  private edit(value: boolean): void { this.editing = value; this.onEdit(value); this.buttons(); }
  private action(title: string, action: () => void | Promise<void>): HTMLButtonElement {
    const b = button(this.root,title,() => { if (this.busy || this.saving || this.editing) return; try { void Promise.resolve(action()).catch(cause => { if (!this.abort.signal.aborted) this.status.textContent = message(cause); }); } catch (cause) { this.status.textContent = message(cause); } }); b.dataset.optimizationAction = ''; return b;
  }
  private buttons(): void {
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-optimization-action]')) b.disabled = this.busy || this.saving || (this.editing && !b.closest('form')) || b.dataset.validated === 'false' || b.dataset.blockedByCandidate === 'true';
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('form button')) b.disabled = this.saving || (b.type === 'submit' && this.busy);
  }
}
function entries(value: unknown, projectId: StableId): readonly AgentExperienceV1[] { if (!Array.isArray(value) || value.length > 100) throw new Error('候选经验数据无效。'); return value.map(raw => { const e = parseAgentExperience(raw); if (e.projectId !== projectId) throw new Error('经验不属于当前项目。'); return e; }); }
function content(e: AgentExperienceV1 | undefined): unknown { return e ? {title:e.title,condition:e.condition,keywords:e.keywords,recommendation:e.recommendation,...(e.matching ? {matching:e.matching} : {}),enabled:e.enabled} : null; }
function describe(e: AgentExperienceV1): string { return `${e.enabled ? '启用' : '停用'} · ${e.title}；适用：${e.condition}；关键词：${e.keywords.join('、')}；${matchingDescription(e)}；建议：${e.recommendation}`; }
function el<K extends keyof HTMLElementTagNameMap>(root: HTMLElement,tag: K,text?: string): HTMLElementTagNameMap[K] { const e = root.ownerDocument.createElement(tag); if (text !== undefined) e.textContent = text; return e; }
function button(root: HTMLElement,title: string,action: () => void): HTMLButtonElement { const b = el(root,'button',title); b.type = 'button'; b.addEventListener('click',action); return b; }
function object(v: unknown): v is Record<string,unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : '优化版本操作失败。'; }
