import { asStableId, type StableId, type StudioDisposable } from '@haiyue/ai-studio-contracts';
import { normalizeSafeLogSummary, safeText } from '../../conversation/validation.js';
import type { LogQueryIntent, LogViewerPort, SafeLogSummary } from '../../conversation/types.js';

export interface LogViewerFilters {
  readonly severity: readonly ('debug' | 'info' | 'warning' | 'error')[];
  readonly kinds: readonly string[];
  readonly sessionId?: StableId;
  readonly turnId?: StableId;
  readonly toolCallId?: StableId;
  readonly entityId?: StableId;
  readonly pluginId?: StableId;
  readonly traverseCorrelation: boolean;
  readonly pageSize: number;
}

export interface LogViewerReadModel {
  readonly revision: number;
  readonly loading: boolean;
  readonly filters: LogViewerFilters;
  readonly events: readonly SafeLogSummary[];
  readonly nextCursor?: string;
  readonly expandedEventIds: readonly StableId[];
  readonly health: string;
  readonly canPersist: boolean;
  readonly diagnosticCount: number;
  readonly error: string | null;
}

export interface LogViewerActions {
  setFilters(filters: Partial<LogViewerFilters>): void;
  loadMore(): void;
  toggleCorrelation(eventId: StableId): void;
  copySafeSummary(eventId: StableId): void;
  exportBugBundle(): void;
}

const defaultFilters: LogViewerFilters = Object.freeze({ severity: Object.freeze([]), kinds: Object.freeze([]), traverseCorrelation: false, pageSize: 50 });

export class LogViewerController implements StudioDisposable {
  private readonly abort = new AbortController();
  private readonly listeners = new Set<(snapshot: LogViewerReadModel) => void>();
  private readonly expanded = new Set<StableId>();
  private filters = defaultFilters;
  private events: readonly SafeLogSummary[] = Object.freeze([]);
  private nextCursor: string | undefined;
  private health = 'unknown';
  private canPersist = false;
  private diagnosticCount = 0;
  private error: string | null = null;
  private revision = 0;
  private requestGeneration = 0;
  private loading = false;
  private disposed = false;

  constructor(private readonly port: LogViewerPort) {}

  snapshot(): LogViewerReadModel {
    this.assertActive();
    return Object.freeze({
      revision: this.revision, loading: this.loading, filters: this.filters, events: this.events,
      ...(this.nextCursor ? { nextCursor: this.nextCursor } : {}), expandedEventIds: Object.freeze([...this.expanded]),
      health: this.health, canPersist: this.canPersist, diagnosticCount: this.diagnosticCount, error: this.error,
    });
  }

  subscribe(listener: (snapshot: LogViewerReadModel) => void): StudioDisposable {
    this.assertActive(); this.listeners.add(listener); listener(this.snapshot()); let active = true;
    return Object.freeze({ dispose: () => { if (active) { active = false; this.listeners.delete(listener); } } });
  }

  async setFilters(value: Partial<LogViewerFilters>): Promise<void> {
    this.filters = normalizeFilters({ ...this.filters, ...value });
    this.expanded.clear();
    await this.refresh();
  }

  async refresh(): Promise<void> { await this.load(false); }
  async loadMore(): Promise<void> { if (this.nextCursor && !this.loading) await this.load(true); }

  toggleCorrelation(eventId: StableId): void {
    this.assertActive();
    if (!this.events.some((item) => item.eventId === eventId)) throw new Error('Log event is not visible.');
    if (this.expanded.has(eventId)) this.expanded.delete(eventId); else this.expanded.add(eventId);
    this.revision += 1; this.emit();
  }

  async copySafeSummary(eventId: StableId): Promise<void> {
    const event = this.events.find((item) => item.eventId === eventId);
    if (!event) throw new Error('Log event is not visible.');
    const safe = JSON.stringify({
      sequence: event.sequence, eventId: event.eventId, timestamp: event.timestamp, kind: event.kind, severity: event.severity,
      source: event.source, correlation: event.correlation, payloadDigest: event.payloadDigest, redactedFieldCount: event.redactedFieldCount,
    }, null, 2);
    await this.port.copyText(safe, this.abort.signal);
    this.assertActive();
  }

  async exportBugBundle(): Promise<void> {
    this.assertActive();
    await this.port.dispatch(Object.freeze({ type: 'logs/export-bug-bundle', query: toQuery(this.filters) }), this.abort.signal);
    this.assertActive();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requestGeneration += 1;
    this.abort.abort(new Error('Log Viewer disposed.'));
    this.listeners.clear(); this.expanded.clear(); this.events = Object.freeze([]);
  }

  private async load(append: boolean): Promise<void> {
    this.assertActive();
    const generation = ++this.requestGeneration;
    this.loading = true; this.error = null; this.revision += 1; this.emit();
    const query = toQuery(this.filters, append ? this.nextCursor : undefined);
    try {
      const page = await this.port.query(query, this.abort.signal);
      if (this.disposed || generation !== this.requestGeneration) return;
      const incoming = page.events.slice(0, this.filters.pageSize).flatMap((value) => { try { return [normalizeSafeLogSummary(value)]; } catch { return []; } });
      const combined = append ? dedupe([...this.events, ...incoming]) : dedupe(incoming);
      this.events = Object.freeze(combined);
      this.nextCursor = typeof page.nextCursor === 'string' && page.nextCursor.length <= 2_048 ? page.nextCursor : undefined;
      this.health = safeText(typeof page.status.health === 'string' ? page.status.health : 'unknown', 64);
      this.canPersist = page.status.canPersist === true;
      this.diagnosticCount = Array.isArray(page.status.diagnostics) ? Math.min(page.status.diagnostics.length, 10_000) : 0;
      this.error = null;
    } catch (cause) {
      if (this.disposed || generation !== this.requestGeneration) return;
      this.error = safeText(cause instanceof Error ? cause.message : 'Log query failed.', 512);
    } finally {
      if (!this.disposed && generation === this.requestGeneration) { this.loading = false; this.revision += 1; this.emit(); }
    }
  }

  private emit(): void { const snapshot = this.snapshot(); for (const listener of [...this.listeners]) listener(snapshot); }
  private assertActive(): void { if (this.disposed) throw new Error('Log Viewer is disposed.'); }
}

export function toQuery(filters: LogViewerFilters, cursor?: string): LogQueryIntent {
  return Object.freeze({
    ...(filters.severity.length ? { severity: filters.severity } : {}), ...(filters.kinds.length ? { kinds: filters.kinds } : {}),
    ...(filters.sessionId ? { sessionId: filters.sessionId } : {}), ...(filters.turnId ? { turnId: filters.turnId } : {}),
    ...(filters.toolCallId ? { toolCallId: filters.toolCallId } : {}), ...(filters.entityId ? { entityId: filters.entityId } : {}),
    ...(filters.pluginId ? { pluginId: filters.pluginId } : {}), limit: filters.pageSize, traverseCorrelation: filters.traverseCorrelation,
    ...(cursor ? { cursor } : {}),
  });
}

export function renderLogViewer(root: HTMLElement, model: LogViewerReadModel, actions: LogViewerActions): void {
  const document = root.ownerDocument;
  const fragment = document.createDocumentFragment();
  const toolbar = document.createElement('form');
  toolbar.className = 'log-viewer-filters';
  const severity = document.createElement('select'); severity.multiple = true; severity.setAttribute('aria-label', 'Log severity');
  for (const value of ['debug', 'info', 'warning', 'error'] as const) { const option = document.createElement('option'); option.value = value; option.selected = model.filters.severity.includes(value); option.textContent = value; severity.append(option); }
  const kind = document.createElement('input'); kind.type = 'text'; kind.value = model.filters.kinds.join(', '); kind.placeholder = 'kind filters'; kind.setAttribute('aria-label', 'Log kinds');
  const session = filterInput(document, 'Session', model.filters.sessionId);
  const turn = filterInput(document, 'Turn', model.filters.turnId);
  const tool = filterInput(document, 'Tool call', model.filters.toolCallId);
  const entity = filterInput(document, 'Entity', model.filters.entityId);
  const plugin = filterInput(document, 'Plugin', model.filters.pluginId);
  const apply = document.createElement('button'); apply.type = 'submit'; apply.textContent = 'Apply filters';
  toolbar.addEventListener('submit', (event) => {
    event.preventDefault();
    actions.setFilters({
      severity: [...severity.selectedOptions].map((item) => item.value).filter((item): item is LogViewerFilters['severity'][number] => ['debug', 'info', 'warning', 'error'].includes(item)),
      kinds: kind.value.split(',').map((item) => item.trim()).filter(Boolean),
      ...idFilter('sessionId', session.value), ...idFilter('turnId', turn.value), ...idFilter('toolCallId', tool.value),
      ...idFilter('entityId', entity.value), ...idFilter('pluginId', plugin.value),
    });
  });
  toolbar.append(severity, kind, session, turn, tool, entity, plugin, apply);
  const bundle = document.createElement('button'); bundle.type = 'button'; bundle.textContent = 'Export safe bug bundle'; bundle.addEventListener('click', () => actions.exportBugBundle()); toolbar.append(bundle);
  fragment.append(toolbar);
  const status = document.createElement('p'); status.textContent = `Log health: ${model.health} · persistence ${model.canPersist ? 'available' : 'unavailable'} · diagnostics ${model.diagnosticCount}`; status.setAttribute('role', model.error ? 'alert' : 'status');
  if (model.error) status.textContent += ` · ${model.error}`;
  fragment.append(status);
  const table = document.createElement('table');
  const head = document.createElement('thead'); const heading = document.createElement('tr');
  for (const label of ['Sequence', 'Time', 'Severity', 'Kind', 'Source', 'Correlation', 'Actions']) { const cell = document.createElement('th'); cell.textContent = label; heading.append(cell); }
  head.append(heading); table.append(head);
  const body = document.createElement('tbody');
  for (const item of model.events) {
    const row = document.createElement('tr'); row.dataset.eventId = item.eventId;
    for (const value of [String(item.sequence), item.timestamp, item.severity, item.kind, item.source]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    const correlation = document.createElement('td');
    const expanded = model.expandedEventIds.includes(item.eventId);
    correlation.textContent = expanded ? Object.entries(item.correlation).map(([key, value]) => `${key}: ${value}`).join(' · ') || 'none' : `${Object.keys(item.correlation).length} id(s)`;
    row.append(correlation);
    const controls = document.createElement('td');
    const expand = document.createElement('button'); expand.type = 'button'; expand.textContent = expanded ? 'Collapse' : 'Expand'; expand.addEventListener('click', () => actions.toggleCorrelation(item.eventId));
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy safe summary'; copy.addEventListener('click', () => actions.copySafeSummary(item.eventId));
    controls.append(expand, copy); row.append(controls); body.append(row);
  }
  table.append(body); fragment.append(table);
  if (model.nextCursor) { const more = document.createElement('button'); more.type = 'button'; more.textContent = model.loading ? 'Loading…' : 'Load more'; more.disabled = model.loading; more.addEventListener('click', () => actions.loadMore()); fragment.append(more); }
  root.replaceChildren(fragment);
}

function normalizeFilters(value: Partial<LogViewerFilters>): LogViewerFilters {
  const severity = [...new Set((value.severity ?? []).filter((item) => ['debug', 'info', 'warning', 'error'].includes(item)))].slice(0, 4);
  const kinds = [...new Set((value.kinds ?? []).map((item) => safeText(item.trim(), 96)).filter((item) => /^[a-z][a-z0-9./-]{2,95}$/.test(item)))].slice(0, 32);
  const pageSize = Number.isInteger(value.pageSize) ? Math.max(1, Math.min(200, value.pageSize as number)) : 50;
  return Object.freeze({
    severity: Object.freeze(severity), kinds: Object.freeze(kinds), ...optionalId('sessionId', value.sessionId),
    ...optionalId('turnId', value.turnId), ...optionalId('toolCallId', value.toolCallId), ...optionalId('entityId', value.entityId),
    ...optionalId('pluginId', value.pluginId), traverseCorrelation: value.traverseCorrelation === true, pageSize,
  });
}

function optionalId<K extends 'sessionId' | 'turnId' | 'toolCallId' | 'entityId' | 'pluginId'>(key: K, value: unknown): Partial<Record<K, StableId>> {
  if (typeof value !== 'string' || !value) return {};
  return { [key]: asStableId(value, key) } as Record<K, StableId>;
}

function filterInput(document: Document, label: string, value?: StableId): HTMLInputElement {
  const input = document.createElement('input'); input.type = 'text'; input.value = value ?? ''; input.placeholder = label; input.setAttribute('aria-label', `${label} filter`); return input;
}

function idFilter<K extends 'sessionId' | 'turnId' | 'toolCallId' | 'entityId' | 'pluginId'>(key: K, value: string): Partial<Record<K, StableId | undefined>> {
  const trimmed = value.trim(); return { [key]: trimmed ? asStableId(trimmed, key) : undefined } as Record<K, StableId | undefined>;
}

function dedupe(values: readonly SafeLogSummary[]): SafeLogSummary[] {
  const byId = new Map(values.map((item) => [item.eventId, item]));
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}
