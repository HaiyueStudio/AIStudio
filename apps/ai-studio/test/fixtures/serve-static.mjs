import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '');
const port = Number(process.argv[3] ?? 4179);
if (!path.isAbsolute(root) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Usage: serve-static.mjs <absolute-root> <port>');
const types = new Map([['.html','text/html; charset=utf-8'],['.js','text/javascript; charset=utf-8'],['.css','text/css; charset=utf-8'],['.png','image/png']]);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const relative = decodeURIComponent(url.pathname === '/' ? '/host.html' : url.pathname).replace(/^\/+/, '');
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Path escapes fixture root.');
    if (!(await stat(target)).isFile()) throw new Error('Not a file.');
    response.writeHead(200, { 'content-type': types.get(path.extname(target)) ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(target).pipe(response);
  } catch { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); response.end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`[g09-static] http://127.0.0.1:${port}/host.html`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
