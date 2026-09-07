import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { analyzeBehavior, BehaviorReadService, parseBehaviorContract } from '@haiyue/ai-studio-script-preview';
import { DeclarativePlayRuntime } from '../dist/declarative-play-components.js';

const fixtureRoot = new URL('../../../config/contracts/fixtures/', import.meta.url);
test('G03/G04 consume public private-package exports and the provider-neutral read port', async t => {
  const file = new URL('./virtual-behavior-consumer.ts', import.meta.url).pathname.replace(/^\/([A-Z]:)/u, '$1');
  const source = `import { BehaviorReadService } from '@haiyue/ai-studio-script-preview';
import type { BehaviorReadPort } from '@haiyue/ai-studio-agent-orchestration';
import type { BehaviorSourceBindingV1, BehaviorManifestV1, BehaviorExplanationV1, BehaviorTraceV1, ResourceCatalogEntryV1, EditorLocationV1 } from '@haiyue/ai-studio-contracts';
const port: BehaviorReadPort = new BehaviorReadService();
const values: [BehaviorSourceBindingV1?,BehaviorManifestV1?,BehaviorExplanationV1?,BehaviorTraceV1?,ResourceCatalogEntryV1?,EditorLocationV1?] = [];
void port; void values;`;
  const options = {module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022,strict:true,noEmit:true,skipLibCheck:true};
  const host=ts.createCompilerHost(options),read=host.readFile.bind(host),exists=host.fileExists.bind(host);
  host.readFile=path=>path.replaceAll('\\','/')===file?source:read(path);host.fileExists=path=>path.replaceAll('\\','/')===file||exists(path);
  const diagnostics=ts.getPreEmitDiagnostics(ts.createProgram([file],options,host));
  assert.deepEqual(diagnostics.map(item=>ts.flattenDiagnosticMessageText(item.messageText,' ')),[]);
  const service=new BehaviorReadService();t.after(()=>service.dispose());
  const corpus=JSON.parse(await readFile(new URL('m14-behavior-inputs.json',fixtureRoot),'utf8'));
  const manifest=await service.analyze(corpus.mixed);
  assert.ok(manifest.nodes.some(node=>node.source.kind==='script'));
  assert.ok(manifest.nodes.some(node=>node.source.kind==='declarative-component'));
  assert.ok(manifest.nodes.some(node=>node.source.kind==='runtime-adapter'));
});

test('all six envelopes and the input reject each checked-in invalid, unknown-version and secret-bearing fixture', async () => {
  for(const name of ['m14-behavior-contract-cases.json','m14-resource-contract-cases.json','m14-editor-location-contract-cases.json']){
    const cases=JSON.parse(await readFile(new URL(name,fixtureRoot),'utf8'));
    const kind=fixture=>fixture.schemaId.replace('haiyue://contracts/','').replace('/v1','');
    for(const fixture of cases.valid) assert.deepEqual(parseBehaviorContract(kind(fixture),fixture.value),fixture.value,fixture.name);
    for(const fixture of cases.invalid) assert.throws(()=>parseBehaviorContract(kind(fixture),fixture.value),fixture.name);
  }
});

test('checked-in pure script, declarative, physics/animation and mixed inputs reproduce valid manifests', async () => {
  const corpus=JSON.parse(await readFile(new URL('m14-behavior-inputs.json',fixtureRoot),'utf8'));
  assert.deepEqual(Object.keys(corpus),['pureScript','declarative','adapters','mixed']);
  for(const input of Object.values(corpus)){
    const a=analyzeBehavior(input),b=analyzeBehavior(JSON.parse(JSON.stringify(input)));
    assert.deepEqual(a,b); assert.ok(a.nodes.length);assert.equal(a.truncation.truncated,false);
  }
});

test('declarative field relationships agree with the existing real headless Play adapter', async () => {
  const {declarative:input}=JSON.parse(await readFile(new URL('m14-behavior-inputs.json',fixtureRoot),'utf8'));
  const components=input.document.components.filter(component=>component.type.startsWith('haiyue.gameplay.'));
  const runtime=new DeclarativePlayRuntime([{id:'entity:main',components}]);
  const graph=analyzeBehavior(input);
  assert.ok(graph.nodes.some(node=>node.label==='add-score'));
  // The adapter receives an actual timer boundary; this is independent evidence for the extracted rule relation.
  const snapshot=runtime.advance(10,{pressedActions:[],heldActions:[],physicsEvents:[]});
  assert.equal(snapshot.observations.find(item=>item.id==='game-state').value.score,1);
});
