export interface ToolPreferencesValue { web: boolean; browser: boolean; node: boolean; browserBackend: 'playwright' | 'chrome-devtools'; }
export function parseToolPreferences(value: unknown): ToolPreferencesValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid tool preferences.');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'browser,browserBackend,node,web' || ['web','browser','node'].some(k => typeof v[k] !== 'boolean') || !['playwright','chrome-devtools'].includes(String(v.browserBackend))) throw new TypeError('Invalid tool preferences.');
  return Object.freeze({ web: v.web as boolean, browser: v.browser as boolean, node: v.node as boolean, browserBackend: v.browserBackend as ToolPreferencesValue['browserBackend'] });
}
