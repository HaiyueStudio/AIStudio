import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import WebRuntime from '@deepseek-ai/dsh-web';
import { DeepSeekSearchProvider } from '@deepseek-ai/dsh-web-search-deepseek';
import * as HttpFetch from '@deepseek-ai/dsh-web-fetch-http';
import type { JsonObject } from '@haiyue/ai-studio-contracts';
import { WEB_BINDINGS, type HarnessExtendedToolOptions } from './extended-tools.js';
import { currentOfficialExecution } from './official-tools.js';
import { WebReadCache } from './web-read-cache.js';

export async function installWebTools(ctx: Context, options: HarnessExtendedToolOptions, resolveApiKey: () => Promise<string | null>): Promise<void> {
  await ctx.plugin(WebRuntime, { searchProvider: 'deepseek-official', fetchProvider: 'http' });
  await ctx.plugin(HttpFetch, { maxResponseBytes: 262144, maxBodyChars: 16000, timeoutMs: 15000, maxRedirects: 3, userAgent: 'Haiyue-AIStudio/0.0.0' });
  await ctx.plugin({ name: 'studio:official-web', inject: ['web', 'tools'], apply: inner => registerWebTools(inner, options, resolveApiKey) });
}

function registerWebTools(ctx: Context, options: HarnessExtendedToolOptions, resolveApiKey: () => Promise<string | null>): void {
  const credentials = new AsyncLocalStorage<string>();
  ctx.web.registerSearchProvider(new DeepSeekSearchProvider(() => ({
    resolveApiKey: async () => credentials.getStore(), baseURL: options.search?.baseURL ?? 'https://api.deepseek.com/anthropic/v1',
    model: options.search?.model ?? 'deepseek-flash', apiVersion: '2023-06-01', maxTokens: 2048, maxUses: 1,
  })));
  // Turn-local cache: no cross-session, cross-turn or cross-credential reuse.
  const cache = new WebReadCache();
  ctx.effect(() => async () => { await cache.dispose(); credentials.disable(); }, 'studio.web-cache');
  for (const spec of WEB_BINDINGS) ctx.tools.register({
    name: spec.nativeName, description: spec.definition.description, parameters: spec.definition.inputSchema,
    output: { schema: spec.definition.outputSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(input, exec) {
      const args = input as JsonObject; // ToolRuntime validated the reviewed schema before dispatch.
      exec.signal.throwIfAborted();
      const search = spec.definition.id === 'official.web.search';
      const key = search ? await resolveApiKey() : null;
      if (search && (!key || /\r|\n/.test(key))) return { status: 'error', code: 'official.web.credentials-missing' };
      const call = currentOfficialExecution();
      if (!call) throw new Error('official.host-authorization-required');
      const parameters = search ? { query: args.query, maxResults: args.maxResults ?? 5 } : { url: args.url };
      const scopeKey = createHash('sha256').update(JSON.stringify([call.sessionId, call.turnId, spec.nativeName, parameters, key])).digest('hex');
      try {
        return await cache.run(scopeKey, exec.signal, async signal => {
          let value: JsonObject;
          const retrievedAt = new Date().toISOString();
          if (search) {
            const result = await credentials.run(key!, () => ctx.web.search({ query: String(args.query), maxResults: Number(args.maxResults ?? 5) }, signal));
            const truncated = result.truncated || result.sources.some(source => source.url.length > 4096 || (source.title?.length ?? 0) > 512 || (source.snippet?.length ?? 0) > 3000 || (source.publishedAt?.length ?? 0) > 128);
            value = { status: 'completed', retrievedAt, sources: result.sources.map(source => ({ url: source.url.slice(0,4096), ...(source.title ? { title: source.title.slice(0,512) } : {}), ...(source.snippet ? { snippet: source.snippet.slice(0,3000) } : {}), ...(source.publishedAt ? { publishedAt: source.publishedAt.slice(0,128) } : {}) })), truncated, auxiliaryUsage: { status: 'unknown', tokens: null, cost: null, maxOutputTokens: 2048, maxSearchUses: 1 }, untrusted: true };
          } else {
            const result = await ctx.web.fetch({ url: String(args.url) }, signal);
            value = { status: 'completed', retrievedAt, url: result.url, statusCode: result.statusCode, content: result.body.content, format: result.body.kind, truncated: result.truncated, untrusted: true };
          }
          signal.throwIfAborted();
          return value;
        });
      } catch (cause) {
        exec.signal.throwIfAborted();
        const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
        return { status: 'error', code: /^WEB_[A-Z_]+$/.test(code) ? code : 'official.web.failed' };
      }
    },
  });
}
