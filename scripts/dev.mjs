import http from 'node:http';
import { readFile, watch } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildStandalone } from './build-standalone.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = new URL(process.env.OPENBEXI_BACKEND || 'http://127.0.0.1:8765');
let building = false;
let dirty = false;
async function rebuild() {
  if (building) { dirty = true; return; }
  building = true;
  try { await buildStandalone(); console.log('Standalone source rebuilt.'); }
  catch (error) { console.error(error.message); }
  finally { building = false; if (dirty) { dirty = false; await rebuild(); } }
}
await buildStandalone();
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) {
    const proxy = http.request(new URL(request.url, backend), {
      method: request.method, headers: { ...request.headers, host: backend.host }, timeout: 3000,
    }, upstream => { response.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(response); });
    proxy.on('timeout', () => proxy.destroy(new Error('Backend timeout')));
    proxy.on('error', () => {
      if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/problem+json' });
      response.end(JSON.stringify({ code: 'server_unavailable', message: 'Python server unavailable' }));
    });
    request.pipe(proxy);
    return;
  }
  if (!['/', '/index.html'].includes(pathname)) { response.writeHead(404); response.end('Not found'); return; }
  try {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(await readFile(path.join(root, 'dist/index.html')));
  } catch { response.writeHead(503); response.end('Build unavailable'); }
});
let port = Number(process.env.PORT || 4173);
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && port < 4190) { port += 1; server.listen(port, '127.0.0.1'); }
  else { console.error(error); process.exitCode = 1; }
});
server.on('listening', () => console.log(`OpenBEXI Timeline: http://127.0.0.1:${port}`));
server.listen(port, '127.0.0.1');
for (const directory of ['client', 'shared', 'data', 'yaml/test-data']) {
  (async () => {
    let timer;
    for await (const _event of watch(path.join(root, directory), { recursive: true })) {
      clearTimeout(timer); timer = setTimeout(rebuild, 150);
    }
  })().catch(error => console.error(`Watch: ${error.message}`));
}
