// skillmap — local live server: the same report, plus Server-Sent Events that
// push the runtime data whenever a session changes. Listens on 127.0.0.1 only:
// the data holds prompts, commands and file paths.

import { createServer } from 'node:http';
import { renderHtml } from './report.mjs';

const HEARTBEAT_MS = 25000;

/**
 * @param {{ port: number, root: string, payload: () => object }} opts  payload — the report data as of now
 * @returns {Promise<{ url: string, send: (event: string, data: unknown) => void, close: () => void }>}
 *   rejects with code 'SKILLMAP_RUNNING' when another skillmap already serves this root on the port
 */
export async function serveReport({ port, root, payload }) {
  const clients = new Set();
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const server = createServer((req, res) => {
    // a page on another site can't reach us through a rebound DNS name
    if (!hosts.has(req.headers.host)) { res.writeHead(403).end(); return; }
    const path = req.url.split('?')[0];
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(renderHtml(payload()));
    } else if (path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (path === '/__skillmap') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tool: 'skillmap', root }));
    } else {
      res.writeHead(404).end();
    }
  });

  await new Promise((ok, fail) => {
    server.once('error', async (err) => {
      if (err.code !== 'EADDRINUSE') return fail(err);
      const other = await fetch(`http://127.0.0.1:${port}/__skillmap`).then((r) => r.json()).catch(() => null);
      const e = new Error(other?.tool === 'skillmap'
        ? `skillmap is already serving ${other.root} on port ${port}`
        : `port ${port} is in use (pick another with --port)`);
      if (other?.tool === 'skillmap' && other.root === root) e.code = 'SKILLMAP_RUNNING';
      fail(e);
    });
    server.listen(port, '127.0.0.1', ok);
  });

  const beat = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, HEARTBEAT_MS);
  return {
    url: `http://127.0.0.1:${port}/`,
    send(event, data) {
      const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const c of clients) c.write(msg);
    },
    close() { clearInterval(beat); for (const c of clients) c.end(); server.close(); },
  };
}
