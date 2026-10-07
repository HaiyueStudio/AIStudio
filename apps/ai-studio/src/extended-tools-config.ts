import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { HarnessExtendedToolOptions } from '@haiyue/ai-studio-harness-bridge/agent';

/** Main-process deployment settings, never model-selected paths or credentials. */
export async function extendedToolsConfiguration(env: NodeJS.ProcessEnv = process.env): Promise<Omit<HarnessExtendedToolOptions, 'storeArtifact'>> {
  const backend = env.AI_STUDIO_BROWSER_BACKEND ?? 'playwright';
  if (backend === 'stagehand' || backend === 'stagehand-native') throw new Error('Stagehand is unavailable: the pinned native provider exposes neither inference usage nor request token caps.');
  if (!['playwright', 'chrome-devtools'].includes(backend)) throw new Error('Unknown AI_STUDIO_BROWSER_BACKEND.');
  if (backend === 'chrome-devtools' && env.AI_STUDIO_EXPERIMENTAL_BROWSER !== '1') throw new Error('Chrome DevTools requires AI_STUDIO_EXPERIMENTAL_BROWSER=1.');
  let nodeExecutable = env.AI_STUDIO_NODE_EXECUTABLE;
  if (!nodeExecutable && !process.versions.electron) nodeExecutable = process.execPath;
  if (!nodeExecutable && process.platform === 'darwin') {
    for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
      try { await access(candidate, constants.X_OK); nodeExecutable = candidate; break; } catch { /* Try the next installed runtime. */ }
    }
  }
  return Object.freeze({
    web: env.AI_STUDIO_WEB_TOOLS !== '0',
    ...(env.AI_STUDIO_SEARCH_BASE_URL || env.AI_STUDIO_SEARCH_MODEL ? { search: { ...(env.AI_STUDIO_SEARCH_BASE_URL ? { baseURL: env.AI_STUDIO_SEARCH_BASE_URL } : {}), ...(env.AI_STUDIO_SEARCH_MODEL ? { model: env.AI_STUDIO_SEARCH_MODEL } : {}) } } : {}),
    ...(env.AI_STUDIO_BROWSER_TOOLS === '0' ? {} : { browser: { ...(backend === 'chrome-devtools' ? { backend: 'chrome-devtools' as const } : {}), ...(env.AI_STUDIO_BROWSER_EXECUTABLE ? { executablePath: env.AI_STUDIO_BROWSER_EXECUTABLE } : {}) } }),
    ...(env.AI_STUDIO_NODE_TOOLS === '0' ? {} : { node: { ...(nodeExecutable ? { executablePath: nodeExecutable } : {}) } }),
  });
}
