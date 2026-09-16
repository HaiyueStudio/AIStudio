/** Host-generated scheduling hints. Never accepted from model arguments or tool search results. */
export type ToolConcurrencyHintV1 =
  | Readonly<{ schemaVersion: 1; mode: 'exclusive' | 'parallel-read' }>
  | Readonly<{ schemaVersion: 1; mode: 'invoke'; targets: readonly Readonly<{ toolId: string; toolVersion: string }>[] }>;

/** Unknown versions, extra authority fields and unbounded payloads fail closed. */
export function isToolConcurrencyHintV1(value: unknown): value is ToolConcurrencyHintV1 {
  if (!record(value) || value.schemaVersion !== 1) return false;
  if (value.mode === 'exclusive' || value.mode === 'parallel-read') return Object.keys(value).length === 2;
  if (value.mode !== 'invoke' || Object.keys(value).length !== 3 || !Array.isArray(value.targets) || value.targets.length > 128) return false;
  const seen = new Set<string>();
  return value.targets.every(target => {
    if (!record(target) || Object.keys(target).length !== 2 || typeof target.toolId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(target.toolId) || target.toolId === 'studio.tool.invoke'
      || typeof target.toolVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(target.toolVersion) || target.toolVersion.length > 32
      || seen.has(target.toolId)) return false;
    seen.add(target.toolId); return true;
  });
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
