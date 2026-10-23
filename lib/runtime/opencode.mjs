// skillmap — OpenCode runtime adapter.
// Reads OpenCode's local SQLite store (read-only) and turns sessions into the
// normalized trace model described in model.mjs. Needs Node 22.5+ (node:sqlite).

import { existsSync, readFileSync } from 'node:fs';
import { join, sep, dirname } from 'node:path';
import { homedir } from 'node:os';
import { makeTrace, makeSpan, spanKind, MCP_RESOURCES } from './model.mjs';

export const RUNTIME = 'opencode';

export function defaultDbPath() {
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'opencode', 'opencode.db');
}

async function openDb(dbPath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new Error(`reading OpenCode sessions needs Node 22.5+ (node:sqlite); you are on ${process.version}`);
  }
  if (!existsSync(dbPath)) throw new Error(`OpenCode database not found at ${dbPath} (use --db)`);
  return new DatabaseSync(dbPath, { readOnly: true });
}

const THINKING_CHARS = 4000; // per reasoning block, when includeThinking is on
const OUTPUT_CHARS = 1500;   // per assistant text block

const inside = (dir, root) => dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Load OpenCode sessions as normalized traces.
 * @param {{ root?: string, all?: boolean, since?: number, dbPath?: string, includeThinking?: boolean }} opts
 *   root   — only sessions started in this folder (or below it)
 *   all    — ignore root, load every project
 *   since  — epoch ms; only sessions created after it
 *   includeThinking — keep the model's reasoning text (large, may hold sensitive details)
 * @returns {Promise<import('./model.mjs').Trace[]>} top-level traces (subagent sessions nested under `children`)
 */
export async function loadTraces({ root, all = false, since = 0, dbPath = defaultDbPath(), includeThinking = false } = {}) {
  const db = await openDb(dbPath);
  try {
    // OpenCode moved to session_v2 + session_message (Sept 2026). The migration
    // copies old sessions over, so when the new tables exist they are the full history.
    const hasV2 = db.prepare(`select count(*) n from sqlite_master where type = 'table' and name in ('session_v2', 'session_message')`).get().n === 2;
    const sessionTable = hasV2 ? 'session_v2' : 'session';

    const sessions = db.prepare(`
      select id, parent_id, title, directory, agent, model, cost, time_created, time_updated
      from ${sessionTable} where time_created >= ?`).all(since);

    // A subagent session lives in the parent's directory, so filtering top-level
    // sessions by root and then pulling in their descendants keeps trees whole.
    const byParent = new Map();
    const known = new Set(sessions.map((s) => s.id));
    for (const s of sessions) {
      if (!s.parent_id) continue;
      if (!byParent.has(s.parent_id)) byParent.set(s.parent_id, []);
      byParent.get(s.parent_id).push(s);
    }
    const wanted = [];
    const collect = (s) => { wanted.push(s); for (const c of byParent.get(s.id) || []) collect(c); };
    for (const s of sessions) {
      if (s.parent_id && known.has(s.parent_id)) continue;
      if (all || !root || inside(s.directory, root)) collect(s);
    }
    if (!wanted.length) return [];

    const ids = wanted.map((s) => s.id);
    const thinkChars = includeThinking ? THINKING_CHARS : 0;
    const { messages, parts } = hasV2 ? readV2(db, ids, thinkChars) : readLegacy(db, ids, thinkChars);
    const mcpNames = loadMcpServers({ root, all, dirs: wanted.map((s) => s.directory) }).map((m) => m.name);
    return buildTraces(wanted, messages, parts, mcpNames);
  } finally {
    db.close();
  }
}

// Both readers return rows with the same columns, so buildTraces is shared.
//   messages: id, session_id, time_created, role, agent, model, variant, finish, error ('aborted' | other | null),
//             completed, tin, tout, treason, tcread, tcwrite, cost
//   parts:    id, session_id, message_id, time_created, type ('text' | 'tool' | 'reasoning'), tool, call_id, status, error,
//             output_len, child_session, t_start, t_end, in_*, text, synthetic, attached (JSON: names the user @-attached),
//             nested (JSON: [{tool, status}] tools a tool called itself — OpenCode's `execute` runs code that calls MCP tools)

function readLegacy(db, ids, thinkChars) {
  const ph = ids.map(() => '?').join(',');
  const messages = db.prepare(`
    select id, session_id, time_created,
           json_extract(data, '$.role') role,
           json_extract(data, '$.agent') agent,
           json_extract(data, '$.modelID') model,
           null variant,
           json_extract(data, '$.finish') finish,
           case json_extract(data, '$.error.name') when 'MessageAbortedError' then 'aborted' else json_extract(data, '$.error.name') end error,
           json_extract(data, '$.time.completed') completed,
           json_extract(data, '$.tokens.input') tin,
           json_extract(data, '$.tokens.output') tout,
           json_extract(data, '$.tokens.reasoning') treason,
           json_extract(data, '$.tokens.cache.read') tcread,
           json_extract(data, '$.tokens.cache.write') tcwrite,
           json_extract(data, '$.cost') cost
    from message where session_id in (${ph})
    order by session_id, time_created, id`).all(...ids);

  // Only pull the fields we need — tool outputs and written file bodies can be huge.
  const parts = db.prepare(`
    select id, session_id, message_id, time_created,
           json_extract(data, '$.type') type,
           json_extract(data, '$.tool') tool,
           json_extract(data, '$.callID') call_id,
           json_extract(data, '$.state.status') status,
           substr(json_extract(data, '$.state.error'), 1, 300) error,
           length(json_extract(data, '$.state.output')) output_len,
           json_extract(data, '$.state.metadata.sessionId') child_session,
           coalesce(json_extract(data, '$.state.time.start'), json_extract(data, '$.time.start')) t_start,
           coalesce(json_extract(data, '$.state.time.end'), json_extract(data, '$.time.end')) t_end,
           ${inputColumns('data')},
           case json_extract(data, '$.type')
             when 'text' then substr(json_extract(data, '$.text'), 1, 2000)
             when 'reasoning' then substr(json_extract(data, '$.text'), 1, ${thinkChars}) end text,
           json_extract(data, '$.synthetic') synthetic,
           null attached,
           ${nestedColumn('data')}
    from part where session_id in (${ph}) and json_extract(data, '$.type') in ('tool', 'text', 'reasoning')
    order by session_id, time_created, id`).all(...ids);
  return { messages, parts };
}

function readV2(db, ids, thinkChars) {
  const ph = ids.map(() => '?').join(',');
  const messages = db.prepare(`
    select id, session_id, time_created,
           type role,
           json_extract(data, '$.agent') agent,
           json_extract(data, '$.model.id') model,
           json_extract(data, '$.model.variant') variant,
           json_extract(data, '$.finish') finish,
           json_extract(data, '$.error.type') error,
           json_extract(data, '$.time.completed') completed,
           json_extract(data, '$.tokens.input') tin,
           json_extract(data, '$.tokens.output') tout,
           json_extract(data, '$.tokens.reasoning') treason,
           json_extract(data, '$.tokens.cache.read') tcread,
           json_extract(data, '$.tokens.cache.write') tcwrite,
           json_extract(data, '$.cost') cost
    from session_message where session_id in (${ph}) and type in ('user', 'assistant')
    order by session_id, seq`).all(...ids);

  // User prompts and tool calls, in conversation order. Tool calls are items of
  // an assistant message's content array; skills/agents the user @-attached
  // are listed on the user message itself.
  const parts = db.prepare(`
    select * from (
      select m.id id, m.session_id, m.id message_id, m.time_created, m.seq, -1 idx,
             'text' type, null tool, null call_id, null status, null error, 0 output_len, null child_session,
             null t_start, null t_end,
             null in_file, null in_path, null in_pattern, null in_command, null in_description,
             null in_subagent, null in_name, null in_prompt, null in_url, null in_query,
             substr(json_extract(m.data, '$.text'), 1, 2000) text, 0 synthetic,
             json_array(
               (select json_group_array(coalesce(json_extract(s.value, '$.name'), s.value)) from json_each(m.data, '$.skills') s),
               (select json_group_array(coalesce(json_extract(a.value, '$.name'), a.value)) from json_each(m.data, '$.agents') a)
             ) attached,
             null nested
      from session_message m where m.session_id in (${ph}) and m.type = 'user'
      union all
      select m.id || ':' || c.key, m.session_id, m.id, m.time_created, m.seq, c.key,
             json_extract(c.value, '$.type'), json_extract(c.value, '$.name'), json_extract(c.value, '$.id'),
             json_extract(c.value, '$.state.status'),
             substr(json_extract(c.value, '$.state.error.message'), 1, 300),
             coalesce(length(json_extract(c.value, '$.state.content')), length(json_extract(c.value, '$.text'))),
             coalesce(json_extract(c.value, '$.state.metadata.sessionID'), json_extract(c.value, '$.state.metadata.sessionId')),
             json_extract(c.value, '$.time.created'), json_extract(c.value, '$.time.completed'),
             ${inputColumns('c.value')},
             case json_extract(c.value, '$.type')
               when 'text' then substr(json_extract(c.value, '$.text'), 1, ${OUTPUT_CHARS})
               when 'reasoning' then substr(json_extract(c.value, '$.text'), 1, ${thinkChars}) end,
             0, null,
             ${nestedColumn('c.value')}
      from session_message m, json_each(m.data, '$.content') c
      where m.session_id in (${ph}) and m.type = 'assistant' and json_extract(c.value, '$.type') in ('tool', 'reasoning', 'text')
    ) order by session_id, seq, idx`).all(...ids, ...ids);
  return { messages, parts };
}

// Only the tool name and status of nested calls: their inputs can hold anything.
function nestedColumn(col) {
  return `(select json_group_array(json_object('tool', json_extract(n.value, '$.tool'), 'status', json_extract(n.value, '$.status')))
            from json_each(json_extract(${col}, '$.state.metadata.toolCalls')) n) nested`;
}

function inputColumns(col) {
  const f = (path) => `json_extract(${col}, '$.state.input.${path}')`;
  return [
    `${f('filePath')} in_file`,
    `${f('path')} in_path`,
    `${f('pattern')} in_pattern`,
    `substr(coalesce(${f('command')}, ${f('code')}), 1, 300) in_command`,
    `${f('description')} in_description`,
    `coalesce(${f('subagent_type')}, ${f('agent')}) in_subagent`,
    `coalesce(${f('name')}, ${f('id')}) in_name`,
    `substr(${f('prompt')}, 1, 1500) in_prompt`,
    `${f('url')} in_url`,
    `${f('query')} in_query`,
  ].join(',\n           ');
}

function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(r);
  }
  return m;
}

function buildTraces(sessions, messages, parts, mcpNames) {
  const msgsBySession = groupBy(messages, 'session_id');
  const partsBySession = groupBy(parts, 'session_id');
  const traces = new Map();

  for (const s of sessions) {
    const msgs = msgsBySession.get(s.id) || [];
    const msgById = new Map(msgs.map((m) => [m.id, m]));
    const assistant = msgs.filter((m) => m.role === 'assistant');
    const last = assistant[assistant.length - 1];

    const trace = makeTrace({
      runtime: RUNTIME,
      id: s.id,
      parentId: s.parent_id || null,
      title: s.title,
      directory: s.directory,
      agent: s.agent || assistant[0]?.agent || null,
      model: modelName(s.model) || assistant[0]?.model || null,
      // reasoning variant ('high', 'medium', 'default'…); null when the runtime doesn't record it
      variant: modelVariant(s.model) || assistant[0]?.variant || null,
      start: msgs[0]?.time_created ?? s.time_created,
      end: Math.max(...msgs.map((m) => m.completed || m.time_created), s.time_created),
      tokens: {
        input: sum(assistant, 'tin'),
        output: sum(assistant, 'tout'),
        reasoning: sum(assistant, 'treason'),
        cacheRead: sum(assistant, 'tcread'),
        cacheWrite: sum(assistant, 'tcwrite'),
      },
      cost: sum(assistant, 'cost') || s.cost || 0,
      // time the agent was actually working, without the user's think time between turns
      activeMs: assistant.reduce((n, m) => n + Math.max(0, (m.completed || m.time_created) - m.time_created), 0),
      stepCount: assistant.length,
      outcome: last?.error === 'aborted' ? 'aborted'
        : last?.error ? 'error'
        : last?.finish === 'stop' ? 'completed'
        : last ? 'incomplete' : 'empty',
    });

    // one step per assistant message = one model call
    const stepOf = new Map();
    for (const m of assistant) {
      const step = {
        index: trace.steps.length,
        turn: 0,
        start: m.time_created,
        end: m.completed || m.time_created,
        tokens: { context: (Number(m.tin) || 0) + (Number(m.tcread) || 0) + (Number(m.tcwrite) || 0), output: Number(m.tout) || 0, reasoning: Number(m.treason) || 0 },
        cost: Number(m.cost) || 0,
        finish: m.finish || null,
        model: m.model || null,
        variant: m.variant || null,
        error: m.error || null,
        items: [],
      };
      trace.steps.push(step);
      stepOf.set(m.id, step);
    }

    let turn = -1;
    for (const p of partsBySession.get(s.id) || []) {
      const msg = msgById.get(p.message_id);
      const step = stepOf.get(p.message_id);
      if (step) step.turn = Math.max(turn, 0);
      if (p.type === 'reasoning') {
        if (p.t_start && p.t_end) {
          const th = { turn: Math.max(turn, 0), step: step?.index ?? null, start: p.t_start, end: p.t_end };
          if (p.text) th.text = p.text;
          trace.thinking.push(th);
          step?.items.push({ type: 'think', start: th.start, end: th.end, ref: trace.thinking.length - 1 });
        }
        continue;
      }
      if (p.type === 'text') {
        if (msg?.role === 'user' && !p.synthetic && p.text) {
          turn++;
          const [skills, agents] = p.attached ? JSON.parse(p.attached) : [[], []];
          trace.prompts.push({ turn, at: p.time_created, text: p.text, attached: [...(skills || []), ...(agents || [])] });
        } else if (step && p.text) {
          // v2 text blocks carry no time: place them right after the previous item
          const after = step.items.length ? step.items[step.items.length - 1].end : step.start;
          step.items.push({ type: 'text', start: p.t_start ?? after, end: p.t_end ?? p.t_start ?? after, text: p.text.slice(0, OUTPUT_CHARS) });
        }
        continue;
      }
      step?.items.push({ type: normalizeTool(p.tool) === 'agent' ? 'agent' : p.tool === 'question' ? 'ask' : 'tool', start: p.t_start ?? p.time_created, end: p.t_end ?? p.time_created, ref: p.call_id || p.id });
      const calls = nestedCalls(p.nested);
      const servers = [...new Set(calls.map((c) => c.server).filter(Boolean))];
      const mcp = mcpServerOf(p.tool, mcpNames) || servers.join(', ') || null;
      trace.spans.push(makeSpan({
        id: p.call_id || p.id,
        traceId: s.id,
        turn: Math.max(turn, 0),
        kind: mcp ? 'mcp' : spanKind(normalizeTool(p.tool)),
        mcp,
        calls,
        name: spanName(p),
        tool: normalizeTool(p.tool),
        status: p.status === 'error' ? 'error' : p.status === 'completed' ? 'ok' : 'pending',
        error: p.error ? p.error.split('\n')[0] : null,
        start: p.t_start ?? p.time_created,
        end: p.t_end ?? p.time_created,
        outputSize: p.output_len || 0,
        childTraceId: p.child_session || null,
        input: compactInput(p),
      }));
    }
    // per-turn usage, so a subagent session reused for several delegations can be split
    for (const m of assistant) {
      const turnOf = trace.prompts.filter((p) => p.at <= m.time_created).pop()?.turn ?? 0;
      const u = trace.turns[turnOf] || (trace.turns[turnOf] = { turn: turnOf, tokens: 0, cost: 0, activeMs: 0, outcome: 'incomplete' });
      u.tokens += (Number(m.tin) || 0) + (Number(m.tout) || 0) + (Number(m.treason) || 0) + (Number(m.tcread) || 0) + (Number(m.tcwrite) || 0);
      u.cost += Number(m.cost) || 0;
      u.activeMs += Math.max(0, (m.completed || m.time_created) - m.time_created);
      u.outcome = m.error === 'aborted' ? 'aborted' : m.error ? 'error' : m.finish === 'stop' ? 'completed' : 'incomplete';
    }
    for (const st of trace.steps) splitStepTime(st);
    for (const th of trace.thinking) if (trace.turns[th.turn]) trace.turns[th.turn].thinkMs = (trace.turns[th.turn].thinkMs || 0) + th.end - th.start;
    trace.turns = trace.turns.filter(Boolean);
    traces.set(s.id, trace);
  }

  // nest subagent traces under their parent
  const roots = [];
  for (const t of traces.values()) {
    const parent = t.parentId && traces.get(t.parentId);
    if (parent) parent.children.push(t);
    else roots.push(t);
  }
  return roots.sort((a, b) => a.start - b.start);
}

// Where a model call's time went. wait = before the model produced anything
// (queue, provider latency, prompt processing); write = output text and gaps.
function splitStepTime(step) {
  const dur = Math.max(0, step.end - step.start);
  // union, not sum: parallel tool calls overlap
  const sumOf = (type) => {
    const iv = step.items.filter((i) => i.type === type).map((i) => [i.start, Math.max(i.start, i.end || i.start)]).sort((a, b) => a[0] - b[0]);
    let total = 0, cur = null;
    for (const [a, b] of iv) {
      if (!cur || a > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [a, b]; } else cur[1] = Math.max(cur[1], b);
    }
    return cur ? total + cur[1] - cur[0] : 0;
  };
  const first = step.items.length ? Math.min(...step.items.map((i) => i.start)) : step.end;
  step.thinkMs = sumOf('think');
  step.toolMs = sumOf('tool');
  step.agentMs = sumOf('agent'); // waiting on subagents — their own steps hold that time
  step.userMs = sumOf('ask');    // waiting on the user to answer a question
  step.waitMs = Math.max(0, Math.min(dur, first - step.start));
  step.writeMs = Math.max(0, dur - step.thinkMs - step.toolMs - step.agentMs - step.userMs - step.waitMs);
}

// OpenCode tool names → the shared vocabulary in model.mjs
function normalizeTool(tool) {
  if (tool === 'task' || tool === 'subagent') return 'agent';
  if (tool === 'shell') return 'bash';
  if (tool === 'skill') return 'skill';
  return tool || 'unknown';
}

// OpenCode's own tools; anything else came from an MCP server or a plugin
const BUILTIN = new Set(['bash', 'shell', 'read', 'write', 'edit', 'patch', 'apply_patch', 'multiedit', 'list', 'glob', 'grep',
  'webfetch', 'websearch', 'codesearch', 'todowrite', 'todoread', 'task', 'subagent', 'skill', 'question', 'lsp', 'batch', 'execute', 'invalid']);
const MCP_RESOURCE_TOOLS = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);

/**
 * The MCP server a tool belongs to, or null. OpenCode names MCP tools
 * `<server>_<tool>` with anything outside [A-Za-z0-9_-] turned into `_`.
 * Servers no longer in the config are guessed from the prefix.
 */
function mcpServerOf(tool, names) {
  if (!tool || BUILTIN.has(tool)) return null;
  if (MCP_RESOURCE_TOOLS.has(tool)) return MCP_RESOURCES;
  const match = names
    .filter((n) => tool.startsWith(n.replace(/[^a-zA-Z0-9_-]/g, '_') + '_'))
    .sort((a, b) => b.length - a.length)[0];
  if (match) return match;
  const i = tool.indexOf('_');
  return i > 0 ? tool.slice(0, i) : null;
}

/**
 * Tools that OpenCode's `execute` tool called from the code it ran, named
 * `<server>.<tool>`. `opencode.*` are OpenCode's own; names without a dot
 * (fetch, search) are built into execute.
 * @returns {{ tool: string, server: string|null, status: 'ok'|'error'|'pending' }[]}
 */
function nestedCalls(json) {
  let list;
  try { list = JSON.parse(json || '[]'); } catch { return []; }
  return list.filter((c) => c && c.tool).map((c) => {
    const i = c.tool.indexOf('.');
    const prefix = i > 0 ? c.tool.slice(0, i) : null, name = i > 0 ? c.tool.slice(i + 1) : c.tool;
    const server = prefix === 'opencode' ? (MCP_RESOURCE_TOOLS.has(name) ? MCP_RESOURCES : null) : prefix;
    return { tool: name, server, status: c.status === 'error' ? 'error' : c.status === 'completed' ? 'ok' : 'pending' };
  });
}

const PROJECT_CONFIGS = ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc'];

/**
 * MCP servers from OpenCode's config: global (~/.config/opencode), plus the
 * project configs OpenCode would load for each session folder (that folder and
 * its parents, up to `root`). Only names and switches are kept — the command,
 * URL, headers and environment can hold secrets and never leave here.
 * @param {{ root?: string, all?: boolean, dirs?: string[] }} opts  dirs: session folders
 * @returns {{ name: string, type: string|null, enabled: boolean, scope: 'global'|'project' }[]}
 */
export function loadMcpServers({ root, all = false, dirs = [] } = {}) {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const projectDirs = new Set();
  for (const d of new Set([...(all || !root ? [] : [root]), ...dirs])) {
    const stop = !all && root && inside(d, root) ? root : homedir();
    for (let cur = d; cur && !projectDirs.has(cur); cur = dirname(cur)) {
      if (cur !== homedir()) projectDirs.add(cur);
      if (cur === stop || dirname(cur) === cur) break;
    }
  }
  // parents first, so a deeper config overrides the same server name
  const ordered = [...projectDirs].sort((a, b) => a.length - b.length);
  const files = [
    ...['opencode.json', 'opencode.jsonc', 'config.json'].map((f) => ['global', join(configHome, 'opencode', f)]),
    ...(process.env.OPENCODE_CONFIG ? [['global', process.env.OPENCODE_CONFIG]] : []),
    ...ordered.flatMap((d) => PROJECT_CONFIGS.map((f) => ['project', join(d, f)])),
  ];
  const servers = new Map(); // later files override earlier ones, like OpenCode does
  for (const [scope, file] of files) {
    if (!existsSync(file)) continue;
    let config;
    try { config = JSON.parse(stripJsonc(readFileSync(file, 'utf8'))); } catch { continue; }
    // `mcp: { name: {…} }`, or `mcp: { servers: { name: {…} } }` as some configs nest it
    const block = config?.mcp || {};
    const isServer = (d) => d && typeof d === 'object' && ('type' in d || 'command' in d || 'url' in d);
    const defs = block.servers && typeof block.servers === 'object' && !isServer(block.servers) ? block.servers : block;
    for (const [name, def] of Object.entries(defs)) {
      if (!isServer(def)) continue;
      servers.set(name, { name, type: typeof def.type === 'string' ? def.type : null, enabled: def.enabled !== false, scope });
    }
  }
  return [...servers.values()];
}

// Drop // and /* */ comments and trailing commas, leaving strings alone.
function stripJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function spanName(p) {
  if (p.tool === 'task' || p.tool === 'subagent') return p.in_subagent || 'general';
  if (p.tool === 'skill') return p.in_name || 'unknown';
  return p.tool;
}

function compactInput(p) {
  const out = {};
  const set = (k, v) => { if (v != null && v !== '') out[k] = v; };
  set('file', p.in_file || p.in_path);
  set('pattern', p.in_pattern);
  set('command', p.in_command);
  set('description', p.in_description);
  set('prompt', p.in_prompt);
  set('url', p.in_url);
  set('query', p.in_query);
  return out;
}

// v2 stores the session model as JSON ({"id": …, "providerID": …})
function modelVariant(m) {
  if (!m || !m.startsWith('{')) return null;
  try { return JSON.parse(m).variant || 'default'; } catch { return null; }
}

function modelName(m) {
  if (!m || !m.startsWith('{')) return m || null;
  try { return JSON.parse(m).id || null; } catch { return m; }
}

function sum(rows, key) {
  let n = 0;
  for (const r of rows) n += Number(r[key]) || 0;
  return n;
}
