import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { ComponentRegistry } from '@haiyue/ai-studio-editor-plugins/components';
import { BehaviorReadService, DEFAULT_BEHAVIOR_CONFIG, instrumentBehaviorScripts, createBehaviorRuntimePlan } from '@haiyue/ai-studio-script-preview';
import { projectLogicGraph } from '@haiyue/ai-studio-shell';
import { digest } from '../../../packages/script-preview/test/behavior-fixtures.mjs';

const corpus = JSON.parse(await readFile(new URL('./logic-m12-fixtures.json', import.meta.url), 'utf8'));
const registry = new ComponentRegistry().snapshot();
for (const fixture of corpus.cases) test(`preserved M12 ${fixture.genre}: main gameplay structure, source ranges and executable observation plan`, async t => {
  const reader = new BehaviorReadService(); t.after(() => reader.dispose());
  const input = { schemaVersion: 1, projectId: fixture.projectId, document: fixture.document, registry: { version: '0.0.0', definitions: registry.definitions },
    adapters: [...new Set(registry.definitions.map(d => d.runtimeAdapter).filter(Boolean))].map(id => ({ id, version: '0.0.0', digest: digest({ fixtureAdapter: id }) })), config: DEFAULT_BEHAVIOR_CONFIG };
  const before = JSON.stringify(input), manifest = await reader.analyze(input);
  assert.equal(manifest.truncation.truncated, false, JSON.stringify(manifest.truncation));
  const script = fixture.document.scripts.find(s => s.enabled);
  assert.ok(script && script.source.length > 2000, 'preserved gameplay source, not a probe or name-only fixture');
  const graph = projectLogicGraph({ manifest, documentId: manifest.binding.documentId, documentRevision: manifest.binding.documentRevision, entityId: script.entityId });
  assert.ok(graph.groups.length && graph.total > 20);
  for (const node of manifest.nodes.filter(n => n.source.kind === 'script')) {
    const request = { schemaVersion: 1, manifestDigest: manifest.digest, sourceBindingDigest: manifest.binding.digest, nodeId: node.id };
    const location = reader.locate(request); assert.equal(reader.resolveLocation(location).status, 'current');
    assert.ok(location.target.source.range.end <= script.source.length);
  }
  const programs = instrumentBehaviorScripts(input, manifest);
  const plan = createBehaviorRuntimePlan(input, manifest, { playId: `play:${fixture.genre}`, generation: 1, scripts: programs.map(p => ({ scriptId: p.scriptId, emittedText: p.originalEmittedText })) });
  assert.ok(plan.programs[0].instrumentedNodeIds.length > 10);
  assert.equal(JSON.stringify(input), before);
  console.log(JSON.stringify({ genre: fixture.genre, source: fixture.provenance.sha256, nodes: manifest.nodes.length, edges: manifest.edges.length, instrumented: plan.programs[0].instrumentedNodeIds.length, mainSource: script.sourcePath }));
});
