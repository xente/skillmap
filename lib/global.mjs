// skillmap — global report: every session of every project in one page, with
// tokens and cost over time. A separate page from the per-project report: it
// reads no project folder, only the local session history.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkTraces, mcpCalls } from './runtime/model.mjs';
import { scan, parseFrontmatter } from './scan.mjs';
import { buildGraph, analyze } from './analyze.mjs';
import { buildPayload, renderHtml as renderReport } from './report.mjs';
import { analyzeRuntime } from './runtime/analyze.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TITLE_CHARS = 120;

const bump = (obj, key, by = 1) => { obj[key] = (obj[key] || 0) + by; };

const SPARK_BUCKETS = 12;

// where a skill's SKILL.md can live, under a project folder and under the home folder
const SKILL_DIRS = ['.claude/skills', '.opencode/skills', '.opencode/skill', '.agents/skills'];
const HOME_SKILL_DIRS = ['.claude/skills', '.config/opencode/skills', '.config/opencode/skill', '.agents/skills'];

/** Name and description of each skill the sessions loaded, from the SKILL.md found for it; skills from plugins have none. */
function skillInfo(rows) {
  const home = homedir();
  const names = new Set(rows.flatMap((r) => Object.keys(r.usage?.skills || {})));
  const dirs = new Set();
  for (const r of rows) {
    // the project folder and the folders above it, up to the home folder: a worktree inherits its repo's skills
    for (let d = r.directory; d && d.startsWith(home) && d !== home && !dirs.has(d); d = dirname(d)) dirs.add(d);
  }
  const find = (name) => {
    for (const d of dirs) for (const sub of SKILL_DIRS) {
      const f = join(d, sub, name, 'SKILL.md');
      if (existsSync(f)) return { f, scope: 'project' };
    }
    for (const sub of HOME_SKILL_DIRS) {
      const f = join(home, sub, name, 'SKILL.md');
      if (existsSync(f)) return { f, scope: 'global' };
    }
    return null;
  };
  const out = {};
  for (const name of names) {
    const hit = name.includes(':') ? null : find(name);
    if (!hit) continue;
    try {
      const { data } = parseFrontmatter(readFileSync(hit.f, 'utf8'));
      out[name] = { description: String(data.description || '').replace(/\s+/g, ' ').trim().slice(0, 220), scope: hit.scope };
    } catch { /* unreadable: no description */ }
  }
  return out;
}

/** Model time of a session spread over `SPARK_BUCKETS` equal slices of its life: a small activity profile. */
function sparkOf(t) {
  const out = new Array(SPARK_BUCKETS).fill(0);
  const span = t.end - t.start;
  if (!(span > 0)) return out;
  for (const s of t.steps) {
    const a = Math.max(s.start, t.start), b = Math.min(s.end, t.end);
    if (!(b > a)) continue;
    for (let i = Math.floor(((a - t.start) / span) * SPARK_BUCKETS); i < SPARK_BUCKETS; i++) {
      const lo = t.start + (i * span) / SPARK_BUCKETS, hi = t.start + ((i + 1) * span) / SPARK_BUCKETS;
      if (lo >= b) break;
      out[i] += Math.max(0, Math.min(b, hi) - Math.max(a, lo));
    }
  }
  return out.map((v) => Math.round(v));
}

/**
 * How many skills, agents and instruction files each project folder defines. The home folder is
 * not scanned (it holds everything and takes seconds); a folder deleted since has no count.
 */
function projectInfo(rows) {
  const home = homedir();
  const out = {};
  for (const dir of new Set(rows.filter((r) => !r.parent).map((r) => r.directory).filter(Boolean))) {
    if (!existsSync(dir) || dir === home || home.startsWith(dir + sep)) { out[dir] = null; continue; }
    try {
      const { docs } = scan(dir);
      const count = (k) => docs.filter((d) => d.kind === k).length;
      out[dir] = { skills: count('skill'), agents: count('agent'), instructions: count('instructions') };
    } catch { out[dir] = null; }
  }
  return out;
}

/** What a session called: skills, subagent types, MCP servers (calls, errors) and built-in tools by kind. */
function usageOf(t) {
  const skills = {}, agents = {}, mcp = {}, tools = {};
  for (const s of t.spans) {
    if (s.kind === 'skill') bump(skills, s.name);
    else if (s.kind === 'agent') bump(agents, s.name);
    else if (s.kind === 'mcp') {
      for (const c of mcpCalls(s)) {
        const m = (mcp[c.server] ||= { calls: 0, errors: 0, tools: {} });
        m.calls++;
        if (c.status === 'error') m.errors++;
        bump(m.tools, c.tool);
      }
    } else bump(tools, s.kind);
  }
  return { skills, agents, mcp, tools };
}

/**
 * One row per session, subagent sessions included (they carry their own tokens
 * and cost; the parent's figures do not include them).
 * @param {import('./runtime/model.mjs').Trace[]} traces  top-level traces
 */
export function buildGlobalPayload(traces, { since, sources, notes = [] }) {
  const rows = [];
  for (const t of walkTraces(traces)) {
    rows.push({
      id: t.id,
      parent: t.parentId,
      runtime: t.runtime,
      client: t.client,
      directory: t.directory,
      agent: t.agent,
      model: t.model,
      title: (t.title || '').slice(0, TITLE_CHARS),
      start: t.start,
      end: t.end,
      activeMs: t.activeMs,
      tokens: t.tokens,
      cost: t.cost,
      costEstimated: Boolean(t.costEstimated),
      outcome: t.outcome,
      usage: usageOf(t),
      spark: sparkOf(t),
    });
  }
  return { generatedAt: new Date().toISOString(), since, sources, notes, rows, skills: skillInfo(rows), projects: projectInfo(rows) };
}

export function renderGlobalHtml(payload) {
  // keep the inline <script> safe
  const json = JSON.stringify(payload).replace(/</g, '\\u003c').replace(new RegExp('\\u2028|\\u2029', 'g'), (m) => (m === '\u2028' ? '\\u2028' : '\\u2029'));
  return readFileSync(join(here, '..', 'assets', 'global.html'), 'utf8').replace('__DATA__', () => json);
}

export function writeGlobalReport(outFile, payload) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, renderGlobalHtml(payload), 'utf8');
  return outFile;
}

// ---------- served mode: a session opens its project's report, built when asked for ----------

const PORT_TRIES = 20;

/**
 * Serves the global page on localhost. Opening a session loads
 * /project?dir=<folder>#session/<id>: the project report (diagram, insights,
 * runtime with the session's flow) built from the sessions already in memory,
 * scanning that folder on first use.
 * @param {{ port: number, strict?: boolean, payload: object, traces: import('./runtime/model.mjs').Trace[], mcpServers: object[], sources: string[], since: string }} opts
 * @returns {Promise<{ url: string, close: () => void }>}
 */
export async function serveGlobal({ port: first, strict = false, payload, traces, mcpServers, sources, since }) {
  const html = renderGlobalHtml({ ...payload, live: true });
  // only folders that sessions ran in: a path from the URL is never read unless it is one of them
  const known = new Set([...walkTraces(traces)].map((t) => t.directory).filter(Boolean));
  const reports = new Map();

  const projectReport = (root) => {
    if (!reports.has(root)) {
      // a folder deleted since (a worktree, say) still has its sessions: show them without a map
      const docs = existsSync(root) ? scan(root).docs : [];
      const graph = buildGraph(docs);
      const inRoot = traces.filter((t) => t.directory === root || t.directory.startsWith(root.endsWith(sep) ? root : root + sep));
      const runtime = { source: sources.join('+'), sources, since, thinking: false, traces: inRoot, analysis: analyzeRuntime(inRoot, { mcpServers }) };
      const data = buildPayload({ root, docs, graph, analysis: analyze(graph), runtime });
      data.meta.live = false;
      data.meta.embed = true;
      reports.set(root, renderReport(data));
    }
    return reports.get(root);
  };

  const server = createServer((req, res) => {
    // a page on another site can't reach us through a rebound DNS name
    const port = server.address().port;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) { res.writeHead(403).end(); return; }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } else if (url.pathname === '/project') {
      const dir = url.searchParams.get('dir') || '';
      if (!known.has(dir)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Unknown project: it has no sessions in this run.'); return; }
      try {
        const page = projectReport(dir);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(page);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(`Could not build the report: ${err.message}`);
      }
    } else if (url.pathname === '/__skillmap') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ tool: 'skillmap', root: 'global' }));
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
      if (i === tries - 1) throw new Error(strict ? `port ${first} is in use (pick another with --port)` : `ports ${first}-${first + i} are in use (pick one with --port)`);
    }
  }
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}
