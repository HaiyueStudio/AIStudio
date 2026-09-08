import type { ComponentDefinitionV2, GameDocumentV2, JsonObject, JsonValue, ObservationArtifactV2 } from '@haiyue/ai-studio-contracts';
import type { EditorHistorySnapshot, EditorSelectionReference, EditorSelectionSnapshot } from '@haiyue/editor-plugin-sdk';

/** Internal, already validated service snapshots. No document/component envelope is redefined. */
export interface AdvancedStudioSource {
  readonly epoch: string;
  readonly document: Pick<GameDocumentV2, 'id' | 'revision' | 'entities' | 'components'> | null;
  readonly definitions: readonly ComponentDefinitionV2[];
  readonly selection: EditorSelectionSnapshot;
  readonly history: EditorHistorySnapshot;
  /** CSS-pixel projection provided by the viewport owner; validated by the Editor seam. */
  readonly projection: JsonObject | null;
  readonly playId: string | null;
  readonly observation: ObservationArtifactV2 | null;
  readonly observationValue: JsonObject | null;
  readonly observationEpoch: string | null;
  readonly observationDocumentId: string | null;
}
export interface AdvancedStudioStamp { readonly epoch: string; readonly documentId: string; readonly baseRevision: number; readonly selectionRevision: number; }
export type AdvancedStudioIntent =
  | Readonly<{ type: 'select'; stamp: AdvancedStudioStamp; reference: EditorSelectionReference | null }>
  | Readonly<{ type: 'author'; stamp: AdvancedStudioStamp; toolId: 'entity.rename' | 'entity.hierarchy' | 'component.add' | 'component.set' | 'component.remove' | 'transform.batch'; arguments: JsonObject }>
  | Readonly<{ type: 'undo' | 'redo' | 'runtime.inspect' | 'focus-selection'; stamp: AdvancedStudioStamp }>
  | Readonly<{ type: 'cancel' }>;

export function invalid(): never { throw Error('advanced-studio.invalid-or-stale-input'); }
export function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(); return value as Record<string, unknown>; }
/** Only unknown seam messages use this bounded JSON boundary. Do not traverse live service objects. */
export function json(input: unknown): JsonValue {
  let remaining = 100_000;
  function visit(value: unknown, depth: number): JsonValue {
    if (--remaining < 0 || depth > 48) return invalid();
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length || Object.entries(descriptors).some(([key, d]) => !('value' in d) || ['__proto__','prototype','constructor'].includes(key))) return invalid();
    if (Array.isArray(value)) { if (value.length > 10_000 || Object.keys(value).length !== value.length) return invalid(); return value.map(item => visit(item, depth+1)); }
    return Object.fromEntries(Object.entries(descriptors).map(([key,d]) => [key,visit(d.value,depth+1)]));
  }
  const result = visit(input, 0); if (new TextEncoder().encode(JSON.stringify(result)).length > 512*1024) return invalid(); return result;
}
export function exact(value: unknown, keys: readonly string[]): Record<string, unknown> { const v = record(value); if (Object.keys(v).length !== keys.length || keys.some(key => !Object.hasOwn(v,key))) return invalid(); return v; }
export function stamp(source: AdvancedStudioSource): AdvancedStudioStamp { if (!source.document || !source.epoch) return invalid(); return { epoch: source.epoch, documentId: source.document.id, baseRevision: source.document.revision, selectionRevision: source.selection.revision }; }
export function isAdvancedStudioCurrent(source: AdvancedStudioSource, expected: AdvancedStudioStamp): boolean { return source.epoch === expected.epoch && source.document?.id === expected.documentId && source.document.revision === expected.baseRevision && source.selection.revision === expected.selectionRevision; }
const reference = (document: NonNullable<AdvancedStudioSource['document']>, id: string) => ({ kind: 'scene-entity', id, documentId: document.id });
const definitionFor = (source: AdvancedStudioSource, type: string, version: string) => source.definitions.find(definition => definition.type === type && definition.version === version);
function tuple(value: JsonValue | undefined): JsonValue { const v = record(value); return [v.x,v.y,v.z] as JsonValue; }
export function transformValue(value: JsonObject): JsonObject { return { position: tuple(value.position), rotationDegrees: tuple(value.rotationDegrees), scale: tuple(value.scale) }; }
function field(id: string, value: JsonValue, schema: JsonValue | undefined, readOnly = false): JsonObject {
  const s = schema && typeof schema === 'object' && !Array.isArray(schema) ? schema as JsonObject : {};
  const options = Array.isArray(s.enum) ? s.enum.map(value => ({ label: String(value), value })) : undefined;
  const kind = options ? 'enum' : s.type === 'number' || s.type === 'integer' ? 'number' : s.type === 'boolean' ? 'boolean' : s.type === 'string' ? 'string' : 'json';
  return { id, label: id === '$value' ? '完整组件值（含可选字段）' : id, kind, value, readOnly, ...(options ? { options } : {}), ...(typeof s.minimum === 'number' ? { minimum: s.minimum } : {}), ...(typeof s.maximum === 'number' ? { maximum: s.maximum } : {}) };
}
/** Emit only the proposed Editor presentation protocol, whose validator remains its sole owner. */
export function projectAdvancedStudio(source: AdvancedStudioSource): unknown {
  const document = source.document, active = document?.entities.find(entity => entity.id === source.selection.active?.id && source.selection.active.documentId === document.id);
  const components = new Map(document?.components.map(component => [component.id, component]) ?? []);
  const selected = active?.componentIds.map(id => components.get(id)!).filter(Boolean) ?? [];
  const ownedObservation = document && source.observationEpoch === source.epoch && source.observationDocumentId === document.id ? source.observation : null;
  const current = ownedObservation && source.playId === ownedObservation.playId && document?.revision === ownedObservation.documentRevision;
  const runtimeFields = ownedObservation && source.observationValue ? Object.entries(source.observationValue).map(([key,value]) => field(key,value,undefined,true)) : [];
  return { schemaVersion: 1, binding: document ? { documentId: document.id, revision: document.revision, epoch: source.epoch } : null,
    hierarchy: document?.entities.map(entity => ({ reference: reference(document,entity.id), parentId: entity.parentId, order: entity.order, label: entity.name, editable: true })) ?? [],
    selection: source.selection, history: source.history,
    sections: selected.map(component => {
      const definition = definitionFor(source,component.type,component.version), properties = definition?.valueSchema.properties as JsonObject | undefined;
      return { id: component.id, title: definition?.editor.label ?? component.type, description: `${component.type}@${component.version}${definition ? '' : ' · 未注册版本，只读'}`, enabled: component.enabled, editable: Boolean(definition), removable: Boolean(definition),
        fields: [...Object.entries(component.value).map(([key,value]) => field(key,value,properties?.[key],!definition)), field('$value',component.value,undefined,!definition)] };
    }),
    additions: document ? source.definitions.map(definition => ({ id: `${definition.type}@${definition.version}`, label: `${definition.editor.label} (${definition.version})`, description: definition.editor.category, enabled: Boolean(active) && !selected.some(component => component.type === definition.type) })) : [],
    gizmo: { enabled: selected.some(component => component.type === 'haiyue.transform.3d' && component.enabled && definitionFor(source,component.type,component.version)), transforms: document?.entities.flatMap(entity => { const component = entity.componentIds.map(id => components.get(id)).find(component => component?.type === 'haiyue.transform.3d'); return component ? [{ id: entity.id, parentId: entity.parentId, value: transformValue(component.value) }] : []; }) ?? [], projection: source.projection },
    runtime: { status: ownedObservation ? current ? 'current' : 'historical' : source.playId ? 'unavailable' : 'stopped', instanceId: ownedObservation?.playId ?? source.playId, documentRevision: ownedObservation?.documentRevision ?? null, frame: ownedObservation?.frame ?? null, tick: ownedObservation?.tick ?? null, fields: runtimeFields, diagnostics: ownedObservation ? [] : ['尚无当前项目的运行时观测。'] },
    diagnostics: [], capabilities: { multiSelection: false, rename: true, reparent: true, addSection: true },
  };
}

/** Validated UI intent translation only; execution and policy stay with existing owners. */
export function adaptAdvancedStudioIntent(input: unknown, source: AdvancedStudioSource): AdvancedStudioIntent {
  const value = record(json(input));
  if (value.type === 'cancel') { exact(value,['type']); return { type:'cancel' }; }
  const current = stamp(source), binding = exact(value.binding,['documentId','revision','epoch']);
  if (binding.documentId !== current.documentId || binding.revision !== current.baseRevision || binding.epoch !== current.epoch) return invalid();
  const document = source.document!;
  const ref = (input: unknown): EditorSelectionReference => { const r = exact(input,['kind','id','documentId']); if (r.kind !== 'scene-entity' || r.documentId !== document.id || !document.entities.some(entity => entity.id === r.id)) return invalid(); return r as unknown as EditorSelectionReference; };
  const active = () => { if (!source.selection.active) return invalid(); return ref(source.selection.active); };
  const author = (toolId: Extract<AdvancedStudioIntent,{type:'author'}>['toolId'], args: JsonObject): AdvancedStudioIntent => ({ type:'author', stamp: current, toolId, arguments: { baseRevision: current.baseRevision, ...args } });
  switch (value.type) {
    case 'selection': { exact(value,['type','binding','references','active']); if (!Array.isArray(value.references) || value.references.length > 1) return invalid(); const r = value.references.length ? ref(value.references[0]) : null; if (r ? ref(value.active).id !== r.id : value.active !== null) return invalid(); return { type:'select', stamp:current, reference:r }; }
    case 'undo': case 'redo': case 'runtime.inspect': case 'focus-selection': exact(value,['type','binding']); if ((value.type === 'undo' && !source.history.canUndo) || (value.type === 'redo' && !source.history.canRedo) || source.history.busy) return invalid(); return { type:value.type, stamp:current };
    case 'rename': { exact(value,['type','binding','reference','name']); if (ref(value.reference).id !== active().id || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) return invalid(); return author('entity.rename',{entityId:active().id,name:value.name.trim()}); }
    case 'reparent': { exact(value,['type','binding','reference','parent','order']); const entity = ref(value.reference), parent = value.parent === null ? null : ref(value.parent); if (entity.id !== active().id || !Number.isSafeInteger(value.order) || Number(value.order) < 0 || Number(value.order) > 1_000_000) return invalid(); let cursor = parent?.id; const seen = new Set<string>(); while (cursor) { if (cursor === entity.id || seen.has(cursor)) return invalid(); seen.add(cursor); cursor = document.entities.find(item => item.id === cursor)?.parentId ?? undefined; } return author('entity.hierarchy',{action:'reparent',entityId:entity.id,parentId:parent?.id ?? null,order:Number(value.order)}); }
    case 'section.add': { exact(value,['type','binding','additionId']); const definition = source.definitions.find(definition => `${definition.type}@${definition.version}` === value.additionId); if (!definition) return invalid(); const entity = document.entities.find(entity => entity.id === active().id)!; if (entity.componentIds.some(id => document.components.find(c => c.id === id)?.type === definition.type)) return invalid(); return author('component.add',{entityId:entity.id,type:definition.type,version:definition.version}); }
    case 'field.edit': case 'section.toggle': case 'section.remove': {
      exact(value,value.type === 'field.edit' ? ['type','binding','sectionId','fieldId','value'] : value.type === 'section.toggle' ? ['type','binding','sectionId','enabled'] : ['type','binding','sectionId']);
      const entity = document.entities.find(entity => entity.id === active().id)!, component = document.components.find(component => component.id === value.sectionId && entity.componentIds.includes(component.id));
      if (!component || !definitionFor(source,component.type,component.version)) return invalid();
      if (value.type === 'section.remove') return author('component.remove',{componentId:component.id});
      if (value.type === 'section.toggle') { if (typeof value.enabled !== 'boolean') return invalid(); return author('component.set',{componentId:component.id,value:component.value,enabled:value.enabled}); }
      if (typeof value.fieldId !== 'string' || value.fieldId !== '$value' && !Object.hasOwn(component.value,value.fieldId)) return invalid();
      const next = value.fieldId === '$value' ? record(value.value) : { ...component.value, [value.fieldId]: value.value };
      return author('component.set',{componentId:component.id,value:next as JsonObject});
    }
    case 'transform': {
      exact(value,['type','binding','changes']); if (!Array.isArray(value.changes) || value.changes.length !== 1) return invalid();
      const change = exact(value.changes[0],['reference','before','after']); if (ref(change.reference).id !== active().id) return invalid();
      const entity = document.entities.find(entity => entity.id === active().id)!, component = document.components.find(component => entity.componentIds.includes(component.id) && component.type === 'haiyue.transform.3d'); if (!component || !definitionFor(source,component.type,component.version)) return invalid();
      const before = transformValue(component.value), after = exact(change.after,['position','rotationDegrees','scale']);
      const givenBefore = exact(change.before,['position','rotationDegrees','scale']);
      for (const key of ['position','rotationDegrees','scale']) if (JSON.stringify(givenBefore[key]) !== JSON.stringify(before[key])) return invalid();
      const vectors = Object.fromEntries(Object.entries(after).map(([key,value]) => { if (!Array.isArray(value) || value.length !== 3 || value.some(v => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1_000_000 || key === 'scale' && v < .000001)) return invalid(); return [key,{x:value[0],y:value[1],z:value[2]}]; }));
      return author('transform.batch',{action:'set',transforms:[{entityId:entity.id,transform:vectors}]});
    }
    default: return invalid();
  }
}
