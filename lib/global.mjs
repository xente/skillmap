// skillmap — global report: every session of every project in one page, with
// tokens and cost over time. A separate page from the per-project report: it
// reads no project folder, only the local session history.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync } from 'node:fs';
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
      out[name] = { description: String(data.description || '').replace(/\s+/g, ' ').trim().slice(0, 220), scope: hit.scope, file: hit.f.startsWith(home) ? '~' + hit.f.slice(home.length) : hit.f };
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
      out[dir] = {
        skills: count('skill'), agents: count('agent'), instructions: count('instructions'),
        skillDefs: docs.filter((d) => d.kind === 'skill').map((d) => ({ name: d.name, description: d.description.slice(0, 160) })),
      };
    } catch { out[dir] = null; }
  }
  return out;
}

/**
 * What is installed, to set against what was used: the skills in the home folder's skill directories
 * and in each project, and the MCP servers that are switched on. Plugin skills are not listed.
 */
function inventoryOf(projects, mcpServers) {
  const home = homedir();
  const skills = new Map();
  for (const sub of HOME_SKILL_DIRS) {
    let entries;
    try { entries = readdirSync(join(home, sub), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const f = join(home, sub, e.name, 'SKILL.md');
      if (skills.has(e.name) || !existsSync(f)) continue;
      let description = '';
      try { description = String(parseFrontmatter(readFileSync(f, 'utf8')).data.description || '').replace(/\s+/g, ' ').trim().slice(0, 160); } catch { /* no description */ }
      skills.set(e.name, { name: e.name, scope: 'global', description, dirs: [] });
    }
  }
  for (const [dir, p] of Object.entries(projects)) {
    for (const d of p?.skillDefs || []) {
      const cur = skills.get(d.name) || skills.set(d.name, { name: d.name, scope: 'project', description: d.description, dirs: [] }).get(d.name);
      if (cur.scope === 'project') cur.dirs.push(dir);
    }
  }
  return {
    skills: [...skills.values()],
    mcp: mcpServers.filter((m) => m.enabled).map((m) => ({ name: m.name, scope: m.scope, type: m.type })),
  };
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
export function buildGlobalPayload(traces, { since, sources, notes = [], mcpServers = [] }) {
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
  const projects = projectInfo(rows);
  const inventory = inventoryOf(projects, mcpServers);
  for (const p of Object.values(projects)) if (p) delete p.skillDefs; // listed once, in the inventory
  return { generatedAt: new Date().toISOString(), since, sources, notes, rows, skills: skillInfo(rows), projects, inventory };
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

// ---------- settings: kept in a file, so they do not depend on the port or the browser ----------

const SETTINGS_FILE = join(homedir(), '.skillmap', 'settings.json');
const SETTINGS_MAX_BYTES = 4096;
const LIMIT_SCOPES = new Set(['all', 'project', 'model', 'agent', 'client']);
const LIMIT_PERIODS = new Set(['day', 'week', 'month', 'session']);
const MAX_LIMITS = 50;
const RANGE_KEY = /^(all|\d{1,5}[mhd]|abs:\d{1,15}:(\d{1,15}|now))$/;

/** Only the settings the page knows, each checked: a file or a request can say anything. */
function cleanSettings(o) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  const money = (v) => (Number.isFinite(Number(v)) ? Math.min(1e7, Math.max(0, Number(v))) : 0);
  if (o.budget && typeof o.budget === 'object') out.budget = { day: money(o.budget.day), week: money(o.budget.week) };
  // cost limits: a scope (everything, or one project, model, agent or client) and a period
  if (Array.isArray(o.limits)) {
    out.limits = o.limits.slice(0, MAX_LIMITS).map((l) => {
      if (!l || typeof l !== 'object' || !LIMIT_SCOPES.has(l.scope) || !LIMIT_PERIODS.has(l.period)) return null;
      const limit = money(l.limit), value = l.scope === 'all' ? '' : String(l.value ?? '').slice(0, 300);
      if (!(limit > 0) || (l.scope !== 'all' && !value)) return null;
      return { id: String(l.id ?? '').replace(/[^\w-]/g, '').slice(0, 40) || Math.random().toString(36).slice(2, 10), scope: l.scope, value, period: l.period, limit };
    }).filter(Boolean);
  }
  // what the automatic checks ignore: sessions and days that cost less than this
  if (o.floors && typeof o.floors === 'object') out.floors = { session: money(o.floors.session), day: money(o.floors.day) };
  if (typeof o.range === 'string' && RANGE_KEY.test(o.range)) out.range = o.range;
  if (o.theme === 'light' || o.theme === 'dark') out.theme = o.theme;
  return out;
}
function readSettings() {
  try { return cleanSettings(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))); } catch { return {}; }
}
function writeSettings(settings) {
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
  const tmp = SETTINGS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  renameSync(tmp, SETTINGS_FILE);
}
const REFRESH_MS = 4000;
const SKILL_TEXT_CHARS = 20000;

/**
 * Serves the global page on localhost. Opening a session loads
 * /project?dir=<folder>#session/<id>: the project report (diagram, insights,
 * runtime with the session's flow) built from the sessions already in memory,
 * scanning that folder on first use.
 * `reload` re-reads the sessions; /data serves the fresh payload so the page can keep up with running agents.
 * @param {{ port: number, strict?: boolean, payload: object, traces: import('./runtime/model.mjs').Trace[], mcpServers: object[], sources: string[], since: string, reload?: () => Promise<{ traces: object[], mcpServers: object[], sources: string[], notes: string[] }> }} opts
 * @returns {Promise<{ url: string, close: () => void }>}
 */
export async function serveGlobal({ port: first, strict = false, payload, traces, mcpServers, sources, since, reload }) {
  let settings = readSettings();
  // read at every load: the page starts from what was saved last, whatever port it ran on
  const page = () => {
    const out = renderGlobalHtml({ ...payload, live: true, settings });
    return settings.theme ? out.replace('<html lang="en">', `<html lang="en" data-theme="${settings.theme}">`) : out;
  };
  // only folders that sessions ran in: a path from the URL is never read unless it is one of them
  let known = new Set([...walkTraces(traces)].map((t) => t.directory).filter(Boolean));
  let reports = new Map();
  let fresh = { at: Date.now(), json: null };
  let skills = payload.skills || {};
  let loading = null;

  // sessions re-read at most every few seconds, however many pages ask
  const refreshed = async () => {
    if (!reload) return null;
    if (fresh.json && Date.now() - fresh.at < REFRESH_MS) return fresh.json;
    loading ||= (async () => {
      const next = await reload();
      traces = next.traces; mcpServers = next.mcpServers; sources = next.sources;
      known = new Set([...walkTraces(traces)].map((t) => t.directory).filter(Boolean));
      reports = new Map();
      const nextPayload = buildGlobalPayload(traces, { since, sources, notes: next.notes, mcpServers });
      skills = nextPayload.skills || {};
      fresh = { at: Date.now(), json: JSON.stringify(nextPayload) };
      return fresh.json;
    })().finally(() => { loading = null; });
    return loading;
  };

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
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/settings') {
      // a custom header makes a cross-site form or fetch fail its preflight; an Origin that is not this server is refused too
      const origin = req.headers.origin;
      if (req.headers['x-skillmap'] !== '1' || (origin && origin !== `http://${req.headers.host}`)) { res.writeHead(403).end(); return; }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > SETTINGS_MAX_BYTES) { res.writeHead(413).end(); req.destroy(); } });
      req.on('end', () => {
        if (res.writableEnded) return;
        try {
          settings = { ...settings, ...cleanSettings(JSON.parse(body)) };
          writeSettings(settings);
          res.writeHead(204).end();
        } catch (err) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Bad settings');
        }
      });
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page());
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
    } else if (url.pathname === '/data') {
      refreshed().then((json) => {
        if (!json) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(json);
      }, (err) => res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(`Could not reload: ${err.message}`));
    } else if (url.pathname === '/skill') {
      // only the SKILL.md of a skill the sessions loaded: the name is looked up, never used as a path
      const file = (skills[url.searchParams.get('name') || ''])?.file;
      if (!file) { res.writeHead(404).end(); return; }
      try {
        const text = readFileSync(file.startsWith('~') ? homedir() + file.slice(1) : file, 'utf8');
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ text: text.slice(0, SKILL_TEXT_CHARS), truncated: text.length > SKILL_TEXT_CHARS }));
      } catch { res.writeHead(404).end(); }
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
