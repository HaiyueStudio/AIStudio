import { readFile, mkdir, writeFile, rename, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { JsonObject } from '@haiyue/ai-studio-contracts';
import type { HarnessExtendedToolOptions } from '@haiyue/ai-studio-harness-bridge/agent';
import { HARNESS_EXPERIMENTAL_ADMISSION } from '@haiyue/ai-studio-harness-bridge/agent';
import { extendedToolsConfiguration } from './extended-tools-config.js';

import { parseToolPreferences, type ToolPreferencesValue } from './tool-preferences-model.js';
export class ToolPreferences {
  private value: ToolPreferencesValue = { web: true, browser: true, node: true, browserBackend: 'playwright' };
  private active = this.value;
  private statuses: JsonObject = {};
  private writes: Promise<unknown> = Promise.resolve();
  private disposed = false;
  constructor(private readonly file: string) {}
  async initialize(): Promise<void> {
    try { this.value = parseToolPreferences(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.active = this.value;
  }
  setParallelStatus(reason: string): void { this.statuses = { ...this.statuses, parallel: { enabled: reason === 'qualification-required-per-plan', backend: 'candidate-only', reason } }; }
  snapshot(): JsonObject { return { preferences: { ...this.value }, active: { ...this.active }, restartRequired: JSON.stringify(this.value) !== JSON.stringify(this.active), capabilities: this.statuses }; }
  configure(value: unknown): Promise<JsonObject> {
    if (this.disposed) throw new Error('Tool preferences disposed.');
    const next = parseToolPreferences(value);
    const work = this.writes.then(async () => { await mkdir(path.dirname(this.file), { recursive: true }); await writeFile(`${this.file}.tmp`, JSON.stringify(next), { mode: 0o600 }); await rename(`${this.file}.tmp`, this.file); this.value = next; return this.snapshot(); });
    this.writes = work.catch(() => {}); return work;
  }
  async configuration(backend: string, env: NodeJS.ProcessEnv = process.env): Promise<Omit<HarnessExtendedToolOptions, 'storeArtifact'>> {
    const enabled = backend === 'harness-api-key';
    const config = await extendedToolsConfiguration({ ...env, AI_STUDIO_WEB_TOOLS: !this.active.web || env.AI_STUDIO_WEB_TOOLS === '0' ? '0' : '1', AI_STUDIO_BROWSER_TOOLS: !this.active.browser || env.AI_STUDIO_BROWSER_TOOLS === '0' ? '0' : '1', AI_STUDIO_NODE_TOOLS: !this.active.node || env.AI_STUDIO_NODE_TOOLS === '0' ? '0' : '1', AI_STUDIO_BROWSER_BACKEND: env.AI_STUDIO_BROWSER_BACKEND ?? this.active.browserBackend,
      // The explicit local setting is the experimental entry; deployment can still force a backend.
      AI_STUDIO_EXPERIMENTAL_BROWSER: this.active.browserBackend === 'chrome-devtools' ? '1' : env.AI_STUDIO_EXPERIMENTAL_BROWSER });
    const available = async (file: string) => { try { await access(file, constants.X_OK); return true; } catch { return false; } };
    let browserPath = config.browser?.executablePath;
    if (config.browser && !browserPath) {
      for (const candidate of process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'] : process.platform === 'win32' ? [path.join(env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (await available(candidate)) { browserPath = candidate; break; }
    }
    const browserReady = !!browserPath && await available(browserPath);
    let nodeReady = false;
    if (config.node?.executablePath && process.platform === 'darwin' && await available('/usr/bin/sandbox-exec')) {
      try { const result = await promisify(execFile)(config.node.executablePath, ['--permission', '-p', 'process.versions.node'], { timeout: 3000, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin' } }); nodeReady = Number(result.stdout.trim().split('.')[0]) >= 22; } catch { /* Display a stable diagnostic, never raw process output or paths. */ }
    }
    this.statuses = {
      ...HARNESS_EXPERIMENTAL_ADMISSION,
      web: { enabled: enabled && !!config.web, backend: 'deepseek/http', reason: !enabled ? 'backend-unsupported' : config.web ? 'ready; search requires credentials' : 'disabled' },
      browser: { enabled: enabled && !!config.browser && browserReady, backend: config.browser?.backend ?? 'playwright', reason: !enabled ? 'backend-unsupported' : !config.browser ? 'disabled' : browserReady ? 'ready' : 'browser-executable-unavailable' },
      node: { enabled: enabled && !!config.node && nodeReady, backend: 'restricted-node', reason: !enabled ? 'backend-unsupported' : !config.node ? 'disabled' : process.platform !== 'darwin' ? 'platform-sandbox-unavailable' : nodeReady ? 'ready' : 'node-22-or-sandbox-unavailable' },
    };
    return { web: enabled && !!config.web, ...(config.search ? { search: config.search } : {}), ...(enabled && config.browser && browserReady ? { browser: { ...config.browser, executablePath: browserPath! } } : {}), ...(enabled && config.node && nodeReady ? { node: config.node } : {}) };
  }
  async dispose(): Promise<void> { this.disposed = true; await this.writes; }
}
