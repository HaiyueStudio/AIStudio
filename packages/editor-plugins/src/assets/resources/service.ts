import { createHash } from 'node:crypto';
import type { EditorLocationV1, JsonObject, JsonValue, ResourceCatalogEntryV1 } from '@haiyue/ai-studio-contracts';
import type { ResourceActionInput, ResourceActionResult, ResourceCatalogBinding, ResourceCatalogItem, ResourceCatalogPage, ResourceCatalogPorts, ResourceCatalogQuery } from './types.js';
import { buildResourceRows, dependenciesFrom, resourceSource, UNKNOWN_DEPENDENCIES, type ResourceDependencyProjection, type ResourceRow, type ResourceSource } from './source.js';
import { checked, digest, equal, fail, freeze, id, publicValue, record, ResourceCatalogError, shape, text } from './values.js';

const PAGE_BYTES = 512 * 1024;
const KINDS = ['asset', 'template', 'preset', 'instance'];

/** Read catalog + typed workflow adapter. Document, assets and approvals keep their existing owners. */
export class ProjectResourceCatalog {
  private closed = false;
  private key: string | null = null;
  private dependencies: ResourceDependencyProjection = UNKNOWN_DEPENDENCIES;
  private readonly health = new Map<string, Readonly<{ health: ResourceCatalogItem['health']; diagnostic: string }>>();
  private readonly tasks = new Set<AbortController>();

  constructor(private readonly ports: ResourceCatalogPorts) {}

  async refresh(input: ResourceCatalogQuery = {}, signal?: AbortSignal): Promise<ResourceCatalogPage> {
    this.cancel(); this.health.clear(); this.dependencies = UNKNOWN_DEPENDENCIES;
    return this.query(input, signal);
  }

  async query(input: ResourceCatalogQuery = {}, signal?: AbortSignal): Promise<ResourceCatalogPage> {
    const query = queryInput(checked(input)), source = this.source();
    if (!source) return freeze({ binding: null, items: [], total: 0, nextCursor: null, categories: [], diagnostics: ['请先打开项目。'] });
    const task = this.task(signal);
    try {
      let dependencies = UNKNOWN_DEPENDENCIES;
      try { dependencies = dependenciesFrom(await abortable(() => this.ports.dependencies(task.signal), task.signal), source); }
      catch { this.guard(source, task.signal); dependencies = { complete: false, reason: '资源引用查询失败或已过期，使用数量保持未知。', references: [] }; }
      this.guard(source, task.signal); this.dependencies = dependencies;
      const allRows = this.rows(source);
      const pbrOwners = new Set(allRows.filter(row => record(row.item.configuration) && row.item.configuration.type === 'haiyue.material.pbr' && row.item.configuration.enabled === true).map(row => row.item.entry.ref.kind === 'instance' ? row.item.entry.ref.entityId : null));
      const rows = allRows.filter(row => !query.projectOnly || isProjectResource(row.item) && !(record(row.item.configuration) && row.item.configuration.type === 'haiyue.render.material' && row.item.entry.ref.kind === 'instance' && pbrOwners.has(row.item.entry.ref.entityId))), categories = [...new Set(rows.map(row => projectCategory(row.item, query)))].sort();
      const matching = rows.filter(row => matches(row.item, query));
      const { cursor, ...filters } = query;
      const fingerprint = digest({ binding: source.binding.digest, filters, states: rows.map(row => [row.item.entry.catalogEntryId, row.item.entry.status, row.item.entry.unused]) });
      const offset = cursor ? cursorOffset(cursor, fingerprint) : 0;
      if (offset > matching.length) fail('cursor-stale');
      const items: ResourceCatalogItem[] = [];
      for (const row of matching.slice(offset, offset + query.limit)) {
        if (Buffer.byteLength(JSON.stringify([...items, row.item])) > PAGE_BYTES - 8192) {
          if (!items.length) fail('page-budget');
          break;
        }
        items.push(row.item);
      }
      this.guard(source, task.signal);
      const nextOffset = offset + items.length;
      return freeze({ binding: source.binding, items, total: matching.length, categories, diagnostics: source.diagnostics,
        nextCursor: nextOffset < matching.length ? encodeCursor(fingerprint, nextOffset) : null });
    } finally { task.detach(); }
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<ResourceActionResult> {
    const raw = shape(checked(input, PAGE_BYTES), ['binding', 'entry', 'action'], ['targetEntityId', 'usage']);
    const source = this.source(); if (!source) return fail('project-unavailable');
    const binding = checkedBinding(raw.binding); if (!equal(binding, source.binding)) fail('stale');
    const entry = this.ports.validateEntry(raw.entry), action = text(raw.action);
    const row = this.rows(source).find(row => row.item.entry.catalogEntryId === entry.catalogEntryId);
    if (!row || !equal(row.item.entry, entry)) fail('reference-stale');
    if (entry.status !== 'available' || !(entry.intents as readonly string[]).includes(action)) fail('action-unavailable');
    const current = row!, task = this.task(signal);
    try {
      this.guard(source, task.signal);
      if (action === 'resource.locate' || action === 'instance.inspect' || action === 'asset.inspect') {
        if (raw.targetEntityId !== undefined || raw.usage !== undefined) fail('action-arguments');
        if (action === 'resource.locate') return freeze({ kind: 'location', location: this.location(source, current) });
        if (action === 'asset.inspect') await this.verifyAsset(source, entry, task.signal);
        this.guard(source, task.signal);
        return freeze({ kind: 'inspection', item: this.rows(source).find(row => row.item.entry.catalogEntryId === entry.catalogEntryId)!.item });
      }
      let toolId: string, args: JsonObject;
      if (action === 'asset.assign' && entry.kind === 'asset') {
        const targetEntityId = id(raw.targetEntityId), usage = text(raw.usage);
        this.requireEntity(source, targetEntityId);
        if (!(current.item.assignments as readonly string[]).includes(usage)) fail('assignment-incompatible');
        await this.verifyAsset(source, entry, task.signal);
        this.guard(source, task.signal);
        toolId = 'asset.assign'; args = { baseRevision: binding.documentRevision, entityId: targetEntityId, assetId: entry.ref.assetId, usage };
      } else if (action === 'template.create' && entry.kind === 'template' && current.template) {
        if (raw.usage !== undefined) fail('action-arguments');
        toolId = current.template.toolId; args = { ...current.template.args, baseRevision: binding.documentRevision };
        if (current.item.target === 'entity') {
          const targetEntityId = id(raw.targetEntityId); this.requireEntity(source, targetEntityId); args = { ...args, entityId: targetEntityId };
        } else if (raw.targetEntityId !== undefined) fail('action-arguments');
      } else return fail('action-unavailable');
      this.guard(source, task.signal);
      const result = await this.request(source, toolId, args, task.signal);
      this.guardOwner(source, task.signal);
      return freeze({ kind: 'workflow', result: publicValue(checked(result, PAGE_BYTES)) });
    } finally { task.detach(); }
  }

  /** Import admission remains in the existing asset.import workflow. */
  async importAsset(input: unknown, signal?: AbortSignal): Promise<ResourceActionResult> {
    const raw = shape(checked(input), ['binding', 'projectPath', 'kind', 'mimeType', 'license', 'provenance', 'decodedBytes'], ['width', 'height']);
    const source = this.source(); if (!source) return fail('project-unavailable');
    if (!equal(checkedBinding(raw.binding), source.binding)) fail('stale');
    if (!['texture', 'model', 'audio', 'animation'].includes(String(raw.kind))) fail('import-kind-unavailable');
    text(raw.projectPath, 512); text(raw.mimeType, 128); text(raw.license, 32); text(raw.provenance, 512);
    if (!Number.isSafeInteger(raw.decodedBytes) || Number(raw.decodedBytes) < 1) fail('input-invalid');
    for (const key of ['width', 'height']) if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 1)) fail('input-invalid');
    const { binding: _binding, ...args } = raw, task = this.task(signal);
    try {
      this.guard(source, task.signal);
      const result = await this.request(source, 'asset.import', { ...args, baseRevision: source.binding.documentRevision }, task.signal);
      this.guardOwner(source, task.signal);
      return freeze({ kind: 'workflow', result: publicValue(checked(result, PAGE_BYTES)) });
    } finally { task.detach(); }
  }

  /** G09 can route a location through this authority before selecting UI state. */
  locateUsage(input: unknown): EditorLocationV1 {
    const raw = shape(checked(input, PAGE_BYTES), ['binding', 'entry', 'ref', 'field']), source = this.source();
    if (!source || !equal(checkedBinding(raw.binding), source.binding)) fail('stale');
    const entry = this.ports.validateEntry(raw.entry), row = this.rows(source).find(row => row.item.entry.catalogEntryId === entry.catalogEntryId);
    if (entry.kind !== 'asset' || !row || !equal(row.item.entry, entry)) fail('reference-stale');
    const site = row.item.locations.find(site => equal(site.ref, raw.ref) && site.field === raw.field);
    if (!site) fail('location-unproven');
    return this.usageLocation(source, site);
  }

  resolveLocation(input: EditorLocationV1): Readonly<{ status: 'current' | 'historical'; location: EditorLocationV1 }> {
    const location = this.ports.validateLocation(checked(input, 4096)), source = this.source();
    const current = source && location.projectId === source.binding.projectId && location.documentId === source.binding.documentId
      && location.documentRevision === source.binding.documentRevision && location.sourceBindingDigest === source.binding.digest
      && (this.rows(source).some(row => row.item.entry.status === 'available' && equal(this.location(source, row), location))
        || this.dependencies.references.some(row => equal(this.usageLocation(source, row.location), location)));
    return freeze({ status: current ? 'current' : 'historical', location });
  }

  cancel(): void { for (const task of this.tasks) task.abort(); }
  dispose(): void { if (this.closed) return; this.closed = true; this.cancel(); this.tasks.clear(); this.health.clear(); this.dependencies = UNKNOWN_DEPENDENCIES; this.key = null; }

  private source(): ResourceSource | null {
    if (this.closed) return fail('disposed');
    const source = resourceSource(this.ports), key = source ? JSON.stringify([source.binding.digest, source.projectRoot]) : null;
    if (key !== this.key) { this.cancel(); this.key = key; this.health.clear(); this.dependencies = UNKNOWN_DEPENDENCIES; }
    return source;
  }
  private rows(source: ResourceSource): readonly ResourceRow[] { return buildResourceRows(source, this.dependencies, this.ports, this.health); }
  private guardOwner(source: ResourceSource, signal: AbortSignal): void {
    if (this.closed || signal.aborted) fail('cancelled');
    const workspace = this.ports.workspace.snapshot(), document = workspace.document;
    if (!document || workspace.projectRoot !== source.projectRoot || document.projectId !== source.binding.projectId || document.documentId !== source.binding.documentId) fail('stale');
  }
  private guard(source: ResourceSource, signal: AbortSignal): void {
    this.guardOwner(source, signal);
    if (resourceSource(this.ports)?.binding.digest !== source.binding.digest) fail('stale');
  }
  private task(signal?: AbortSignal) {
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
    this.tasks.add(controller);
    return { signal: controller.signal, detach: () => { signal?.removeEventListener('abort', abort); this.tasks.delete(controller); } };
  }
  private async request(source: ResourceSource, toolId: string, args: JsonObject, signal: AbortSignal): Promise<JsonValue> {
    try { return await abortable(() => { this.guard(source, signal); return this.ports.request(toolId, args, source.binding, signal); }, signal); }
    catch (error) { this.guardOwner(source, signal); if (error instanceof ResourceCatalogError && ['resource.stale', 'resource.cancelled'].includes(error.code)) throw error; return fail('workflow-failed'); }
  }
  private requireEntity(source: ResourceSource, entityId: string): void { if (!source.document.entities.some(entity => entity.id === entityId)) fail('target-missing'); }
  private async verifyAsset(source: ResourceSource, entry: ResourceCatalogEntryV1, signal: AbortSignal): Promise<void> {
    if (entry.kind !== 'asset' || !source.catalog) fail('asset-invalid');
    const assetId = (entry as Extract<ResourceCatalogEntryV1, { kind: 'asset' }>).ref.assetId, asset = source.catalog!.get(assetId);
    let read = false;
    try {
      const bytes = await abortable(() => this.ports.workspace.readControlledAsset(asset.projectPath, 32 * 1024 * 1024, signal), signal);
      read = true; this.guard(source, signal);
      if (!(bytes instanceof Uint8Array) || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest) fail('asset-digest');
      source.catalog!.import({ projectPath: asset.projectPath, bytes, kind: asset.kind, mimeType: asset.mimeType, license: asset.license, provenance: asset.provenance,
        decodedBytes: asset.decodedBytes, ...(asset.width === null ? {} : { width: asset.width, height: asset.height! }) });
      this.guard(source, signal); this.health.set(assetId, { health: 'verified', diagnostic: '' });
    } catch {
      this.guard(source, signal);
      this.health.set(assetId, { health: read ? 'invalid' : 'missing', diagnostic: read ? '文件内容与登记摘要、格式或解码预算不一致。' : '无法读取项目内资源，请检查文件是否存在及是否仍在受控目录。' });
      fail(read ? 'asset-invalid' : 'asset-missing');
    }
  }
  private location(source: ResourceSource, row: ResourceRow): EditorLocationV1 {
    let target: EditorLocationV1['target'] = { kind: 'resource', ref: row.item.entry.ref };
    if (row.scriptId) {
      const script = source.document.scripts.find(script => script.id === row.scriptId)!;
      const lines = script.source.split(/\r\n|\n|\r/u);
      target = { kind: 'script', source: { kind: 'script', entityId: script.entityId, scriptId: script.id, path: script.sourcePath, digest: script.digest,
        range: { start: 0, end: script.source.length, startLine: 1, startColumn: 1, endLine: lines.length, endColumn: lines.at(-1)!.length + 1 } } };
    }
    return this.ports.validateLocation({ schemaVersion: 1, projectId: source.binding.projectId, documentId: source.binding.documentId, documentRevision: source.binding.documentRevision, sourceBindingDigest: source.binding.digest, target });
  }
  private usageLocation(source: ResourceSource, site: ResourceCatalogItem['locations'][number]): EditorLocationV1 {
    const component = source.document.components.find(component => component.id === site.ref.componentId);
    if (!component) fail('location-unproven');
    return this.ports.validateLocation({ schemaVersion: 1, projectId: source.binding.projectId, documentId: source.binding.documentId,
      documentRevision: source.binding.documentRevision, sourceBindingDigest: source.binding.digest,
      target: { kind: 'component', entityId: site.ref.entityId, componentId: component.id, componentVersion: component.version, field: site.field } });
  }
}

function checkedBinding(value: unknown): ResourceCatalogBinding {
  const binding = shape(value, ['projectId', 'documentId', 'documentRevision', 'registryVersion', 'registryDigest', 'digest']);
  id(binding.projectId); id(binding.documentId);
  if (!Number.isSafeInteger(binding.documentRevision) || Number(binding.documentRevision) < 0 || !/^\d+\.\d+\.\d+$/u.test(String(binding.registryVersion))
    || !/^sha256:[a-f0-9]{64}$/u.test(String(binding.registryDigest)) || !/^sha256:[a-f0-9]{64}$/u.test(String(binding.digest))) fail('binding-invalid');
  return binding as unknown as ResourceCatalogBinding;
}
function queryInput(value: unknown): ResourceCatalogQuery & { limit: number } {
  const query = shape(value, [], ['text', 'category', 'kind', 'status', 'unused', 'limit', 'cursor', 'projectOnly']);
  if (query.projectOnly !== undefined && typeof query.projectOnly !== 'boolean') fail('query-invalid');
  if (query.text !== undefined && (typeof query.text !== 'string' || query.text.length > 256)) fail('query-invalid');
  if (query.category !== undefined) text(query.category, 64);
  if (query.kind !== undefined && !KINDS.includes(String(query.kind))) fail('query-invalid');
  if (query.status !== undefined && !['available', 'unavailable'].includes(String(query.status))) fail('query-invalid');
  if (query.unused !== undefined && typeof query.unused !== 'boolean') fail('query-invalid');
  if (query.cursor !== undefined) text(query.cursor, 1024);
  const limit = query.limit ?? 25;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) fail('query-invalid');
  return { ...query, limit } as ResourceCatalogQuery & { limit: number };
}
function matches(item: ResourceCatalogItem, query: ResourceCatalogQuery): boolean {
  const { entry } = item;
  if (query.kind && entry.kind !== query.kind || query.category && projectCategory(item, query) !== query.category || query.status && entry.status !== query.status) return false;
  if (query.unused && (entry.kind !== 'asset' || entry.unused !== 'yes')) return false;
  const search = query.text?.trim().toLocaleLowerCase('en-US');
  return !search || `${entry.label} ${entry.category} ${entry.kind} ${JSON.stringify(entry.ref)} ${item.asset?.projectPath ?? ''} ${item.asset?.license ?? ''} ${item.asset?.provenance ?? ''} ${item.diagnostics.join(' ')}`.toLocaleLowerCase('en-US').includes(search);
}
function encodeCursor(fingerprint: string, offset: number): string { return Buffer.from(JSON.stringify({ fingerprint, offset })).toString('base64url'); }
function cursorOffset(cursor: string, fingerprint: string): number {
  let value: JsonValue; try { value = checked(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')), 1024); } catch { return fail('cursor-invalid'); }
  const parsed = shape(value, ['fingerprint', 'offset']);
  if (parsed.fingerprint !== fingerprint || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) return fail('cursor-stale');
  return Number(parsed.offset);
}
async function abortable<T>(run: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return fail('cancelled');
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(new ResourceCatalogError('resource.cancelled')); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(run), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** Inventory is based on document ownership, never similarities to registered defaults. */
function isProjectResource(item: ResourceCatalogItem): boolean {
  if (item.entry.kind === 'asset') return true;
  if (item.entry.kind !== 'instance' || item.entry.source !== 'document') return false;
  const configuration = item.configuration;
  if (!record(configuration)) return false;
  // Script resources have their own records; binding components are not scripts.
  if (item.entry.category === 'Script') return typeof configuration.scriptId === 'string';
  // The component is the resource. Its containing entity is a use site, not another geometry.
  return ['Geometry', 'Material', 'Model', 'Audio', 'Animation', 'Lighting'].includes(item.entry.category)
    && item.entry.ref.kind === 'instance' && item.entry.ref.componentId !== null;
}

function projectCategory(item: ResourceCatalogItem, query: ResourceCatalogQuery): string {
  return query.projectOnly && item.asset?.kind === 'texture' ? 'Texture' : item.entry.category;
}
