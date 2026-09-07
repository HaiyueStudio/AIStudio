import type { WorkspacePreferenceStorage } from './ports.js';

export const WORKSPACE_PREFERENCE_KEY = 'haiyue.ai-studio.workspace.v1';
export function workspaceSplitPreferenceKey(mode: 'intent' | 'classic', key: string): string {
  return `${mode === 'intent' ? 'haiyue.ai-studio.split.intent.v1.' : 'haiyue.ai-studio.split.v2.'}${key}`;
}
export const WORKSPACE_CATEGORIES = ['all', 'geometry', 'lights', 'materials', 'textures', 'models', 'scripts', 'scene', 'other'] as const;
export type WorkspaceCategory = typeof WORKSPACE_CATEGORIES[number];
export interface WorkspacePreferences {
  readonly schemaVersion: 1;
  readonly mode: 'intent' | 'classic';
  readonly tab: 'logic' | 'resources';
  readonly category: WorkspaceCategory;
  readonly advancedTab: 'inspect' | 'script';
}
const defaults: WorkspacePreferences = Object.freeze({ schemaVersion: 1, mode: 'intent', tab: 'logic', category: 'geometry', advancedTab: 'inspect' });
export function parseWorkspacePreferences(input: unknown): WorkspacePreferences | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.keys(descriptors).sort().join(',') !== 'advancedTab,category,mode,schemaVersion,tab' || Object.values(descriptors).some(value => !('value' in value))) return null;
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1 || !['intent', 'classic'].includes(value.mode as string) || !['logic', 'resources'].includes(value.tab as string) || !WORKSPACE_CATEGORIES.includes(value.category as WorkspaceCategory) || !['inspect', 'script'].includes(value.advancedTab as string)) return null;
  return Object.freeze({ schemaVersion: 1, mode: value.mode, tab: value.tab, category: value.category, advancedTab: value.advancedTab }) as WorkspacePreferences;
}
export function loadWorkspacePreferences(storage?: WorkspacePreferenceStorage): WorkspacePreferences {
  try {
    const raw = storage?.getItem(WORKSPACE_PREFERENCE_KEY);
    if (raw && raw.length <= 1024) return parseWorkspacePreferences(JSON.parse(raw)) ?? defaults;
  } catch { /* Storage is optional; legacy split values remain untouched. */ }
  // Existing split.v2.* preferences continue to be read by the same split owner. Never rewrite them during migration.
  return defaults;
}
export function saveWorkspacePreferences(storage: WorkspacePreferenceStorage | undefined, preferences: WorkspacePreferences): boolean {
  try { storage?.setItem(WORKSPACE_PREFERENCE_KEY, JSON.stringify(preferences)); return !!storage; }
  catch { return false; }
}
