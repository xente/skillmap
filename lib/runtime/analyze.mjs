// skillmap — runtime analysis over normalized traces.
// Answers: which skills/agents were used, by whom, how they ended (effectiveness),
// why they ran as far as the runtime shows it (decision audit), and which
// subagent delegations look like wasted time and tokens.

import { walkTraces, totalTokens, delegatedSlice, timeBreakdown, mcpCalls, MCP_RESOURCES } from './model.mjs';

// Delegation heuristics. Thresholds are deliberately conservative.
const TRIVIAL_MAX_CALLS = 2;      // a subagent that made this few tool calls…
const LOOKUP_MAX_CALLS = 5;       // …or only read/searched this few times
const DUPLICATE_SIMILARITY = 0.6; // prompt overlap with an earlier delegation
const REDONE_OVERLAP = 0.5;       // share of the child's files the parent re-reads
const RETRY_WINDOW = 3;           // spans after an error that count as a retry

// Time hotspots inside a session
const SLOW_THINK_MS = 60000;      // one reasoning step longer than this
const MODEL_WAIT_MS = 20000;      // model produced nothing for this long (queue / latency)
const SLOW_TOOL_MS = 60000;       // one non-agent tool call longer than this
const REREAD_MIN = 3;             // same file read this many times in one session
const BIG_CONTEXT = 100000;       // context tokens where every step gets slow and costly
const RUMINATION_HITS = 6;        // second-guessing phrases in one reasoning block…
const RUMINATION_DENSITY = 3;     // …per 1000 characters…
const RUMINATION_MS = 20000;      // …in a block at least this long
const USER_WAIT_TOOLS = new Set(['question']); // the agent waiting on you is not agent time
const RUMINATION = /\b(wait|actually|hmm+|on second thought|let me (?:re-?check|re-?verify|reconsider|re-?read|double-check|think again)|double-check|re-?check|re-?verify|reconsider|not sure|but then|or maybe|alternatively)\b/gi;

const duration = (x) => Math.max(0, (x.end || 0) - (x.start || 0));

function words(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9áéíóúñü_-]+/i).filter((w) => w.length > 2));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const filesRead = (spans) => new Set(spans.filter((s) => s.kind === 'read' && s.input.file).map((s) => s.input.file));

/** Count error → same-tool-again sequences inside one trace. */
function countRetries(spans) {
  let retries = 0;
  spans.forEach((s, i) => {
    if (s.status !== 'error') return;
    if (spans.slice(i + 1, i + 1 + RETRY_WINDOW).some((n) => n.tool === s.tool)) retries++;
  });
  return retries;
}

/**
 * Decision audit: how did this skill/agent call come about?
 * Only reports what is observable. The model's reasoning is never assumed.
 */
function decisionFor(span, trace) {
  const prompt = trace.prompts.find((p) => p.turn === span.turn);
  const name = span.name.toLowerCase();
  const text = (prompt?.text || '').toLowerCase();
  if (prompt?.attached?.some((a) => String(a).toLowerCase() === name)) {
    return { how: 'user-attached', observed: true, evidence: prompt.text.slice(0, 120), note: 'The user attached it to the prompt (@mention).' };
  }
  const re = new RegExp(`(^|[^a-z0-9_-])[/@]?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_-])`);
  if (prompt && re.test(text)) {
    const at = text.search(re);
    return {
      how: 'user-named',
      observed: true,
      evidence: prompt.text.slice(Math.max(0, at - 40), at + name.length + 40).trim(),
      note: 'The user prompt for this turn names it; the model then called it.',
    };
  }
  if (trace.parentId) {
    return { how: 'subagent-chose', observed: true, evidence: null, note: 'Called from inside a subagent; its prompt came from the parent agent.' };
  }
  return {
    how: 'model-chose',
    observed: true,
    evidence: null,
    note: 'The model issued the tool call without the user naming it. The runtime does not record why.',
  };
}

/** Classify one delegation (agent span) and its subagent trace. */
function delegationFindings(span, parent, child, slice, earlierDelegations) {
  const flags = [];
  const childSpans = slice?.spans || [];
  const calls = childSpans.length;

  const failed = span.status === 'error' || !child || ['aborted', 'error', 'empty'].includes(slice.outcome);
  if (failed) {
    const cancelled = /cancel|abort/i.test(span.error || '') || slice?.outcome === 'aborted';
    flags.push({ type: cancelled ? 'cancelled' : 'failed', detail: span.error || `subagent ended as "${slice?.outcome || 'missing'}"` });
  } else if (calls <= TRIVIAL_MAX_CALLS && !child.children.length) {
    flags.push({ type: 'trivial', detail: `subagent made ${calls} tool call${calls === 1 ? '' : 's'} — a direct call would have done` });
  } else if (calls <= LOOKUP_MAX_CALLS && childSpans.every((s) => s.kind === 'read' || s.kind === 'search')) {
    flags.push({ type: 'lookup', detail: `only ${calls} read/search calls — cheaper to run them directly` });
  }

  // parent re-reads what the subagent already read, later in the same turn.
  // Files the subagent changed don't count: reading those back is verification.
  const edited = new Set(childSpans.filter((s) => s.kind === 'edit' && s.input.file).map((s) => s.input.file));
  const childFiles = new Set([...filesRead(childSpans)].filter((f) => !edited.has(f)));
  if (childFiles.size) {
    const after = parent.spans.filter((s) => s.turn === span.turn && s.start >= span.end);
    const reread = [...filesRead(after)].filter((f) => childFiles.has(f));
    if (reread.length && reread.length / childFiles.size >= REDONE_OVERLAP) {
      flags.push({ type: 'redone', detail: `parent re-read ${reread.length}/${childFiles.size} files the subagent had already read`, files: reread });
    }
  }

  const prompt = words(span.input.prompt || span.input.description);
  // re-running after a failure is a retry, not duplicated work
  const dup = earlierDelegations.find((d) => d.status === 'ok' && d.name === span.name && jaccard(prompt, words(d.input.prompt || d.input.description)) >= DUPLICATE_SIMILARITY);
  if (dup) flags.push({ type: 'duplicate', detail: `repeats an earlier ${span.name} delegation ("${dup.input.description || ''}")`, of: dup.id });

  return flags;
}

function emptyStats() {
  return { invocations: 0, traces: new Set(), completed: 0, durationMs: 0, tokens: 0, cost: 0, errorsAfter: 0, callsAfter: 0, retriesAfter: 0 };
}

function finalizeStats(name, st) {
  const n = st.traces.size || 1;
  return {
    name,
    invocations: st.invocations,
    sessions: st.traces.size,
    completionRate: st.completed / n,
    avgDurationMs: st.durationMs / n,
    avgTokens: st.tokens / n,
    cost: st.cost,
    errorRateAfter: st.callsAfter ? st.errorsAfter / st.callsAfter : 0,
    retriesAfter: st.retriesAfter,
  };
}

/**
 * Where a session (one trace, without its subagents) loses time, step by step.
 * Facts (durations, repeats) are observed; `inferred: true` marks findings
 * that read the model's own reasoning text.
 */
function timeFindings(trace) {
  const out = [];
  const add = (type, step, ms, detail, extra = {}) => out.push({ type, traceId: trace.id, step: step?.index ?? null, at: step?.start ?? null, ms, detail, inferred: false, ...extra });
  const stepAt = (t) => trace.steps.find((s) => t >= s.start && t <= s.end) || null;

  for (const st of trace.steps) {
    if (st.thinkMs >= SLOW_THINK_MS) add('slow-thinking', st, st.thinkMs, `model reasoned for ${Math.round(st.thinkMs / 1000)} s before acting`);
    if (st.waitMs >= MODEL_WAIT_MS) add('model-wait', st, st.waitMs, `${Math.round(st.waitMs / 1000)} s before the model produced anything (provider queue / latency / long prompt)`);
  }
  const bigFrom = trace.steps.find((st) => st.tokens.context >= BIG_CONTEXT);
  if (bigFrom) {
    const after = trace.steps.filter((st) => st.index >= bigFrom.index);
    // the measurable cost of a huge prompt is the wait before each step starts producing
    add('big-context', bigFrom, after.reduce((n, st) => n + st.waitMs, 0),
      `context passed ${Math.round(BIG_CONTEXT / 1000)}k tokens at step ${bigFrom.index + 1}; the ${after.length} steps after it each re-read up to ${Math.round(Math.max(...after.map((s) => s.tokens.context)) / 1000)}k tokens`);
  }

  for (const sp of trace.spans) {
    if (sp.kind !== 'agent' && !USER_WAIT_TOOLS.has(sp.tool) && sp.end - sp.start >= SLOW_TOOL_MS) add('slow-tool', stepAt(sp.start), sp.end - sp.start, `${sp.tool} took ${Math.round((sp.end - sp.start) / 1000)} s${sp.input.command ? `: ${sp.input.command.slice(0, 80)}` : ''}`, { span: sp.id });
  }

  const reads = new Map();
  for (const sp of trace.spans) if (sp.kind === 'read' && sp.input.file) {
    if (!reads.has(sp.input.file)) reads.set(sp.input.file, []);
    reads.get(sp.input.file).push(sp);
  }
  for (const [file, sps] of reads) if (sps.length >= REREAD_MIN) {
    add('reread', stepAt(sps[1].start), sps.slice(1).reduce((n, x) => n + x.end - x.start, 0), `read ${sps.length}× ${file.split('/').slice(-2).join('/')}`, { spans: sps.map((x) => x.id) });
  }
  const cmds = new Map();
  for (const sp of trace.spans) if (sp.kind === 'exec' && sp.input.command) {
    const k = sp.input.command.trim();
    if (!cmds.has(k)) cmds.set(k, []);
    cmds.get(k).push(sp);
  }
  for (const [cmd, sps] of cmds) if (sps.length >= 2) {
    add('repeat-command', stepAt(sps[1].start), sps.slice(1).reduce((n, x) => n + x.end - x.start, 0), `ran the same command ${sps.length}×: ${cmd.slice(0, 80)}`, { spans: sps.map((x) => x.id) });
  }

  for (let i = 0; i < trace.spans.length; i++) {
    const run = [trace.spans[i]];
    while (i + run.length < trace.spans.length && trace.spans[i + run.length].status === 'error' && trace.spans[i + run.length].tool === trace.spans[i].tool) run.push(trace.spans[i + run.length]);
    if (trace.spans[i].status === 'error' && run.length >= 3) {
      add('error-loop', stepAt(run[0].start), run[run.length - 1].end - run[0].start, `${run.length} failed ${run[0].tool} calls in a row: ${run[0].error || ''}`.slice(0, 160));
      i += run.length - 1;
    }
  }

  // reading the reasoning text: inferred, never a fact about intent
  for (const th of trace.thinking) {
    if (!th.text) continue;
    const hits = (th.text.match(RUMINATION) || []).length;
    if (hits >= RUMINATION_HITS && hits / (th.text.length / 1000) >= RUMINATION_DENSITY && th.end - th.start >= RUMINATION_MS) {
      add('rumination', trace.steps[th.step] || null, th.end - th.start, `reasoning second-guesses itself ${hits}× in one block`, { inferred: true });
    }
  }
  return out.sort((a, b) => b.ms - a.ms);
}

/**
 * Calls per MCP server: configured servers first (so unused ones show up),
 * then any server seen in the traces that the config no longer lists.
 * configured: true / false (not in config any more) / null (not a server).
 */
function mcpUsage(all, rootOf, mcpServers) {
  const servers = new Map(mcpServers.map((m) => [m.name, { ...m, configured: true, calls: 0, viaCode: 0, errors: 0, durationMs: 0, sessions: new Set(), tools: {} }]));
  for (const t of all) {
    for (const c of t.spans.flatMap(mcpCalls)) {
      if (!servers.has(c.server)) servers.set(c.server, { name: c.server, type: null, enabled: null, scope: null, configured: c.server === MCP_RESOURCES ? null : false, calls: 0, viaCode: 0, errors: 0, durationMs: 0, sessions: new Set(), tools: {} });
      const m = servers.get(c.server);
      m.calls++;
      if (c.viaCode) m.viaCode++;
      if (c.status === 'error') m.errors++;
      m.durationMs += c.ms;
      m.sessions.add(rootOf.get(t.id));
      m.tools[c.tool] = (m.tools[c.tool] || 0) + 1;
    }
  }
  return [...servers.values()]
    .map((m) => ({ ...m, sessions: m.sessions.size }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

/**
 * @param {import('./model.mjs').Trace[]} traces top-level traces
 * @param {{ mcpServers?: { name: string, type: string|null, enabled: boolean, scope: string }[] }} [opts]
 */
export function analyzeRuntime(traces, { mcpServers = [] } = {}) {
  const all = [...walkTraces(traces)];
  const byId = new Map(all.map((t) => [t.id, t]));

  const skills = new Map();
  const decisions = [];
  const delegations = [];

  for (const trace of all) {
    const seenSkills = new Set();
    const earlier = [];
    trace.spans.forEach((span, i) => {
      if (span.kind === 'skill') {
        decisions.push({ traceId: trace.id, spanId: span.id, kind: 'skill', name: span.name, at: span.start, ...decisionFor(span, trace) });
        if (!skills.has(span.name)) skills.set(span.name, emptyStats());
        const st = skills.get(span.name);
        st.invocations++;
        if (seenSkills.has(span.name)) return; // per-trace outcome counted once
        seenSkills.add(span.name);
        st.traces.add(trace.id);
        if (trace.outcome === 'completed') st.completed++;
        st.durationMs += trace.activeMs;
        st.tokens += totalTokens(trace.tokens);
        st.cost += trace.cost;
        const after = trace.spans.slice(i + 1);
        st.callsAfter += after.length;
        st.errorsAfter += after.filter((s) => s.status === 'error').length;
        st.retriesAfter += countRetries(after);
      }
      if (span.kind === 'agent') {
        decisions.push({ traceId: trace.id, spanId: span.id, kind: 'agent', name: span.name, at: span.start, ...decisionFor(span, trace) });
        const child = span.childTraceId ? byId.get(span.childTraceId) : null;
        const slice = delegatedSlice(span, child);
        const flags = delegationFindings(span, trace, child, slice, earlier);
        earlier.push(span);
        delegations.push({
          traceId: trace.id,
          spanId: span.id,
          childTraceId: child?.id || null,
          agent: span.name,
          description: span.input.description || '',
          durationMs: duration(span),
          childTurns: slice?.turns || null,
          time: child ? timeBreakdown(child, slice.turns) : null,
          tokens: slice?.tokens || 0,
          cost: slice?.cost || 0,
          toolCalls: slice?.spans.length || 0,
          outcome: slice?.outcome || 'missing',
          flags,
        });
      }
    });
  }

  // baseline so skill numbers have something to be compared against
  const base = emptyStats();
  for (const t of traces) {
    base.traces.add(t.id);
    if (t.outcome === 'completed') base.completed++;
    base.durationMs += t.activeMs;
    base.tokens += totalTokens(t.tokens);
    base.cost += t.cost;
    base.callsAfter += t.spans.length;
    base.errorsAfter += t.spans.filter((s) => s.status === 'error').length;
    base.retriesAfter += countRetries(t.spans);
  }

  const agents = new Map();
  for (const d of delegations) {
    if (!agents.has(d.agent)) agents.set(d.agent, { name: d.agent, delegations: 0, flagged: 0, failed: 0, durationMs: 0, tokens: 0, cost: 0, toolCalls: 0 });
    const a = agents.get(d.agent);
    a.delegations++;
    if (d.flags.length) a.flagged++;
    if (d.flags.some((f) => f.type === 'failed' || f.type === 'cancelled')) a.failed++;
    a.durationMs += d.durationMs;
    a.tokens += d.tokens;
    a.cost += d.cost;
    a.toolCalls += d.toolCalls;
  }

  const wasted = delegations.filter((d) => d.flags.length);
  const hotspots = all.flatMap(timeFindings);

  // per top-level session, subagent sessions folded in
  const rootOf = new Map();
  for (const t of traces) for (const x of walkTraces([t])) rootOf.set(x.id, t.id);
  const sessions = traces.map((t) => {
    const tree = [...walkTraces([t])];
    const spans = tree.flatMap((x) => x.spans);
    const own = delegations.filter((d) => rootOf.get(d.traceId) === t.id);
    const flagged = own.filter((d) => d.flags.length);
    const used = (kind) => [...new Set(decisions.filter((d) => d.kind === kind && rootOf.get(d.traceId) === t.id).map((d) => d.name))];
    const mcp = {};
    for (const c of spans.flatMap(mcpCalls)) {
      const m = mcp[c.server] || (mcp[c.server] = { server: c.server, calls: 0, errors: 0, durationMs: 0 });
      m.calls++;
      if (c.status === 'error') m.errors++;
      m.durationMs += c.ms;
    }
    return {
      id: t.id,
      title: t.title,
      start: t.start,
      outcome: t.outcome,
      activeMs: t.activeMs,
      time: timeBreakdown(t),
      tokens: tree.reduce((n, x) => n + totalTokens(x.tokens), 0),
      cost: tree.reduce((n, x) => n + x.cost, 0),
      toolCalls: spans.length,
      errors: spans.filter((s) => s.status === 'error').length,
      retries: tree.reduce((n, x) => n + countRetries(x.spans), 0),
      skills: used('skill'),
      agents: used('agent'),
      mcp: Object.values(mcp).sort((a, b) => b.calls - a.calls),
      delegations: own.length,
      delegatedMs: own.reduce((n, d) => n + d.durationMs, 0),
      delegatedTokens: own.reduce((n, d) => n + d.tokens, 0),
      flagged: flagged.length,
      wasteMs: flagged.reduce((n, d) => n + d.durationMs, 0),
      wasteTokens: flagged.reduce((n, d) => n + d.tokens, 0),
      wasteCost: flagged.reduce((n, d) => n + d.cost, 0),
      hotspots: hotspots.filter((f) => rootOf.get(f.traceId) === t.id).length,
    };
  });

  return {
    sessions,
    counts: {
      sessions: traces.length,
      subagentSessions: all.length - traces.length,
      toolCalls: all.reduce((n, t) => n + t.spans.length, 0),
      skillCalls: decisions.filter((d) => d.kind === 'skill').length,
      delegations: delegations.length,
      mcpCalls: all.reduce((n, t) => n + t.spans.flatMap(mcpCalls).length, 0),
    },
    baseline: finalizeStats('(all sessions)', base),
    skills: [...skills].map(([name, st]) => finalizeStats(name, st)).sort((a, b) => b.invocations - a.invocations),
    agents: [...agents.values()].sort((a, b) => b.delegations - a.delegations),
    mcp: mcpUsage(all, rootOf, mcpServers),
    decisions,
    delegations,
    hotspots,
    waste: {
      // upper bound: the direct alternative would not have been free
      delegations: wasted.length,
      durationMs: wasted.reduce((n, d) => n + d.durationMs, 0),
      tokens: wasted.reduce((n, d) => n + d.tokens, 0),
      cost: wasted.reduce((n, d) => n + d.cost, 0),
      byType: wasted.flatMap((d) => d.flags).reduce((m, f) => ({ ...m, [f.type]: (m[f.type] || 0) + 1 }), {}),
    },
  };
}
