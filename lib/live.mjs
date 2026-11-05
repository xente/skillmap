// skillmap live — interactive terminal view of agent sessions, made for a herdr
// pane. Two screens: every agent herdr knows about, and one session (tabs for
// overview, tools, subagents, prompts and alerts, with details and drill-down
// into subagents). From a session it acts on the agent through herdr: focus its
// pane, open a file in herdr-file-viewer, send a prompt, interrupt it.
// First screen: the session named by SKILLMAP_AGENT + SKILLMAP_SESSION (set by
// the open-live action); else the agents screen inside herdr; else the newest
// session in the current folder. Keyboard and mouse.

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, relative, isAbsolute, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as claude from './runtime/claude.mjs';
import * as opencode from './runtime/opencode.mjs';
import { analyzeRuntime } from './runtime/analyze.mjs';
import { loadAllTraces, LABEL } from './runtime/load.mjs';

const run = promisify(execFile);
const HERDR = process.env.HERDR_BIN_PATH || 'herdr';
const IN_HERDR = Boolean(process.env.HERDR_ENV || process.env.HERDR_BIN_PATH || process.env.HERDR_PANE_ID);
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_RUNTIME = { claude: 'claude-code', opencode: 'opencode' };
const RECENT_MS = 120000;  // a subagent counts as running if it wrote within this
const SESSION_MS = 1500;   // reload the open session this often
const AGENTS_MS = 5000;    // reload every agent's session this often

const ESC = '\x1b[';
const sgr = (code) => (s) => `${ESC}${code}m${s}${ESC}0m`;
const dim = sgr(2), bold = sgr(1), red = sgr(31), green = sgr(32), yellow = sgr(33), cyan = sgr(36), magenta = sgr(35), inverse = sgr(7);
const plain = (s) => s;
// Each agent gets its own colour (256-colour codes, none of the status greens/yellows/reds),
// handed out in order of first sight so neighbours differ, and kept for the run.
const AGENT_COLORS = [75, 177, 80, 208, 211, 141, 37, 180, 105, 174];
const agentColors = new Map();
const agentColor = (id) => {
  if (!agentColors.has(id)) agentColors.set(id, sgr(`38;5;${AGENT_COLORS[agentColors.size % AGENT_COLORS.length]}`));
  return agentColors.get(id);
};

const fmtMs = (ms) => ms >= 3600000 ? `${(ms / 3600000).toFixed(1)} h` : ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
const fmtTok = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));
const fmtClock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).slice(0, 8);
const clip = (s, n) => (n <= 0 ? '' : s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s);
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const tokTotal = (t) => t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
// OpenCode records the provider's cost, which is 0 for some (subscriptions, free
// models): say so rather than show $0.00. Claude Code costs are estimates (≈).
const costText = (t, cost, digits = 2) => !t.costEstimated && !cost && tokTotal(t.tokens) ? 'no cost' : `${t.costEstimated ? '≈' : ''}$${cost.toFixed(digits)}`;
// context of the latest model call that reported usage (synthetic steps have none)
const lastContext = (t) => t.steps.findLast((s) => s.tokens.context)?.tokens.context || 0;

const TABS = [['overview', 'Overview'], ['tools', 'Tools'], ['subagents', 'Subagents'], ['prompts', 'Prompts'], ['alerts', 'Alerts'], ['thinking', 'Thinking']];
const HOT_LABEL = {
  'slow-thinking': 'slow thinking', 'model-wait': 'waiting for the model', 'big-context': 'huge context', 'slow-tool': 'slow tool',
  reread: 'file read again and again', 'repeat-command': 'repeated command', 'error-loop': 'error loop', rumination: 'second-guessing',
};

async function herdr(args) {
  const { stdout } = await run(HERDR, args, { timeout: 5000 });
  return stdout;
}

/** Agents herdr knows about (Claude Code and OpenCode only), or [] outside herdr. */
async function herdrAgents() {
  try {
    return (JSON.parse(await herdr(['agent', 'list'])).result?.agents || [])
      .filter((a) => AGENT_RUNTIME[a.agent] && a.agent_session?.value)
      .map((a) => ({
        agent: a.agent, session: a.agent_session.value, cwd: a.foreground_cwd || a.cwd, pane: a.pane_id,
        title: a.terminal_title_stripped || '', status: a.agent_status || 'unknown', focused: Boolean(a.focused), workspace: a.workspace_id,
      }));
  } catch {
    return [];
  }
}

/** Workspace names by id. */
async function herdrWorkspaces() {
  try {
    return new Map((JSON.parse(await herdr(['workspace', 'list'])).result?.workspaces || []).map((w) => [w.workspace_id, w.label]));
  } catch {
    return new Map();
  }
}

/** The workspace this pane lives in: herdr sets it for the panes it starts. */
async function ownWorkspace() {
  if (process.env.HERDR_WORKSPACE_ID) return process.env.HERDR_WORKSPACE_ID;
  try {
    return JSON.parse(await herdr(['pane', 'current'])).result?.pane?.workspace_id || null;
  } catch {
    return null;
  }
}

/** Newest session started in `cwd`, from either runtime. */
async function newestIn(cwd, args) {
  const { traces } = await loadAllTraces(cwd, { ...args, runtime: 'all', since: '7d' });
  const t = traces.sort((a, b) => b.end - a.end)[0];
  return t ? { agent: t.runtime === 'opencode' ? 'opencode' : 'claude', session: t.id, cwd: t.directory || cwd } : null;
}

function* walk(t) { for (const c of t.children) { yield c; yield* walk(c); } }
const findTrace = (root, id) => (root.id === id ? root : [...walk(root)].find((t) => t.id === id) || null);

function toolLabel(s) {
  if (s.kind === 'mcp') return `${s.mcp || 'mcp'}:${s.tool.split('__').pop()}`;
  if (s.kind === 'agent') return `agent ${s.name}`;
  if (s.kind === 'skill') return `skill ${s.name}`;
  return s.tool;
}

function spanTarget(s, dir) {
  const i = s.input || {};
  if (i.file) return dir && isAbsolute(i.file) && i.file.startsWith(dir) ? relative(dir, i.file) || basename(i.file) : i.file;
  return oneLine(i.command || i.pattern || i.url || i.query || i.description || '');
}

/** Wrap text to `w` columns at spaces (a word longer than a line is cut), keeping its line breaks. */
function wrap(text, w) {
  const out = [];
  for (let line of String(text).split('\n')) {
    if (!line) { out.push(''); continue; }
    // styled lines count their escape codes too, so they wrap a little early
    while (line.length > w) {
      const at = line.lastIndexOf(' ', w);
      const cut = at > w / 3 ? at : w;
      out.push(line.slice(0, cut));
      line = line.slice(cut).replace(/^ /, '');
    }
    out.push(line);
  }
  return out;
}

export async function live(args) {
  claude.enableCache();
  const out = process.stdout, env = process.env;
  const st = {
    screen: 'agents',
    agents: [],          // from herdr
    workspaces: new Map(), // workspace id → name
    workspace: null,     // the workspace this pane is in (null: unknown, so no filtering)
    scope: 'workspace',  // agents screen: 'workspace' (this one) or 'all'
    data: new Map(),     // session id → { trace, analysis } | { error }
    target: null,        // { agent, session, cwd, pane? } shown on the session screen
    stack: [],           // ids of the subagent traces drilled into
    tab: 'overview',
    lists: new Map(),    // list key → { sel, top, len }
    modal: null,         // { kind: 'detail'|'confirm'|'input', … }
    follow: false,       // session screen follows herdr's focused agent
    newestFirst: false,  // chronological lists: oldest first (default) or newest first
    thinking: Boolean(args.thinking), // load the model's reasoning text (opt-in: it may hold sensitive details)
    note: '',
    hits: [],            // clickable regions of the last frame
  };
  let ready = false;

  /* ---------- data ---------- */

  function put(id, trace) {
    const prev = st.data.get(id);
    if (prev?.trace && prev.trace === trace) return; // cached, unchanged
    st.data.set(id, trace ? { trace, analysis: analyzeRuntime([trace]) } : { error: 'session not found yet' });
  }

  async function loadClaude(t) {
    try { put(t.session, await claude.loadSessionById({ sessionId: t.session, cwd: t.cwd, configDir: args.claudeDir, includeThinking: st.thinking })); }
    catch (err) { st.data.set(t.session, { error: err.message }); }
  }
  // OpenCode keeps every session in one SQLite file: reload only when it (or its WAL) changed
  const dbPath = args.db || opencode.defaultDbPath();
  const dbSeen = new Map(); // session id → db signature it was loaded at
  const dbSignature = async () => (await Promise.all(['', '-wal'].map((x) => stat(dbPath + x).then((s) => `${s.size}:${s.mtimeMs}`, () => '-')))).join('|');
  async function loadOpencode(all) {
    const sig = await dbSignature();
    const ts = all.filter((t) => !st.data.has(t.session) || dbSeen.get(t.session) !== sig);
    if (!ts.length) return;
    for (const t of ts) dbSeen.set(t.session, sig);
    try {
      const traces = await opencode.loadTraces({ sessionIds: ts.map((t) => t.session), dbPath, includeThinking: st.thinking });
      for (const t of ts) put(t.session, traces.find((x) => x.id === t.session) || null);
    } catch (err) {
      for (const t of ts) st.data.set(t.session, { error: err.message });
    }
  }
  const load = (ts) => Promise.all([...ts.filter((t) => t.agent === 'claude').map(loadClaude), loadOpencode(ts.filter((t) => t.agent === 'opencode'))]);

  let loadingAll = false;
  async function refreshAgents() {
    if (loadingAll) return;
    loadingAll = true;
    try {
      [st.agents, st.workspaces] = await Promise.all([herdrAgents(), herdrWorkspaces()]);
      if (st.follow) {
        const f = st.agents.find((a) => a.focused);
        if (f && f.session !== st.target?.session) openSession(f, { keepFollow: true });
      }
      await load(sortedAgents()); // only the ones on screen
    } finally {
      loadingAll = false;
      draw();
    }
  }
  async function refreshSession() {
    if (st.screen !== 'session' || !st.target) return;
    await load([st.target]);
    draw();
  }

  /* ---------- navigation ---------- */

  const entry = () => (st.target ? st.data.get(st.target.session) : null);
  const rootTrace = () => entry()?.trace || null;
  const curTrace = () => {
    const r = rootTrace();
    return r ? (st.stack.length ? findTrace(r, st.stack.at(-1)) || r : r) : null;
  };
  const agentInfo = () => st.agents.find((a) => a.session === st.target?.session) || null;
  const paneOf = () => st.target?.pane || agentInfo()?.pane || null;

  function openSession(t, { keepFollow = false } = {}) {
    st.target = t;
    st.stack = [];
    st.tab = 'overview';
    st.screen = 'session';
    if (!keepFollow) st.follow = false;
    st.note = '';
    if (!st.data.has(t.session)) load([t]).then(draw);
    draw();
  }
  function back() {
    if (st.stack.length) st.stack.pop();
    else if (IN_HERDR) { st.screen = 'agents'; st.follow = false; }
    draw();
  }
  function drill(childId) {
    st.stack.push(childId);
    st.tab = 'overview';
    draw();
  }

  /** Selection state of a list; sticks to the end when it was there and items were added. */
  const ordered = (items) => (st.newestFirst ? [...items].reverse() : items);
  /** `live` lists grow while you watch: they stay on the newest item if you were on it, and keep the selected item otherwise. */
  function list(key, len, live = false) {
    let l = st.lists.get(key);
    if (!l) { l = { sel: live && !st.newestFirst ? len - 1 : 0, top: 0, len }; st.lists.set(key, l); }
    if (live && len > l.len) {
      if (!st.newestFirst) { if (l.sel === l.len - 1) l.sel = len - 1; }
      else if (l.sel > 0) l.sel += len - l.len; // new items go on top
    }
    l.len = len;
    l.sel = Math.max(0, Math.min(len - 1, l.sel));
    return l;
  }
  const listKey = () => (st.screen === 'session' ? `session:${curTrace()?.id}:${st.tab}` : 'agents');
  const sticky = () => st.screen === 'session' && (st.tab === 'overview' || st.tab === 'tools' || st.tab === 'thinking');

  function tabItems(t, analysis) {
    if (!t) return [];
    if (st.tab === 'tools') return ordered(t.spans);
    if (st.tab === 'subagents') return ordered(t.children);
    if (st.tab === 'prompts') return ordered(t.prompts);
    if (st.tab === 'alerts') return ordered(alertsOf(t, analysis));
    if (st.tab === 'thinking') return ordered(t.thinking);
    return [];
  }
  function alertsOf(t, analysis) {
    const ids = new Set([t.id, ...[...walk(t)].map((x) => x.id)]);
    return [
      ...(analysis?.hotspots || []).filter((h) => ids.has(h.traceId)).map((h) => ({ hot: h })),
      ...(analysis?.delegations || []).filter((d) => d.flags.length && ids.has(d.traceId)).map((d) => ({ del: d })),
    ];
  }

  /** Every call of the session and its subagents, oldest first. */
  function recentActions(t) {
    return [t, ...walk(t)].flatMap((owner) => owner.spans.map((s) => ({ s, owner, sub: owner === t ? null : owner }))).sort((a, b) => (st.newestFirst ? b.s.start - a.s.start : a.s.start - b.s.start));
  }
  function currentItems() {
    if (st.screen === 'agents') return sortedAgents();
    const t = curTrace();
    if (!t) return [];
    return st.tab === 'overview' ? recentActions(t) : tabItems(t, entry()?.analysis);
  }
  function selected() {
    const items = currentItems();
    return items.length ? items[list(listKey(), items.length, sticky()).sel] : null;
  }
  function move(delta) {
    if (st.modal?.kind === 'detail') { st.modal.top = Math.max(0, st.modal.top + delta); return draw(); }
    const n = currentItems().length;
    if (!n) return;
    const l = list(listKey(), n, sticky());
    l.sel = Math.max(0, Math.min(n - 1, l.sel + delta));
    draw();
  }

  function enter() {
    const item = selected();
    if (!item) return;
    if (st.screen === 'agents') return openSession(item);
    const t = curTrace();
    if (st.tab === 'overview') {
      if (item.s.kind === 'agent' && item.s.childTraceId) return drill(item.s.childTraceId);
      return showDetail(() => toolDetail(item.s.id, item.owner.id));
    }
    if (st.tab === 'subagents') return drill(item.id);
    if (st.tab === 'tools') {
      if (item.kind === 'agent' && item.childTraceId) return drill(item.childTraceId);
      return showDetail(() => toolDetail(item.id, t.id));
    }
    if (st.tab === 'prompts') return showDetail(() => promptDetail(item, t));
    if (st.tab === 'thinking') return showDetail(() => thinkingDetail(t.id, t.thinking.indexOf(item)));
    if (st.tab === 'alerts') {
      const spanId = item.hot?.span || item.del?.spanId;
      const owner = item.hot?.traceId || item.del?.traceId;
      if (spanId && owner === t.id) {
        st.tab = 'tools';
        const i = t.spans.findIndex((s) => s.id === spanId);
        if (i >= 0) list(listKey(), t.spans.length, true).sel = st.newestFirst ? t.spans.length - 1 - i : i;
        return draw();
      }
      return showDetail(() => alertDetail(item));
    }
  }

  function setTab(k) {
    if (st.screen !== 'session') return;
    st.tab = k;
    draw();
  }
  const tabStep = (d) => setTab(TABS[(TABS.findIndex(([k]) => k === st.tab) + d + TABS.length) % TABS.length][0]);

  /* ---------- details ---------- */

  // `build` runs on every draw and looks its subject up again, so an open detail
  // follows reloads (e.g. the reasoning text arriving after T)
  function showDetail(build) { st.modal = { kind: 'detail', top: 0, build }; draw(); }

  // The reasoning of the model step that made each call: span id → its thinking blocks
  const reasoningIndex = new WeakMap();
  function reasoningOf(trace, span) {
    let m = reasoningIndex.get(trace);
    if (!m) {
      m = new Map();
      for (const step of trace.steps) {
        const blocks = step.items.filter((i) => i.type === 'think').map((i) => trace.thinking[i.ref]).filter(Boolean);
        if (blocks.length) for (const i of step.items) if (i.type !== 'think' && i.type !== 'text') m.set(i.ref, blocks);
      }
      reasoningIndex.set(trace, m);
    }
    return m.get(span.id) || [];
  }
  const noText = () => dim(st.thinking ? `(${LABEL[AGENT_RUNTIME[st.target.agent]]} did not store the text of this block, only how long it lasted)` : '(text off: press T to read it)');
  const thinkKey = () => ['T', st.thinking ? 'hide reasoning' : 'read reasoning', toggleThinking];

  function toolDetail(spanId, traceId) {
    const t = rootTrace() && findTrace(rootTrace(), traceId);
    const s = t?.spans.find((x) => x.id === spanId);
    if (!s) return { title: 'Tool call', lines: [dim('loading…')], keys: [] };
    const lines = [
      `${bold(toolLabel(s))}  ${s.status === 'error' ? red('error') : s.status === 'pending' ? cyan('running') : green('ok')}`,
      `${dim('kind')} ${s.kind}${s.mcp ? `   ${dim('MCP server')} ${s.mcp}` : ''}`,
      `${dim('started')} ${fmtClock(s.start)}   ${dim('took')} ${fmtMs((s.status === 'pending' ? Date.now() : s.end) - s.start)}   ${dim('output')} ${s.outputSize.toLocaleString()} chars`,
    ];
    if (s.error) lines.push('', red('Error'), ...s.error.split('\n'));
    for (const [k, v] of Object.entries(s.input || {})) lines.push('', bold(k), ...String(v).split('\n'));
    const keys = [];
    if (s.input?.file) keys.push(['o', 'open in file viewer', () => openFile(s.input.file, t)]);
    if (s.kind === 'agent' && s.childTraceId) keys.push(['enter', 'open subagent', () => { st.modal = null; drill(s.childTraceId); }]);
    const blocks = reasoningOf(t, s);
    if (blocks.length) {
      lines.push('', bold('Reasoning before this call'), dim(`${blocks.length === 1 ? '1 block' : `${blocks.length} blocks`} · ${fmtMs(blocks.reduce((n, b) => n + b.end - b.start, 0))} · the same step as its other calls`));
      for (const b of blocks) lines.push('', ...(b.text ? b.text.split('\n') : [noText()]));
      keys.push(thinkKey());
    }
    return { title: `Tool call · ${toolLabel(s)}`, lines, keys };
  }
  function thinkingDetail(traceId, index) {
    const th = rootTrace() && findTrace(rootTrace(), traceId)?.thinking[index];
    if (!th) return { title: 'Thinking', lines: [dim('loading…')], keys: [] };
    const lines = [`${dim('turn')} ${th.turn + 1}${th.step != null ? `   ${dim('step')} ${th.step + 1}` : ''}   ${dim('at')} ${fmtClock(th.start)}   ${dim('thought for')} ${fmtMs(th.end - th.start)}`, ''];
    if (th.text) lines.push(...th.text.split('\n'), '', dim('What the model wrote while reasoning: not a verified account of why it acted. Long blocks are cut.'));
    else lines.push(noText());
    return { title: `Thinking · turn ${th.turn + 1}`, lines, keys: [thinkKey()] };
  }
  function promptDetail(p, t) {
    const u = t.turns.find((x) => x.turn === p.turn);
    const lines = [`${dim('turn')} ${p.turn + 1}   ${dim('sent')} ${fmtClock(p.at)}`];
    if (u) lines.push(`${dim('tokens')} ${fmtTok(u.tokens)}   ${dim('cost')} ${costText(t, u.cost, 3)}   ${dim('active')} ${fmtMs(u.activeMs)}   ${dim('outcome')} ${u.outcome}`);
    if (p.attached.length) lines.push(`${dim('attached')} ${p.attached.join(', ')}`);
    lines.push('', ...p.text.split('\n'));
    return { title: `Prompt · turn ${p.turn + 1}`, lines, keys: [] };
  }
  function alertDetail(item) {
    if (item.hot) {
      const h = item.hot;
      const lines = [h.detail, '', `${dim('time lost')} ${fmtMs(h.ms || 0)}${h.step != null ? `   ${dim('step')} ${h.step + 1}` : ''}`];
      if (h.inferred) lines.push(dim('Inferred from the model’s own words: a hint, not a fact.'));
      return { title: `Alert · ${HOT_LABEL[h.type] || h.type}`, lines, keys: [] };
    }
    const d = item.del;
    return { title: `Flagged delegation · ${d.agent}`, lines: [d.description || '', '', ...d.flags.flatMap((f) => [bold(f.type), f.detail || '', ''])], keys: [] };
  }

  /* ---------- actions on the agent (through herdr) ---------- */

  const say = (msg) => { st.note = msg; draw(); };
  async function attempt(fn, ok) {
    try { await fn(); if (ok) say(ok); } catch (err) { say(`failed: ${oneLine(err.stderr || err.message).slice(0, 200)}`); }
  }
  function needPane() {
    const pane = paneOf();
    if (!pane) say(IN_HERDR ? 'this session is not open in any herdr pane' : 'acting on the agent needs herdr');
    return pane;
  }
  const agentName = () => clip(agentInfo()?.title || curTrace()?.title || st.target?.session || '', 40);

  function focusAgent(pane = needPane()) {
    if (pane) attempt(() => herdr(['agent', 'focus', pane]));
  }
  function confirm(text, yes) { st.modal = { kind: 'confirm', text, yes }; draw(); }
  function interrupt() {
    const pane = needPane();
    if (!pane) return;
    // OpenCode asks for a second Esc before it interrupts
    const keys = st.target.agent === 'opencode' ? ['esc', 'esc'] : ['esc'];
    confirm(`Interrupt “${agentName()}”? (sends ${keys.length > 1 ? 'Esc twice' : 'Esc'} to its pane)`, () => attempt(() => herdr(['agent', 'send-keys', pane, ...keys]), 'interrupt sent'));
  }
  function promptAgent() {
    const pane = needPane();
    if (!pane) return;
    st.modal = {
      kind: 'input', label: `Prompt for “${agentName()}”`, value: '',
      submit: (text) => {
        if (!text.trim()) { st.modal = null; return draw(); }
        confirm(`Send to “${agentName()}”:\n\n${text}`, () => attempt(() => herdr(['agent', 'prompt', pane, text]), 'prompt sent'));
      },
    };
    draw();
  }
  async function openFile(file, t) {
    st.modal = null;
    const pane = needPane();
    if (!pane) return;
    await attempt(async () => {
      const plugins = JSON.parse(await herdr(['plugin', 'list', '--json'])).result?.plugins || [];
      if (!plugins.some((p) => p.plugin_id === 'herdr-file-viewer' && p.enabled !== false)) throw new Error('herdr-file-viewer is not installed');
      // the viewer roots itself at the focused pane's repository, so focus the agent first
      const cwd = t.directory || st.target.cwd;
      const top = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel']).then((r) => r.stdout.trim()).catch(() => cwd);
      const abs = isAbsolute(file) ? file : join(cwd, file);
      await herdr(['agent', 'focus', pane]);
      await herdr(['plugin', 'pane', 'open', '--plugin', 'herdr-file-viewer', '--entrypoint', 'file-viewer', '--placement', 'split', '--direction', 'right', '--focus', '--env', `HERDR_FILE_VIEWER_OPEN=${relative(top, abs)}`]);
    }, `opened ${basename(file)} in the file viewer`);
  }
  function openWeb() {
    const cwd = (st.screen === 'agents' ? selected()?.cwd : st.target?.cwd) || process.cwd();
    if (!IN_HERDR) return say(`run: skillmap ${cwd} --watch --open`);
    execFile('/bin/sh', [join(PLUGIN_ROOT, 'herdr', 'open-web.sh')], { env: { ...env, SKILLMAP_CWD: cwd } }, (err) => {
      if (err) say(`could not open the web view: ${err.message}`);
    });
  }
  function toggleFollow() {
    st.follow = !st.follow;
    say(st.follow ? 'following the agent focused in herdr' : 'staying on this agent');
    refreshAgents();
  }
  function toggleScope() {
    if (!st.workspace) return say('this pane\'s workspace is unknown: showing all agents');
    st.scope = st.scope === 'workspace' ? 'all' : 'workspace';
    st.lists.delete('agents');
    draw();
    refreshAgents();
  }
  function toggleOrder() {
    st.newestFirst = !st.newestFirst;
    for (const [key, l] of st.lists) if (key !== 'agents') { l.sel = Math.max(0, l.len - 1 - l.sel); l.top = 0; } // same item stays selected
    say(st.newestFirst ? 'newest first' : 'oldest first');
  }
  function toggleThinking() {
    st.thinking = !st.thinking;
    say(st.thinking ? 'reasoning text on: reading it from the session' : 'reasoning text off');
    reload();
  }
  function reload() {
    st.data.clear();
    refreshAgents().then(refreshSession);
  }

  /* ---------- input ---------- */

  const KEYS = {
    '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left',
    '\x1b[5~': 'pgup', '\x1b[6~': 'pgdn', '\x1b[H': 'home', '\x1b[F': 'end', '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[Z': 'backtab',
    '\r': 'enter', '\n': 'enter', '\t': 'tab', '\x7f': 'backspace', '\b': 'backspace', '\x1b': 'esc', '\x03': 'ctrl-c',
  };
  const SEQS = Object.keys(KEYS).filter((k) => k.length > 1).sort((a, b) => b.length - a.length);
  function* tokens(data) {
    let i = 0;
    while (i < data.length) {
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(data.slice(i));
      if (mouse) { yield { mouse: { b: +mouse[1], x: +mouse[2] - 1, y: +mouse[3] - 1, down: mouse[4] === 'M' } }; i += mouse[0].length; continue; }
      const seq = SEQS.find((k) => data.startsWith(k, i));
      if (seq) { yield { key: KEYS[seq] }; i += seq.length; continue; }
      const ch = data[i++];
      yield KEYS[ch] ? { key: KEYS[ch] } : { ch };
    }
  }

  function onKey({ key, ch, mouse }) {
    if (key === 'ctrl-c') return quit();
    if (mouse) return onMouse(mouse);
    const m = st.modal;
    if (m?.kind === 'input') {
      if (key === 'esc') st.modal = null;
      else if (key === 'enter') return m.submit(m.value);
      else if (key === 'backspace') m.value = m.value.slice(0, -1);
      else if (ch && ch >= ' ') m.value += ch;
      return draw();
    }
    if (m?.kind === 'confirm') {
      st.modal = null;
      if (ch === 'y' || ch === 'Y' || key === 'enter') m.yes();
      return draw();
    }
    if (m?.kind === 'detail') {
      if (key === 'esc' || ch === 'q' || key === 'backspace') { st.modal = null; return draw(); }
      const k = m.build().keys.find(([kk]) => kk === (key || ch));
      if (k) return k[2]();
      if (key === 'enter') { st.modal = null; return draw(); }
      if (key === 'up' || ch === 'k') return move(-1);
      if (key === 'down' || ch === 'j') return move(1);
      if (key === 'pgup') return move(-10);
      if (key === 'pgdn' || ch === ' ') return move(10);
      return;
    }
    st.note = '';
    const page = Math.max(1, (out.rows || 24) - 10);
    if (ch === 'q') return quit();
    if (key === 'up' || ch === 'k') return move(-1);
    if (key === 'down' || ch === 'j') return move(1);
    if (key === 'pgup') return move(-page);
    if (key === 'pgdn') return move(page);
    if (key === 'home' || ch === 'g') return move(-1e9);
    if (key === 'end' || ch === 'G') return move(1e9);
    if (key === 'enter') return enter();
    if (ch === 'r') return reload();
    if (ch === 'w') return openWeb();
    if (st.screen === 'agents') {
      if (ch === 'a' && selected()) return focusAgent(selected().pane);
      if (ch === 't') return toggleScope();
      return draw();
    }
    if (key === 'esc' || key === 'backspace') return back();
    if (key === 'tab' || key === 'right') return tabStep(1);
    if (key === 'backtab' || key === 'left') return tabStep(-1);
    if (ch >= '1' && ch <= String(TABS.length)) return setTab(TABS[+ch - 1][0]);
    if (ch === 'a') return focusAgent();
    if (ch === 'p') return promptAgent();
    if (ch === 'x') return interrupt();
    if (ch === 'f') return toggleFollow();
    if (ch === 'T') return toggleThinking();
    if (ch === 's') return toggleOrder();
    if (ch === 'o') return openSelectedFile();
    draw();
  }
  function openSelectedFile() {
    const s = st.tab === 'tools' ? selected() : null;
    return s?.input?.file ? openFile(s.input.file, curTrace()) : say('select a tool call on a file first (Tools tab)');
  }

  function onMouse({ b, x, y, down }) {
    if (!down) return;
    if (b === 64) return move(-3); // wheel
    if (b === 65) return move(3);
    if (b !== 0) return;
    const h = st.hits.find((r) => r.y === y && x >= r.x0 && x < r.x1);
    if (h) h.fn();
  }

  /* ---------- drawing ---------- */

  function draw() {
    if (!ready) return;
    const W = Math.max(30, (out.columns || 80) - 1), H = Math.max(10, out.rows || 24);
    st.hits = [];
    const lines = st.modal ? renderModal(W, H) : st.screen === 'agents' ? renderAgents(W, H) : renderSession(W, H);
    out.write(`${ESC}H` + lines.slice(0, H).map((l) => l + `${ESC}K`).join('\n') + `${ESC}J`);
  }

  const hit = (y, x0, x1, fn) => st.hits.push({ y, x0, x1, fn });

  /** Key hints laid out in lines of at most W columns. */
  function layoutFooter(W, items) {
    const lines = [[]];
    let x = 0;
    for (const it of items) {
      const w = it[0].length + 1 + it[1].length;
      if (x && x + w > W) { lines.push([]); x = 0; }
      lines.at(-1).push({ it, x, w });
      x += w + 2;
    }
    return lines;
  }
  const footerHeight = (W, items) => layoutFooter(W, items).length;
  /** Clickable key hints, wrapped. */
  function footer(L, W, items) {
    for (const line of layoutFooter(W, items)) {
      let s = '';
      for (const { it: [k, label, fn], x, w } of line) {
        if (fn) hit(L.length, x, x + w, fn);
        s += `${bold(k)} ${dim(label)}  `;
      }
      L.push(s);
    }
  }

  /** A selectable list taking `rows` lines. `row` returns [text, style] segments. */
  function drawList(L, W, rows, items, row, empty = 'nothing yet') {
    const l = list(listKey(), items.length, sticky());
    if (l.sel < l.top) l.top = l.sel;
    if (l.sel >= l.top + rows) l.top = l.sel - rows + 1;
    l.top = Math.max(0, Math.min(l.top, Math.max(0, items.length - rows)));
    for (let i = l.top; i < Math.min(items.length, l.top + rows); i++) {
      const segs = row(items[i], W);
      const idx = i;
      hit(L.length, 0, W, () => { if (l.sel === idx) enter(); else { l.sel = idx; draw(); } });
      L.push(idx === l.sel ? inverse(clip(segs.map(([s]) => s).join(''), W).padEnd(W)) : segs.map(([s, f]) => (f || plain)(s)).join(''));
    }
    if (!items.length) L.push(dim(`  ${empty}`));
  }

  const scoped = () => st.scope === 'workspace' && st.workspace;
  function sortedAgents() {
    const rank = (a) => (a.status === 'working' ? 0 : a.status === 'idle' ? 1 : 2);
    const end = (a) => st.data.get(a.session)?.trace?.end || 0;
    return st.agents.filter((a) => !scoped() || a.workspace === st.workspace).sort((a, b) => rank(a) - rank(b) || end(b) - end(a));
  }

  function renderAgents(W, H) {
    const L = [];
    const agents = sortedAgents();
    const working = agents.filter((a) => a.status === 'working').length;
    const where = scoped() ? `workspace ${st.workspaces.get(st.workspace) || st.workspace}` : 'all workspaces';
    L.push(`${bold('◍ skillmap')}  ${dim(`${agents.length} agent${agents.length === 1 ? '' : 's'} · ${where}`)}${working ? `  ${green(`● ${working} working`)}` : ''}`);
    L.push(dim('─'.repeat(W)));
    if (!IN_HERDR) L.push(dim('Not running inside herdr: no agents to list.'));
    const keys = [['enter', 'open', enter], ['a', 'go to pane', () => selected() && focusAgent(selected().pane)], ...(st.workspace ? [['t', scoped() ? 'all workspaces' : 'this workspace', toggleScope]] : []), ['w', 'web', openWeb], ['r', 'reload', reload], ['q', 'quit', quit]];
    const reserve = footerHeight(W, keys) + 1;
    drawList(L, W, H - L.length - reserve, agents, (a, w) => {
      const d = st.data.get(a.session);
      const t = d?.trace;
      const dot = a.status === 'working' ? ['●', green] : a.status === 'idle' ? ['●', yellow] : ['·', dim];
      const ctx = t ? lastContext(t) : 0;
      const cost = t ? [t, ...walk(t)].reduce((n, x) => n + x.cost, 0) : 0;
      const alerts = d?.analysis ? alertsOf(t, d.analysis).length : 0;
      const right = t ? `${fmtTok(ctx).padStart(5)} ctx ${costText(t, cost).padStart(8)} ${alerts ? `!${String(alerts).padEnd(2)}` : '   '}` : d?.error ? 'not found' : 'loading…';
      // all workspaces: say which one each agent is in; one workspace: its folder
      const folder = clip(scoped() ? basename(a.cwd || '') : st.workspaces.get(a.workspace) || basename(a.cwd || ''), 16).padEnd(16);
      const room = Math.max(8, w - right.length - folder.length - 5);
      const color = agentColor(a.session);
      return [['▌', color], dot, [' '], [clip(a.title || t?.title || a.session, room).padEnd(room), color], [' '], [folder, dim], [' '], [right, alerts ? yellow : dim]];
    }, scoped() ? 'no agents in this workspace · t shows all' : 'no agents in herdr');
    while (L.length < H - reserve) L.push('');
    L.push(st.note ? dim(clip(st.note, W)) : '');
    footer(L, W, keys);
    return L;
  }

  function renderSession(W, H) {
    const L = [];
    const e = entry(), root = rootTrace(), t = curTrace(), status = agentInfo()?.status;
    const dot = status === 'working' ? green('● working') : status === 'idle' ? yellow('● idle') : status ? dim(`● ${status}`) : '';
    const crumbs = st.stack.length ? dim(' · ' + ['main', ...st.stack.map((id) => findTrace(root, id)?.agent || 'subagent')].join(' › ')) : '';
    L.push(`${bold('◍ skillmap')}${st.target ? dim(' · ' + LABEL[AGENT_RUNTIME[st.target.agent]]) : ''}  ${dot}${crumbs}${dim(st.follow ? '  following focus' : '')}`);
    if (!t) {
      L.push('', dim(e?.error || 'loading…'));
      while (L.length < H - 1) L.push('');
      footer(L, W, [['esc', 'agents', back], ['q', 'quit', quit]]);
      return L;
    }
    const now = Date.now();
    const cost = [t, ...walk(t)].reduce((n, x) => n + x.cost, 0);
    const lastPrompt = t.prompts.at(-1);
    L.push(bold(agentColor(st.target?.session || t.id)(clip(t.title || t.id, W))));
    L.push(dim(clip([t.agent && `agent ${t.agent}`, t.model, t.variant && `thinking: ${t.variant}`, lastPrompt && `turn ${t.prompts.length} · ${fmtMs(now - lastPrompt.at)}`, `${fmtMs(t.activeMs)} active`, costText(t, cost)].filter(Boolean).join(' · '), W)));

    // tab bar, clickable
    const counts = { tools: t.spans.length, subagents: t.children.length, prompts: t.prompts.length, alerts: alertsOf(t, e.analysis).length, thinking: t.thinking.length };
    let x = 0, bar = '';
    TABS.forEach(([k, label], i) => {
      const txt = ` ${i + 1} ${label}${counts[k] != null ? ` ${counts[k]}` : ''} `;
      if (x + txt.length > W) return;
      hit(L.length, x, x + txt.length, () => setTab(k));
      bar += (k === st.tab ? inverse(txt) : k === 'alerts' && counts.alerts ? yellow(txt) : dim(txt)) + ' ';
      x += txt.length + 1;
    });
    L.push(bar, dim('─'.repeat(W)));

    const enterHint = { overview: 'details', tools: 'detail', subagents: 'open', prompts: 'read', alerts: 'go to', thinking: 'read' }[st.tab];
    const keys = [
      ...(enterHint ? [['enter', enterHint, enter]] : []),
      ['esc', st.stack.length ? 'up' : 'agents', back],
      ['a', 'go to agent', () => focusAgent()],
      ['p', 'prompt', promptAgent],
      ['x', 'interrupt', interrupt],
      ...(st.tab === 'tools' ? [['o', 'open file', openSelectedFile]] : []),
      ...(st.tab === 'thinking' ? [['T', st.thinking ? 'hide text' : 'load text', toggleThinking]] : []),
      ['s', st.newestFirst ? 'oldest first' : 'newest first', toggleOrder],
      ['f', st.follow ? 'stay' : 'follow', toggleFollow],
      ['w', 'web', openWeb],
      ['q', 'quit', quit],
    ];
    const reserve = footerHeight(W, keys) + 1; // the footer and the note line above it
    const rows = H - L.length - reserve;
    if (st.tab === 'overview') renderOverview(L, W, rows, t, e.analysis, now);
    else {
      const rowFn = { tools: toolRow, subagents: subRow, prompts: promptRow, alerts: alertRow, thinking: thinkingRow }[st.tab];
      drawList(L, W, rows, tabItems(t, e.analysis), (it, w) => rowFn(it, w, t, now));
    }
    while (L.length < H - reserve) L.push('');
    L.length = H - reserve;
    L.push(st.note ? dim(clip(st.note, W)) : '');
    footer(L, W, keys);
    return L;
  }

  function renderOverview(L, W, rows, t, analysis, now) {
    const start = L.length;
    const status = agentInfo()?.status;
    const tree = [t, ...walk(t)];
    const spans = tree.flatMap((x) => x.spans.map((s) => ({ s, sub: x === t ? null : x })));
    const open = spans.filter(({ s }) => s.status === 'pending' && s.kind !== 'agent').sort((a, b) => b.s.start - a.s.start)[0];
    const lastStep = t.steps.at(-1);
    let doing;
    if (open) doing = `${cyan('⟳')} ${open.sub ? `[${open.sub.agent || 'subagent'}] ` : ''}${toolLabel(open.s)}  ${clip(spanTarget(open.s, t.directory), W - 40)}  ${dim(fmtMs(now - open.s.start))}`;
    else if (status === 'idle' || (!status && t.outcome === 'completed')) doing = dim('waiting for you');
    else if (status === 'working' || now - t.end < 10000) doing = magenta(lastStep?.items.at(-1)?.type === 'think' ? 'thinking…' : 'waiting for the model…');
    else doing = dim(`last activity ${fmtMs(now - t.end)} ago · ${t.outcome}`);
    L.push(`${bold('Now')}  ${doing}`);
    const errors = spans.filter(({ s }) => s.status === 'error').length;
    L.push(`${dim('Steps')} ${t.stepCount}  ${dim('Tools')} ${spans.length}  ${dim('Subagents')} ${t.children.length}  ${dim('Errors')} ${errors ? red(errors) : 0}`);
    const ctx = lastContext(t);
    L.push(`${dim('Tokens')} ${fmtTok(tree.reduce((n, x) => n + tokTotal(x.tokens), 0))}  ${dim('in')} ${fmtTok(t.tokens.input)} ${dim('out')} ${fmtTok(t.tokens.output + t.tokens.reasoning)} ${dim('cache')} ${fmtTok(t.tokens.cacheRead + t.tokens.cacheWrite)}  ${dim('context')} ${ctx > 100000 ? yellow(fmtTok(ctx)) : fmtTok(ctx)}`);

    const running = [...walk(t)].filter((x) => x.outcome !== 'completed' && x.outcome !== 'aborted' && now - x.end < RECENT_MS);
    if (running.length) {
      L.push('', bold('Running subagents'));
      for (const x of running.slice(0, 4)) {
        hit(L.length, 0, W, () => drill(x.id));
        L.push(subRow(x, W, t, now).map(([s, f]) => (f || plain)(s)).join(''));
      }
    }
    const alerts = alertsOf(t, analysis);
    if (alerts.length) {
      L.push('', `${bold(yellow('Alerts'))} ${dim(`${alerts.length} · tab 5`)}`);
      for (const a of alerts.slice(-3)) {
        hit(L.length, 0, W, () => setTab('alerts'));
        L.push(alertRow(a, W).map(([s, f]) => (f || plain)(s)).join(''));
      }
    }
    const room = rows - (L.length - start) - 2;
    if (room > 0) {
      L.push('', `${bold('Recent actions')} ${dim(`↑↓ select · enter: details and reasoning${st.newestFirst ? ' · newest first' : ''}`)}`);
      drawList(L, W, room, recentActions(t), (a, w) => toolRow(a.s, w, t, now, a.sub?.agent || (a.sub ? 'subagent' : null), a.owner));
    }
  }

  function toolRow(s, W, t, now, sub = null, owner = t) {
    const mark = s.status === 'error' ? ['✗', red] : s.status === 'pending' ? ['⟳', cyan] : [' '];
    const dur = s.status === 'pending' ? fmtMs(now - s.start) : fmtMs(s.end - s.start);
    const label = `${sub ? `[${sub}] ` : ''}${toolLabel(s)}`;
    const room = Math.max(0, W - 35 - dur.length);
    const think = reasoningOf(owner, s).length ? ['✎', dim] : [' ']; // the model reasoned before this call
    return [[fmtClock(s.start), dim], [' '], mark, [' '], [clip(label, 20).padEnd(20)], [' '], [clip(spanTarget(s, t.directory), room).padEnd(room)], [' '], think, [' '], [dur, dim]];
  }
  function subRow(x, W, t, now) {
    const running = x.outcome !== 'completed' && x.outcome !== 'aborted' && now - x.end < RECENT_MS;
    const icon = running ? ['●', green] : x.outcome === 'completed' ? ['✓', dim] : x.outcome === 'error' ? ['✗', red] : ['·', dim];
    const right = `${fmtMs((running ? now : x.end) - x.start)}  ${fmtTok(tokTotal(x.tokens))} tok  ${costText(x, x.cost)}`;
    const room = Math.max(0, W - right.length - 4);
    return [[' '], icon, [' '], [clip(`${x.agent || 'subagent'}  ${x.title || ''}`, room).padEnd(room)], [' '], [right, dim]];
  }
  function promptRow(p, W, t) {
    const u = t.turns.find((x) => x.turn === p.turn);
    const right = u ? `${fmtTok(u.tokens)} tok  ${u.outcome}` : '';
    const room = Math.max(0, W - right.length - 16);
    return [[`#${String(p.turn + 1).padEnd(3)}`, dim], [fmtClock(p.at), dim], ['  '], [clip(oneLine(p.text), room).padEnd(room)], [' '], [right, dim]];
  }
  function thinkingRow(th, W) {
    const dur = fmtMs(th.end - th.start);
    const text = th.text ? oneLine(th.text) : st.thinking ? '(text not stored)' : '(press T to read the text)';
    const room = Math.max(0, W - 34);
    return [[`#${String(th.turn + 1).padEnd(3)}`, dim], [fmtClock(th.start), dim], ['  '], [dur.padStart(7)], ['  '], [clip(text, room).padEnd(room), th.text ? plain : dim]];
  }
  function alertRow(a, W) {
    const [label, detail] = a.hot ? [HOT_LABEL[a.hot.type] || a.hot.type, a.hot.detail] : [`flagged ${a.del.agent}`, a.del.flags.map((f) => f.type).join(', ')];
    return [[' ! ', yellow], [clip(label, 24).padEnd(24), yellow], [' '], [clip(oneLine(detail), W - 28)]];
  }

  function renderModal(W, H) {
    const m = st.modal, L = [];
    if (m.kind === 'confirm') {
      L.push(bold('◍ skillmap'), dim('─'.repeat(W)), '', ...m.text.split('\n').flatMap((l) => wrap(l, W)).slice(0, H - 6), '');
      hit(L.length, 0, 7, () => onKey({ ch: 'y' }));
      hit(L.length, 9, 15, () => onKey({ ch: 'n' }));
      L.push(`${inverse(' y yes ')}  ${dim(' n no')}`);
      return L;
    }
    if (m.kind === 'input') {
      L.push(bold(clip(`◍ ${m.label}`, W)), dim('─'.repeat(W)), '');
      const text = wrap(m.value, W - 2);
      text.forEach((l, i) => L.push(`${i === 0 ? '> ' : '  '}${l}${i === text.length - 1 ? inverse(' ') : ''}`));
      if (!m.value) L.push(`> ${inverse(' ')}`);
      L.push('', dim('enter send · esc cancel'));
      return L;
    }
    const d = m.build();
    L.push(bold(clip(`◍ ${d.title}`, W)), dim('─'.repeat(W)));
    const body = d.lines.flatMap((l) => wrap(l, W));
    const rows = H - 4;
    m.top = Math.min(m.top, Math.max(0, body.length - rows));
    L.push(...body.slice(m.top, m.top + rows));
    while (L.length < H - 2) L.push('');
    L.push(dim(body.length > rows ? `lines ${m.top + 1}–${Math.min(body.length, m.top + rows)} of ${body.length} · ↑↓ scroll` : ''));
    footer(L, W, [...d.keys, ['esc', 'close', () => { st.modal = null; draw(); }]]);
    return L;
  }

  /* ---------- start ---------- */

  function quit() {
    out.write(`${ESC}?1000l${ESC}?1006l${ESC}?25h${ESC}?1049l`);
    process.exit(0);
  }

  const pinned = env.SKILLMAP_SESSION && AGENT_RUNTIME[env.SKILLMAP_AGENT]
    ? { agent: env.SKILLMAP_AGENT, session: env.SKILLMAP_SESSION, cwd: env.SKILLMAP_CWD || process.cwd() }
    : null;

  // alternate screen, no cursor, mouse clicks + wheel (SGR); the title lets open-live find this pane
  out.write(`${ESC}?1049h${ESC}?25l${ESC}?1000h${ESC}?1006h\x1b]0;skillmap live\x07`);
  ready = true;
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  out.on('resize', draw);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (data) => { for (const k of tokens(data)) onKey(k); });
  }

  if (pinned) openSession(pinned);
  else if (!IN_HERDR) {
    const t = await newestIn(process.cwd(), args).catch(() => null);
    if (t) openSession(t);
  }
  if (IN_HERDR) st.workspace = await ownWorkspace();
  draw();
  refreshAgents();
  setInterval(draw, 1000);
  setInterval(() => refreshSession().catch(() => {}), SESSION_MS);
  if (IN_HERDR) setInterval(() => refreshAgents().catch(() => {}), AGENTS_MS);
}
