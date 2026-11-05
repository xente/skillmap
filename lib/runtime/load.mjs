// skillmap — load sessions from every selected runtime as one list.

import * as opencode from './opencode.mjs';
import * as claude from './claude.mjs';

export const LABEL = { opencode: 'OpenCode', 'claude-code': 'Claude Code' };
export const RUNTIMES = { opencode: ['opencode'], claude: ['claude-code'], all: ['opencode', 'claude-code'] };
export const runtimeLabel = (sources) => sources.map((s) => LABEL[s]).join(' + ');

/** "7d" / "12h" / "30m" → ms */
export function parseAge(s) {
  const m = /^(\d+)\s*([dhm])$/.exec(s);
  if (!m) throw new Error(`--since expects an age like 7d, 12h or 30m, got "${s}"`);
  return Number(m[1]) * { d: 86400000, h: 3600000, m: 60000 }[m[2]];
}

/**
 * Sessions from every selected runtime, merged into one list. A runtime that
 * is missing or unreadable only matters when it was asked for by name or
 * nothing else had sessions: its error is returned in `notes`.
 * @param {string} root
 * @param {{ runtime: string, all?: boolean, since: string, db?: string, claudeDir?: string, thinking?: boolean }} args  CLI options
 */
export async function loadAllTraces(root, args) {
  const since = Date.now() - parseAge(args.since);
  const traces = [], servers = new Map(), sources = [], notes = [];
  for (const rt of RUNTIMES[args.runtime]) {
    try {
      let ts, mcp;
      if (rt === 'opencode') {
        ts = await opencode.loadTraces({ root, all: args.all, since, dbPath: args.db, includeThinking: args.thinking });
        mcp = opencode.loadMcpServers({ root, all: args.all, dirs: ts.map((t) => t.directory) });
      } else {
        ts = await claude.loadTraces({ root, all: args.all, since, configDir: args.claudeDir, includeThinking: args.thinking });
        mcp = await claude.loadMcpServers({ root, all: args.all, dirs: ts.map((t) => t.directory), configDir: args.claudeDir });
        claude.resolveMcpNames(ts, mcp);
      }
      // a runtime without sessions here says nothing about its MCP servers' use
      if (!ts.length) continue;
      sources.push(rt);
      traces.push(...ts);
      for (const m of mcp) if (!servers.has(m.name)) servers.set(m.name, m);
    } catch (err) {
      notes.push(`${LABEL[rt]}: ${err.message}`);
    }
  }
  traces.sort((a, b) => a.start - b.start);
  return { traces, mcpServers: [...servers.values()], sources, notes };
}
