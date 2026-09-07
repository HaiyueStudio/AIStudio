import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeBehavior, createBehaviorSourceBinding, parseBehaviorContract } from '../dist/behavior/index.js';
import { clone, controlScript, declarativeInput, digest, hashText, makeInput, seal } from './behavior-fixtures.mjs';

test('script control flow preserves branches, loops, awaiting, explicit aggregate lanes and dynamic gaps', () => {
  const manifest = analyzeBehavior(makeInput({ script: controlScript }));
  const kinds = new Set(manifest.nodes.map(node => node.kind));
  for (const kind of ['entry', 'condition', 'loop', 'await', 'fork', 'join', 'try', 'catch', 'return']) assert.ok(kinds.has(kind), kind);
  for (const kind of ['sequence', 'true', 'false', 'loop-body', 'loop-back', 'await', 'concurrent', 'join', 'exception', 'finally']) assert.ok(manifest.edges.some(edge => edge.kind === kind), kind);
  assert.ok(manifest.nodes.some(node => node.unknown === 'dynamic-call'));
  assert.ok(manifest.nodes.every(node => node.source.kind === 'script'));
  assert.equal(manifest.truncation.truncated, false);
  assert.equal(JSON.stringify(manifest).includes('ArrowDown'), false, 'source literals do not leak into labels');
});

test('serial calls do not become concurrent and return/throw do not fall through', () => {
  const manifest = analyzeBehavior(makeInput({ script: 'function run() { first(); second(); return; third(); }' }));
  const calls = manifest.nodes.filter(node => node.kind === 'call');
  assert.equal(calls.length, 3);
  assert.ok(manifest.edges.some(edge => edge.from === calls[0].id && edge.to === calls[1].id && edge.kind === 'sequence'));
  assert.equal(manifest.edges.some(edge => edge.to === calls[2].id), false);
  assert.equal(manifest.edges.some(edge => edge.kind === 'concurrent'), false);
  const thrown = analyzeBehavior(makeInput({ script: 'throw failure; next();' }));
  assert.equal(thrown.edges.some(edge => edge.to === thrown.nodes.find(node => node.kind === 'call').id), false);
});

test('Promise shadowing disables intrinsic concurrency recognition', () => {
  for (const script of ['async function f(Promise) { await Promise.all([a(), b()]); }', 'Promise.all = fake; Promise.all([a(), b()]);', 'const { Promise } = other; Promise.all([a(), b()]);', "import { Promise } from 'other'; Promise.all([a(), b()]);"]) {
    const manifest = analyzeBehavior(makeInput({ script }));
    assert.equal(manifest.nodes.some(node => node.kind === 'fork'), false);
  }
});

test('finally preserves return and normal completion paths without false fall-through', () => {
  const source = 'function run(flag) { try { if (flag) return; work(); } finally { cleanup(); } next(); }';
  const manifest = analyzeBehavior(makeInput({script:source}));
  const returned = manifest.nodes.find(node=>node.kind==='return');
  const next = manifest.nodes.find(node=>node.kind==='call' && source.slice(node.source.range.start,node.source.range.end)==='next()');
  const reachable = new Set([returned.id]);
  for(let changed=true;changed;){changed=false;for(const edge of manifest.edges)if(reachable.has(edge.from)&&!reachable.has(edge.to)){reachable.add(edge.to);changed=true;}}
  assert.equal(reachable.has(next.id),false);
  const emptyCatch=analyzeBehavior(makeInput({script:'try { throw failure; } catch (error) {} next();'}));
  assert.ok(emptyCatch.edges.some(edge=>edge.to===emptyCatch.nodes.find(node=>node.kind==='call').id));
});

test('pointer/custom callbacks preserve source entries and cross-entity declarative targets', () => {
  const input=declarativeInput("api.events.on('custom', () => { api.input.pointerEvents(); });");
  const state=input.document.components.find(component=>component.type==='haiyue.gameplay.state');
  input.document.entities[0].componentIds=input.document.entities[0].componentIds.filter(id=>id!==state.id);
  input.document.entities.push({id:'entity:target',sceneId:'scene:main',name:'Target',parentId:null,order:1,componentIds:[state.id]});
  input.document.scenes[0].rootEntityIds.push('entity:target');
  const manifest=analyzeBehavior(input);
  assert.ok(manifest.nodes.some(node=>node.label==='function-entry'));
  const target=manifest.nodes.find(node=>node.source.kind==='declarative-component'&&node.source.entityId==='entity:target'&&node.source.field==='/score');
  assert.ok(target);assert.ok(manifest.edges.some(edge=>edge.kind==='drives'&&edge.to===target.id));
});

test('declarative timers and rules retain component fields without script generation', () => {
  const input = declarativeInput(), before = JSON.stringify(input);
  const manifest = analyzeBehavior(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(manifest.binding.scripts.length, 0);
  assert.ok(manifest.nodes.some(node => node.label === 'input-pressed'));
  assert.ok(manifest.nodes.some(node => node.label === 'collision'));
  const timer = manifest.nodes.find(node => node.label === 'timer-event' && node.source.field.startsWith('/timers/'));
  const rule = manifest.nodes.find(node => node.label === 'timer-event' && node.source.field.startsWith('/rules/'));
  assert.ok(manifest.edges.some(edge => edge.from === timer.id && edge.to === rule.id && edge.kind === 'trigger'));
  assert.ok(manifest.nodes.some(node => node.source.kind === 'runtime-adapter' && node.source.adapter.id === 'adapter.animation.3d-mixer'));
  assert.ok(manifest.nodes.some(node => node.source.kind === 'runtime-adapter' && node.source.adapter.id === 'adapter.physics.world-3d'));
  assert.ok(manifest.nodes.some(node => node.label === 'contact-occurrence' && node.unknown === 'adapter-internals'));
});

test('disabled components and missing/changed adapter semantics stay honest', () => {
  const input = declarativeInput();
  input.document.components.find(component => component.type === 'haiyue.gameplay.timers').enabled = false;
  input.adapters = [];
  const manifest = analyzeBehavior(input);
  assert.equal(manifest.nodes.some(node => node.source.kind === 'runtime-adapter'), false);
  assert.ok(manifest.nodes.some(node => node.unknown === 'unregistered-adapter'));
  assert.ok(manifest.nodes.some(node => node.label === 'timer-source' && node.unknown === 'unresolved-reference'));
});

test('canonical full input is deterministic; components, dependencies, registry, adapter and config invalidate it', () => {
  const input = declarativeInput(controlScript), original = analyzeBehavior(input);
  assert.deepEqual(analyzeBehavior(clone(input)), original);
  const reordered = clone(input);
  reordered.document.components.reverse(); reordered.registry.definitions.reverse(); reordered.adapters.reverse();
  assert.deepEqual(analyzeBehavior(reordered), original);
  const variants = [
    value => { value.document.components[0].enabled = !value.document.components[0].enabled; },
    value => { value.document.components.find(component => component.type === 'haiyue.gameplay.state').value.score += 1; },
    value => { value.adapters[0].version = '2.0.0'; },
    value => { value.adapters[0].digest = digest('new-adapter'); },
    value => { value.registry.version = '2.0.0'; },
    value => { value.document.settings.dependencies = ['asset:other']; },
    value => { value.projectId = 'project:copy'; },
  ];
  for (const mutate of variants) { const value = clone(input); mutate(value); assert.notEqual(analyzeBehavior(value).digest, original.digest); }
  const config = clone(input); config.config.maxNodes--;
  assert.notEqual(analyzeBehavior(config).digest, original.digest);
  assert.equal(analyzeBehavior(config).binding.digest, original.binding.digest);
  const migrated = clone(input); migrated.document.savedRevision = 1; migrated.document.migration.migratedAt = '2026-09-07T01:00:00Z';
  assert.equal(analyzeBehavior(migrated).digest, original.digest, 'nonstructural persistence timestamps are excluded');
  const { digest: _old, ...content } = original;
  assert.notEqual(seal({ ...content, analyzerVersion: '2.0.0' }).digest, original.digest);
});

test('source ranges refer to original UTF-16 text including CRLF and Unicode', () => {
  const source = '// 中文 😀\r\nfunction f() {\r\n  first();\r\n}\r\n';
  const manifest = analyzeBehavior(makeInput({ script: source }));
  const call = manifest.nodes.find(node => node.kind === 'call');
  assert.equal(source.slice(call.source.range.start, call.source.range.end), 'first()');
  assert.equal(call.source.range.startLine, 3); assert.equal(call.source.range.startColumn, 3);
  const bad = clone(makeInput({ script: source })); bad.document.scripts[0].digest = digest('wrong');
  assert.throws(() => analyzeBehavior(bad), /script-digest/);
});

test('AST and output budgets yield explicit truncation with no dangling edges', () => {
  const input = makeInput({ script: 'first();'.repeat(200) }); input.config.maxAstNodes = 50;
  const ast = analyzeBehavior(input);
  assert.ok(ast.truncation.reasons.includes('ast')); assert.ok(ast.nodes.some(node => node.unknown === 'budget'));
  input.config.maxAstNodes = 100000; input.config.maxNodes = 10; input.config.maxEdges = 3;
  const output = analyzeBehavior(input), ids = new Set(output.nodes.map(node => node.id));
  assert.ok(output.truncation.truncated); assert.ok(output.nodes.length <= 10); assert.ok(output.edges.length <= 3);
  assert.ok(output.edges.every(edge => ids.has(edge.from) && ids.has(edge.to)));
  const syntax = analyzeBehavior(makeInput({ script: 'if (' })); assert.ok(syntax.nodes.some(node => node.unknown === 'syntax-error'));
});

test('input rejects unknown versions, secrets, accessors, live objects and malformed authority', () => {
  const input = makeInput(); input.schemaVersion = 2; assert.throws(() => analyzeBehavior(input), /invalid/);
  const secret = makeInput(); secret.document.settings.apiKey = 'redacted-fixture'; assert.throws(() => analyzeBehavior(secret), /secret/);
  const oauth = makeInput(); oauth.document.settings.oauthToken = 'redacted-fixture'; assert.throws(() => analyzeBehavior(oauth), /secret/);
  const credentialPath = makeInput(); credentialPath.document.settings.note = 'C:/fixture/.codex/auth.json'; assert.throws(() => analyzeBehavior(credentialPath), /secret/);
  let invoked = false; const getter = makeInput(); Object.defineProperty(getter.document.settings, 'x', { enumerable: true, get() { invoked = true; return 1; } });
  assert.throws(() => analyzeBehavior(getter), /accessor/); assert.equal(invoked, false);
  const live = makeInput(); live.document.settings.live = new Date(); assert.throws(() => analyzeBehavior(live), /non-json/);
  const missing = makeInput(); missing.document.entities[0].componentIds = ['component:missing']; assert.throws(() => analyzeBehavior(missing));
  const path = makeInput({ script: 'first();' }); path.document.scripts[0].sourcePath = '../private.ts'; assert.throws(() => createBehaviorSourceBinding(path), /source-path/);
});
