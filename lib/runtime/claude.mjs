// skillmap — Claude Code runtime adapter.
// Reads Claude Code's local session transcripts (read-only JSONL under
// ~/.claude/projects) and turns them into the normalized trace model described
// in model.mjs. Claude Code records no cost, so cost is estimated from list prices.

import { readFile, readdir, stat, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, sep, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { makeTrace, makeSpan, spanKind, MCP_RESOURCES } from './model.mjs';

export const RUNTIME = 'claude-code';

export function defaultConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

const THINKING_CHARS = 4000; // per reasoning block, when includeThinking is on
const OUTPUT_CHARS = 1500;   // per assistant text block
const PROMPT_CHARS = 2000;

const inside = (dir, root) => dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);
const ms = (ts) => (ts ? Date.parse(ts) : NaN);

// Claude Code names a project folder after its path with every non-alphanumeric character as '-'
export const projectKey = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-');

/**
 * Load Claude Code sessions as normalized traces.
 * @param {{ root?: string, all?: boolean, since?: number, configDir?: string, includeThinking?: boolean }} opts
 *   root   — only sessions started in this folder (or below it)
 *   all    — ignore root, load every project
 *   since  — epoch ms; only sessions started after it
 *   includeThinking — keep the model's reasoning text (large, may hold sensitive details)
 * @returns {Promise<import('./model.mjs').Trace[]>} top-level traces (subagent sessions nested under `children`)
 */
export async function loadTraces({ root, all = false, since = 0, configDir = defaultConfigDir(), includeThinking = false } = {}) {
  const thinkChars = includeThinking ? THINKING_CHARS : 0;
  const traces = [];
  for (const dir of await projectDirs({ root, all, configDir })) {
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = join(dir, f);
      if ((await stat(file)).mtimeMs < since) continue; // not touched since: cannot have started after it
      const session = await loadSession(file, thinkChars);
      if (!session || session.start < since) continue;
      if (!all && root && !inside(session.directory, root)) continue;
      traces.push(session);
    }
  }
  return traces.sort((a, b) => a.start - b.start);
}

/** Project folders that can hold sessions started in `root` (or below it). */
export async function projectDirs({ root, all = false, configDir = defaultConfigDir() } = {}) {
  const projects = join(configDir, 'projects');
  if (!existsSync(projects)) throw new Error(`Claude Code sessions not found at ${projects} (set CLAUDE_CONFIG_DIR)`);
  const key = root ? projectKey(root) : null;
  return (await readdir(projects, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && (all || !key || d.name === key || d.name.startsWith(key + '-')))
    .map((d) => join(projects, d.name));
}

/**
 * One session by id, with its subagents. `cwd` (where it was started) finds
 * its folder directly; without it every project folder is searched.
 */
export async function loadSessionById({ sessionId, cwd, configDir = defaultConfigDir(), includeThinking = false }) {
  const projects = join(configDir, 'projects');
  let file = cwd ? join(projects, projectKey(cwd), `${sessionId}.jsonl`) : null;
  if (!file || !existsSync(file)) {
    file = null;
    for (const dir of await projectDirs({ all: true, configDir })) {
      if (existsSync(join(dir, `${sessionId}.jsonl`))) { file = join(dir, `${sessionId}.jsonl`); break; }
    }
  }
  return file ? loadSession(file, includeThinking ? THINKING_CHARS : 0) : null;
}

// For processes that reload the same sessions over and over (--watch, the live
// pane): parsed lines per file (transcripts only grow, so a reload parses just
// the lines appended since the last one) and built traces per session (reused
// while none of its files changed). Off by default: a one-shot run over every
// project would hold all of them in memory for nothing.
let cache = null;
export function enableCache() { cache ??= { lines: new Map(), traces: new Map() }; }

async function readJsonl(file) {
  if (!cache) return parseLines(await readFile(file, 'utf8'), []);
  const { size, mtimeMs } = await stat(file);
  let c = cache.lines.get(file);
  if (c && c.mtimeMs === mtimeMs && c.size === size) return c.entries;
  if (!c || size < c.offset) c = { offset: 0, entries: [] }; // new, or rewritten
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(size - c.offset);
    await fh.read(buf, 0, buf.length, c.offset);
    const end = buf.lastIndexOf(10) + 1; // only whole lines: the last one may be half written
    parseLines(buf.subarray(0, end).toString('utf8'), c.entries);
    c = { offset: c.offset + end, entries: c.entries, size, mtimeMs };
  } finally {
    await fh.close();
  }
  cache.lines.set(file, c);
  return c.entries;
}

function parseLines(text, out) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* a line being written right now */ }
  }
  return out;
}

/** One session file plus its subagent transcripts, nested. */
async function loadSession(file, thinkChars) {
  const id = basename(file, '.jsonl');
  // <session>/subagents/agent-<id>.jsonl, with agent-<id>.meta.json naming the
  // Agent tool call that started it
  const subDir = join(dirname(file), id, 'subagents');
  const sig = cache && `${thinkChars};${await filesSignature(file, subDir)}`;
  const hit = cache?.traces.get(file);
  if (hit && hit.sig === sig) return hit.trace;

  const main = buildTrace(await readJsonl(file), { id, parentId: null, agent: null, thinkChars });
  if (!main) { cache?.traces.set(file, { sig, trace: null }); return null; }

  const subs = [];
  if (existsSync(subDir)) {
    for (const f of await readdir(subDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const agentId = basename(f, '.jsonl').replace(/^agent-/, '');
      let meta = {};
      try { meta = JSON.parse(await readFile(join(subDir, `agent-${agentId}.meta.json`), 'utf8')); } catch { /* older versions write no meta */ }
      const t = buildTrace(await readJsonl(join(subDir, f)), { id: `${id}:${agentId}`, parentId: id, agent: meta.agentType || null, thinkChars });
      if (t) subs.push({ trace: t, agentId, toolUseId: meta.toolUseId || null });
    }
  }

  // link each delegation span to its subagent trace
  const all = [main, ...subs.map((s) => s.trace)];
  const byToolUse = new Map(subs.filter((s) => s.toolUseId).map((s) => [s.toolUseId, s]));
  const byAgentId = new Map(subs.map((s) => [s.agentId, s]));
  const linked = new Set();
  for (const t of all) {
    for (const sp of t.spans) {
      if (sp.kind !== 'agent') continue;
      const sub = byToolUse.get(sp.id) || byAgentId.get(t._agentIds.get(sp.id));
      if (!sub || linked.has(sub)) continue;
      linked.add(sub);
      sp.childTraceId = sub.trace.id;
      sub.trace.parentId = t.id;
      // a background subagent returns at once: the delegation lasts until it finishes
      if (t._async.has(sp.id)) sp.end = Math.max(sp.end, sub.trace.end);
      t.children.push(sub.trace);
    }
  }
  for (const s of subs) if (!linked.has(s)) main.children.push(s.trace);
  for (const t of all) { delete t._agentIds; delete t._async; t.children.sort((a, b) => a.start - b.start); }
  cache?.traces.set(file, { sig, trace: main }); // only once linked: a concurrent load must not get half of it
  return main;
}

/** Sizes and mtimes of a session's files: equal means nothing to rebuild. */
async function filesSignature(file, subDir) {
  const { size, mtimeMs } = await stat(file);
  const parts = [size, mtimeMs];
  if (existsSync(subDir)) {
    for (const f of (await readdir(subDir)).sort()) {
      const s = await stat(join(subDir, f));
      parts.push(f, s.size, s.mtimeMs);
    }
  }
  return parts.join(',');
}

// User entries that are not something the user typed
const NOT_PROMPT = /^(<task-notification|<local-command-|<bash-(input|stdout|stderr)|<system-reminder>|\[Request interrupted)/;
const INTERRUPTED = /^\[Request interrupted/;

function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// "<command-name>/review</command-name><command-args>x</command-args>" → "/review x"
function slashCommand(text) {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
  return { name: name.replace(/^\//, ''), text: args ? `${name} ${args}` : name };
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

function buildTrace(entries, { id, parentId, agent, thinkChars }) {
  const conv = entries.filter((e) => e.type === 'user' || e.type === 'assistant');
  if (!conv.length) return null;
  const titles = { custom: null, ai: null, summary: null };
  for (const e of entries) {
    if (e.type === 'custom-title') titles.custom = e.customTitle;
    else if (e.type === 'ai-title') titles.ai = e.aiTitle;
    else if (e.type === 'summary') titles.summary = e.summary;
  }

  const trace = makeTrace({
    runtime: RUNTIME,
    id,
    parentId,
    title: '',
    directory: conv.find((e) => e.cwd)?.cwd || '',
    client: conv.find((e) => e.entrypoint)?.entrypoint || null,
    agent,
    model: null,
    variant: null,
    start: ms(conv[0].timestamp),
    end: ms(conv[conv.length - 1].timestamp),
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    costEstimated: true,
    activeMs: 0,
    stepCount: 0,
    outcome: 'empty',
  });
  trace._agentIds = new Map(); // tool_use id → subagent id, from the tool result
  trace._async = new Set();    // tool_use ids of background subagents

  // Claude Code writes one line per content block; lines of one model call
  // share message.id and carry the same usage
  const stepById = new Map();
  const pending = new Map(); // tool_use id → { span, item, step }
  let turn = -1, lastAt = trace.start, command = null, stepsAtPrompt = 0;
  const usage = new Map();   // step → { u, model, speed }
  const interruptedAfter = new Set(); // steps the user interrupted

  for (const e of conv) {
    const at = ms(e.timestamp);
    if (Number.isNaN(at)) continue;
    const m = e.message || {};

    if (e.type === 'assistant') {
      let step = stepById.get(m.id);
      if (!step) {
        step = {
          index: trace.steps.length, turn: Math.max(turn, 0), start: lastAt, end: at,
          tokens: { context: 0, output: 0, reasoning: 0 }, cost: 0,
          finish: null, model: m.model && m.model !== '<synthetic>' ? m.model : null,
          variant: e.effort || null, error: e.isApiErrorMessage ? (e.error || 'api_error') : null, items: [],
        };
        trace.steps.push(step);
        stepById.set(m.id || `${at}`, step);
      }
      step.end = Math.max(step.end, at);
      if (m.stop_reason) step.finish = m.stop_reason;
      if (m.usage && step.model) usage.set(step, { u: m.usage, model: step.model, speed: m.usage.speed });
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'thinking' || b.type === 'redacted_thinking') {
          const dur = Number(e.thinkingDurationMs) || 0;
          const text = thinkChars && b.thinking ? b.thinking.slice(0, thinkChars) : '';
          if (!dur && !text) continue;
          const th = { turn: step.turn, step: step.index, start: at - dur, end: at };
          if (text) th.text = text;
          trace.thinking.push(th);
          step.items.push({ type: 'think', start: th.start, end: th.end, ref: trace.thinking.length - 1 });
        } else if (b.type === 'text' && b.text) {
          step.items.push({ type: 'text', start: at, end: at, text: b.text.slice(0, OUTPUT_CHARS) });
        } else if (b.type === 'tool_use') {
          const tool = normalizeTool(b.name);
          const input = b.input || {};
          const span = makeSpan({
            id: b.id, traceId: id, turn: step.turn,
            kind: 'other', mcp: null, calls: [],
            name: tool === 'agent' ? input.subagent_type || 'general-purpose' : tool === 'skill' ? input.skill || input.name || 'unknown' : b.name,
            tool, status: 'pending', error: null, start: at, end: at, outputSize: 0, childTraceId: null,
            input: compactInput(input),
          });
          span._raw = b.name;
          trace.spans.push(span);
          const item = { type: tool === 'agent' ? 'agent' : tool === 'question' || tool === 'exitplanmode' ? 'ask' : 'tool', start: at, end: at, ref: b.id };
          step.items.push(item);
          pending.set(b.id, { span, item, step });
        }
      }
      lastAt = at;
      continue;
    }

    // user entries: tool results, prompts, and Claude Code's own injected messages
    lastAt = at;
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        const p = pending.get(b.tool_use_id);
        if (!p) continue;
        pending.delete(b.tool_use_id);
        const out = resultText(b.content);
        p.span.end = p.item.end = at;
        p.step.end = Math.max(p.step.end, at);
        p.span.status = b.is_error ? 'error' : 'ok';
        if (b.is_error) p.span.error = out.replace(/<\/?tool_use_error>/g, '').trim().split('\n')[0].slice(0, 300) || 'error';
        p.span.outputSize = out.length;
        const r = e.toolUseResult;
        if (r && typeof r === 'object' && r.agentId) {
          trace._agentIds.set(b.tool_use_id, r.agentId);
          if (r.status === 'async_launched' || r.isAsync) trace._async.add(b.tool_use_id);
        }
      }
    }
    const text = userText(m.content);
    if (!text) continue;
    if (INTERRUPTED.test(text) && trace.steps.length) interruptedAfter.add(trace.steps[trace.steps.length - 1]);
    // a skill run as a slash command arrives as an injected message right after the command
    if (e.isMeta && text.startsWith('Base directory for this skill:') && command) {
      const name = basename(text.split('\n')[0].replace('Base directory for this skill:', '').trim()) || command.name;
      const prompt = trace.prompts[trace.prompts.length - 1];
      if (prompt && !prompt.attached.includes(name)) prompt.attached.push(name);
      trace.spans.push(makeSpan({
        id: e.uuid || `${id}:skill:${at}`, traceId: id, turn: Math.max(turn, 0), kind: 'skill', mcp: null, calls: [],
        name, tool: 'skill', status: 'ok', error: null, start: at, end: at, outputSize: text.length, childTraceId: null, input: {},
      }));
      command = null;
      continue;
    }
    // a built-in command (/model, /clear…) answers locally: not a prompt to the model
    if (/^<local-command-(stdout|stderr)/.test(text) && command && trace.steps.length === stepsAtPrompt) {
      trace.prompts.pop();
      turn--;
      command = null;
      continue;
    }
    if (e.isMeta || e.isCompactSummary || e.toolUseResult || NOT_PROMPT.test(text)) continue;
    const cmd = slashCommand(text);
    command = cmd;
    stepsAtPrompt = trace.steps.length;
    turn++;
    trace.prompts.push({ turn, at, text: (cmd ? cmd.text : text).slice(0, PROMPT_CHARS), attached: [] });
  }

  // MCP servers and kinds, now that every span is known
  for (const sp of trace.spans) {
    if (sp.kind === 'skill' && !sp._raw) continue;
    const mcp = mcpServerOf(sp._raw);
    sp.mcp = mcp;
    sp.kind = mcp ? 'mcp' : spanKind(sp.tool);
    delete sp._raw;
  }

  for (const st of trace.steps) {
    const x = usage.get(st);
    if (x) {
      const t = tokensOf(x.u);
      st.tokens = { context: t.input + t.cacheRead + t.cacheWrite, output: t.output, reasoning: t.reasoning };
      st.cost = estimateCost(x.model, x.u, x.speed);
      for (const k of Object.keys(trace.tokens)) trace.tokens[k] += t[k];
      trace.cost += st.cost;
    }
    splitStepTime(st);
  }

  // waiting on you (a question, plan approval) is not time the agent worked
  const busy = (st) => Math.max(0, st.end - st.start - (st.userMs || 0));
  const outcomeOf = (st) => interruptedAfter.has(st) ? 'aborted'
    : st.error ? 'error'
    : st.finish === 'end_turn' || st.finish === 'stop_sequence' ? 'completed'
    : 'incomplete';
  for (const st of trace.steps) {
    const u = trace.turns[st.turn] || (trace.turns[st.turn] = { turn: st.turn, tokens: 0, cost: 0, activeMs: 0, outcome: 'incomplete' });
    u.tokens += st.tokens.context + st.tokens.output + st.tokens.reasoning;
    u.cost += st.cost;
    u.activeMs += busy(st);
    u.outcome = outcomeOf(st);
  }
  for (const th of trace.thinking) if (trace.turns[th.turn]) trace.turns[th.turn].thinkMs = (trace.turns[th.turn].thinkMs || 0) + th.end - th.start;
  trace.turns = trace.turns.filter(Boolean);

  const assistant = trace.steps.filter((st) => st.model);
  const last = trace.steps[trace.steps.length - 1];
  trace.model = assistant[0]?.model || null;
  trace.variant = assistant[0]?.variant || null;
  trace.stepCount = trace.steps.length;
  trace.activeMs = trace.steps.reduce((n, st) => n + busy(st), 0);
  trace.end = Math.max(trace.end, ...trace.spans.map((s) => s.end));
  trace.outcome = last ? outcomeOf(last) : 'empty';
  trace.title = titles.custom || titles.ai || titles.summary || trace.prompts[0]?.text.split('\n')[0].slice(0, 80) || id;
  return trace;
}

// Where a model call's time went; same split as the OpenCode adapter. A step
// here runs from the entry that triggered it until its last tool result.
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
  step.agentMs = sumOf('agent');
  step.userMs = sumOf('ask');
  step.waitMs = Math.max(0, Math.min(dur, first - step.start));
  step.writeMs = Math.max(0, dur - step.thinkMs - step.toolMs - step.agentMs - step.userMs - step.waitMs);
}

function tokensOf(u) {
  const reasoning = Number(u.output_tokens_details?.thinking_tokens) || 0;
  return {
    input: Number(u.input_tokens) || 0,
    output: Math.max(0, (Number(u.output_tokens) || 0) - reasoning), // thinking is billed as output; kept apart here
    reasoning,
    cacheRead: Number(u.cache_read_input_tokens) || 0,
    cacheWrite: Number(u.cache_creation_input_tokens) || 0,
  };
}

// Anthropic list prices, $ per million tokens: [input, output, cache read].
// First matching prefix wins. Cache writes cost 1.25× input (5 min) or 2× (1 h).
const PRICES = [
  ['claude-fable-5-1', 10, 50, 0.25], ['claude-mythos-5-1', 10, 50, 0.25],
  ['claude-fable-5', 10, 50, 1], ['claude-mythos-5', 10, 50, 1],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25, 0.5], ['claude-opus-4-8', 5, 25, 0.5], ['claude-opus-4-7', 5, 25, 0.5],
  ['claude-opus-4-6', 5, 25, 0.5], ['claude-opus-4-5', 5, 25, 0.5],
  ['claude-opus-4', 15, 75, 1.5], ['claude-3-opus', 15, 75, 1.5],
  ['claude-sonnet-5', 2, 10, 0.2],
  ['claude-sonnet-4', 3, 15, 0.3], ['claude-3-7-sonnet', 3, 15, 0.3], ['claude-3-5-sonnet', 3, 15, 0.3],
  ['claude-haiku-5-5', 0.1, 0.5, 0.01],
  ['claude-haiku-4-5', 1, 5, 0.1], ['claude-3-5-haiku', 0.8, 4, 0.08],
];
const HAIKU_55_LONG = 100000; // Haiku 5.5 bills 5× past this many prompt tokens

/** Estimated $ for one model call; 0 for a model not in the table. */
export function estimateCost(model, u, speed) {
  const id = String(model || '').replace(/^(anthropic\.|us\.anthropic\.|eu\.anthropic\.)/, '');
  const row = PRICES.find(([p]) => id.startsWith(p));
  if (!row) return 0;
  let [, inP, outP, readP] = row;
  const t = tokensOf(u);
  if (row[0] === 'claude-haiku-5-5' && t.input + t.cacheRead + t.cacheWrite > HAIKU_55_LONG) { inP *= 5; outP *= 5; readP *= 5; }
  const w1h = Number(u.cache_creation?.ephemeral_1h_input_tokens) || 0;
  const w5m = u.cache_creation ? Number(u.cache_creation.ephemeral_5m_input_tokens) || 0 : t.cacheWrite;
  const cost = (t.input * inP + (t.output + t.reasoning) * outP + t.cacheRead * readP + w5m * inP * 1.25 + w1h * inP * 2) / 1e6;
  return speed === 'fast' ? cost * 2 : cost;
}

// Claude Code tool names → the shared vocabulary in model.mjs
const TOOLS = {
  Agent: 'agent', Task: 'agent', Skill: 'skill',
  Read: 'read', LS: 'list', Grep: 'grep', Glob: 'glob',
  Edit: 'edit', MultiEdit: 'multiedit', Write: 'write', NotebookEdit: 'edit',
  Bash: 'bash', PowerShell: 'bash',
  WebFetch: 'webfetch', WebSearch: 'websearch',
  AskUserQuestion: 'question', TodoWrite: 'todowrite',
};

function normalizeTool(name) {
  if (!name) return 'unknown';
  if (TOOLS[name]) return TOOLS[name];
  return name.startsWith('mcp__') ? name : name.toLowerCase();
}

const MCP_RESOURCE_TOOLS = new Set(['ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool']);

/**
 * The MCP server a tool belongs to, or null. Claude Code names MCP tools
 * `mcp__<server>__<tool>`, with anything outside [A-Za-z0-9_-] in the server
 * name turned into `_`. The name is mapped back to the configured spelling
 * later (see mcpNameOf).
 */
function mcpServerOf(tool) {
  if (!tool) return null;
  if (MCP_RESOURCE_TOOLS.has(tool)) return MCP_RESOURCES;
  if (!tool.startsWith('mcp__')) return null;
  const rest = tool.slice(5);
  const i = rest.lastIndexOf('__');
  return i > 0 ? rest.slice(0, i) : rest;
}

/**
 * Rename span.mcp from the normalized form in the tool name ("claude_ai_Gmail")
 * to the configured server name ("claude.ai Gmail") where one matches.
 */
export function resolveMcpNames(traces, servers) {
  const byNorm = new Map(servers.map((s) => [s.name.replace(/[^a-zA-Z0-9_-]/g, '_'), s.name]));
  const walk = (ts) => {
    for (const t of ts) {
      for (const sp of t.spans) if (sp.mcp && byNorm.has(sp.mcp)) sp.mcp = byNorm.get(sp.mcp);
      walk(t.children);
    }
  };
  walk(traces);
}

function compactInput(i) {
  const out = {};
  const set = (k, v) => { if (typeof v === 'string' && v !== '') out[k] = v; };
  set('file', i.file_path || i.notebook_path || i.path);
  set('pattern', i.pattern);
  set('command', typeof i.command === 'string' ? i.command.slice(0, 300) : undefined);
  set('description', i.description);
  set('prompt', typeof i.prompt === 'string' ? i.prompt.slice(0, 1500) : undefined);
  set('url', i.url);
  set('query', i.query);
  return out;
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

/**
 * MCP servers Claude Code would load: user scope (~/.claude.json `mcpServers`),
 * local scope (~/.claude.json `projects[<dir>].mcpServers`), project scope
 * (.mcp.json in each session folder and its parents, up to `root`), enabled
 * plugins, and claude.ai connectors that were ever connected. Only names and
 * switches are kept — commands, URLs, headers and environment never leave here.
 * @param {{ root?: string, all?: boolean, dirs?: string[], configDir?: string }} opts  dirs: session folders
 * @returns {Promise<{ name: string, type: string|null, enabled: boolean, scope: 'global'|'project'|'plugin'|'claude.ai' }[]>}
 */
export async function loadMcpServers({ root, all = false, dirs = [], configDir = defaultConfigDir() } = {}) {
  const projectDirs = new Set();
  for (const d of new Set([...(all || !root ? [] : [root]), ...dirs])) {
    const stop = !all && root && inside(d, root) ? root : homedir();
    for (let cur = d; cur && !projectDirs.has(cur); cur = dirname(cur)) {
      if (cur !== homedir()) projectDirs.add(cur);
      if (cur === stop || dirname(cur) === cur) break;
    }
  }
  const ordered = [...projectDirs].sort((a, b) => a.length - b.length);
  const servers = new Map();
  const add = (defs, scope, disabled = new Set()) => {
    if (!defs || typeof defs !== 'object') return;
    for (const [name, def] of Object.entries(defs)) {
      if (!def || typeof def !== 'object') continue;
      servers.set(name, { name, type: typeof def.type === 'string' ? def.type : def.command ? 'stdio' : null, enabled: !disabled.has(name), scope });
    }
  };

  const state = (await readJson(process.env.CLAUDE_CONFIG_DIR ? join(configDir, '.claude.json') : join(homedir(), '.claude.json'))) || {};
  const settings = [(await readJson(join(configDir, 'settings.json'))) || {}];
  for (const d of ordered) {
    for (const f of ['settings.json', 'settings.local.json']) settings.push((await readJson(join(d, '.claude', f))) || {});
  }
  const disabledJson = new Set(settings.flatMap((s) => s.disabledMcpjsonServers || []));
  const enabledPlugins = Object.assign({}, ...settings.map((s) => s.enabledPlugins || {}));

  add(state.mcpServers, 'global');
  for (const d of ordered) {
    const p = state.projects?.[d];
    const disabled = new Set([...(p?.disabledMcpServers || []), ...(p?.disabledMcpjsonServers || []), ...disabledJson]);
    add((await readJson(join(d, '.mcp.json')))?.mcpServers, 'project', disabled);
    add(p?.mcpServers, 'project', disabled);
  }

  // plugin servers are named plugin:<plugin>:<server>
  const installed = (await readJson(join(configDir, 'plugins', 'installed_plugins.json')))?.plugins || {};
  for (const [key, installs] of Object.entries(installed)) {
    const path = Array.isArray(installs) ? installs[installs.length - 1]?.installPath : null;
    if (!path) continue;
    const plugin = key.split('@')[0];
    const manifest = await readJson(join(path, '.claude-plugin', 'plugin.json'));
    let defs = manifest?.mcpServers;
    if (!defs || typeof defs !== 'object') {
      const j = await readJson(join(path, typeof defs === 'string' ? defs : '.mcp.json'));
      defs = j?.mcpServers || j;
    }
    if (!defs || typeof defs !== 'object') continue;
    const on = enabledPlugins[key] === true;
    for (const [name, def] of Object.entries(defs)) {
      if (!def || typeof def !== 'object') continue;
      const full = `plugin:${plugin}:${name}`;
      servers.set(full, { name: full, type: typeof def.type === 'string' ? def.type : def.command ? 'stdio' : null, enabled: on, scope: 'plugin' });
    }
  }

  for (const name of state.claudeAiMcpEverConnected || []) {
    if (!servers.has(name)) servers.set(name, { name, type: 'http', enabled: true, scope: 'claude.ai' });
  }
  return [...servers.values()];
}
