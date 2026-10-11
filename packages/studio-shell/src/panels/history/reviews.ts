import { asStableId, parseAgentReview, parseAgentExperience, type AgentReviewFindingV1, type AgentReviewV1, type StableId } from '@haiyue/ai-studio-contracts';
import { AgentExperiencePanel, experienceForm, type AgentExperiencePort } from './experiences.js';
import { AgentOptimizationPanel, type AgentOptimizationPort } from './optimizations.js';

export interface AgentReviewViewerPort {
  list(projectId: StableId, signal: AbortSignal, cursor?: string): Promise<unknown>;
  read(projectId: StableId, taskId: StableId, signal: AbortSignal): Promise<unknown>;
  deepen(projectId: StableId, taskId: StableId, signal: AbortSignal): Promise<unknown>;
  evidence(projectId: StableId, recordId: StableId, signal: AbortSignal): Promise<unknown>;
  readonly experiences?: AgentExperiencePort;
  readonly optimizations?: AgentOptimizationPort;
}
/** Presentation only: review requests are explicit and all content is rendered as text. */
export class AgentReviewViewer {
  private projectId: StableId | null = null;
  private abort = new AbortController();
  private deep: AbortController | null = null;
  private generation = 0;
  private cursor: string | undefined;
  private readonly previous: (string | undefined)[] = [];
  private disposed = false;
  private selected: StableId | null = null;
  private storage = '';
  private busy = false;
  private editingExperience = false;
  private experiencePanel: AgentExperiencePanel | null = null;
  private optimizationPanel: AgentOptimizationPanel | null = null;
  private editingOptimization = false;
  constructor(private readonly root: HTMLElement, private readonly port: AgentReviewViewerPort) { this.root.textContent = '打开项目后可查看任务复盘。'; }
  setProject(projectId: StableId | null, storage?: string): void {
    if (projectId === this.projectId && this.storage === storage) return;
    this.abort.abort(); this.deep?.abort(); this.deep = null; this.abort = new AbortController(); this.generation++; this.selected = null;
    this.cursor = undefined; this.previous.length = 0;
    this.projectId = projectId; this.storage = storage ?? ''; this.root.replaceChildren();
    this.editingExperience = false; this.experiencePanel?.dispose(); this.experiencePanel = null;
    this.editingOptimization = false; this.optimizationPanel?.dispose(); this.optimizationPanel = null;
    if (projectId) this.refresh(); else this.root.textContent = '打开项目后可查看任务复盘。';
  }
  setBusy(busy: boolean): void { this.busy = busy; for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-deep-review],[data-experience-action]')) button.disabled = busy || this.deep !== null || this.editingOptimization; this.experiencePanel?.setBusy(busy || this.editingOptimization); this.optimizationPanel?.setBusy(busy || this.deep !== null || this.editingExperience); }
  refresh(): void { if (!this.disposed && this.projectId && !this.deep && !this.editingExperience && !this.editingOptimization) void this.load(); }
  dispose(): void { this.disposed = true; this.generation++; this.abort.abort(); this.deep?.abort(); this.experiencePanel?.dispose(); this.optimizationPanel?.dispose(); this.root.replaceChildren(); }
  private async load(): Promise<void> {
    const projectId = this.projectId!; const generation = ++this.generation;
    try {
      const value = await this.port.list(projectId,this.abort.signal,this.cursor);
      if (!this.current(generation)) return;
      if (!object(value) || value.projectId !== projectId || !Array.isArray(value.records) || value.records.length > 50) throw new Error('复盘列表格式无效。');
      const header = this.el('div'); header.className = 'agent-history-toolbar';
      header.append(this.el('strong','任务复盘'),this.button('刷新',() => this.firstPage()));
      this.root.replaceChildren(header,this.el('p',this.storage === 'project' ? '复盘与经验自动保存于项目 .aistudio/agent/。规则分析和经验匹配不消耗模型额度。' : '规则报告自动生成；保存项目时会一并保存复盘和经验。'),this.el('p','复盘建议需要人工确认后才能成为项目经验。历史报告长期保留，每页最多 50 份。'));
      this.experiencePanel?.dispose(); this.experiencePanel = null;
      if (this.port.experiences) {
        const panel = this.el('div'); this.root.append(panel);
        this.experiencePanel = new AgentExperiencePanel(panel,projectId,this.port.experiences,value => { this.editingExperience = value; this.setBusy(this.busy); },taskId => this.showSource(taskId,generation));
        this.experiencePanel.setBusy(this.busy);
      }
      this.optimizationPanel?.dispose(); this.optimizationPanel = null;
      if (this.port.optimizations) {
        const panel = this.el('div'); this.root.append(panel);
        this.optimizationPanel = new AgentOptimizationPanel(panel,projectId,{list:this.port.optimizations.list,effects:this.port.optimizations.effects,
          command:async (input,signal) => { const value = await this.port.optimizations!.command(input,signal); if (this.current(generation)) this.experiencePanel?.refresh(); return value; }},value => { this.editingOptimization = value; this.setBusy(this.busy); },taskId => this.showSource(taskId,generation));
        this.optimizationPanel.setBusy(this.busy);
      }
      if (typeof value.total === 'number') {
        const nav = this.el('div'); nav.className = 'agent-history-toolbar';
        const back = this.button('较新报告',() => { this.cursor = this.previous.pop(); this.refresh(); }); back.disabled = !this.previous.length;
        const next = this.button('更早报告',() => { this.previous.push(this.cursor); this.cursor = value.nextCursor as string; this.refresh(); }); next.disabled = typeof value.nextCursor !== 'string';
        nav.append(this.el('span','共 '+value.total+' 份报告'),back,next); this.root.append(nav);
      }
      if (typeof value.error === 'string' && value.error) this.root.append(this.el('p',value.error));
      if (!value.records.length) this.root.append(this.el('p','任务完成、失败、受阻或取消后，将自动生成报告；等待审批期间不生成终局报告。'));
      for (const raw of value.records) {
        if (!object(raw) || typeof raw.taskId !== 'string' || typeof raw.title !== 'string' || typeof raw.outcome !== 'string' || typeof raw.generatedAt !== 'string' || typeof raw.findingCount !== 'number') throw new Error('复盘列表格式无效。');
        const taskId = asStableId(raw.taskId);
        const item = this.el('details'); item.className = 'agent-history-record'; item.dataset.reviewTask = taskId;
        const summary = this.el('summary',`${raw.title} · ${outcome(raw.outcome)} · ${raw.findingCount} 条发现`);
        const body = this.el('div'); let loaded = false;
        const load = () => {
          if (loaded || !item.open) return; loaded = true; this.selected = taskId;
          body.textContent = '正在读取复盘…';
          void this.port.read(projectId,taskId,this.abort.signal).then(value => {
            if (!this.current(generation)) return;
            const report = parseAgentReview(value); if (report.projectId !== projectId || report.taskId !== taskId) throw new Error('复盘不属于当前任务。');
            this.renderReport(body,report,generation);
          }).catch(cause => { if (this.current(generation)) { loaded = false; body.textContent = message(cause); } });
        };
        item.addEventListener('toggle',load); item.append(summary,body); this.root.append(item);
        if (this.selected === taskId) { item.open = true; load(); }
      }
    } catch (cause) { if (this.current(generation)) this.root.replaceChildren(this.el('p',message(cause)),this.button('返回最新报告',() => this.firstPage())); }
  }
  private firstPage(): void { this.cursor = undefined; this.previous.length = 0; this.refresh(); }
  private showSource(taskId: StableId, generation: number): void {
    const existing = [...this.root.querySelectorAll<HTMLDetailsElement>('[data-review-task]')].find(e => e.dataset.reviewTask === taskId);
    if (existing) { existing.open = true; existing.scrollIntoView({block:'nearest'}); return; }
    const projectId = this.projectId!;
    const details = this.el('details'); details.open = true; details.dataset.reviewTask = taskId;
    const body = this.el('div','正在读取来源复盘…'); details.append(this.el('summary','来源复盘'),body); this.root.append(details);
    void this.port.read(projectId,taskId,this.abort.signal).then(raw => {
      if (!this.current(generation)) return;
      const report = parseAgentReview(raw); if (report.projectId !== projectId || report.taskId !== taskId) throw new Error('来源复盘不属于当前项目。');
      this.renderReport(body,report,generation);
    }).catch(cause => { if (this.current(generation)) body.textContent = message(cause); });
  }
  private renderReport(body: HTMLElement, report: AgentReviewV1, generation: number): void {
    const m = report.metrics;
    body.replaceChildren(this.el('p',`${report.generatedAt} · 规则 ${report.ruleVersion}`),this.el('p',`工具调用 ${m.toolCalls} · 失败 ${m.failed} · 取消 ${m.cancelled} · 等待审批 ${m.suspended} · 重复失败 ${m.repeatedFailures} · 修复 ${m.repairs} 次 · 总历时 ${(m.durationMs/1000).toFixed(1)} 秒（含等待）`));
    body.append(this.el('p',`证据 ${report.coverage.records} 条 · 缺失或超出读取限额 ${report.coverage.missing} 条${report.coverage.partial ? ' · 证据不完整，结论仅覆盖保留记录' : ''}${report.coverage.omittedEvidence ? ` · 面板省略 ${report.coverage.omittedEvidence} 条，可在执行记录中查看` : ''}`));
    if (!report.findings.length) body.append(this.el('p','未命中当前规则。此结果不代表任务已全面验证，也不代表没有优化空间。'));
    this.findings(body,report.findings,report,generation);
    const action = this.button(report.deep ? '重新 AI 深度复盘' : 'AI 深度复盘',() => {
      if (this.deep || this.busy) return;
      const controller = new AbortController(); this.deep = controller; action.disabled = true;
      status.textContent = '正在分析…'; cancel.hidden = false;
      void this.port.deepen(report.projectId,report.taskId,controller.signal).then(value => {
        if (!this.current(generation) || controller.signal.aborted) return;
        const next = parseAgentReview(value); if (next.projectId !== report.projectId || next.taskId !== report.taskId) throw new Error('深度复盘不属于当前任务。');
        this.renderReport(body,next,generation);
      }).catch(cause => { if (this.current(generation)) status.textContent = controller.signal.aborted ? '深度复盘已取消，规则报告保留。' : message(cause); })
        .finally(() => { if (this.deep === controller) this.deep = null; if (this.current(generation)) { cancel.hidden = true; this.setBusy(this.busy); } });
    });
    action.dataset.deepReview = ''; action.disabled = this.busy || this.deep !== null;
    const status = this.el('p'); status.setAttribute('role','status');
    const cancel = this.button('取消复盘',() => this.deep?.abort()); cancel.hidden = true;
    body.append(this.el('p','AI 深度复盘使用当前选择的模型，会消耗模型额度；单回合、最长 90 秒。请求最多 4096 输出 token（部分后端不支持硬上限）。仅分析本报告的摘要与至多 80 条证据。'),action,cancel,status);
    if (report.deep) {
      body.append(this.el('h4','AI 深度复盘 · 待人工审阅'),this.el('p',`${report.deep.model} · ${report.deep.createdAt}`),this.el('p',report.deep.usageLabel),this.el('p',report.deep.summary));
      this.findings(body,report.deep.findings,report,generation,'deep');
    }
  }
  private findings(body: HTMLElement, findings: readonly AgentReviewFindingV1[], report: AgentReviewV1, generation: number, findingSource: 'rules' | 'deep' = 'rules'): void {
    for (const finding of findings) {
      const section = this.el('section'); section.className = 'agent-review-finding';
      section.append(this.el('h4',finding.title),this.el('p',finding.detail),this.el('p',`建议：${finding.recommendation}`));
      if (this.port.experiences && finding.recordIds.length && !report.coverage.partial && !report.coverage.missing) {
        const formHost = this.el('div');
        const adopt = this.button('整理为经验',() => {
          if (this.busy || this.deep || this.editingExperience || this.editingOptimization) return; this.editingExperience = true; this.setBusy(this.busy);
          formHost.replaceChildren(experienceForm(this.root,{title:finding.title,condition:`遇到类似情况时：${finding.title}`.slice(0,800),recommendation:finding.recommendation,keywords:[]},async draft => {
            if (this.busy) throw new Error('请等待当前任务结束。');
            const entry = parseAgentExperience(await this.port.experiences!.adopt({schemaVersion:1,projectId:report.projectId,taskId:report.taskId,reviewDigest:report.sourceDigest,findingSource,finding,draft},this.abort.signal));
            if (!this.current(generation)) return;
            if (entry.projectId !== report.projectId) throw new Error('经验不属于当前项目。');
            this.editingExperience = false; this.refresh();
          },() => { formHost.replaceChildren(); this.editingExperience = false; this.setBusy(this.busy); }));
        }); adopt.dataset.experienceAction = ''; adopt.disabled = this.busy || this.deep !== null;
        section.append(adopt,formHost);
      } else if (this.port.experiences) section.append(this.el('p','此发现缺少完整的来源证据，暂不能启用经验。'));
      for (const id of finding.recordIds) {
        const detail = this.el('details'); const evidence = report.evidence.find(e => e.recordId === id);
        detail.append(this.el('summary',`查看证据 · ${evidence?.toolId ?? evidence?.kind ?? id} · ${evidence?.startedAt ?? ''}`));
        let loaded = false;
        detail.addEventListener('toggle',() => {
          if (!detail.open || loaded) return; loaded = true; const pre = this.el('pre','正在读取…'); detail.append(pre);
          void this.port.evidence(report.projectId,id,this.abort.signal).then(value => {
            if (!this.current(generation)) return;
            if (!object(value) || value.projectId !== report.projectId || !object(value.record) || value.record.id !== id) throw new Error('证据不属于当前任务。');
            const text = JSON.stringify(value,null,2); pre.textContent = text.length > 100_000 ? `${text.slice(0,100_000)}\n…此处已截断，请到执行记录查看完整内容。` : text;
          }).catch(cause => { if (this.current(generation)) pre.textContent = message(cause); });
        }); section.append(detail);
      }
      body.append(section);
    }
  }
  private current(generation: number): boolean { return !this.disposed && generation === this.generation; }
  private el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] { const node = this.root.ownerDocument.createElement(tag); if (text !== undefined) node.textContent = text; return node; }
  private button(text: string, action: () => void): HTMLButtonElement { const button = this.el('button',text); button.type = 'button'; button.addEventListener('click',action); return button; }
}
function object(value: unknown): value is Record<string,unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : '复盘操作失败。'; }
function outcome(value: string): string { return ({completed:'完成',failed:'失败',blocked:'受阻',cancelled:'取消'} as Record<string,string>)[value] ?? value; }
