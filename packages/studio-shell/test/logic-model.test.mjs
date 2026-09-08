import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeBehavior } from '@haiyue/ai-studio-script-preview';
import { projectLogicGraph, layoutLogicGraph } from '../dist/panels/logic/index.js';
import { declarativeInput, controlScript } from '../../script-preview/test/behavior-fixtures.mjs';

const manifest = analyzeBehavior(declarativeInput(controlScript));
const data = { documentId: manifest.binding.documentId, documentRevision: manifest.binding.documentRevision, entityId: 'entity:main', manifest, historicalStructure: false, trace: null };
test('logic graph keeps explicit relations, filtering, bounds, unknown sources and historical overlays separate', () => {
  const graph = projectLogicGraph(data);
  assert.ok(graph.nodes.some(n => n.unknown)); assert.ok(graph.edges.some(e => e.kind === 'concurrent'));
  assert.deepEqual(graph.edges, manifest.edges.filter(e => graph.nodes.some(n => n.id === e.from) && graph.nodes.some(n => n.id === e.to)));
  const placed = layoutLogicGraph(graph.nodes, graph.edges); assert.equal(placed.length, graph.nodes.length); assert.ok(placed.every(p => Number.isFinite(p.x + p.y)));
  assert.equal(projectLogicGraph(data, { search: 'not-an-existing-source' }).total, 0);
  assert.equal(projectLogicGraph(data, { limit: 2 }).nodes.length, 2);
  assert.deepEqual(projectLogicGraph(data, { limit: 2, offset: 2 }).nodes, graph.nodes.slice(2, 4));
  const trigger = graph.groups.find(n => n.source.kind === 'declarative-component');
  assert.ok(projectLogicGraph(data, { group: trigger.id }).nodes.some(n => n.id === trigger.id));
  const trace = { trace: { manifestDigest: manifest.digest, sourceBindingDigest: manifest.binding.digest } };
  assert.equal(projectLogicGraph({ ...data, trace }).overlay, true);
  assert.equal(projectLogicGraph({ ...data, trace: { trace: { ...trace.trace, manifestDigest: 'other' } } }).overlay, false);
  assert.equal(projectLogicGraph({ ...data, documentRevision: data.documentRevision + 1 }).current, false);
  assert.equal(projectLogicGraph({ ...data, historicalStructure: true }).current, false);
});

test('cross-entity rule targets are shown only through actual source-backed edges', () => {
  const input = declarativeInput();
  const state = input.document.components.find(c => c.type === 'haiyue.gameplay.state');
  input.document.entities[0].componentIds = input.document.entities[0].componentIds.filter(id => id !== state.id);
  input.document.entities.push({ id: 'entity:score', sceneId: 'scene:main', name: 'Score', parentId: null, order: 1, componentIds: [state.id] });
  input.document.scenes[0].rootEntityIds.push('entity:score');
  const other = analyzeBehavior(input), graph = projectLogicGraph({ ...data, manifest: other }, { limit: 200 });
  assert.ok(graph.nodes.some(n => n.source.entityId === 'entity:score'));
  assert.ok(graph.edges.some(e => other.nodes.find(n => n.id === e.to)?.source.entityId === 'entity:score'));
  assert.equal(projectLogicGraph({ ...data, manifest: other, entityId: 'entity:absent' }).total, 0);
});
