// skillmap — local live server: the same report, plus Server-Sent Events that
// push the runtime data whenever a session changes. Listens on 127.0.0.1 only:
// the data holds prompts, commands and file paths.

import { createServer } from 'node:http';
import { renderHtml } from './report.mjs';

const HEARTBEAT_MS = 25000;
const PORT_TRIES = 20; // ports tried from `port` up when it is taken and not `strict`

/**
 * One server per project folder: a taken port moves on to the next one, unless
 * the same folder is already served there.
 * @param {{ port: number, strict?: boolean, root: string, payload: () => object }} opts
 *   payload — the report data as of now; strict — use exactly `port` or fail
 * @returns {Promise<{ url: string, port: number, send: (event: string, data: unknown) => void, close: () => void }>}
 *   rejects with code 'SKILLMAP_RUNNING' (and `port`) when another skillmap already serves this root
 */
export async function serveReport({ port: first, strict = false, root, payload }) {
  const clients = new Set();

  const server = createServer((req, res) => {
    // a page on another site can't reach us through a rebound DNS name
    const port = server.address().port;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) { res.writeHead(403).end(); return; }
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

  const listen = (p) => new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(p, '127.0.0.1', () => { server.off('error', fail); ok(); });
  });
  const tries = strict ? 1 : PORT_TRIES;
  for (let i = 0; i < tries; i++) {
    try {
      await listen(first + i);
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      const other = await fetch(`http://127.0.0.1:${first + i}/__skillmap`).then((r) => r.json()).catch(() => null);
      if (other?.tool === 'skillmap' && other.root === root) {
        const e = new Error(`skillmap is already serving ${root} on port ${first + i}`);
        e.code = 'SKILLMAP_RUNNING';
        e.port = first + i;
        throw e;
      }
      if (i === tries - 1) throw new Error(strict ? `port ${first} is in use (pick another with --port)` : `ports ${first}-${first + i} are in use (pick one with --port)`);
    }
  }
  const port = server.address().port;

  const beat = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, HEARTBEAT_MS);
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    send(event, data) {
      const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const c of clients) c.write(msg);
    },
    close() { clearInterval(beat); for (const c of clients) c.end(); server.close(); },
  };
}
