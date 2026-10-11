import { parseExperienceHistoryQuery, asStableId, parseAgentExperience, parseExperienceLibrary, parseExperienceOptimizationState, parseExperienceValidation, type AgentExperienceLibraryV1, type AgentExperienceSelectionV1, type AgentExperienceV1, type EvaluationResultV2, type ExperienceCandidateV1, type ExperienceOptimizationCommandV1, type ExperienceOptimizationStateV1, type ExperienceReleaseV1, type JsonObject, type StableId, type TaskSpecV2 } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, scanRetainedEvents, type ConversationOperationLog } from '@haiyue/ai-studio-operation-log';
import { parseExperienceCases, type ExperienceMatchCaseV1 } from '@haiyue/ai-studio-contracts';

interface ReleaseOptions {
  readonly projectId: StableId; readonly log: ConversationOperationLog;
  library(): AgentExperienceLibraryV1;
  select(library: AgentExperienceLibraryV1, artifactId: StableId, request: string, taskId: StableId, signal?: AbortSignal): Promise<AgentExperienceSelectionV1>;
  valid(entry: AgentExperienceV1, signal?: AbortSignal): Promise<boolean>;
  guard(signal?: AbortSignal): void;
  flush(): Promise<void>;
  changed(): void;
  readonly signal: AbortSignal;
  archived?(id: StableId): boolean;
}
/** Serialized by ProjectExperiences. Only the final journal append activates a release. */
export class ExperienceReleases {
  private state: ExperienceOptimizationStateV1;
  private initialized = false;
  private readonly historyRefs = new Map<StableId,StableId>();
  private error: string | null = null;
  constructor(private readonly options: ReleaseOptions) { this.state = {schemaVersion:1,projectId:options.projectId,revision:0,activeReleaseId:null,candidate:null,releases:[]}; }
  async initialize(): Promise<void> {
    if (this.initialized) return;
    let latest;
    // A quiet release must not disappear after 50,000 unrelated tool events.
    for await (const event of scanRetainedEvents(this.options.log,['agent/experience-optimization-updated'],0)) {
      this.options.signal.throwIfAborted(); if (event.correlation.projectId === this.options.projectId) {
        latest = event;
        if (typeof event.payload.activeReleaseId === 'string' && event.artifactRefs[0]) this.historyRefs.set(asStableId(event.payload.activeReleaseId),event.artifactRefs[0]);
      }
    }
    if (latest) {
      try {
        if (!latest.artifactRefs[0]) throw new Error('Missing release state');
        const state = parseExperienceOptimizationState((await this.options.log.readArtifact(latest.artifactRefs[0])).value);
        if (state.projectId !== this.options.projectId || state.revision !== latest.payload.revision) throw new Error('Release state mismatch');
        this.state = state;
        await this.activeLibrary();
      } catch { this.error = '优化版本记录损坏或不兼容，已停止经验引用；请恢复项目记录后重试。'; }
    }
    this.options.signal.throwIfAborted(); this.initialized = true;
  }
  async activeLibrary(): Promise<null | {library: AgentExperienceLibraryV1; artifactId: StableId; releaseId: StableId}> {
    if (this.error) throw new Error(this.error);
    const release = this.active(); if (!release) return null;
    return {library:await this.readLibrary(release.libraryArtifactId),artifactId:release.libraryArtifactId,releaseId:release.id};
  }
  async view(releaseId?: StableId, cursor?: string) {
    await this.initialize();
    const releaseReport = releaseId ? await this.readReleaseReport(releaseId) : null;
    const history = await this.historyPage(cursor);
    try {
      if (this.error) throw new Error(this.error);
      const active = await this.activeLibrary(); const candidate = this.state.candidate;
      const uses = new Map<string,{taskId:string;releaseId:string;at:string}>();
      for await (const event of scanRetainedEvents(this.options.log,['agent/experience-context-prepared'],Math.max(0,this.options.log.status().nextSequence-50_000))) {
        this.options.signal.throwIfAborted();
        const {taskId,releaseId} = event.payload;
        if (event.correlation.projectId === this.options.projectId && typeof taskId === 'string' && typeof releaseId === 'string' && this.state.releases.some(r => r.id === releaseId)) uses.set(`${releaseId}/${taskId}`,{taskId,releaseId,at:event.timestamp});
      }
      return structuredClone({state:this.state,error:null,releaseReport,history,activeEntries:active?.library.entries ?? this.options.library().entries,
        candidateEntries:candidate ? (await this.readLibrary(candidate.libraryArtifactId)).entries : [],
        uses:[...uses.values()].sort((a,b) => b.at.localeCompare(a.at)).slice(0,50),
        evaluation:candidate?.validation ? (await this.options.log.readArtifact(candidate.validation.evaluationArtifactId)).value : null,
        comparison:candidate?.validation ? (await this.options.log.readArtifact(candidate.validation.comparisonArtifactId)).value : null});
    } catch (cause) { return {state:structuredClone(this.state),error:cause instanceof Error ? cause.message : '无法读取优化版本。',releaseReport,history,activeEntries:[],candidateEntries:[],uses:[],evaluation:null,comparison:null}; }
  }
  async command(input: ExperienceOptimizationCommandV1, signal?: AbortSignal) {
    await this.initialize(); this.guard(signal);
    if (input.projectId !== this.options.projectId || input.expectedRevision !== this.state.revision) throw new Error('优化版本已变化或项目已切换，请刷新后重试。');
    let next = this.state;
    if (input.action === 'create') next = await this.create(input.title,signal);
    else if (input.action === 'rollback') next = await this.rollback(input.releaseId,signal);
    else {
      const candidate = this.state.candidate; if (!candidate) throw new Error('请先生成候选版本。');
      if (input.action === 'discard') next = {...this.state,regressionCases:this.state.regressionCases ?? candidate.cases,candidate:null};
      else if (input.action === 'edit') {
        const library = await this.readLibrary(candidate.libraryArtifactId);
        const entry = library.entries.find(e => e.id === input.experienceId); if (!entry) throw new Error('候选经验不存在。');
        const {matching:previousMatching,...base} = entry;
        const edited = parseAgentExperience({...base,...input.draft,enabled:input.enabled,revision:entry.revision+1,updatedAt:new Date().toISOString()});
        const artifact = await this.put({...library,revision:library.revision+1,entries:library.entries.map(e => e.id === entry.id ? edited : e)},'agent-experience-library/1');
        next = {...this.state,candidate:{...candidate,revision:candidate.revision+1,libraryArtifactId:artifact,validation:null}};
      } else if (input.action === 'cases') next = {...this.state,regressionCases:input.cases,candidate:{...candidate,revision:candidate.revision+1,cases:input.cases,validation:null}};
      else if (input.action === 'validate') next = {...this.state,candidate:{...candidate,validation:await this.validate(candidate,signal)}};
      else if (input.action === 'publish') {
        if (!candidate.validation?.passed) throw new Error('请先通过当前候选的验证，再确认发布。');
        const evaluation = (await this.options.log.readArtifact(candidate.validation.evaluationArtifactId)).value;
        if (!evaluation || typeof evaluation !== 'object' || !('status' in evaluation) || !('taskId' in evaluation) || !('evaluatorVersion' in evaluation)
          || evaluation.status !== 'pass' || evaluation.taskId !== this.taskId(candidate) || evaluation.evaluatorVersion !== '1.1.0') throw new Error('验证记录无效或匹配规则已升级，请重新验证。');
        const checked = await this.check(candidate,signal);
        if (checked.results.some(r => r.status !== 'pass')) throw new Error('候选或来源证据已变化，请重新验证。');
        const release = this.release(candidate.title,'publish',candidate.libraryArtifactId,candidate.sourceLibraryArtifactId,candidate.id,candidate.validation.evaluationArtifactId,null);
        next = this.withRelease(release);
      }
    }
    await this.save(next,input.action,signal); return this.view();
  }
  /** Commit all generated changes at once; a partial model result can never become live advice. */
  async propose(title: string, entries: readonly AgentExperienceV1[], cases: readonly ExperienceMatchCaseV1[], expectedRevision: number, sourceRevision: number, signal: AbortSignal) {
    await this.initialize(); this.guard(signal);
    if (this.state.revision !== expectedRevision || this.options.library().revision !== sourceRevision) throw new Error('整理期间经验或候选已变化，结果未采纳。');
    const next = await this.create(title,signal), candidate = next.candidate!;
    const library = await this.readLibrary(candidate.libraryArtifactId);
    const merged = parseExperienceLibrary({...library,revision:library.revision+1,entries:[...library.entries,...entries]});
    // Existing regression expectations remain untouched. Conflicting generated examples fail closed.
    const combined = parseExperienceCases([...candidate.cases,...cases]);
    const libraryArtifactId = await this.put(merged,'agent-experience-library/1'); this.guard(signal);
    await this.save({...next,regressionCases:combined,candidate:{...candidate,libraryArtifactId,cases:combined}},'ai-propose',signal);
  }
  private async create(title: string, signal?: AbortSignal): Promise<ExperienceOptimizationStateV1> {
    if (this.state.candidate) throw new Error('已有候选，请先发布或放弃当前候选。');
    const source = this.options.library(), sourceId = await this.put(source,'agent-experience-library/1');
    let state = this.state;
    if (!state.activeReleaseId) {
      const baseline = this.release('当前经验基线','baseline',sourceId,sourceId,null,null,null);
      state = {...state,activeReleaseId:baseline.id,releases:[baseline]};
    }
    const active = state.releases.find(r => r.id === state.activeReleaseId)!;
    const activeLibrary = await this.readLibrary(active.libraryArtifactId), previousSource = await this.readLibrary(active.sourceLibraryArtifactId);
    // Keep released refinements unless the corresponding working entry was deliberately changed.
    const entries = source.entries.map(e => same(e,previousSource.entries.find(p => p.id === e.id)) ? activeLibrary.entries.find(p => p.id === e.id) ?? e : e);
    // AI-origin advice is candidate-only until publication, so it has no working-library row.
    entries.push(...activeLibrary.entries.filter(e => !source.entries.some(s => s.id === e.id) && !previousSource.entries.some(s => s.id === e.id) && !this.options.archived?.(e.id)));
    const cases = await this.savedCases();
    const libraryId = await this.put({...source,revision:Math.max(source.revision,entries.length ? 1 : 0),entries},'agent-experience-library/1'); this.guard(signal);
    const candidate: ExperienceCandidateV1 = {id:asStableId(`candidate:${crypto.randomUUID()}`),title,revision:1,createdAt:new Date().toISOString(),baseReleaseId:active.id,
      sourceLibraryRevision:source.revision,sourceLibraryArtifactId:sourceId,libraryArtifactId:libraryId,cases,validation:null};
    return {...state,regressionCases:cases,candidate};
  }
  private async check(candidate: ExperienceCandidateV1, signal?: AbortSignal) {
    const library = await this.readLibrary(candidate.libraryArtifactId), baseline = await this.readLibrary(this.active()!.libraryArtifactId);
    const results: EvaluationResultV2['acceptanceResults'][number][] = [];
    const add = (id: string, pass: boolean, diagnostic: string) => results.push({acceptanceId:asStableId(`acceptance:${id}`),status:pass ? 'pass' : 'fail',evidenceIds:[],diagnostic:pass ? null : diagnostic});
    add('current',candidate.sourceLibraryRevision === this.options.library().revision && candidate.baseReleaseId === this.state.activeReleaseId,'经验库或生效版本已变化，请放弃旧候选并重新生成。');
    const changes = library.entries.filter(e => !same(content(e),content(baseline.entries.find(b => b.id === e.id))));
    add('changed',changes.length > 0 || baseline.entries.some(e => !library.entries.some(next => next.id === e.id)),'候选与基线没有内容差异。');
    let sourcesValid = true;
    for (const entry of library.entries.filter(e => e.enabled)) { if (!await this.options.valid(entry,signal)) sourcesValid = false; this.guard(signal); }
    add('sources',sourcesValid,'启用经验的来源证据已失效，需停用该条或从最新复盘重新整理。');
    const enabled = library.entries.filter(e => e.enabled);
    const covered = changes.filter(e => e.enabled).every(e => candidate.cases.some(c => c.expectedIds.includes(e.id)));
    add('coverage',candidate.cases.length >= 2 && candidate.cases.some(c => c.expectedIds.length === 0) && (!enabled.length || candidate.cases.some(c => c.expectedIds.length > 0)) && covered,
      '至少填写两个不同的验证请求，包含不应引用经验的反例，并覆盖每条新增或修改的启用经验。');
    const comparisons = [];
    for (const example of candidate.cases) {
      const before = await this.options.select(baseline,this.active()!.libraryArtifactId,example.request,this.taskId(candidate),signal);
      const after = await this.options.select(library,candidate.libraryArtifactId,example.request,this.taskId(candidate),signal); this.guard(signal);
      const beforeIds = before.entries.map(e => e.experience.id), afterIds = after.entries.map(e => e.experience.id);
      const beforePass = same([...beforeIds].sort(),[...example.expectedIds].sort()), afterPass = same([...afterIds].sort(),[...example.expectedIds].sort());
      add(`case-${example.id}`,afterPass,`实际引用与预期不一致：${example.request.slice(0,160)}`);
      comparisons.push({id:example.id,request:example.request,expectedIds:example.expectedIds,beforeIds,afterIds,beforePass,afterPass,beforeBytes:Buffer.byteLength(JSON.stringify(before.entries)),afterBytes:Buffer.byteLength(JSON.stringify(after.entries))});
    }
    return {results,comparisons};
  }
  private async validate(candidate: ExperienceCandidateV1, signal?: AbortSignal): Promise<NonNullable<ExperienceCandidateV1['validation']>> {
    const checked = await this.check(candidate,signal), taskId = this.taskId(candidate), now = new Date().toISOString();
    const task: TaskSpecV2 = {schemaVersion:2,id:taskId,request:`离线经验匹配验证：${candidate.title}`,visibleConstraints:['仅验证来源完整性、匹配行为和上下文限额；不衡量模型实际任务效果。'],budgetId:asStableId('budget:experience-offline'),requiredCapabilities:[],
      acceptance:checked.results.map(r => ({id:r.acceptanceId,required:true,visibility:'agent',category:'functional',assertion:r.diagnostic ?? `验证 ${r.acceptanceId}`}))};
    const taskArtifactId = await this.put(task,'haiyue://contracts/task-spec/v2');
    const comparisonArtifactId = await this.put({projectId:this.options.projectId,candidateId:candidate.id,candidateRevision:candidate.revision,candidateLibraryArtifactId:candidate.libraryArtifactId,baselineLibraryArtifactId:this.active()!.libraryArtifactId,taskArtifactId,cases:checked.comparisons},'agent-experience-comparison/1');
    const passed = checked.results.every(r => r.status === 'pass');
    const evaluation: EvaluationResultV2 = {schemaVersion:2,id:asStableId(`evaluation:${crypto.randomUUID()}`),taskId,evaluatorVersion:'1.1.0',status:passed ? 'pass' : 'fail',
      acceptanceResults:checked.results.map(r => ({...r,evidenceIds:[comparisonArtifactId]})),budgetStatus:'within',usageRecordIds:[],costRecordIds:[],turns:[],tools:[],completedAt:now};
    const evaluationArtifactId = await this.put(evaluation,'haiyue://contracts/evaluation-result/v2'); this.guard(signal);
    return {candidateRevision:candidate.revision,evaluationArtifactId,comparisonArtifactId,passed,evaluatedAt:now};
  }
  private async rollback(id: StableId, signal?: AbortSignal): Promise<ExperienceOptimizationStateV1> {
    if (this.state.candidate) throw new Error('请先放弃当前候选，再回滚。');
    const target = await this.readRelease(id);
    if (!target || id === this.state.activeReleaseId) throw new Error('请选择保留记录中的其他版本。');
    const library = await this.readLibrary(target.libraryArtifactId);
    for (const entry of library.entries.filter(e => e.enabled)) { if (!await this.options.valid(entry,signal)) throw new Error('旧版本来源已失效，不能重新启用；请创建新候选。'); this.guard(signal); }
    const regressionCases = await this.savedCases(); this.guard(signal);
    return {...this.withRelease(this.release(`回滚至 v${target.number}`,'rollback',target.libraryArtifactId,target.sourceLibraryArtifactId,null,target.evaluationArtifactId,target.id)),regressionCases};
  }
  private release(title: string,kind: ExperienceReleaseV1['kind'],libraryArtifactId: StableId,sourceLibraryArtifactId: StableId,candidateId: StableId | null,evaluationArtifactId: StableId | null,restoredReleaseId: StableId | null): ExperienceReleaseV1 {
    return {id:asStableId(`release:${crypto.randomUUID()}`),number:(this.state.releases.at(-1)?.number ?? 0)+1,title,createdAt:new Date().toISOString(),kind,libraryArtifactId,sourceLibraryArtifactId,candidateId,evaluationArtifactId,restoredReleaseId};
  }
  private withRelease(release: ExperienceReleaseV1): ExperienceOptimizationStateV1 { return {...this.state,...(this.state.candidate ? {regressionCases:this.state.candidate.cases} : {}),activeReleaseId:release.id,candidate:null,releases:[...this.state.releases,release].slice(-20)}; }
  private async savedCases() {
    if (this.state.regressionCases !== undefined) return structuredClone(this.state.regressionCases);
    if (this.state.candidate) return structuredClone(this.state.candidate.cases);
    // Upgrade legacy projects from their latest saved report, even after a rollback to the initial baseline.
    const history = [...this.state.releases].reverse();
    const published = history.find(r => r.kind === 'publish' && r.evaluationArtifactId) ?? history.find(r => r.evaluationArtifactId);
    if (!published) return [];
    const report = await this.readReleaseReport(published.id);
    if (report.error || !report.comparison) throw new Error('无法恢复旧版回归用例，请恢复对应历史验证报告后重试。');
    return report.comparison.cases.map(({id,request,expectedIds}) => ({id,request,expectedIds}));
  }
  private async historyPage(cursor?: string) {
    parseExperienceHistoryQuery({projectId:this.options.projectId,...(cursor ? {cursor} : {})});
    const [revision,offset] = cursor ? cursor.split(':').map(Number) : [this.state.revision,0];
    const ids = [...new Set([...this.historyRefs.keys(),...this.state.releases.map(r => r.id)])].reverse();
    if (revision !== this.state.revision || !Number.isSafeInteger(offset) || offset > ids.length) throw new Error('版本列表已变化，请返回最新版本。');
    const releases: ExperienceReleaseV1[] = [], errors: {id:StableId;message:string}[] = [];
    for (const id of ids.slice(offset,offset+20)) {
      try { const release = await this.readRelease(id); if (!release) throw new Error('Missing release'); releases.push(release); }
      catch { this.options.signal.throwIfAborted(); errors.push({id,message:'历史版本记录损坏或缺失，原记录已保留。'}); }
    }
    return {total:ids.length,releases:releases.sort((a,b) => a.number-b.number),errors,nextCursor:offset+20 < ids.length ? String(revision)+':'+String(offset+20) : null};
  }
  private async readRelease(id: StableId): Promise<ExperienceReleaseV1 | undefined> {
    const current = this.state.releases.find(r => r.id === id); if (current) return current;
    const ref = this.historyRefs.get(id); if (!ref) return undefined;
    const state = parseExperienceOptimizationState((await this.options.log.readArtifact(ref)).value); this.options.signal.throwIfAborted();
    if (state.projectId !== this.options.projectId || state.activeReleaseId !== id) throw new Error('历史版本不属于当前项目。');
    return state.releases.find(r => r.id === id);
  }
  private async readReleaseReport(releaseId: StableId) {
    const release = await this.readRelease(releaseId);
    if (!release) throw new Error('版本不存在或不属于当前项目。');
    if (!release.evaluationArtifactId) return {releaseId,error:null,evaluation:null,comparison:null};
    try {
      const value = (await this.options.log.readArtifact(release.evaluationArtifactId)).value;
      // Older releases stored the comparison reference inside the M12 acceptance evidence.
      if (!value || typeof value !== 'object' || !('acceptanceResults' in value) || !Array.isArray(value.acceptanceResults)) throw new Error('Missing acceptance evidence');
      const refs = new Set<string>();
      for (const row of value.acceptanceResults) {
        if (!row || typeof row !== 'object' || !Array.isArray(row.evidenceIds)) throw new Error('Missing comparison evidence');
        for (const ref of row.evidenceIds) { if (typeof ref !== 'string') throw new Error('Invalid evidence'); refs.add(ref); }
      }
      if (refs.size !== 1) throw new Error('Ambiguous comparison evidence');
      const comparisonId = asStableId([...refs][0]!);
      const report = parseExperienceValidation(value,(await this.options.log.readArtifact(comparisonId)).value);
      if (report.evaluation.status !== 'pass' || report.comparison.projectId !== this.options.projectId || report.comparison.candidateLibraryArtifactId !== release.libraryArtifactId
        || (release.candidateId !== null && report.comparison.candidateId !== release.candidateId)) throw new Error('Release evidence mismatch');
      this.options.signal.throwIfAborted();
      return structuredClone({releaseId,error:null,...report});
    } catch {
      this.options.signal.throwIfAborted();
      return {releaseId,error:'历史验证报告缺失、损坏或版本不兼容，无法展示当时结果。',evaluation:null,comparison:null};
    }
  }
  private active(): ExperienceReleaseV1 | undefined { return this.state.releases.find(r => r.id === this.state.activeReleaseId); }
  private taskId(candidate: ExperienceCandidateV1): StableId { return asStableId(`task:${candidate.id}`); }
  private guard(signal?: AbortSignal): void { this.options.guard(signal); if (this.error) throw new Error(this.error); }
  private async readLibrary(id: StableId): Promise<AgentExperienceLibraryV1> {
    const library = parseExperienceLibrary((await this.options.log.readArtifact(id)).value);
    this.options.signal.throwIfAborted(); if (library.projectId !== this.options.projectId) throw new Error('版本经验不属于当前项目。'); return library;
  }
  private async put(value: unknown, schemaVersion: string): Promise<StableId> { return (await this.options.log.putArtifact(value as JsonObject,{schemaVersion})).id; }
  private async save(next: ExperienceOptimizationStateV1, action: string, signal?: AbortSignal): Promise<void> {
    this.guard(signal); const state = parseExperienceOptimizationState({...next,revision:this.state.revision+1});
    const artifactId = await this.put(state,'agent-experience-optimization/1'); this.guard(signal);
    await this.options.log.append({kind:'agent/experience-optimization-updated',severity:'info',source:asStableId('studio.experience'),correlation:{projectId:this.options.projectId},payload:{revision:state.revision,action,activeReleaseId:state.activeReleaseId},artifactRefs:[artifactId]}, {signal:signal ? AbortSignal.any([signal,this.options.signal]) : this.options.signal});
    this.state = state; if (state.activeReleaseId) this.historyRefs.set(state.activeReleaseId,artifactId); await this.options.flush(); this.options.changed();
  }
}
function same(a: unknown,b: unknown): boolean { return a === undefined || b === undefined ? a === b : canonicalStringify(a as JsonObject) === canonicalStringify(b as JsonObject); }
function content(e: AgentExperienceV1 | undefined): unknown { return e ? {id:e.id,title:e.title,condition:e.condition,recommendation:e.recommendation,keywords:e.keywords,...(e.matching ? {matching:e.matching} : {}),enabled:e.enabled,source:e.source} : null; }
