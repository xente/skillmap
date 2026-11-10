// skillmap — global report: every session of every project in one page, with
// tokens and cost over time. A separate page from the per-project report: it
// reads no project folder, only the local session history.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkTraces } from './runtime/model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TITLE_CHARS = 120;

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
