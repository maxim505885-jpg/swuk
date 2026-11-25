import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml' };

export function resolveStaticPath(baseDirectory, pathname) {
  const safeRoot = resolve(baseDirectory);
  const normalizedUrlPath = pathname.replaceAll('\\', '/');
  if (!normalizedUrlPath.startsWith('/') || normalizedUrlPath.includes('\0')) return null;
  const segments = normalizedUrlPath.split('/');
  if (segments.some(segment => segment === '..' || segment.includes(':'))) return null;
  const file = resolve(safeRoot, `.${normalizedUrlPath === '/' ? '/index.html' : normalizedUrlPath}`);
  const relativePath = relative(safeRoot, file);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return relativePath ? null : file;
  return file;
}

export function createStaticServer(baseDirectory = root, port = Number(process.env.PORT || 4173)) {
  return createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); }
    catch { response.writeHead(400).end('Bad request'); return; }
    const file = resolveStaticPath(baseDirectory, pathname);
    if (!file) { response.writeHead(403).end('Forbidden'); return; }
    try {
      if (!statSync(file).isFile()) throw new Error('not a file');
      response.writeHead(200, {
        'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      createReadStream(file).on('error', () => { if (!response.headersSent) response.writeHead(500); response.end('Read error'); }).pipe(response);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  }).listen(port, '127.0.0.1', () => console.log(`SONORA Studio: http://127.0.0.1:${port}`));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  createStaticServer();
}
