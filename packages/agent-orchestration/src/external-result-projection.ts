import type { JsonObject, JsonValue } from '@haiyue/ai-studio-contracts';
import { canonicalStringify, sha256 } from '@haiyue/ai-studio-operation-log';
import { isRecord } from './value-utils.js';

interface DeliveredRead { toolId: string; callId: string; value: JsonObject; }
/** Lossless reductions only. Host persists the original before publishing this projection. */
export function compactExternalResult(result: JsonObject, toolId: string, delivered: readonly DeliveredRead[] = []): JsonObject {
  if (result.status !== 'completed' || !isRecord(result.value)) return result;
  const value = result.value as JsonObject;
  if (toolId === 'official.web.fetch' || toolId === 'official.web.search') {
    const identity = (v: JsonObject) => { const { cached: _cached, ...content } = v; return canonicalStringify(content); };
    const serialized = identity(value);
    const prior = delivered.find(item => item.toolId === toolId && identity(item.value) === serialized);
    if (prior) {
      const { content: _content, sources: _sources, ...metadata } = value;
      return { ...result, value: { ...metadata, projection: 'same-batch-reference', duplicateOf: { toolCallId: prior.callId, digest: `sha256:${sha256(serialized)}` }, instruction: 'Reuse the identical content/sources from this earlier successful result in the same batch. Other metadata here remains authoritative.' } };
    }
  }
  // Exact adjacent repetitions are encoded with counts; distinct snippets, refs and diagnostics survive.
  const field = toolId === 'official.web.search' ? 'sources' : toolId === 'official.code.run' ? 'logs' : toolId.startsWith('official.browser.') ? 'content' : null;
  if (!field || !Array.isArray(value[field])) return result;
  const rows = value[field] as JsonValue[];
  const runs: { value: JsonValue; count: number }[] = [];
  let previous = '';
  for (const row of rows) {
    const encoded = canonicalStringify(row);
    if (runs.length && encoded === previous) runs[runs.length - 1]!.count += 1;
    else { runs.push({ value: row, count: 1 }); previous = encoded; }
  }
  if (runs.length === rows.length) return result;
  const { [field]: _original, ...retained } = value;
  return { ...result, value: { ...retained, [field]: runs.map(run => run.value), repetitionEncoding: { field, counts: runs.map(run => run.count), instruction: 'Lossless consecutive repetition counts, aligned with the array entries. Expand each entry count times to reconstruct the original.' } } };
}
