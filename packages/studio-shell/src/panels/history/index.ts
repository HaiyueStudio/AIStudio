import { asStableId, type AgentHistoryPageV1, type AgentHistoryRecordV1, type StableId } from '@haiyue/ai-studio-contracts';

export interface AgentHistoryViewerPort {
  query(projectId: StableId, cursor: string | undefined, signal: AbortSignal): Promise<unknown>;
  detail(projectId: StableId, id: StableId, signal: AbortSignal): Promise<unknown>;
}

/** A paged, read-only view. Project changes cancel requests and discard all previous DOM/data. */
export class AgentHistoryViewer {
  private projectId: StableId | null | undefined;
  private abort = new AbortController();
  private generation = 0;
  private cursor: string | undefined;
  private readonly previousCursors: Array<string | undefined> = [];
  private disposed = false;
  private storage: string | undefined;
  constructor(private readonly root: HTMLElement, private readonly port: AgentHistoryViewerPort) {}

  setProject(projectId: StableId | null, storage?: string): void {
    if (this.disposed || this.projectId === projectId && this.storage === storage) return;
    this.storage = storage;
    this.abort.abort(); this.abort = new AbortController(); this.generation += 1;
    this.projectId = projectId; this.cursor = undefined; this.previousCursors.length = 0;
    this.root.replaceChildren();
    if (!projectId) { this.message('打开项目后可查看该项目的 Agent 执行记录。'); return; }
    void this.load();
  }

  dispose(): void { this.disposed = true; this.abort.abort(); this.generation += 1; this.root.replaceChildren(); }
  refresh(): void { if (!this.disposed) { this.cursor = undefined; this.previousCursors.length = 0; void this.load(); } }

  private async load(): Promise<void> {
    const projectId = this.projectId; if (!projectId || this.disposed) return;
    const generation = ++this.generation;
    this.message('正在读取项目执行记录…');
    try {
      const page = normalizeHistoryPage(await this.port.query(projectId, this.cursor, this.abort.signal));
      if (generation !== this.generation || this.disposed) return;
      if (page.projectId !== projectId) throw new Error('项目已切换，请刷新记录。');
      this.render(page, generation);
    } catch (cause) {
      if (generation !== this.generation || this.disposed) return;
      this.message(cause instanceof Error ? cause.message : '记录读取失败。');
      const retry = this.root.ownerDocument.createElement('button'); retry.textContent = '重新读取';
      retry.addEventListener('click', () => this.refresh()); this.root.append(retry);
    }
  }

  private render(page: AgentHistoryPageV1, generation: number): void {
    const document = this.root.ownerDocument;
    const header = document.createElement('div'); header.className = 'agent-history-toolbar';
    const title = document.createElement('strong'); title.textContent = `项目执行记录 · ${page.total}`;
    const refresh = document.createElement('button'); refresh.textContent = '刷新';
    refresh.addEventListener('click', () => this.refresh());
    header.append(title, refresh);
    const storage = document.createElement('p'); storage.className = 'agent-history-storage';
    storage.textContent = page.storage === 'project' ? '自动保存于项目目录 .aistudio/agent/。' : '当前项目尚未保存；首次保存项目时会一并写入执行记录。';
    const list = document.createElement('div'); list.className = 'agent-history-records';
    for (const record of page.records) {
      const item = document.createElement('details'); item.className = 'agent-history-record'; item.dataset.recordId = record.id;
      const summary = document.createElement('summary');
      const status = ({ pending: '等待中', streaming: '执行中', completed: '完成', failed: '失败', cancelled: '已取消' } as const)[record.status];
      summary.textContent = `${record.kind}${record.toolId ? ` · ${record.toolId}` : ''} · ${status}`;
      const timing = document.createElement('p'); timing.className = 'agent-history-timing';
      timing.textContent = `开始：${record.startedAt}　结束：${record.finishedAt ?? '—'}　时长：${record.durationMs === null ? '—' : `${record.durationMs} ms`}`;
      const body = document.createElement('div'); body.className = 'agent-history-data';
      let loaded = false;
      const loadDetail = (): void => {
        if (loaded) return;
        loaded = true; body.textContent = '正在读取参数与结果…';
        void this.port.detail(page.projectId!, record.id, this.abort.signal).then(value => {
          if (generation !== this.generation || this.disposed) return;
          if (!isRecord(value) || value.schemaVersion !== 1 || value.projectId !== page.projectId || !isRecord(value.record) || value.record.id !== record.id || !('data' in value)) throw new Error('执行明细与当前项目不匹配。');
          const data = isRecord(value.data) ? value.data : { value: value.data };
          body.replaceChildren();
          if (record.status === 'cancelled' && isSuspendedToolRecord(record, data)) {
            summary.textContent = `${record.kind} · ${record.toolId} · 已挂起（等待确认）`;
            const explanation = document.createElement('p');
            explanation.textContent = '这次调用为等待用户确认而挂起，进度已保存，可在确认后继续。原始记录保留调用结束时的 cancelled 状态。';
            body.append(explanation);
          }
          for (const [label, entry] of [['参数', data.parameters ?? null], ['返回结果', data.result ?? null], ['完整记录', value.data]] as const) {
            const heading = document.createElement('h4'); heading.textContent = label;
            const text = document.createElement('pre'); text.textContent = JSON.stringify(entry, null, 2);
            body.append(heading, text);
          }
        }).catch(cause => { if (generation === this.generation && !this.disposed) { loaded = false; body.textContent = cause instanceof Error ? cause.message : '读取明细失败。'; } });
      };
      item.addEventListener('toggle', () => { if (item.open) loadDetail(); });
      // Only cancelled tool rows need their result to distinguish user cancellation from a durable pause.
      if (record.status === 'cancelled' && (record.kind === 'tool-call' || record.kind === 'tool-result')) loadDetail();
      item.append(summary, timing, body); list.append(item);
    }
    if (page.records.length === 0) { const empty = document.createElement('p'); empty.textContent = '该项目还没有 Agent 执行记录。'; list.append(empty); }
    const navigation = document.createElement('div'); navigation.className = 'agent-history-toolbar';
    const previous = document.createElement('button'); previous.textContent = '上一页'; previous.disabled = this.previousCursors.length === 0;
    previous.addEventListener('click', () => { this.cursor = this.previousCursors.pop(); void this.load(); });
    const next = document.createElement('button'); next.textContent = '下一页'; next.disabled = !page.nextCursor;
    next.addEventListener('click', () => { this.previousCursors.push(this.cursor); this.cursor = page.nextCursor ?? undefined; void this.load(); });
    navigation.append(previous, next);
    this.root.replaceChildren(header, storage, list, navigation);
  }

  private message(text: string): void { const paragraph = this.root.ownerDocument.createElement('p'); paragraph.textContent = text; this.root.replaceChildren(paragraph); }
}

export function normalizeHistoryPage(value: unknown): AgentHistoryPageV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.projectId !== null && typeof value.projectId !== 'string' || !Array.isArray(value.records) || value.records.length > 100
    || !Number.isSafeInteger(value.total) || Number(value.total) < value.records.length || value.nextCursor !== null && typeof value.nextCursor !== 'string' || !['project', 'unsaved', 'none'].includes(String(value.storage))) throw new Error('执行记录格式不受支持。');
  const records = value.records.map(record => {
    if (!isRecord(record) || Object.keys(record).some(key => !['schemaVersion', 'id', 'projectId', 'kind', 'status', 'sessionId', 'turnId', 'toolId', 'startedAt', 'finishedAt', 'durationMs', 'dataArtifactId'].includes(key)) || record.schemaVersion !== 1 || record.projectId !== value.projectId || typeof record.kind !== 'string' || !/^[a-z][a-z0-9.-]{0,95}$/u.test(record.kind) || !['pending', 'streaming', 'completed', 'failed', 'cancelled'].includes(String(record.status))
      || typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt)) || record.finishedAt !== null && (typeof record.finishedAt !== 'string' || !Number.isFinite(Date.parse(record.finishedAt)))
      || record.durationMs !== null && (!Number.isSafeInteger(record.durationMs) || Number(record.durationMs) < 0) || record.toolId !== null && typeof record.toolId !== 'string' || typeof record.dataArtifactId !== 'string' || !/^artifact:sha256:[a-f0-9]{64}$/u.test(record.dataArtifactId)) throw new Error('执行记录条目无效。');
    for (const key of ['id', 'projectId', 'sessionId', 'turnId', 'dataArtifactId']) { if (typeof record[key] !== 'string') throw new Error('记录标识无效。'); asStableId(record[key]); }
    return Object.freeze(record) as unknown as AgentHistoryRecordV1;
  });
  return Object.freeze({ ...value, records: Object.freeze(records) }) as unknown as AgentHistoryPageV1;
}
function isSuspendedToolRecord(record: AgentHistoryRecordV1, data: Record<string, unknown>): boolean {
  if (record.kind !== 'tool-call' && record.kind !== 'tool-result' || !isRecord(data.result) || data.result.status !== 'cancelled' || !isRecord(data.result.value)) return false;
  return data.result.value.code === 'barrier.waiting-user' && data.result.value.preserved === true;
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
