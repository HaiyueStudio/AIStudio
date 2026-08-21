import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'dist');
const portIndex = process.argv.indexOf('--port');
const requestedPort = Number(portIndex >= 0 ? process.argv[portIndex + 1] : 4173);
if (!Number.isSafeInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535) throw new Error('Web port must be an integer between 1 and 65535.');
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'], ['.json', 'application/json; charset=utf-8'], ['.png', 'image/png'],
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const relative = decodeURIComponent(url.pathname === '/' ? '/web.html' : url.pathname).replace(/^\/+/, '');
    const candidate = path.resolve(root, relative);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error('Path escapes web root.');
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error('Not a file.');
    const extension = path.extname(candidate);
    const isEmbeddableAsset = extension === '.js' || extension === '.css' || extension === '.map';
    response.writeHead(200, {
      'content-type': contentTypes.get(extension) ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'cross-origin-opener-policy': 'same-origin',
      // The preview iframe intentionally omits allow-same-origin. Its module graph
      // therefore has an opaque origin and needs explicit CORS for static assets.
      ...(isEmbeddableAsset ? {
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
      } : {
        'cross-origin-resource-policy': 'same-origin',
      }),
    });
    createReadStream(candidate).pipe(response);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(requestedPort, '127.0.0.1', () => console.log(`[ai-studio-web] http://127.0.0.1:${requestedPort}/web.html`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
