import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { BUILTIN_COMPONENT_DEFINITIONS } from '@haiyue/ai-studio-editor-plugins';
import { GAME_AUTHORING_TOOL_DEFINITIONS, ToolCatalogRuntime } from '@haiyue/ai-studio-game-authoring-tools';

export async function readG10Corpus(url = new URL('../suites/m13-g10-seven-game-retrieval.json', import.meta.url)) {
  const value = JSON.parse(await readFile(url, 'utf8'));
  if (value?.schemaVersion !== 1 || !Array.isArray(value.cases) || value.cases.length !== 7) throw new TypeError('G10 retrieval corpus must contain exactly seven cases.');
  return value;
}

export async function evaluateG10Retrieval({ corpus, knowledge }) {
  const catalog = new ToolCatalogRuntime(GAME_AUTHORING_TOOL_DEFINITIONS, () => BUILTIN_COMPONENT_DEFINITIONS);
  const fixedIds = new Set(GAME_AUTHORING_TOOL_DEFINITIONS.map((tool) => tool.id));
  const rows = [];
  for (const fixture of corpus.cases) {
    const exactStarted = performance.now();
    const exactKnowledge = await knowledge.search({ query: fixture.request, mode: 'exact-only', allowedPermissionScopes: ['knowledge:engine-local'], limit: 8, tokenBudget: 2048 });
    const exactLatencyMs = performance.now() - exactStarted;
    const hybridStarted = performance.now();
    const selected = catalog.selectDefinitions(fixture.request);
    const hybridKnowledge = await knowledge.search({ query: fixture.request, mode: 'hybrid', allowedPermissionScopes: ['knowledge:engine-local'], limit: 8, tokenBudget: 2048 });
    const hybridLatencyMs = performance.now() - hybridStarted;
    const selectedIds = new Set(selected.selectedIds);
    const expectedSources = fixture.expectedKnowledge.map((id) => `engine://guide/${id}@0.1.0`);
    const exactSources = new Set(exactKnowledge.hits.map((hit) => hit.hit.source));
    const hybridSources = new Set(hybridKnowledge.hits.map((hit) => hit.hit.source));
    const exactToolSuccess = fixture.expectedToolIds.every((id) => fixedIds.has(id));
    const hybridToolSuccess = fixture.expectedToolIds.every((id) => selectedIds.has(id));
    const grounded = hybridKnowledge.hits.every((hit) => hit.citation.source === hit.hit.source && hit.citation.contentDigest === hit.hit.contentDigest && hit.hit.stale === false);
    rows.push(Object.freeze({
      id: fixture.id, exactToolSuccess, hybridToolSuccess,
      exactRecallAt8: recall(expectedSources, exactSources), hybridRecallAt8: recall(expectedSources, hybridSources), grounded,
      fixedSchemaBytes: selected.fixedSchemaBytes, selectedSchemaBytes: selected.selectedSchemaBytes,
      exactKnowledgeTokens: exactKnowledge.estimatedTokens, hybridKnowledgeTokens: hybridKnowledge.estimatedTokens,
      exactInputTokens: Math.ceil(selected.fixedSchemaBytes / 4) + exactKnowledge.estimatedTokens,
      hybridInputTokens: Math.ceil(selected.selectedSchemaBytes / 4) + hybridKnowledge.estimatedTokens,
      exactLatencyMs: round(exactLatencyMs), hybridLatencyMs: round(hybridLatencyMs),
      selectedIds: selected.selectedIds, hybridSources: hybridKnowledge.hits.map((hit) => hit.hit.source),
    }));
  }
  const summary = Object.freeze({
    cases: rows.length,
    exactToolSuccessRate: mean(rows.map((row) => Number(row.exactToolSuccess))),
    hybridToolSuccessRate: mean(rows.map((row) => Number(row.hybridToolSuccess))),
    exactRecallAt8: mean(rows.map((row) => row.exactRecallAt8)),
    hybridRecallAt8: mean(rows.map((row) => row.hybridRecallAt8)),
    groundedCitationRate: mean(rows.map((row) => Number(row.grounded))),
    schemaByteReduction: 1 - sum(rows, 'selectedSchemaBytes') / sum(rows, 'fixedSchemaBytes'),
    inputTokenReduction: 1 - sum(rows, 'hybridInputTokens') / sum(rows, 'exactInputTokens'),
    exactLatencyMs: round(sum(rows, 'exactLatencyMs')),
    hybridLatencyMs: round(sum(rows, 'hybridLatencyMs')),
  });
  const defaultEnabled = summary.hybridToolSuccessRate >= summary.exactToolSuccessRate
    && summary.hybridRecallAt8 >= summary.exactRecallAt8
    && summary.groundedCitationRate === 1
    && summary.schemaByteReduction >= 0.25
    && summary.inputTokenReduction >= 0.20;
  return Object.freeze({ schemaVersion: 1, corpusId: corpus.id, generatedAt: new Date().toISOString(), defaultEnabled, summary, cases: Object.freeze(rows) });
}

function recall(expected, actual) { return expected.length ? expected.filter((value) => actual.has(value)).length / expected.length : 1; }
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function sum(rows, key) { return rows.reduce((total, row) => total + row[key], 0); }
function round(value) { return Math.round(value * 1000) / 1000; }
