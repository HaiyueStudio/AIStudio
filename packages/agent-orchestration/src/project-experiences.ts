import { AutoExperienceCandidates, type ExperienceAnalysisResult } from './experience-auto.js';
import { parseExperienceSuggestion, type ExperienceMatchCaseV1 } from '@haiyue/ai-studio-contracts';
import { readExperienceEffects } from './experience-effects.js';
import { asStableId, parseAgentReview, parseAgentExperience, parseExperienceAdoption, parseExperienceDraft, parseExperienceLibrary, parseExperienceOptimizationCommand, type AgentExperienceLibraryV1, type AgentExperienceSelectionV1, type AgentExperienceV1, type AgentReviewV1, type JsonObject, type StableId } from '@haiyue/ai-studio-contracts';
import { matchExperience } from './experience-matching.js';
import { canonicalStringify, scanRetainedEvents, sha256, type ConversationOperationLog, type DurableOperationEvent } from '@haiyue/ai-studio-operation-log';
import { ExperienceReleases } from './experience-releases.js';
import { parseExperienceArchive, parseExperienceArchiveChange, parseExperienceHistoryQuery, type AgentExperienceArchiveV1, type AgentExperienceArchiveChangeV1, parseExperienceReuseState, parseExperienceReuseChange, type AgentExperienceReuseStateV1 } from '@haiyue/ai-studio-contracts';

interface ExperienceOptions {
  readonly projectId: StableId;
  readonly log: ConversationOperationLog;
  busy(): boolean;
  review(taskId: StableId): Promise<AgentReviewV1>;
  flush(): Promise<void>;
  changed(): void;
  suggest?(report: AgentReviewV1, entries: readonly AgentExperienceV1[], signal: AbortSignal): Promise<ExperienceAnalysisResult>;
}
/** Reviewed advice, owned by the existing project scope and portable journal. */
export class ProjectExperiences {
  private library: AgentExperienceLibraryV1;
  private readonly archived = new Map<StableId,StableId>();
  private artifactId: StableId | null = null;
  private readonly abort = new AbortController();
  private tail: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private error: string | null = null;
  private readonly releases: ExperienceReleases;
  private reuse: AgentExperienceReuseStateV1;
  private reuseError: string | null = null;
  private readonly auto: AutoExperienceCandidates | null;

  constructor(private readonly options: ExperienceOptions) {
    this.library = {schemaVersion:1,projectId:options.projectId,revision:0,entries:[]};
    this.reuse = {schemaVersion:1,projectId:options.projectId,revision:0,paused:false,updatedAt:null};
    this.releases = new ExperienceReleases({...options,library:() => this.library,signal:this.abort.signal,guard:signal => this.assertWritable(signal),
      select:(library,artifactId,request,taskId,signal) => this.selectLibrary(library,artifactId,request,taskId,signal),valid:(entry,signal) => this.validSource(entry,signal),archived:id => this.archived.has(id)});
    this.auto = options.suggest ? new AutoExperienceCandidates({...options,read:options.review,analyze:options.suggest,
      snapshot:async () => { await this.tail; const view = await this.releases.view(); if (view.error || this.error) throw new Error(view.error ?? this.error!); return {revision:view.state.revision,libraryRevision:this.library.revision,candidate:!!view.state.candidate,entries:view.activeEntries}; },
      apply:(report,result,revision,libraryRevision,signal) => this.propose(report,result,revision,libraryRevision,signal)}) : null;
  }
  async initialize(): Promise<void> {
    if (this.initialized) return;
    let latest: DurableOperationEvent | undefined, reuseEvent: DurableOperationEvent | undefined;
    for await (const event of this.events(['agent/experience-library-updated','agent/experience-reuse-updated'])) {
      if (event.kind === 'agent/experience-reuse-updated') reuseEvent = event;
      else {
        latest = event;
        if (event.payload.archive !== undefined) {
          try {
            const change = parseExperienceArchiveChange(event.payload.archive);
            if (change.projectId !== this.options.projectId || event.payload.revision !== change.libraryRevision+1 || !event.artifactRefs[1]) throw new Error('Invalid archive reference');
            if (change.action === 'archive') this.archived.set(change.id,event.artifactRefs[1]); else this.archived.delete(change.id);
          } catch { this.error = '经验归档记录损坏或不兼容，已停止经验引用；请恢复项目记录后重试。'; }
        }
      }
    }
    if (reuseEvent) {
      try {
        if (!reuseEvent.artifactRefs[0]) throw new Error('Missing reuse state');
        const reuse = parseExperienceReuseState((await this.options.log.readArtifact(reuseEvent.artifactRefs[0])).value);
        if (reuse.projectId !== this.options.projectId || reuse.revision !== reuseEvent.payload.revision || reuse.paused !== reuseEvent.payload.paused) throw new Error('Reuse state mismatch');
        this.reuse = reuse;
      } catch { this.reuseError = '经验复用开关记录损坏或不兼容，已停止引用；请恢复项目记录后重试。'; }
    }
    if (latest) {
      try {
        if (!latest.artifactRefs[0]) throw new Error('Missing experience library');
        const library = parseExperienceLibrary((await this.options.log.readArtifact(latest.artifactRefs[0])).value);
        if (library.projectId !== this.options.projectId || library.revision !== latest.payload.revision) throw new Error('Experience library mismatch');
        this.library = library; this.artifactId = latest.artifactRefs[0];
      } catch { this.error = '经验库损坏或版本不兼容，已停止引用；请恢复项目记录后重新打开。'; }
    }
    await this.releases.initialize(); this.abort.signal.throwIfAborted();
    await this.auto?.initialize(); this.initialized = true;
  }
  async list() {
    await this.tail; await this.initialize(); await this.options.flush(); this.abort.signal.throwIfAborted();
    const uses = [];
    for await (const event of this.events(['agent/experience-context-prepared'])) {
      if (Array.isArray(event.payload.experienceIds) && typeof event.payload.taskId === 'string') uses.push({taskId:event.payload.taskId,at:event.timestamp,experienceIds:event.payload.experienceIds.filter(id => typeof id === 'string'),artifactId:event.artifactRefs[0] ?? null});
    }
    const optimization = await this.releases.view();
    return { ...this.library, publishedEntries:optimization.activeEntries.filter(e => !this.archived.has(e.id) && !this.library.entries.some(w => w.id === e.id)), reuse:structuredClone(this.reuse), reuseError:this.reuseError, archivedCount:this.archived.size, versioned:optimization.state.activeReleaseId !== null, error:this.error ?? optimization.error, uses:uses.slice(-50).reverse() };
  }
  async archivePage(cursor?: string) {
    parseExperienceHistoryQuery({projectId:this.options.projectId,...(cursor ? {cursor} : {})});
    await this.tail; await this.initialize(); this.abort.signal.throwIfAborted();
    if (this.error) throw new Error(this.error);
    const [revision,offset] = cursor ? cursor.split(':').map(Number) : [this.library.revision,0];
    if (revision !== this.library.revision || !Number.isSafeInteger(offset) || offset > this.archived.size) throw new Error('归档列表已变化，请返回第一页。');
    const refs = [...this.archived.entries()].reverse(), records = [];
    for (const [id,ref] of refs.slice(offset,offset+20)) {
      try { records.push({id,archive:await this.readArchive(id,ref),error:null}); }
      catch { records.push({id,archive:null,error:'归档内容损坏或缺失，原记录已保留。'}); }
    }
    this.abort.signal.throwIfAborted();
    return {projectId:this.options.projectId,revision,total:refs.length,records,nextCursor:offset+20 < refs.length ? String(revision)+':'+String(offset+20) : null};
  }
  archive(value: unknown, signal?: AbortSignal) {
    const input = structuredClone(parseExperienceArchiveChange(value));
    return this.mutate(async () => {
      if (input.projectId !== this.options.projectId || input.libraryRevision !== this.library.revision) throw new Error('经验库已变化或项目已切换，请刷新后重试。');
      const old = input.action === 'archive' ? await this.editableEntry(input.id) : (await this.readArchive(input.id,this.archived.get(input.id))).experience;
      if (!old || old.revision !== input.expectedRevision) throw new Error('经验已变化，请刷新后重试。');
      const entry = parseAgentExperience({...old,revision:old.revision+1,updatedAt:new Date().toISOString()});
      if (input.action === 'restore' && this.library.entries.length >= 100) throw new Error('经验库已达 100 条，请先归档其他经验再恢复。');
      const record = parseExperienceArchive({schemaVersion:1,projectId:this.options.projectId,archivedAt:new Date().toISOString(),experience:entry});
      await this.save(input.action === 'archive' ? this.library.entries.filter(e => e.id !== input.id) : [...this.library.entries,entry],signal,{input,record});
      return entry;
    },signal);
  }
  private async readArchive(id: StableId, ref?: StableId): Promise<AgentExperienceArchiveV1> {
    if (!ref) throw new Error('归档经验不存在。');
    const record = parseExperienceArchive((await this.options.log.readArtifact(ref)).value); this.abort.signal.throwIfAborted();
    if (record.projectId !== this.options.projectId || record.experience.id !== id) throw new Error('归档经验不属于当前项目。');
    return record;
  }
  setReuse(value: unknown, signal?: AbortSignal): Promise<AgentExperienceReuseStateV1> {
    const input = structuredClone(parseExperienceReuseChange(value));
    const pending = this.tail.then(async () => {
      await this.initialize(); this.assertReuseWritable(signal);
      if (input.projectId !== this.options.projectId || input.expectedRevision !== this.reuse.revision) throw new Error('经验复用状态已变化或项目已切换，请刷新后重试。');
      if (input.paused === this.reuse.paused) return structuredClone(this.reuse);
      const next = parseExperienceReuseState({...this.reuse,revision:this.reuse.revision+1,paused:input.paused,updatedAt:new Date().toISOString()});
      const artifact = await this.options.log.putArtifact(next as unknown as JsonObject,{schemaVersion:'agent-experience-reuse/1'});
      this.assertReuseWritable(signal);
      await this.options.log.append({kind:'agent/experience-reuse-updated',severity:'info',source:asStableId('studio.experience'),correlation:{projectId:this.options.projectId},payload:{revision:next.revision,paused:next.paused},artifactRefs:[artifact.id]}, {signal:signal ? AbortSignal.any([signal,this.abort.signal]) : this.abort.signal});
      this.reuse = next; await this.options.flush(); this.options.changed(); return structuredClone(next);
    });
    this.tail = pending.catch(() => undefined); return pending;
  }
  async effects(cursor?: string, signal?: AbortSignal) { await this.tail; await this.initialize(); await this.options.flush(); return readExperienceEffects(this.options.log,this.options.projectId,signal ? AbortSignal.any([signal,this.abort.signal]) : this.abort.signal,cursor); }
  async optimizations(releaseId?: StableId, cursor?: string) { await this.tail; await this.initialize(); await this.options.flush(); this.abort.signal.throwIfAborted(); return {...await this.releases.view(releaseId,cursor),automatic:this.auto?.view() ?? null}; }
  optimize(value: unknown, signal?: AbortSignal) {
    const input = structuredClone(parseExperienceOptimizationCommand(value));
    return this.mutate(() => this.releases.command(input,signal),signal).finally(() => this.auto?.observe());
  }
  adopt(value: unknown, signal?: AbortSignal): Promise<AgentExperienceV1> {
    // Copy validated renderer data before enqueueing; caller mutation cannot change approval.
    const input = structuredClone(parseExperienceAdoption(value));
    return this.mutate(async () => {
      if (input.projectId !== this.options.projectId) throw new Error('经验不属于当前项目。');
      const report = parseAgentReview(await this.options.review(input.taskId)); this.assertWritable(signal);
      const findings = input.findingSource === 'deep' ? report.deep?.findings ?? [] : report.findings;
      if (report.projectId !== input.projectId || report.taskId !== input.taskId || report.sourceDigest !== input.reviewDigest || !findings.some(f => same(f,input.finding))) throw new Error('复盘已变化，请重新读取后整理经验。');
      if (!input.finding.recordIds.length || report.coverage.partial || report.coverage.missing) throw new Error('此发现缺少完整的来源证据，暂不能启用经验。');
      const review = await this.options.log.putArtifact(report as unknown as JsonObject,{schemaVersion:'agent-task-review/1'});
      this.assertWritable(signal);
      const id = asStableId(`experience:${sha256(canonicalStringify({projectId:input.projectId,taskId:input.taskId,reviewDigest:input.reviewDigest,findingSource:input.findingSource,finding:input.finding} as unknown as JsonObject)).slice(0,40)}`);
      const previous = this.library.entries.find(e => e.id === id);
      // Repeating a stale adoption can never silently re-enable disabled advice.
      if (previous) return structuredClone(previous);
      if (this.archived.has(id)) throw new Error('这条经验已归档，请到经验归档中查看或恢复。');
      if (this.library.entries.length >= 100) throw new Error('当前项目经验已达 100 条，请先归档不再使用的经验。');
      const now = new Date().toISOString();
      const entry = parseAgentExperience({schemaVersion:1,id,projectId:input.projectId,revision:1,enabled:true,createdAt:now,updatedAt:now,...input.draft,
        source:{taskId:input.taskId,taskRevision:report.taskRevision,reviewDigest:report.sourceDigest,reviewArtifactId:review.id,findingSource:input.findingSource,finding:input.finding}});
      await this.save([...this.library.entries,entry],signal); return structuredClone(entry);
    },signal);
  }
  update(id: StableId, expectedRevision: number, enabled: boolean, draft: unknown, signal?: AbortSignal): Promise<AgentExperienceV1> {
    const edited = structuredClone(parseExperienceDraft(draft));
    return this.mutate(async () => {
      const entry = await this.editableEntry(id);
      if (!entry || entry.revision !== expectedRevision) throw new Error('经验已变化或不属于当前项目，请刷新后重试。');
      const {matching:previousMatching,...base} = entry;
      const next = parseAgentExperience({...base,...edited,enabled,revision:entry.revision+1,updatedAt:new Date().toISOString()});
      await this.save(this.library.entries.some(e => e.id === id) ? this.library.entries.map(e => e.id === id ? next : e) : [...this.library.entries,next],signal); return structuredClone(next);
    },signal);
  }
  private async editableEntry(id: StableId): Promise<AgentExperienceV1 | undefined> {
    if (this.archived.has(id)) return undefined;
    return this.library.entries.find(e => e.id === id) ?? (await this.releases.activeLibrary())?.library.entries.find(e => e.id === id);
  }
  async select(request: string, taskId: StableId, signal?: AbortSignal): Promise<AgentExperienceSelectionV1> {
    await this.tail; await this.initialize(); signal?.throwIfAborted(); this.abort.signal.throwIfAborted();
    if (this.reuseError) throw new Error(this.reuseError);
    if (this.reuse.paused) return this.emptySelection();
    if (this.error) throw new Error(this.error);
    const active = await this.releases.activeLibrary();
    const selection = active ? {...await this.selectLibrary(active.library,active.artifactId,request,taskId,signal),releaseId:active.releaseId} : await this.selectLibrary(this.library,this.artifactId,request,taskId,signal);
    // A pause committed during source lookups must win over their late result.
    await this.tail; signal?.throwIfAborted(); this.abort.signal.throwIfAborted();
    return this.reuse.paused ? this.emptySelection() : {...selection,entries:selection.entries.filter(e => !this.archived.has(e.experience.id))};
  }
  private emptySelection(): AgentExperienceSelectionV1 { return {schemaVersion:1,projectId:this.options.projectId,libraryRevision:0,libraryArtifactId:null,entries:[]}; }
  private assertReuseWritable(signal?: AbortSignal): void { signal?.throwIfAborted(); this.abort.signal.throwIfAborted(); if (this.reuseError) throw new Error(this.reuseError); }
  private async selectLibrary(library: AgentExperienceLibraryV1, artifactId: StableId | null, request: string, taskId: StableId, signal?: AbortSignal): Promise<AgentExperienceSelectionV1> {
    const ranked = library.entries.filter(e => e.enabled && !this.archived.has(e.id) && e.source.taskId !== taskId)
      .flatMap(experience => { const match = matchExperience(experience,request); return match ? [{experience,...match}] : []; })
      .sort((a,b) => b.specificity-a.specificity || b.coverage-a.coverage || a.experience.id.localeCompare(b.experience.id));
    const entries: AgentExperienceSelectionV1['entries'][number][] = [];
    for (const match of ranked) {
      const candidate = {experience:match.experience,matchedKeywords:match.matchedKeywords};
      // Do not recycle stale conclusions after their source task has been resumed.
      if (!await this.validSource(candidate.experience,signal)) continue;
      if (Buffer.byteLength(JSON.stringify([...entries,candidate]),'utf8') > 12_000) continue;
      entries.push(candidate); if (entries.length === 3) break;
    }
    signal?.throwIfAborted(); this.abort.signal.throwIfAborted();
    return structuredClone({schemaVersion:1,projectId:this.options.projectId,libraryRevision:library.revision,libraryArtifactId:artifactId,entries});
  }
  private async validSource(entry: AgentExperienceV1, signal?: AbortSignal): Promise<boolean> {
    const source = entry.source;
    const report = await this.options.review(source.taskId).catch(() => null);
    const original = await this.options.log.readArtifact(source.reviewArtifactId).then(a => parseAgentReview(a.value)).catch(() => null);
    signal?.throwIfAborted(); this.abort.signal.throwIfAborted();
    return !!original && original.projectId === this.options.projectId && original.taskId === source.taskId && original.sourceDigest === source.reviewDigest
      && (source.findingSource === 'rules' ? original.findings : original.deep?.findings ?? []).some(f => same(f,source.finding))
      && !!report && report.projectId === this.options.projectId && report.taskId === source.taskId && report.sourceDigest === source.reviewDigest && report.taskRevision === source.taskRevision
      && !report.coverage.partial && !report.coverage.missing;
  }
  observeSuggestions(): void { this.auto?.observe(); }
  cancelSuggestions(): void { this.auto?.cancel(); }
  async dispose(): Promise<void> { this.abort.abort(); await this.auto?.dispose(); await this.tail.catch(() => undefined); }

  private propose(report: AgentReviewV1, result: ExperienceAnalysisResult, revision: number, libraryRevision: number, signal: AbortSignal): Promise<boolean> {
    return this.mutate(async () => {
      const suggestions = parseExperienceSuggestion(result.value);
      const current = await this.options.review(report.taskId); this.assertWritable(signal);
      if (current.sourceDigest !== report.sourceDigest || current.taskRevision !== report.taskRevision || report.coverage.partial || report.coverage.missing) throw new Error('来源证据已变化。');
      const view = await this.releases.view();
      if (view.state.candidate || view.state.revision !== revision || this.library.revision !== libraryRevision) throw new Error('已有候选或经验已变化。');
      const review = await this.options.log.putArtifact(report as unknown as JsonObject,{schemaVersion:'agent-task-review/1'});
      const entries: AgentExperienceV1[] = [], cases: ExperienceMatchCaseV1[] = [], now = new Date().toISOString();
      for (const p of suggestions.proposals) {
        const finding = report.findings[p.findingIndex];
        if (!finding?.recordIds.length || finding.recordIds.some(id => !report.evidence.some(e => e.recordId === id))) throw new Error('候选缺少可核验来源。');
        const id = asStableId('experience:' + sha256(canonicalStringify({projectId:report.projectId,taskId:report.taskId,reviewDigest:report.sourceDigest,findingSource:'rules',finding} as unknown as JsonObject)).slice(0,40));
        if (this.archived.has(id) || [...view.activeEntries,...this.library.entries].some(e => e.id === id)) continue;
        const entry = parseAgentExperience({schemaVersion:1,id,projectId:this.options.projectId,revision:1,enabled:true,createdAt:now,updatedAt:now,...p.draft,
          source:{taskId:report.taskId,taskRevision:report.taskRevision,reviewDigest:report.sourceDigest,reviewArtifactId:review.id,findingSource:'rules',finding}});
        entries.push(entry);
        for (const [request,expectedIds] of [[p.positiveRequest,[id]],[p.negativeRequest,[]]] as const) {
          const previous = [...(view.state.regressionCases ?? []),...cases].find(c => c.request.trim().toLowerCase() === request.trim().toLowerCase());
          if (previous) { if (!same(previous.expectedIds,expectedIds)) throw new Error('生成用例与已有预期冲突。'); continue; }
          cases.push({id:asStableId('case:' + crypto.randomUUID()),request,expectedIds});
        }
      }
      if (!entries.length) return false;
      this.assertWritable(signal);
      await this.releases.propose('AI 整理：' + report.title.slice(0,180),entries,cases,revision,libraryRevision,signal);
      return true;
    },signal);
  }

  private mutate<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const pending = this.tail.then(async () => { await this.initialize(); this.assertWritable(signal); return work(); });
    this.tail = pending.catch(() => undefined); return pending;
  }
  private async save(entries: readonly AgentExperienceV1[], signal?: AbortSignal, archive?: {input:AgentExperienceArchiveChangeV1;record:AgentExperienceArchiveV1}): Promise<void> {
    this.assertWritable(signal);
    const library = parseExperienceLibrary({...this.library,revision:this.library.revision+1,entries});
    const artifact = await this.options.log.putArtifact(library as unknown as JsonObject,{schemaVersion:'agent-experience-library/1'});
    const archiveRef = archive ? await this.options.log.putArtifact(archive.record as unknown as JsonObject,{schemaVersion:'agent-experience-archive/1'}) : null;
    this.assertWritable(signal);
    await this.options.log.append({kind:'agent/experience-library-updated',severity:'info',source:asStableId('studio.experience'),correlation:{projectId:this.options.projectId},payload:{revision:library.revision,...(archive ? {archive:archive.input as unknown as JsonObject} : {})},artifactRefs:[artifact.id,...(archiveRef ? [archiveRef.id] : [])]}, {signal:signal ? AbortSignal.any([signal,this.abort.signal]) : this.abort.signal});
    this.library = library; this.artifactId = artifact.id;
    if (archive && archiveRef) { if (archive.input.action === 'archive') this.archived.set(archive.input.id,archiveRef.id); else this.archived.delete(archive.input.id); }
    await this.options.flush(); this.options.changed();
  }
  private assertWritable(signal?: AbortSignal): void {
    signal?.throwIfAborted(); this.abort.signal.throwIfAborted();
    if (this.error) throw new Error(this.error);
    if (this.options.busy()) throw new Error('请等待当前任务结束后再修改经验；变更将在后续回合生效。');
  }
  private async *events(kinds: readonly string[]) {
    for await (const event of scanRetainedEvents(this.options.log,kinds,kinds.includes('agent/experience-library-updated') ? 0 : Math.max(0,this.options.log.status().nextSequence-50_000))) {
      this.abort.signal.throwIfAborted(); if (event.correlation.projectId === this.options.projectId) yield event;
    }
  }
}
function same(a: unknown, b: unknown): boolean { return canonicalStringify(a as JsonObject) === canonicalStringify(b as JsonObject); }
