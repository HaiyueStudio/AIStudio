import { createHash } from 'node:crypto';
import { ComponentRegistry } from '@haiyue/ai-studio-editor-plugins/components';
import { DEFAULT_BEHAVIOR_CONFIG } from '../dist/behavior/index.js';

export const hashText = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
export const digest = value => hashText(canonical(value));
export const seal = value => ({ ...value, digest: digest(value) });
export const clone = value => JSON.parse(JSON.stringify(value));
export const controlScript = `async function run() {
  first(); second();
  if (api.input.isDown('ArrowDown')) yes(); else no();
  for (let i = 0; i < 3; i++) { if (stop()) break; step(); }
  await Promise.all([loadA(), loadB()]);
  try { await risky(); throw new Error('fixture'); } catch (error) { recover(); } finally { cleanup(); }
  unknown[method]();
  return;
  unreachable();
}`;
export function makeInput({ script = '', types = [], projectId = 'project:test' } = {}) {
  const registry = new ComponentRegistry();
  const definitions = registry.snapshot().definitions.filter(definition => types.includes(definition.type));
  const components = definitions.map((definition, index) => registry.create({ id: `component:${index}`, type: definition.type, version: definition.version }));
  const adapters = [...new Set(definitions.map(definition => definition.runtimeAdapter).filter(Boolean))].map(id => ({ id, version: '1.0.0', digest: digest({ registeredFixtureAdapter: id }) }));
  const document = { schemaVersion: 2, id: 'document:test', revision: 1, savedRevision: 0,
    scenes: [{ id: 'scene:main', name: 'Main', rootEntityIds: ['entity:main'] }],
    entities: [{ id: 'entity:main', sceneId: 'scene:main', name: 'Main', parentId: null, order: 0, componentIds: components.map(component => component.id) }],
    components, scripts: script ? [{ id: 'script:main', entityId: 'entity:main', name: 'Main', sourcePath: 'scripts/main.ts', source: script, textRevision: 1, enabled: true, order: 0, capabilities: ['read', 'input', 'debug'], digest: hashText(script) }] : [],
    assets: [], settings: {}, migration: { fromVersion: null, migratedAt: null, sourceDigest: null } };
  return clone({ schemaVersion: 1, projectId, document, registry: { version: '1.0.0', definitions }, adapters, config: DEFAULT_BEHAVIOR_CONFIG });
}
export function declarativeInput(script = '') {
  const input = makeInput({ script, types: ['haiyue.gameplay.state', 'haiyue.gameplay.timers', 'haiyue.gameplay.rules', 'haiyue.physics.world.3d', 'haiyue.physics.rigidbody.3d', 'haiyue.animation.transform-clips'] });
  const state = input.document.components.find(component => component.type === 'haiyue.gameplay.state');
  const timers = input.document.components.find(component => component.type === 'haiyue.gameplay.timers');
  const rules = input.document.components.find(component => component.type === 'haiyue.gameplay.rules');
  state.value.observationId = 'game-state';
  timers.value.timers = [{ id: 'clock', durationTicks: 10, startDelayTicks: 0, repeat: true, running: true, event: 'elapsed' }];
  const action = { kind: 'add-score', targetObservationId: 'game-state', key: '', numberValue: 1, textValue: '', booleanValue: false };
  rules.value.rules = [
    { id: 'timer-rule', once: false, when: { source: 'timer-event', value: 'elapsed', entityAId: '', entityBId: '', phase: 'enter' }, actions: [action, {...action, kind: 'add-health'}] },
    { id: 'input-rule', once: false, when: { source: 'input-pressed', value: 'jump', entityAId: '', entityBId: '', phase: 'enter' }, actions: [action] },
    { id: 'collision-rule', once: false, when: { source: 'collision', value: 'contact', entityAId: 'entity:main', entityBId: '', phase: 'enter' }, actions: [action] },
  ];
  return input;
}
export function query(manifest, extra = {}) { return { schemaVersion: 1, manifestDigest: manifest.digest, sourceBindingDigest: manifest.binding.digest, ...extra }; }

export const resourceExamples = ['asset','template','preset','instance'].map((kind,i) => ({
  schemaVersion:1,catalogEntryId:`catalog:${kind}`,kind,category:'Lighting',label:`Fixture ${kind}`,status:kind==='preset'?'unavailable':'available',artifactId:null,
  source:['controlled-manifest','registry','unsupported','document'][i],
  ref:[{kind:'asset',assetId:'asset:light',digest:digest('asset'),source:'project'},{kind:'template',templateId:'template:light',registryVersion:'1.0.0',defaultsDigest:digest({})},{kind:'preset',presetId:'preset:light',schemaId:'haiyue.light.point',schemaVersion:'1.0.0',valueDigest:digest({})},{kind:'instance',projectId:'project:test',entityId:'entity:main',documentRevision:1,componentId:null}][i],
  dependencies:{status:'unknown',reason:'Not yet analyzed'},usage:kind==='instance'?{status:'inapplicable',reason:'Scene instance'}:{status:'unknown',reason:'No complete usage provenance'},
  intents:[['asset.inspect','asset.assign'],['template.create'],[],['instance.inspect']][i],unused:kind==='asset'?'unknown':'inapplicable',
}));
export const traceEvent = node => ({sequence:0,entityId:node.source.entityId,componentId:node.source.kind==='script'?null:node.source.componentId,scriptId:node.source.kind==='script'?node.source.scriptId:null,nodeId:node.id,kind:'node-enter',event:null,tick:1,frame:1,durationMicros:null,stateDiff:null,error:null});
export const observationFor = (trace,manifest) => ({schemaVersion:2,id:'observation:trace',type:'event-trace',digest:digest(trace),taskId:'task:test',turnId:'turn:test',playId:trace.playId,documentRevision:manifest.binding.documentRevision,scriptDigests:[...new Set(manifest.binding.scripts.filter(script=>script.enabled).map(script=>script.digest))],tick:1,frame:1,viewport:null,device:null,capturedAt:'2026-09-07T00:00:00Z',byteLength:Buffer.byteLength(canonical(trace)),redacted:false,producerVersion:'1.0.0'});
