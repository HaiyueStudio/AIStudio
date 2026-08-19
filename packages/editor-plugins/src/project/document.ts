import type { EditorDisposable, EditorDocumentAdapter, EditorDocumentIdentity } from '@haiyue/editor-plugin-sdk';
import type { JsonObject, JsonValue, StableId } from '@haiyue/ai-studio-contracts';

export interface ProjectDocumentFile {
  readonly schemaVersion: 1;
  readonly projectId: StableId;
  readonly name: string;
  readonly document: Readonly<{
    id: StableId;
    revision: number;
    savedRevision: number;
    settings: JsonObject;
  }>;
}

export interface ProjectDocumentReadModel {
  readonly projectId: StableId;
  readonly documentId: StableId;
  readonly name: string;
  readonly revision: number;
  readonly savedRevision: number;
  readonly dirty: boolean;
  readonly settings: JsonObject;
  readonly closed: boolean;
}

export class ProjectDocument implements EditorDocumentAdapter<ProjectDocumentFile> {
  readonly identity: EditorDocumentIdentity;
  private listeners = new Set<() => void>();
  private settings: Record<string, JsonValue>;
  private currentRevision: number;
  private currentSavedRevision: number;
  private closed = false;

  constructor(
    readonly projectId: StableId,
    readonly name: string,
    readonly documentId: StableId,
    settings: JsonObject = {},
    revision = 0,
    savedRevision = revision,
  ) {
    if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(savedRevision) || savedRevision < 0 || savedRevision > revision) {
      throw new TypeError('Project document revisions are invalid.');
    }
    this.currentRevision = revision;
    this.currentSavedRevision = savedRevision;
    this.settings = cloneObject(settings);
    this.identity = Object.freeze({ id: documentId, kind: 'haiyue.scene', name });
  }

  get revision(): number { return this.currentRevision; }
  get savedRevision(): number { return this.currentSavedRevision; }

  snapshot(): ProjectDocumentReadModel {
    return Object.freeze({
      projectId: this.projectId,
      documentId: this.documentId,
      name: this.name,
      revision: this.currentRevision,
      savedRevision: this.currentSavedRevision,
      dirty: this.currentRevision !== this.currentSavedRevision,
      settings: Object.freeze(cloneObject(this.settings)),
      closed: this.closed,
    });
  }

  serialize(): ProjectDocumentFile {
    this.assertOpen();
    return Object.freeze({
      schemaVersion: 1,
      projectId: this.projectId,
      name: this.name,
      document: Object.freeze({
        id: this.documentId,
        revision: this.currentRevision,
        savedRevision: this.currentSavedRevision,
        settings: Object.freeze(cloneObject(this.settings)),
      }),
    });
  }

  serializeForSave(): ProjectDocumentFile {
    const value = this.serialize();
    return Object.freeze({ ...value, document: Object.freeze({ ...value.document, savedRevision: value.document.revision }) });
  }

  markSaved(revision = this.currentRevision): void {
    this.assertOpen();
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > this.currentRevision) throw new RangeError('Saved revision is invalid.');
    this.currentSavedRevision = revision;
    this.emit();
  }

  setSetting(key: string, value: JsonValue): Readonly<{ existed: boolean; value?: JsonValue }> {
    this.assertOpen();
    assertSettingKey(key);
    const existed = Object.hasOwn(this.settings, key);
    const previous = existed ? cloneJson(this.settings[key]!) : undefined;
    this.settings[key] = cloneJson(value);
    this.currentRevision += 1;
    this.emit();
    return Object.freeze(previous === undefined ? { existed } : { existed, value: previous });
  }

  restoreSetting(key: string, previous: Readonly<{ existed: boolean; value?: JsonValue }>): void {
    this.assertOpen();
    if (previous.existed) this.settings[key] = cloneJson(previous.value!);
    else delete this.settings[key];
    this.currentRevision += 1;
    this.emit();
  }

  subscribe(listener: () => void): EditorDisposable {
    this.assertOpen();
    this.listeners.add(listener);
    let active = true;
    return Object.freeze({ dispose: () => { if (active) { active = false; this.listeners.delete(listener); } } });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
  }

  private emit(): void { for (const listener of [...this.listeners]) listener(); }
  private assertOpen(): void { if (this.closed) throw new Error('Project document is closed.'); }
}

export function parseProjectDocumentFile(value: unknown): ProjectDocumentFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Project file must be an object.');
  const root = value as Record<string, unknown>;
  const document = root.document;
  if (root.schemaVersion !== 1 || typeof root.projectId !== 'string' || typeof root.name !== 'string' || !document || typeof document !== 'object' || Array.isArray(document)) {
    throw new TypeError('Project file envelope is invalid.');
  }
  const doc = document as Record<string, unknown>;
  if (typeof doc.id !== 'string' || !Number.isSafeInteger(doc.revision) || !Number.isSafeInteger(doc.savedRevision) || !isJsonObject(doc.settings)) {
    throw new TypeError('Project document payload is invalid.');
  }
  return Object.freeze({
    schemaVersion: 1,
    projectId: root.projectId as StableId,
    name: root.name,
    document: Object.freeze({
      id: doc.id as StableId,
      revision: doc.revision as number,
      savedRevision: doc.savedRevision as number,
      settings: Object.freeze(cloneObject(doc.settings)),
    }),
  });
}

function assertSettingKey(key: string): void {
  if (!/^[a-z][a-z0-9.-]{1,63}$/.test(key)) throw new TypeError(`Invalid project setting key ${key}.`);
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  try { cloneObject(value as JsonObject); return true; } catch { return false; }
}

function cloneObject(value: JsonObject): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, cloneJson(member)]));
}

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value && typeof value === 'object') return cloneObject(value as JsonObject);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Project data contains a non-finite number.');
  return value;
}
