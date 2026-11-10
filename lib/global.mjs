// skillmap — global report: every session of every project in one page, with
// tokens and cost over time. A separate page from the per-project report: it
// reads no project folder, only the local session history.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkTraces, mcpCalls } from './runtime/model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TITLE_CHARS = 120;

const bump = (obj, key, by = 1) => { obj[key] = (obj[key] || 0) + by; };

const SPARK_BUCKETS = 12;

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
  return { generatedAt: new Date().toISOString(), since, sources, notes, rows };
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
