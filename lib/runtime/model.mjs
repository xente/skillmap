// skillmap — normalized runtime model.
// Every runtime adapter (OpenCode today; Claude Code and Codex later) emits the
// same shapes, so analysis and the report never care where a trace came from.
//
// Trace — one session. Subagent sessions are nested under `children`.
// Span  — one tool call inside a session. Delegations are spans of kind 'agent'
//         whose `childTraceId` points at the subagent's trace.
//
// Only facts the runtime records go in here. Anything inferred is computed
// later in analyze.mjs and labelled as such.

/**
 * @typedef {{ input: number, output: number, reasoning: number, cacheRead: number, cacheWrite: number }} Tokens
 * @typedef {{ turn: number, at: number, text: string, attached: string[] }} Prompt  attached: skills/agents the user @-attached
 * @typedef {{
 *   id: string, traceId: string, turn: number,
 *   kind: 'agent'|'skill'|'read'|'search'|'edit'|'exec'|'web'|'other',
 *   name: string, tool: string, status: 'ok'|'error'|'pending', error: string|null,
 *   start: number, end: number, outputSize: number, childTraceId: string|null,
 *   input: Record<string, string>,
 * }} Span
 * @typedef {{
 *   runtime: string, id: string, parentId: string|null, title: string, directory: string,
 *   agent: string|null, model: string|null, variant: string|null, start: number, end: number,
 *   activeMs: number, tokens: Tokens, cost: number, stepCount: number, steps: Step[],
 *   outcome: 'completed'|'aborted'|'error'|'incomplete'|'empty',
 *   prompts: Prompt[], spans: Span[], children: Trace[], turns: TurnUsage[], thinking: Thinking[],
 * }} Trace
 * @typedef {{ turn: number, step: number|null, start: number, end: number, text?: string }} Thinking
 *   a reasoning block — model time that is not a tool call. `text` only with includeThinking:
 *   it is what the model wrote while reasoning, not a verified account of why it acted.
 * @typedef {{
 *   index: number, turn: number, start: number, end: number,
 *   tokens: { context: number, output: number, reasoning: number }, cost: number,
 *   finish: string|null, error: string|null, model: string|null, variant: string|null,
 *   waitMs: number, thinkMs: number, toolMs: number, agentMs: number, userMs: number, writeMs: number,
 *   items: { type: 'think'|'tool'|'agent'|'ask'|'text', start: number, end: number, ref?: string|number, text?: string }[],
 * }} Step
 *   one model call (assistant message); items point at thinking[] / spans[] by ref
 * @typedef {{ turn: number, tokens: number, cost: number, activeMs: number, outcome: string }} TurnUsage
 *   usage per user/parent turn — a subagent session can be resumed by several delegations
 */

const KINDS = {
  agent: 'agent',
  skill: 'skill',
  read: 'read', list: 'read',
  grep: 'search', glob: 'search',
  edit: 'edit', write: 'edit', patch: 'edit', multiedit: 'edit',
  bash: 'exec',
  webfetch: 'web', websearch: 'web',
};

/** Coarse category of a normalized tool name. */
export function spanKind(tool) {
  return KINDS[tool] || 'other';
}

/** @returns {Trace} */
export function makeTrace(fields) {
  return { prompts: [], spans: [], children: [], turns: [], thinking: [], steps: [], ...fields };
}

/** @returns {Span} */
export function makeSpan(fields) {
  return fields;
}

export const totalTokens = (t) => t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;

/** Depth-first walk over a trace and all its subagent traces. */
export function* walkTraces(traces) {
  for (const t of traces) {
    yield t;
    yield* walkTraces(t.children);
  }
}

/**
 * The part of a subagent trace that belongs to one delegation. OpenCode can
 * resume the same subagent session for several delegations; each one starts a
 * new turn, so match turns whose prompt arrived while the delegation ran.
 */
export function delegatedSlice(span, child) {
  if (!child) return null;
  const turns = child.prompts.filter((p) => p.at >= span.start - 2000 && p.at <= span.end).map((p) => p.turn);
  if (!turns.length || turns.length === child.prompts.length) {
    return { turns: null, spans: child.spans, tokens: totalTokens(child.tokens), cost: child.cost, outcome: child.outcome };
  }
  const set = new Set(turns);
  const usage = child.turns.filter((u) => set.has(u.turn));
  return {
    turns,
    spans: child.spans.filter((s) => set.has(s.turn)),
    tokens: usage.reduce((n, u) => n + u.tokens, 0),
    cost: usage.reduce((n, u) => n + u.cost, 0),
    outcome: usage.length ? usage[usage.length - 1].outcome : child.outcome,
  };
}

/**
 * Where the time of a trace (or a set of its turns) went: waiting on subagents,
 * tool calls, model reasoning, and the rest (writing output, provider latency).
 */
export function timeBreakdown(trace, turns = null) {
  const inTurn = (x) => !turns || turns.includes(x.turn);
  const ms = (xs) => xs.reduce((n, s) => n + Math.max(0, s.end - s.start), 0);
  const spans = trace.spans.filter(inTurn);
  const agentMs = ms(spans.filter((s) => s.kind === 'agent'));
  const toolMs = ms(spans.filter((s) => s.kind !== 'agent'));
  const thinkMs = ms(trace.thinking.filter(inTurn));
  const activeMs = turns ? trace.turns.filter(inTurn).reduce((n, u) => n + u.activeMs, 0) : trace.activeMs;
  return { activeMs, agentMs, toolMs, thinkMs, otherMs: Math.max(0, activeMs - agentMs - toolMs - thinkMs) };
}
