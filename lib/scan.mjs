// skillmap — filesystem scanner.
// Walks a project folder, finds skills / agents / instruction files and
// returns normalized records. Pure Node, no dependencies.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename, sep, extname } from 'node:path';

// Never descend into these — they are noise or generated/vendored trees.
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', 'vendor', '.venv',
  'venv', '__pycache__', 'target', '.gradle', '.idea', '.vscode-test',
  'worktrees', '.worktrees', 'graphify-out', '.terraform', '.serverless',
]);

// Directories that anchor an "AI tooling" scope. The nearest one wins.
const SCOPE_DIRS = {
  '.claude': 'Claude Code',
  '.opencode': 'OpenCode',
  '.codex': 'Codex',
  '.cursor': 'Cursor',
  '.gemini': 'Gemini',
  '.config': 'AGENTS',
  '.github': 'GitHub',
  '.ai': 'AI',
};

const SKILL_FILE = 'skill.md'; // lower-cased compare
// Docs that commonly sit in skills/ or agents/ folders but are not definitions.
const NON_DEFINITION = /^(readme|changelog|license|contributing)\.(md|markdown|mdx)$/i;
const AGENT_EXT = new Set(['.md', '.markdown', '.mdx']);

/** Recursively yield every file path under `root`, skipping ignored dirs. */
export function* walk(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.DS_Store')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.config') {
          // hidden dirs: still descend for the tool scopes we care about
          if (!(entry.name in SCOPE_DIRS)) continue;
        }
        stack.push(full);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }
}

/** Minimal YAML-subset frontmatter parser. Returns { data, body, hasFrontmatter }. */
export function parseFrontmatter(text) {
  const norm = text.replace(/^\uFEFF/, '');
  const m = norm.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: norm, hasFrontmatter: false };
  const body = norm.slice(m[0].length);
  return { data: parseYamlBlock(m[1]), body, hasFrontmatter: true };
}

function unquote(v) {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  return v;
}

/** Parse a small, forgiving subset of YAML: scalars, folded blocks, one map level. */
function parseYamlBlock(src) {
  const data = {};
  const lines = src.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) { i++; continue; }
    const top = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!top) { i++; continue; }
    const key = top[1];
    let rest = top[2];
    const isBlockScalar = /^[>|][+-]?$/.test(rest);
    if (isBlockScalar || rest === '') {
      // collect indented continuation lines (and un-indented `- item` lists)
      const block = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || /^\s+/.test(lines[j]) || (rest === '' && /^-\s/.test(lines[j])))) {
        block.push(lines[j]);
        j++;
      }
      const isMap = block.some((l) => /^\s+[A-Za-z0-9_.-]+\s*:/.test(l));
      if (isBlockScalar) {
        // folded/literal scalar — always text, even if a line looks like `key: value`
        data[key] = block.map((l) => l.trim()).join(' ').trim();
      } else if (block.length && isMap && !block.some((l) => /^\s*-\s/.test(l))) {
        // nested map
        data[key] = parseYamlBlock(block.join('\n'));
      } else if (rest === '' && block.length) {
        // bare key with indented list or fold
        const items = block.map((l) => l.trim()).filter(Boolean);
        const isList = items.every((l) => l.startsWith('-'));
        data[key] = isList ? items.map((l) => unquote(l.replace(/^-\s*/, ''))) : items.join(' ');
      } else {
        data[key] = '';
      }
      i = j;
      continue;
    }
    // inline list [a, b, c]
    if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = rest.slice(1, -1).split(',').map((s) => unquote(s)).filter(Boolean);
    } else {
      data[key] = unquote(rest);
    }
    i++;
  }
  return data;
}

function scopeFor(relPath) {
  const parts = relPath.split(sep);
  for (const p of parts) if (p in SCOPE_DIRS) return SCOPE_DIRS[p];
  return 'Project';
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Classify a single file. Returns a record or null if it is not an AI doc. */
function classify(root, full) {
  const rel = relative(root, full);
  const segs = rel.split(sep);
  const lower = segs.map((p) => p.toLowerCase());
  const ext = extname(full).toLowerCase();
  const base = basename(full);
  const baseLower = base.toLowerCase();

  const isCursorRules = /^\.cursorrules$/i.test(base);
  if (!AGENT_EXT.has(ext) && !isCursorRules) return null;
  if (NON_DEFINITION.test(base)) return null;

  const isSkillFile = baseLower === SKILL_FILE;
  const skillsIdx = lower.indexOf('skills');
  const hasAgentsDir = segs.some((s) => s === 'agents' || s === 'Agents' || s === 'agent');
  const hasAGENTSDir = segs.some((s) => s === 'AGENTS');
  const parent = segs.slice(-2, -1)[0] || '';

  let kind = null;
  if (isSkillFile) {
    kind = 'skill';
  } else if (skillsIdx !== -1) {
    // A skill folder owns everything beneath it. Only the SKILL.md is a node;
    // a single `<scope>/skills/<name>.md` is a one-file skill; anything deeper
    // (references/, scripts/, templates/, examples/…) is part of a skill.
    const after = segs.slice(skillsIdx + 1);
    if (after.length === 1 && ext === '.md') kind = 'skill';
  } else if (hasAgentsDir && ext === '.md') {
    kind = 'agent';
  } else if (hasAGENTSDir && ext === '.md') {
    kind = 'instructions';
  } else if (/^(agents?|claude|gemini|codex)\.md$/i.test(base) || isCursorRules) {
    kind = 'instructions';
  }
  if (!kind) return null;

  let text = '';
  try { text = readFileSync(full, 'utf8'); } catch { return null; }
  const { data, body, hasFrontmatter } = parseFrontmatter(text);

  // Display name: frontmatter name → SKILL.md folder → filename
  let name = data.name ? String(data.name).trim() : '';
  if (!name) {
    if (isSkillFile && parent) name = parent;
    else name = base.replace(/\.(md|markdown|mdx)$/i, '').replace(/^\./, '');
  }

  const description = data.description ? String(data.description).replace(/\s+/g, ' ').trim() : '';
  const tools = normalizeTools(data.tools || data['allowed-tools']);
  const scope = scopeFor(rel);

  return {
    id: slug(name) + '@' + slug(scope) + ':' + slug(rel),
    kind,
    name: String(name),
    slug: slug(name),
    description,
    scope,
    rel,
    abs: full,
    dir: rel.split(sep).slice(0, -1).join(sep),
    isSkillFile,
    frontmatter: data,
    model: data.model ? String(data.model) : '',
    mode: data.mode ? String(data.mode) : '',
    tools,
    commandOnly: data['disable-model-invocation'] === true || data['disable-model-invocation'] === 'true',
    argumentHint: data['argument-hint'] ? String(data['argument-hint']) : '',
    body,
    raw: text,
    hasFrontmatter,
    lines: text.split('\n').length,
    bytes: Buffer.byteLength(text),
  };
}

function normalizeTools(t) {
  if (!t) return [];
  if (Array.isArray(t)) return t.map(String);
  return String(t).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

/** Scan a project folder → { root, docs } */
export function scan(root) {
  if (!existsSync(root)) throw new Error(`Folder not found: ${root}`);
  const st = statSync(root);
  if (!st.isDirectory()) throw new Error(`Not a folder: ${root}`);

  const docs = [];
  const seen = new Set();
  for (const full of walk(root)) {
    const rec = classify(root, full);
    if (!rec) continue;
    if (seen.has(rec.rel)) continue;
    seen.add(rec.rel);
    docs.push(rec);
  }
  docs.sort((a, b) => (a.kind === b.kind ? a.rel.localeCompare(b.rel) : a.kind.localeCompare(b.kind)));
  return { root, docs };
}
