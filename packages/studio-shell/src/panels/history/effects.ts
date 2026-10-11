import { parseExperienceEffects, type ExperienceEffectsV1, type ExperienceEffectGroupV1, type StableId } from '@haiyue/ai-studio-contracts';

/** Display only: grouping and evidence checks belong to orchestration. */
export class ExperienceEffectsPanel {
  private readonly abort = new AbortController();
  private generation = 0;
  private readonly previous: (string | undefined)[] = [];
  private cursor: string | undefined;
  private chosen: string[] = [];
  constructor(private readonly root: HTMLElement, private readonly projectId: StableId, private readonly read: (projectId: StableId, signal: AbortSignal, cursor?: string) => Promise<unknown>, private readonly openSource?: (taskId: StableId) => void) {
    const details = document.createElement('details'); details.dataset.experienceEffects = '';
    const title = document.createElement('summary'); title.textContent = '真实任务版本效果对比';
    const body = document.createElement('div'); details.append(title,body); root.append(details);
    let loaded = false; details.addEventListener('toggle',() => { if (details.open && !loaded) { loaded = true; void this.load(body); } },{signal:this.abort.signal});
  }
  dispose(): void { this.abort.abort(); }
  private async load(body: HTMLElement, cursor?: string): Promise<void> {
    const generation = ++this.generation; body.textContent = '正在整理项目任务证据…';
    try {
      const data = parseExperienceEffects(await this.read(this.projectId,this.abort.signal,cursor));
      if (this.abort.signal.aborted || generation !== this.generation) return;
      if (data.projectId !== this.projectId) throw new Error('对比报告不属于当前项目。');
      this.cursor = cursor; this.render(body,data);
    } catch (cause) {
      if (this.abort.signal.aborted || generation !== this.generation) return;
      body.textContent = cause instanceof Error ? cause.message : '无法读取任务对比';
      body.append(this.button('重新读取',() => { this.previous.length = 0; void this.load(body); }));
    }
  }
  private render(body: HTMLElement, data: ExperienceEffectsV1): void {
    body.replaceChildren();
    body.append(this.p(`共 ${data.total} 个任务；${data.excluded} 个因混用版本、证据不全或仍在执行而未计入，${data.unreadable} 份复盘无法读取。每个任务只计最新复盘。`),this.p('统计依据是已关联执行回合的上下文，不证明模型采纳了每条经验。这是实际使用记录的观察性对比。任务难度、模型与环境可能不同，不能据此认定版本导致提升。完成率表示任务状态；验收详情请查看复盘。耗时包含等待，重复失败不等于所有重试。'));
    const refresh = this.button('刷新任务对比',() => { this.previous.length = 0; void this.load(body); }); body.append(refresh);
    if (!data.groups.length) body.append(this.p('暂无可可靠归属版本的终局任务。后续任务结束后会自动进入统计；旧记录不会按发布日期猜测版本。'));
    const choices = document.createElement('div'), comparison = document.createElement('div'); comparison.style.overflowX = 'auto';
    const baseline = data.groups.find(g => g.label === '未引用经验') ?? data.groups[0];
    const candidate = data.groups.find(g => g.key !== baseline?.key) ?? baseline;
    const selects = [0,1].map(index => {
      const select = document.createElement('select'); select.style.maxWidth = '100%'; select.style.width = '100%'; select.setAttribute('aria-label',index ? '对比版本' : '基线版本');
      for (const group of data.groups) { const option = document.createElement('option'); option.value = group.key; option.textContent = `${group.label} · ${group.backend} / ${group.model} · ${group.tasks} 个任务`; select.append(option); }
      select.value = data.groups.some(g => g.key === this.chosen[index]) ? this.chosen[index]! : (index ? candidate : baseline)?.key ?? '';
      select.addEventListener('change',draw,{signal:this.abort.signal}); choices.append(select); return select;
    });
    const self = this;
    function draw(): void {
      self.chosen = selects.map(s => s.value); comparison.replaceChildren();
      const selected = self.chosen.map(k => data.groups.find(g => g.key === k)).filter((g): g is ExperienceEffectGroupV1 => !!g);
      if (!selected.length) return;
      const table = document.createElement('table'); table.className = 'agent-effect-table';
      const rows: [string,(g:ExperienceEffectGroupV1)=>string][] = [
        ['版本',g=>g.label],['模型',g=>`${g.backend} / ${g.model}`],['任务数',g=>`${g.tasks}${g.tasks<5 ? '（样本较少）' : ''}`],
        ['完成率',g=>`${(g.completed/g.tasks*100).toFixed(1)}%（${g.completed}/${g.tasks}）`],
        ['失败 / 受阻 / 取消',g=>`${g.failed} / ${g.blocked} / ${g.cancelled}`],
        ['平均工具调用',g=>mean(g.toolCalls,g.tasks)],['工具失败率',g=>g.toolCalls ? `${(g.toolFailures/g.toolCalls*100).toFixed(1)}%（${g.toolFailures}/${g.toolCalls}）` : '无工具调用'],
        ['平均重复失败',g=>mean(g.repeatedFailures,g.tasks)],['平均修复轮次',g=>mean(g.repairs,g.tasks)],['平均耗时（秒）',g=>mean(g.durationMs/1000,g.tasks)],
        ['平均输入 / 输出 Token',g=>`${mean(g.inputTokens,g.tokenSamples)} / ${mean(g.outputTokens,g.tokenSamples)}`],['用量已知任务',g=>`${g.tokenSamples}/${g.tasks}`],['含环境异常任务',g=>String(g.environmentTasks)],
      ];
      for (const [label,format] of rows) { const tr = document.createElement('tr'), th = document.createElement('th'); th.textContent = label; tr.append(th); for (const group of selected) { const td = document.createElement('td'); td.textContent = format(group); td.style.padding = '6px 12px'; tr.append(td); } table.append(tr); }
      comparison.append(table);
    }
    draw(); body.append(choices,comparison,this.p('Token 只统计最终用量完整的任务；缓存输入不重复相加，推理 Token 不重复叠加到输出。未引用经验包含暂停、未匹配或上下文预算省略经验的任务。费用保持原任务记录口径。'));
    const samples = document.createElement('details'); samples.dataset.effectSamples = ''; const title = document.createElement('summary'); title.textContent = '任务样本与归属依据'; samples.append(title);
    for (const row of data.records) {
      const item = document.createElement('div'); item.dataset.effectTask = row.report.taskId;
      item.append(this.p(`${row.report.title} · ${row.report.outcome} · ${row.groupKey ? '计入统计' : '未计入'} · ${row.note}`),this.p(`复盘修订 ${row.report.taskRevision} · ${row.report.generatedAt} · 实际引用 ${row.experienceIds.length} 条经验`));
      if (this.openSource) item.append(this.button('查看任务复盘',() => this.openSource!(row.report.taskId))); samples.append(item);
    }
    const back = this.button('较新任务',() => { void this.load(body,this.previous.pop()); }); back.disabled = !this.previous.length;
    const next = this.button('更早任务',() => { this.previous.push(this.cursor); void this.load(body,data.nextCursor!); }); next.disabled = !data.nextCursor;
    samples.append(back,next); samples.open = !!this.cursor; body.append(samples,this.p(`统计截止记录 ${data.sequence} · ${data.generatedAt}。来源随项目长期保存，可从复盘定位执行证据。`));
  }
  private p(text: string): HTMLElement { const el = document.createElement('p'); el.textContent = text; return el; }
  private button(text: string, action:()=>void): HTMLButtonElement { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.addEventListener('click',action,{signal:this.abort.signal}); return b; }
}
function mean(value: number, count: number): string { return count ? (value/count).toFixed(1) : '未知'; }
