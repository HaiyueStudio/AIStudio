import type { JsonObject, StableId } from '@haiyue/ai-studio-contracts';
import { validateStudioIpcRequest, type StudioIpcRequest, type StudioIpcResponse } from './ipc.js';

const SAVED_PROJECT_KEY = 'haiyue.ai-studio.web.project.saved.v1';
const DRAFT_PROJECT_KEY = 'haiyue.ai-studio.web.project.draft.v1';
const LOG_KEY = 'haiyue.ai-studio.web.operation-log.v1';
const MAX_LOG_EVENTS = 500;

interface Vec3 { x: number; y: number; z: number; }
interface Transform { position: Vec3; rotationDegrees: Vec3; scale: Vec3; }
type WebEntityKind = 'empty' | 'cube' | 'sphere' | 'cone' | 'cylinder' | 'plane' | 'torus' | 'icosahedron' | 'directional-light' | 'point-light' | 'ambient-light';
type WebMaterialKind = 'basic' | 'pbr' | 'blinn-phong' | 'normal';
interface WebEntity {
  id: StableId; name: string; kind: WebEntityKind; parentId: StableId | null; order: number; transform: Transform;
  appearance?: { material: WebMaterialKind; color: [number, number, number, number] };
  light?: { color: [number, number, number]; intensity: number; range?: number; direction?: [number, number, number]; castShadow?: boolean };
}
interface WebScript { id: StableId; entityId: StableId; text: string; textRevision: number; }
interface WebProject {
  schemaVersion: 1;
  projectId: StableId;
  documentId: StableId;
  name: string;
  revision: number;
  savedRevision: number;
  sceneRevision: number;
  entities: WebEntity[];
  scripts: WebScript[];
}
interface WebProposal {
  id: StableId; entityId: StableId; scriptId: StableId; baseRevision: number; text: string; nextTextRevision: number;
  diagnostics: ScriptDiagnostic[]; emittedText: string; addedLines: number; removedLines: number;
}
interface ScriptDiagnostic { code: string; severity: 'error' | 'warning'; line: number; column: number; message: string; }
interface WebPreviewPlan {
  id: StableId; scriptId: StableId; entityId: StableId; documentRevision: number; textRevision: number; digest: string;
  capabilities: string[]; risk: 'trusted-project'; diagnostics: ScriptDiagnostic[]; emittedText: string;
}
interface WebLogEvent { sequence: number; eventId: StableId; timestamp: string; kind: string; severity: 'info' | 'warning' | 'error'; source: string; payloadDigest: string; }

export function installWebStudioHost(): void {
  if (window.haiyueStudio) return;
  const host = new WebStudioHost();
  Object.defineProperty(window, 'haiyueStudio', { configurable: false, enumerable: false, writable: false, value: Object.freeze({
    invoke: (request: StudioIpcRequest) => host.handle(request),
    cancel: (requestId: string) => host.cancel(requestId),
    onConversationChanged: (listener: () => void) => host.onConversationChanged(listener),
  }) });
}

class WebStudioHost {
  private project: WebProject | null = readProject(DRAFT_PROJECT_KEY);
  private readonly undoStack: WebProject[] = [];
  private readonly redoStack: WebProject[] = [];
  private readonly proposals = new Map<StableId, WebProposal>();
  private readonly plans = new Map<StableId, WebPreviewPlan>();
  private readonly grants = new Map<StableId, Readonly<{ plan: WebPreviewPlan; expiresAt: number }>>();
  private readonly cancelled = new Set<string>();
  private readonly conversationListeners = new Set<() => void>();
  private logs: WebLogEvent[] = readLogs();

  async handle(value: unknown): Promise<StudioIpcResponse> {
    let request: StudioIpcRequest;
    try { request = validateStudioIpcRequest(value); }
    catch (cause) { return failure('request:web-invalid', 'correlation:web-invalid', 'web-request-invalid', errorMessage(cause)); }
    if (this.cancelled.delete(request.id)) return failure(request.id, request.correlationId, 'web-request-cancelled', 'Web request was cancelled.');
    try {
      const payload = await this.dispatch(request);
      return Object.freeze({ schemaVersion: 1, id: request.id, correlationId: request.correlationId, ok: true, payload });
    } catch (cause) {
      await this.appendLog('ipc/failed', 'error', 'studio.web-host', `${request.channel}:${errorMessage(cause)}`);
      return failure(request.id, request.correlationId, errorCode(cause), errorMessage(cause));
    }
  }

  cancel(requestId: string): void { this.cancelled.add(requestId); }
  onConversationChanged(listener: () => void): () => void { this.conversationListeners.add(listener); return () => this.conversationListeners.delete(listener); }

  private async dispatch(request: StudioIpcRequest): Promise<JsonObject> {
    const payload = request.payload as Record<string, unknown>;
    switch (request.channel) {
      case 'app/status': return json({ ...this.projectSnapshot(), smoke: false, shell: 'web' });
      case 'project/snapshot': return this.projectSnapshot();
      case 'project/new': {
        this.project = createProject(String(payload.name));
        this.undoStack.length = 0; this.redoStack.length = 0; this.proposals.clear(); this.plans.clear(); this.grants.clear();
        this.saveProject();
        await this.appendLog('project/created', 'info', 'studio.web-host', this.project.documentId);
        return this.projectSnapshot();
      }
      case 'project/open': {
        const stored = readProject(SAVED_PROJECT_KEY);
        if (!stored) throw new WebHostError('web-project-missing', 'No saved AIStudio Web project exists in this browser. Create and save one first.');
        this.project = stored; this.undoStack.length = 0; this.redoStack.length = 0; this.persistDraft();
        await this.appendLog('project/opened', 'info', 'studio.web-host', stored.documentId);
        return this.projectSnapshot();
      }
      case 'project/save': this.requireProject().savedRevision = this.requireProject().revision; this.saveProject(); await this.appendLog('project/saved', 'info', 'studio.web-host', this.requireProject().documentId); return this.projectSnapshot();
      case 'project/close': this.project = null; localStorage.removeItem(DRAFT_PROJECT_KEY); return json({ closed: true });
      case 'project/reopen': {
        const stored = readProject(SAVED_PROJECT_KEY);
        if (!stored) throw new WebHostError('web-project-missing', 'No saved AIStudio Web project can be reopened.');
        this.project = stored; this.undoStack.length = 0; this.redoStack.length = 0; this.persistDraft(); return this.projectSnapshot();
      }
      case 'project/command': throw new WebHostError('web-command-unsupported', 'Generic project settings are not exposed by the Web POC.');
      case 'history/undo': return this.applyHistory('undo', number(payload.baseRevision));
      case 'history/redo': return this.applyHistory('redo', number(payload.baseRevision));
      case 'scene/snapshot': return this.sceneSnapshot();
      case 'scene/create': {
        const project = this.requireRevision(number(payload.baseRevision));
        const kind = payload.kind as WebEntityKind;
        if (!isGeometryKind(kind) && (payload.material !== undefined || payload.color !== undefined)) throw new WebHostError('web-material-target-invalid', 'Only geometry entities can use materials.');
        this.commitMutation(project, true, () => project.entities.push({
          id: id('entity'), name: typeof payload.name === 'string' ? payload.name : entityKindLabel(kind), kind,
          parentId: typeof payload.parentId === 'string' ? payload.parentId as StableId : null, order: project.entities.length,
          transform: identityTransform(),
          ...(isGeometryKind(kind) ? { appearance: { material: (payload.material as WebMaterialKind | undefined) ?? 'basic', color: webMaterialColor(payload.color) } } : {}),
          ...(isLightKind(kind) ? { light: defaultWebLight(kind) } : {}),
        }));
        await this.appendLog('scene/entity-created', 'info', 'studio.web-host', kind);
        return this.sceneSnapshot();
      }
      case 'scene/select': return json({ activeEntityId: payload.entityId ?? null, source: payload.source });
      case 'scene/transform': {
        const project = this.requireRevision(number(payload.baseRevision));
        const entity = project.entities.find((item) => item.id === payload.entityId);
        if (!entity) throw new WebHostError('web-entity-missing', 'Selected entity no longer exists.');
        const transform = validateTransform(payload.transform);
        this.commitMutation(project, true, () => { entity.transform = transform; });
        await this.appendLog('scene/transform-committed', 'info', 'studio.web-host', entity.id);
        return this.sceneSnapshot();
      }
      case 'scene/material': {
        const project = this.requireRevision(number(payload.baseRevision));
        const entity = project.entities.find((item) => item.id === payload.entityId);
        if (!entity) throw new WebHostError('web-entity-missing', 'Selected entity no longer exists.');
        if (!isGeometryKind(entity.kind)) throw new WebHostError('web-material-target-invalid', 'Only geometry entities can use materials.');
        this.commitMutation(project, true, () => { entity.appearance = { material: payload.material as WebMaterialKind, color: payload.color === undefined ? entity.appearance?.color ?? [0.16, 0.58, 1, 1] : webMaterialColor(payload.color) }; });
        await this.appendLog('scene/material-edited', 'info', 'studio.web-host', entity.id);
        return this.sceneSnapshot();
      }
      case 'viewport/report': await this.appendLog(`viewport/${String(payload.event)}`, payload.event === 'ready' || payload.event === 'rendered' ? 'info' : 'error', 'studio.viewport.web', String(payload.message)); return json({ recorded: true });
      case 'script/snapshot': return this.scriptSnapshot();
      case 'script/propose': return this.proposeScript(payload);
      case 'script/commit': return this.commitScript(payload);
      case 'preview/prepare': return this.preparePreview(payload);
      case 'preview/authorize': return this.authorizePreview(payload);
      case 'preview/consume': return this.consumePreview(payload);
      case 'preview/report': await this.appendLog(`preview/${String(payload.event)}`, payload.event === 'runtime-error' ? 'error' : 'info', 'studio.preview.web', String(payload.message)); return json({ recorded: true });
      case 'preview/agent-command': return json({ pending: false });
      case 'preview/agent-result': return json({ recorded: true });
      case 'conversation/replay': return json({
        revision: 0, connection: 'disconnected', busy: false, backendId: 'backend:web-unavailable', events: [],
        backends: [{ id: 'backend:web-unavailable', label: 'Desktop Agent required', kind: 'codex-app-server', state: 'unavailable', authMode: 'none', rateLimits: [], diagnostic: { code: 'web-agent-unavailable', message: 'Local Codex and API-key backends require Electron.' } }],
      });
      case 'conversation/intent': throw new WebHostError('web-agent-unavailable', 'AI Agent backends require the Electron desktop app.');
      case 'logs/query': {
        const query = payload.query as Record<string, unknown>; const limit = Math.min(200, Math.max(1, Number(query.limit) || 80));
        return json({ events: this.logs.slice(-limit), status: { health: 'healthy', canPersist: true } });
      }
      case 'logs/export': return this.exportLogs();
    }
  }

  private projectSnapshot(): JsonObject {
    const project = this.project;
    const logging = { health: 'healthy', canPersist: true, nextSequence: (this.logs.at(-1)?.sequence ?? 0) + 1, eventCount: this.logs.length };
    if (!project) return json({ projectId: null, document: null, history: { canUndo: false, canRedo: false }, logging });
    return json({
      projectId: project.projectId,
      document: { documentId: project.documentId, name: project.name, revision: project.revision, savedRevision: project.savedRevision, dirty: project.revision !== project.savedRevision, settings: {} },
      history: { canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 },
      logging,
    });
  }

  private sceneSnapshot(): JsonObject {
    const project = this.project;
    return json({ schemaVersion: 1, revision: project?.sceneRevision ?? 0, documentId: project?.documentId ?? 'document:web-none', entities: project?.entities ?? [] });
  }

  private scriptSnapshot(): JsonObject {
    const project = this.project;
    return json({ schemaVersion: 1, documentId: project?.documentId ?? 'document:web-none', documentRevision: project?.revision ?? 0, resources: (project?.scripts ?? []).map((script) => ({ ...script, name: 'Entity Script', sourcePath: `scripts/${script.id.slice(7)}.js`, dirty: Boolean(project && project.revision !== project.savedRevision) })) });
  }

  private async proposeScript(payload: Record<string, unknown>): Promise<JsonObject> {
    const project = this.requireRevision(number(payload.baseRevision));
    const entityId = String(payload.entityId) as StableId;
    if (!project.entities.some((entity) => entity.id === entityId)) throw new WebHostError('web-entity-missing', 'Script entity no longer exists.');
    const text = String(payload.text);
    const previous = project.scripts.find((script) => script.entityId === entityId);
    const diagnostics = validateWebScript(text);
    const proposal: WebProposal = {
      id: id('script-proposal'), entityId, scriptId: previous?.id ?? id('script'), baseRevision: project.revision, text,
      nextTextRevision: (previous?.textRevision ?? 0) + 1, diagnostics, emittedText: text,
      ...lineDiff(previous?.text ?? '', text),
    };
    this.proposals.set(proposal.id, proposal);
    await this.appendLog('script/proposal-ready', diagnostics.length ? 'warning' : 'info', 'studio.script.web', proposal.id);
    return json(proposal);
  }

  private async commitScript(payload: Record<string, unknown>): Promise<JsonObject> {
    const proposal = this.proposals.get(String(payload.proposalId) as StableId);
    if (!proposal) throw new WebHostError('web-proposal-missing', 'Script proposal is missing or already consumed.');
    if (proposal.diagnostics.some((item) => item.severity === 'error')) throw new WebHostError('web-script-invalid', 'Fix script diagnostics before commit.');
    const project = this.requireRevision(proposal.baseRevision);
    this.commitMutation(project, false, () => {
      project.scripts = project.scripts.filter((item) => item.entityId !== proposal.entityId);
      project.scripts.push({ id: proposal.scriptId, entityId: proposal.entityId, text: proposal.text, textRevision: proposal.nextTextRevision });
    });
    this.proposals.delete(proposal.id);
    await this.appendLog('script/edit-committed', 'info', 'studio.script.web', proposal.scriptId);
    const script = project.scripts.find((item) => item.id === proposal.scriptId)!;
    return json({ ...script, name: 'Entity Script', sourcePath: `scripts/${script.id.slice(7)}.js`, dirty: true });
  }

  private async preparePreview(payload: Record<string, unknown>): Promise<JsonObject> {
    const project = this.requireProject(); const script = project.scripts.find((item) => item.id === payload.scriptId);
    if (!script) throw new WebHostError('web-script-missing', 'Committed script does not exist.');
    const diagnostics = validateWebScript(script.text);
    const plan: WebPreviewPlan = {
      id: id('preview-plan'), scriptId: script.id, entityId: script.entityId, documentRevision: project.revision, textRevision: script.textRevision,
      digest: await digest(`${script.text}\0${JSON.stringify(payload.capabilities ?? [])}`), capabilities: Array.isArray(payload.capabilities) ? payload.capabilities.map(String) : ['read', 'input', 'debug'],
      risk: 'trusted-project', diagnostics, emittedText: script.text,
    };
    this.plans.set(plan.id, plan);
    const { emittedText: _hidden, ...disclosure } = plan;
    return json(disclosure);
  }

  private async authorizePreview(payload: Record<string, unknown>): Promise<JsonObject> {
    const plan = this.plans.get(String(payload.planId) as StableId);
    if (!plan) throw new WebHostError('web-preview-plan-missing', 'Preview plan is missing.');
    this.plans.delete(plan.id);
    if (payload.approved !== true) return json({ denied: true });
    if (plan.diagnostics.some((item) => item.severity === 'error')) throw new WebHostError('web-script-invalid', 'A preview with validation errors cannot be authorized.');
    const grantId = id('preview-grant'); this.grants.set(grantId, { plan, expiresAt: Date.now() + 60_000 });
    await this.appendLog('preview/authorized', 'info', 'studio.preview.web', plan.id);
    return json({ id: grantId });
  }

  private async consumePreview(payload: Record<string, unknown>): Promise<JsonObject> {
    const grantId = String(payload.grantId) as StableId; const entry = this.grants.get(grantId);
    if (!entry) throw new WebHostError('web-preview-grant-missing', 'Preview grant is missing or already consumed.');
    this.grants.delete(grantId);
    if (Date.now() > entry.expiresAt) throw new WebHostError('web-preview-grant-expired', 'Preview grant expired.');
    const project = this.requireProject(); const script = project.scripts.find((item) => item.id === entry.plan.scriptId);
    if (!script || project.revision !== entry.plan.documentRevision || script.textRevision !== entry.plan.textRevision) throw new WebHostError('web-preview-grant-stale', 'Preview grant is stale.');
    return json(entry.plan);
  }

  private applyHistory(direction: 'undo' | 'redo', baseRevision: number): JsonObject {
    const project = this.requireRevision(baseRevision); const source = direction === 'undo' ? this.undoStack : this.redoStack; const target = source.pop();
    if (!target) throw new WebHostError('web-history-empty', `Nothing to ${direction}.`);
    const destination = direction === 'undo' ? this.redoStack : this.undoStack; destination.push(clone(project));
    const revision = project.revision + 1; const sceneRevision = project.sceneRevision + 1; const savedRevision = project.savedRevision;
    this.project = clone(target); this.project.revision = revision; this.project.sceneRevision = sceneRevision; this.project.savedRevision = savedRevision; this.persistDraft();
    return this.projectSnapshot();
  }

  private commitMutation(project: WebProject, sceneChanged: boolean, mutation: () => void): void {
    this.undoStack.push(clone(project)); this.redoStack.length = 0; mutation(); project.revision += 1; if (sceneChanged) project.sceneRevision += 1; this.persistDraft();
  }

  private requireProject(): WebProject { if (!this.project) throw new WebHostError('web-project-not-open', 'Create or open an AIStudio Web project first.'); return this.project; }
  private requireRevision(baseRevision: number): WebProject { const project = this.requireProject(); if (project.revision !== baseRevision) throw new WebHostError('web-revision-stale', `Document changed: expected revision ${project.revision}, received ${baseRevision}.`); return project; }
  private persistDraft(): void { if (this.project) writeStorage(DRAFT_PROJECT_KEY, this.project); }
  private saveProject(): void { if (!this.project) return; writeStorage(SAVED_PROJECT_KEY, this.project); writeStorage(DRAFT_PROJECT_KEY, this.project); }

  private async appendLog(kind: string, severity: WebLogEvent['severity'], source: string, summary: string): Promise<void> {
    const sequence = (this.logs.at(-1)?.sequence ?? 0) + 1;
    this.logs.push({ sequence, eventId: id('event'), timestamp: new Date().toISOString(), kind, severity, source, payloadDigest: await digest(summary.slice(0, 2_000)) });
    if (this.logs.length > MAX_LOG_EVENTS) this.logs.splice(0, this.logs.length - MAX_LOG_EVENTS);
    writeStorage(LOG_KEY, this.logs);
  }

  private async exportLogs(): Promise<JsonObject> {
    const text = JSON.stringify({ schemaVersion: 1, source: 'haiyue-ai-studio-web', exportedAt: new Date().toISOString(), events: this.logs }, null, 2);
    const contentDigest = await digest(text); const anchor = document.createElement('a'); const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    anchor.href = url; anchor.download = `haiyue-ai-studio-web-log-${Date.now()}.json`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
    return json({ contentDigest, downloaded: true });
  }
}

class WebHostError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'WebHostError'; } }

function createProject(name: string): WebProject { return { schemaVersion: 1, projectId: id('project'), documentId: id('document'), name: name.trim() || 'HaiYue Web Game', revision: 1, savedRevision: 1, sceneRevision: 1, entities: [], scripts: [] }; }
function identityTransform(): Transform { return { position: { x: 0, y: 0, z: 0 }, rotationDegrees: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }; }
function id(prefix: string): StableId { return `${prefix}:${crypto.randomUUID()}` as StableId; }
function number(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new WebHostError('web-number-invalid', 'Expected a non-negative integer.'); return value; }
function clone<T>(value: T): T { return structuredClone(value); }
function json(value: unknown): JsonObject { return clone(value) as JsonObject; }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function errorCode(value: unknown): string { return value instanceof WebHostError ? value.code : 'web-host-failed'; }
function failure(idValue: string, correlationId: string, code: string, message: string): StudioIpcResponse { return Object.freeze({ schemaVersion: 1, id: idValue as StableId, correlationId: correlationId as StableId, ok: false, payload: json({ diagnostic: { code, message } }) }); }

function validateTransform(value: unknown): Transform {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WebHostError('web-transform-invalid', 'Transform must be an object.');
  const source = value as Record<string, unknown>;
  return { position: vector(source.position, 'position'), rotationDegrees: vector(source.rotationDegrees, 'rotation'), scale: vector(source.scale, 'scale') };
}
function webMaterialColor(value: unknown): [number, number, number, number] {
  if (value === undefined) return [0.16, 0.58, 1, 1];
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 1)) throw new WebHostError('web-material-color-invalid', 'Material color must contain four normalized RGBA channels.');
  return [...value] as [number, number, number, number];
}
function vector(value: unknown, label: string): Vec3 { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WebHostError('web-transform-invalid', `${label} must be a vector.`); const item = value as Record<string, unknown>; if (![item.x, item.y, item.z].every((entry) => typeof entry === 'number' && Number.isFinite(entry))) throw new WebHostError('web-transform-invalid', `${label} contains a non-finite value.`); return { x: item.x as number, y: item.y as number, z: item.z as number }; }

function validateWebScript(text: string): ScriptDiagnostic[] {
  const diagnostics: ScriptDiagnostic[] = [];
  const forbidden = /\b(?:import|export|require|process|window|document|globalThis|fetch|WebSocket|XMLHttpRequest|eval|Function)\b/gu;
  for (const match of text.matchAll(forbidden)) diagnostics.push(diagnostic(text, match.index, 'script.capability.forbidden', `${match[0]} is outside the browser-local trusted-project contract.`));
  const typescript = /\bas\s+(?:unknown|string|number|boolean|Record|Readonly|[A-Z][A-Za-z0-9_]*)\b|:\s*(?:string|number|boolean|unknown)\b/gu;
  const typeMatch = typescript.exec(text);
  if (typeMatch) diagnostics.push(diagnostic(text, typeMatch.index, 'script.web.javascript-only', 'Web preview currently accepts a JavaScript function body; remove TypeScript-only annotations and assertions.'));
  return diagnostics;
}
function diagnostic(text: string, index: number, code: string, message: string): ScriptDiagnostic { const prefix = text.slice(0, index); const lines = prefix.split(/\r?\n/u); return { code, severity: 'error', line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1, message }; }
function lineDiff(before: string, after: string): Readonly<{ addedLines: number; removedLines: number }> { const left = before ? before.split(/\r?\n/u) : []; const right = after ? after.split(/\r?\n/u) : []; let shared = 0; const remaining = new Map<string, number>(); for (const line of left) remaining.set(line, (remaining.get(line) ?? 0) + 1); for (const line of right) { const count = remaining.get(line) ?? 0; if (count > 0) { shared += 1; remaining.set(line, count - 1); } } return { addedLines: right.length - shared, removedLines: left.length - shared }; }
async function digest(value: string): Promise<string> { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, '0')).join(''); }

function readProject(key: string): WebProject | null { const value = readStorage(key); if (!value || typeof value !== 'object' || Array.isArray(value)) return null; const project = value as Partial<WebProject>; return project.schemaVersion === 1 && typeof project.projectId === 'string' && typeof project.documentId === 'string' && typeof project.name === 'string' && Number.isSafeInteger(project.revision) && Number.isSafeInteger(project.savedRevision) && Number.isSafeInteger(project.sceneRevision) && Array.isArray(project.entities) && Array.isArray(project.scripts) ? clone(project as WebProject) : null; }
function isGeometryKind(kind: WebEntityKind): boolean { return ['cube', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'icosahedron'].includes(kind); }
function isLightKind(kind: WebEntityKind): boolean { return kind === 'directional-light' || kind === 'point-light' || kind === 'ambient-light'; }
function entityKindLabel(kind: WebEntityKind): string { return ({ empty: 'Empty', cube: 'Cube', sphere: 'Sphere', cone: 'Cone', cylinder: 'Cylinder', plane: 'Plane', torus: 'Torus', icosahedron: 'Icosahedron', 'directional-light': 'Directional Light', 'point-light': 'Point Light', 'ambient-light': 'Ambient Light' } as Record<WebEntityKind, string>)[kind]; }
function defaultWebLight(kind: WebEntityKind): NonNullable<WebEntity['light']> {
  if (kind === 'directional-light') return { color: [1, 1, 1], intensity: 1, direction: [-0.5, -1, -0.35], castShadow: true };
  if (kind === 'point-light') return { color: [1, 0.9, 0.75], intensity: 2, range: 12 };
  return { color: [0.7, 0.8, 1], intensity: 0.25 };
}
function readLogs(): WebLogEvent[] { const value = readStorage(LOG_KEY); return Array.isArray(value) ? value.slice(-MAX_LOG_EVENTS) as WebLogEvent[] : []; }
function readStorage(key: string): unknown { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : null; } catch { return null; } }
function writeStorage(key: string, value: unknown): void { try { localStorage.setItem(key, JSON.stringify(value)); } catch (cause) { throw new WebHostError('web-storage-unavailable', `Browser storage is unavailable: ${errorMessage(cause)}`); } }
