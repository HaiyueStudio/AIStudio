import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, realpath, rm, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SessionResources } from '@deepseek-ai/dsh-experimental-browser-use-runtime';
import { Config as BrowserConfig } from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp';
import { Config as DevtoolsConfig } from '@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp';
import { DEVTOOLS_CATALOG } from './devtools-catalog.js';
import BrowserUse from '@deepseek-ai/dsh-browser-use';
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand';
import type { OfficialToolProviderV1 } from '@haiyue/ai-studio-contracts';
import { prepareOfficialNative } from './official-tools.js';
import type { HarnessExtendedToolOptions } from './extended-tools.js';

/** Lazy startup uses the official provider's public SessionResources and MCP seams. */
export async function installBrowserTools(port: OfficialToolProviderV1, context: Context, options: HarnessExtendedToolOptions): Promise<void> {
  const devtools = options.browser?.backend === 'chrome-devtools';
  const serverName = devtools ? 'chrome-devtools-mcp' : 'playwright-mcp';
  const config = (devtools ? DevtoolsConfig : BrowserConfig)({ mode: 'launch', headless: true, ...(options.browser?.executablePath ? { executablePath: options.browser.executablePath } : {}) });
  await context.plugin(BrowserUse);
  await context.plugin({ name: 'studio:official-browser', inject: ['browserUse', 'agents', 'tools', 'systemPrompt'], apply(ctx) {
    ctx.browserUse.register(BrowserUseProviderName(serverName));
    const byAgent = new Map<Agent, SessionResources<{ scope: ReturnType<typeof createScope>; directory: string }>>();
    const resourcesFor = (agent: Agent) => {
      const previous = byAgent.get(agent); if (previous) return previous;
      const resources = new SessionResources(ctx, { label: `studio-${serverName}`, exclusive: false, async open(agent, signal) {
        const scope = createScope(ctx, agent);
        const directory = await realpath(await mkdtemp(join(tmpdir(), 'aistudio-browser-')));
        const cancel = () => { void scope.dispose().catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          signal.throwIfAborted();
          const cli = devtools ? fileURLToPath(import.meta.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js')) : join(dirname(fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'))), 'cli.js');
          const env = Object.fromEntries(Object.keys(process.env).filter(key => key.toUpperCase().startsWith('PLAYWRIGHT_MCP_')).map(key => [key, '']));
          if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
          const args = devtools ? [cli, '--no-usage-statistics', '--no-performance-crux', '--isolated', '--headless=true'] : [cli, '--browser', 'chromium', '--isolated', '--headless', '--output-dir', directory, '--output-max-size', '4194304', '--codegen', 'none', '--timeout-navigation', '15000'];
          if (config.mode === 'launch' && config.executablePath) args.push('--executable-path', config.executablePath);
          await scope.ctx.plugin(McpClient, McpClient.Config({ transport: 'stdio', serverName, command: process.execPath, args, env, cwd: directory, toolCallTimeoutMs: 20000, failOnStartupError: true, reconnect: { enabled: false }, maxInstructionBytes: 2048 }));
          signal.throwIfAborted();
          return { value: { scope, directory }, async close() { await scope.dispose(); await rm(directory, { recursive: true, force: true }); } };
        } catch (cause) { await scope.dispose(); await rm(directory, { recursive: true, force: true }); throw cause; }
        finally { signal.removeEventListener('abort', cancel); }
      } });
      byAgent.set(agent, resources);
      agent.ctx.effect(() => async () => { await resources.dispose(); byAgent.delete(agent); }, 'studio.browser-owner');
      return resources;
    };
    ctx.effect(() => async () => { await Promise.all([...byAgent.values()].map(r => r.dispose())); byAgent.clear(); }, 'studio.browser-resources');
    prepareOfficialNative(port, async (call, agent, signal) => {
      if (!call.toolId.startsWith('official.browser.')) return;
      // The pinned MCP has optional arbitrary file destinations. They are deliberately not admitted.
      if (call.arguments.filename !== undefined || call.arguments.filePath !== undefined || call.arguments.initScript !== undefined) throw new Error('official.browser.file-destination-denied');
      if (devtools) {
        const action = call.toolId.slice('official.browser.'.length);
        const native = action === 'navigate' ? 'navigate_page' : action === 'snapshot' ? 'take_snapshot' : action;
        const schema = DEVTOOLS_CATALOG.find(t => t.name.endsWith(`__${native}`));
        const properties = schema?.parameters.properties as Record<string, unknown> | undefined;
        if (!properties || Object.keys(call.arguments).some(key => !Object.hasOwn(properties, key))) throw new Error('official.browser.arguments-denied');
      }
      if ((call.toolId === 'official.browser.navigate' && (!devtools || call.arguments.url !== undefined)) || call.toolId === 'official.browser.new_page') {
        const url = new URL(String(call.arguments.url));
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('official.browser.url-denied');
      }
      const resources = resourcesFor(agent);
      let cleanup: Promise<void> | undefined;
      const cancel = () => { cleanup = resources.dispose(); void cleanup.catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try { signal.throwIfAborted(); await resources.get(agent); signal.throwIfAborted(); }
      finally { signal.removeEventListener('abort', cancel); if (cleanup) { await cleanup; byAgent.delete(agent); } }
    });
    ctx.on('tools/execute', async (exec, next) => {
      if (!exec.name.startsWith(`mcp__${serverName}__`)) return next();
      if (!exec.agent) throw new Error('official.browser.session-required');
      return resourcesFor(exec.agent).run(exec.agent, exec.signal, async (resource, signal) => {
        const original = exec.signal; exec.signal = signal;
        try {
          const result = await next();
          if (result.isError || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) return result;
          const content = (result.value as { content?: unknown }).content;
          if (!Array.isArray(content)) return result;
          const expanded = [];
          for (const block of content) {
            if (block?.type !== 'text' || typeof block.text !== 'string') { expanded.push(block); continue; }
            let text = block.text;
            const match = /\[Snapshot\]\(\.\/(page-[A-Za-z0-9T_.:-]+\.yml)\)/.exec(text);
            if (match) {
              const file = await open(join(resource.directory, match[1]!), constants.O_RDONLY | constants.O_NOFOLLOW);
              try {
                const stat = await file.stat(); if (!stat.isFile()) throw new Error('official.browser.snapshot-invalid');
                const buffer = Buffer.alloc(24000), read = await file.read(buffer, 0, buffer.length, 0);
                text = text.replace(match[0], buffer.subarray(0,read.bytesRead).toString('utf8') + (stat.size > read.bytesRead ? '\n[Snapshot truncated]' : ''));
              } finally { await file.close(); }
            }
            expanded.push({ type: 'text', text });
          }
          return { ...result, value: { ...result.value, content: expanded }, content: expanded };
        } finally { exec.signal = original; }
      });
    });
    // Browser instructions are untrusted server metadata; the Studio descriptors carry the needed guidance.
    ctx.on('system-prompt/assemble', async (_assembly, _input, next) => {
      const assembly = await next();
      return { ...assembly, sections: assembly.sections.filter(section => section.name !== `mcp:${serverName}`) };
    });
  } });
}
