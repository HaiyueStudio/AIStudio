import type { JsonObject } from '@haiyue/ai-studio-contracts';

/** User preferences are soft per-query thresholds, distinct from bounded transport pages. */
export const QUERY_LIMIT_DEFAULTS = Object.freeze({ 'engine.docs.search': 12, 'tool.search': 50, 'scene.query': 100, 'scene.diff': 100 });
export type QueryLimitTool = keyof typeof QUERY_LIMIT_DEFAULTS;
export type QueryLimits = Readonly<Record<QueryLimitTool, number>>;
export const QUERY_PAGE_SIZE = 1_000;
export function parseQueryLimits(value: unknown): QueryLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('查询额度必须是对象。');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== Object.keys(QUERY_LIMIT_DEFAULTS).length || Object.keys(v).some(key => !Object.hasOwn(QUERY_LIMIT_DEFAULTS, key))) throw new TypeError('查询额度包含未知或缺失的工具。');
  for (const count of Object.values(v)) if (!Number.isSafeInteger(count) || (count as number) < 1) throw new TypeError('查询额度必须是正整数。');
  return Object.freeze({ ...v }) as QueryLimits;
}
export function queryLimitRequest(toolId: string, args: JsonObject, limits: QueryLimits = QUERY_LIMIT_DEFAULTS) {
  if (!Object.hasOwn(QUERY_LIMIT_DEFAULTS, toolId)) return null;
  const tool = toolId as QueryLimitTool;
  const requested = args.limit === undefined ? limits[tool] : args.limit;
  if (!Number.isSafeInteger(requested) || (requested as number) < 1) return null; // Target validator reports malformed values.
  return Object.freeze({ toolId: tool, requested: requested as number, limit: limits[tool] });
}
