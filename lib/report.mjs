// skillmap — report generator. Builds a single self-contained HTML file.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, '..', 'assets');

export function buildPayload({ root, docs, graph, analysis, runtime = null }) {
  const nodes = graph.nodes.map((n) => {
    const { tokens, tokenSet, frontmatter, body, abs, ...rest } = n;
    return rest;
  });
  return {
    meta: {
      tool: 'skillmap',
      version: '0.1.0',
      root,
      projectLabel: basename(root),
      generatedAt: new Date().toISOString(),
      counts: {
        docs: docs.length,
        skills: docs.filter((d) => d.kind === 'skill').length,
        agents: docs.filter((d) => d.kind === 'agent').length,
        instructions: docs.filter((d) => d.kind === 'instructions').length,
        edges: graph.edges.length,
      },
    },
    nodes,
    edges: graph.edges,
    analysis,
    runtime,
  };
}

export function renderHtml(payload) {
  let json = JSON.stringify(payload);
  // keep the inline <script> safe
  json = json.replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, (m) => (m === '\u2028' ? '\\u2028' : '\\u2029'));

  const css = readFileSync(join(assetsDir, 'app.css'), 'utf8');
  const js = readFileSync(join(assetsDir, 'app.js'), 'utf8');
  let html = readFileSync(join(assetsDir, 'template.html'), 'utf8');

  html = html
    .replace('__CSS__', () => css)
    .replace('__JS__', () => js)
    .replace('__DATA__', () => json)
    .replaceAll('__PROJECT__', escapeHtml(payload.meta.projectLabel))
    .replaceAll('__ROOT__', escapeHtml(payload.meta.root));
  return html;
}

export function writeReport(outFile, payload) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, renderHtml(payload), 'utf8');
  return outFile;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
