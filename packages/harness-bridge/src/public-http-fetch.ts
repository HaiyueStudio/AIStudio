import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch, type Dispatcher } from 'undici';
import { WebError, type WebFetchProvider, type WebFetchRequest, type WebFetchResult } from '@deepseek-ai/dsh-web';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6'); blocked.addSubnet('2001:db8::', 32, 'ipv6'); blocked.addSubnet('2002::', 16, 'ipv6');
export function isPublicHttpAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
export async function resolvePublicHttpAddresses(hostname: string, resolve: (host: string) => Promise<readonly { address: string; family: number }[]> = host => lookup(host, { all: true, verbatim: true })) {
  const addresses = await resolve(hostname);
  if (!addresses.length || addresses.some(entry => !isPublicHttpAddress(entry.address))) throw new WebError('Destination is not public.', 'WEB_BLOCKED_URL');
  return [...addresses];
}
function safeUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new WebError('Invalid URL.', 'WEB_INVALID_URL'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (input.length > 2048 || !['http:', 'https:'].includes(url.protocol)) throw new WebError('Unsupported URL.', 'WEB_INVALID_URL');
  if (url.username || url.password || host === 'localhost' || host.endsWith('.localhost') || isIP(host) && !isPublicHttpAddress(host)) throw new WebError('Only public anonymous URLs are allowed.', 'WEB_BLOCKED_URL');
  return url;
}
/** rc.5 permits intranet fetches. Studio retains public-only retrieval and checks actual connection DNS. */
export class PublicHttpFetchProvider implements WebFetchProvider {
  readonly id = 'studio-public-http';
  private readonly abort = new AbortController();
  private readonly active = new Set<Promise<WebFetchResult>>();
  private disposal?: Promise<void>;
  constructor(private readonly dispatcher: Dispatcher = new Agent({ connect: { lookup(hostname, options, callback) {
    void resolvePublicHttpAddresses(hostname).then(addresses => {
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    }).catch(error => callback(error, ''));
  } } })) {}
  available(): boolean { return !this.abort.signal.aborted; }
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const work = this.read(request.url, signal); this.active.add(work);
    void work.finally(() => this.active.delete(work)).catch(() => {}); return work;
  }
  dispose(): Promise<void> {
    this.abort.abort();
    return this.disposal ??= (async () => { await Promise.allSettled(this.active); await this.dispatcher.close(); })();
  }
  private async read(input: string, caller?: AbortSignal): Promise<WebFetchResult> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000), ...(caller ? [caller] : [])]);
    let url = safeUrl(input);
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted();
      const response = await fetch(url, { dispatcher: this.dispatcher, redirect: 'manual', signal,
        headers: { 'user-agent': 'Haiyue-AIStudio/0.0.0', accept: 'text/html,application/xhtml+xml,text/*,application/json' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects >= 3) throw new WebError('Redirect limit reached.', 'WEB_REDIRECT_BLOCKED');
        const target = safeUrl(new URL(location, url).href);
        if (target.origin !== url.origin) throw new WebError('Cross-origin redirect requires a new call.', 'WEB_REDIRECT_BLOCKED');
        url = target; continue;
      }
      try {
        const type = response.headers.get('content-type') ?? '';
        const mime = type.split(';')[0]!.trim().toLowerCase();
        if (!mime.startsWith('text/') && !/^application\/(?:json|xml|xhtml\+xml|[^;]+\+(?:json|xml))$/.test(mime)) throw new WebError('Unsupported body type.', 'WEB_UNSUPPORTED_CONTENT_TYPE');
        if (Number(response.headers.get('content-length')) > 262144) throw new WebError('Response exceeds byte limit.', 'WEB_FETCH_TOO_LARGE');
        const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(type)?.[1] ?? 'utf-8';
        const decoder = new TextDecoder(charset);
        const reader = response.body?.getReader();
        let text = '', bytes = 0, truncated = false;
        if (reader) try {
          for (;;) {
            const part = await reader.read(); signal.throwIfAborted(); if (part.done) break;
            const remaining = 262144 - bytes; bytes += part.value.byteLength;
            text += decoder.decode(part.value.subarray(0, Math.max(0, remaining)), { stream: true });
            if (bytes > 262144 || text.length > 16000) { truncated = true; break; }
          }
          text += decoder.decode();
        } finally { await reader.cancel(); reader.releaseLock(); }
        return { url: url.href, statusCode: response.status, body: { kind: /^(?:text\/html|application\/xhtml\+xml)$/.test(mime) ? 'html' : 'text', content: text.slice(0, 16000) }, truncated: truncated || text.length > 16000 };
      } finally { if (!response.body?.locked) await response.body?.cancel(); }
    }
  }
}
