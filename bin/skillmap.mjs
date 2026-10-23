#!/usr/bin/env node
// skillmap CLI — scan an AI project folder and build a visual report.
//
//   skillmap <project-folder> [options]
//   skillmap trace [project-folder] [options]   runtime traces (OpenCode)
//
// Options:
//   -o, --out <file>     Output HTML file (default: <project>/.skillmap/skillmap.html)
//   -j, --json <file>    Also write the raw graph as JSON
//       --open           Open the report in the default browser
//   -h, --help           Show help

import { resolve, join, basename } from 'node:path';
import { writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { scan } from '../lib/scan.mjs';
import { buildGraph, analyze } from '../lib/analyze.mjs';
import { buildPayload, writeReport } from '../lib/report.mjs';
import { loadTraces, loadMcpServers } from '../lib/runtime/opencode.mjs';
import { analyzeRuntime } from '../lib/runtime/analyze.mjs';

const REPORT_DIR = '.skillmap';

const HELP = `skillmap — visualize a project's skills, agents and how they connect

Usage:
  skillmap <project-folder> [options]
  skillmap trace [project-folder] [options]

Options:
  -o, --out <file>   Output HTML file   (default: <project>/.skillmap/skillmap.html)
  -j, --json <file>  Also write raw graph JSON
      --open         Open the report in your browser
      --no-trace     Skip the Runtime tab (OpenCode session traces)
      --include-thinking
                     Embed the model's reasoning text in the report (large; may
                     contain sensitive details — don't share the report blindly)
  -h, --help         Show this help

Runtime options (report + trace; read OpenCode sessions, needs Node 22.5+):
      --all          Every project, not just <project-folder>
      --since <age>  Only sessions newer than this (e.g. 7d, 12h; default 30d)
      --db <file>    OpenCode database (default ~/.local/share/opencode/opencode.db)

Examples:
  skillmap .
  skillmap ~/code/my-app --open
  skillmap . -o reports/skillmap.html --json reports/skillmap.json
  skillmap trace . --since 7d
`;

function parseArgs(argv) {
  const args = { _: [], open: false, all: false, since: '30d', trace: true };
  if (argv[0] === 'trace') { args.command = 'trace'; argv = argv.slice(1); }
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('-')) throw new Error(`${flag} needs a file path`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--open') args.open = true;
    else if (a === '--all') args.all = true;
    else if (a === '--no-trace') args.trace = false;
    else if (a === '--include-thinking') args.thinking = true;
    else if (a === '--since') args.since = value(++i, a);
    else if (a === '--db') args.db = value(++i, a);
    else if (a === '-o' || a === '--out') args.out = value(++i, a);
    else if (a === '-j' || a === '--json') args.json = value(++i, a);
    else if (a.startsWith('--out=')) args.out = a.slice(6);
    else if (a.startsWith('--json=')) args.json = a.slice(7);
    else if (a.startsWith('-') && a !== '-') throw new Error(`unknown option ${a} (see --help)`);
    else args._.push(a);
  }
  if (args._.length > 1) throw new Error(`expected one project folder, got ${args._.length} (see --help)`);
  return args;
}

let runtimeNote = '';
// Runtime traces are a bonus on the static report: never fail the scan over them.
async function loadRuntime(root, args) {
  try {
    const traces = await loadTraces({ root, all: args.all, since: Date.now() - parseAge(args.since), dbPath: args.db, includeThinking: args.thinking });
    if (!traces.length) { runtimeNote = `no OpenCode sessions for this folder in the last ${args.since}`; return null; }
    const mcpServers = loadMcpServers({ root, all: args.all, dirs: traces.map((t) => t.directory) });
    return { source: 'opencode', since: args.since, thinking: Boolean(args.thinking), traces, analysis: analyzeRuntime(traces, { mcpServers }) };
  } catch (err) {
    runtimeNote = err.message;
    return null;
  }
}

function parseAge(s) {
  const m = /^(\d+)\s*([dhm])$/.exec(s);
  if (!m) throw new Error(`--since expects an age like 7d, 12h or 30m, got "${s}"`);
  return Number(m[1]) * { d: 86400000, h: 3600000, m: 60000 }[m[2]];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'trace' && !args.help) return trace(args);
  if (args.all) throw new Error('--all only applies to `skillmap trace`');
  if (args.help || args._.length === 0) { process.stdout.write(HELP); process.exit(args.help ? 0 : 1); }

  const root = resolve(args._[0]);
  const t0 = Date.now();

  const { docs } = scan(root);
  const graph = buildGraph(docs);
  const analysis = analyze(graph);
  const runtime = args.trace ? await loadRuntime(root, args) : null;
  const payload = buildPayload({ root, docs, graph, analysis, runtime });

  // By default the report lives inside the scanned project, next to what it describes.
  const out = args.out ? resolve(args.out) : join(root, REPORT_DIR, 'skillmap.html');
  if (!args.out && payload.meta.counts.docs === 0 && !runtime?.analysis.counts.sessions) {
    // don't litter an unrelated folder with an empty .skillmap/
    throw new Error(`no SKILL.md, agents/*.md or AGENTS.md-style files found in ${root} — is this the right folder?`);
  }
  writeReport(out, payload);
  if (args.json) { writeFileSync(resolve(args.json), JSON.stringify(payload, null, 2), 'utf8'); }

  const c = payload.meta.counts;
  const line = (s) => process.stdout.write(s + '\n');
  line('');
  line(`  ◍  SkillMap · ${payload.meta.projectLabel}`);
  line(`     ${root}`);
  line('  ' + '─'.repeat(56));
  line(`     Skills ${c.skills}   Agents ${c.agents}   Instructions ${c.instructions}   Links ${c.edges}`);
  if (c.docs === 0) line('     ! No SKILL.md, agents/*.md or AGENTS.md-style files found — is this the right folder?');
  line(`     Health ${analysis.health.grade} (${analysis.health.score}/100)`);
  line(`     Unused ${analysis.unused.length} · Duplicate names ${analysis.duplicateNames.length} · Similar names ${analysis.similarNames.length} · Overlapping descriptions ${analysis.descDupes.length} · Cycles ${analysis.cycles.length}`);
  line('');
  line(`  ✔ Report written to ${out}`);
  if (runtime) {
    const r = runtime.analysis;
    line(`     Runtime (OpenCode, last ${args.since}): ${r.counts.sessions} sessions · ${r.counts.delegations} delegations · ${r.waste.delegations} flagged`);
  } else if (args.trace && runtimeNote) line(`     Runtime: ${runtimeNote}`);
  if (args.json) line(`  ✔ Graph JSON written to ${resolve(args.json)}`);
  line(`  ⏱  ${Date.now() - t0} ms`);

  if (args.open) {
    // `start` is a cmd.exe builtin, not an executable — it has to go through cmd.
    const [cmd, cmdArgs] = process.platform === 'darwin' ? ['open', [out]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', out]]
      : ['xdg-open', [out]];
    execFile(cmd, cmdArgs, (err) => {
      if (err) process.stderr.write(`  ! Could not open the browser automatically — open ${out} manually.\n`);
    });
  }
}

const fmtMs = (ms) => (ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`);
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const pct = (x) => `${Math.round(x * 100)}%`;

async function trace(args) {
  const root = resolve(args._[0] || '.');
  const traces = await loadTraces({ root, all: args.all, since: Date.now() - parseAge(args.since), dbPath: args.db, includeThinking: args.thinking });
  const mcpServers = loadMcpServers({ root, all: args.all, dirs: traces.map((t) => t.directory) });
  const r = analyzeRuntime(traces, { mcpServers });
  if (args.json) writeFileSync(resolve(args.json), JSON.stringify({ root: args.all ? null : root, traces, analysis: r }, null, 2), 'utf8');

  const line = (s = '') => process.stdout.write(s + '\n');
  const c = r.counts;
  line();
  line(`  ◍  SkillMap trace · OpenCode · ${args.all ? 'all projects' : basename(root)} · last ${args.since}`);
  line('  ' + '─'.repeat(56));
  line(`     Sessions ${c.sessions}   Subagent sessions ${c.subagentSessions}   Tool calls ${c.toolCalls}`);
  line(`     Skill calls ${c.skillCalls}   Delegations ${c.delegations}   MCP calls ${c.mcpCalls}`);
  if (!c.sessions) line(`     ! No OpenCode sessions found${args.all ? '' : ' for this folder — try --all or a longer --since'}.`);

  if (r.skills.length) {
    const b = r.baseline;
    line();
    line('  Skills                     calls  done   errors after  retries  avg time');
    line(`     ${'(baseline)'.padEnd(23)} ${'-'.padStart(5)}  ${pct(b.completionRate).padStart(4)}   ${pct(b.errorRateAfter).padStart(12)}  ${String(b.retriesAfter).padStart(7)}  ${fmtMs(b.avgDurationMs)}`);
    for (const s of r.skills) {
      line(`     ${s.name.slice(0, 23).padEnd(23)} ${String(s.invocations).padStart(5)}  ${pct(s.completionRate).padStart(4)}   ${pct(s.errorRateAfter).padStart(12)}  ${String(s.retriesAfter).padStart(7)}  ${fmtMs(s.avgDurationMs)}`);
    }
  }

  if (r.agents.length) {
    line();
    line('  Subagents                  calls  flagged  failed  avg calls  avg time   tokens');
    for (const a of r.agents) {
      line(`     ${a.name.slice(0, 23).padEnd(23)} ${String(a.delegations).padStart(5)}  ${String(a.flagged).padStart(7)}  ${String(a.failed).padStart(6)}  ${(a.toolCalls / a.delegations).toFixed(1).padStart(9)}  ${fmtMs(a.durationMs / a.delegations).padStart(8)}  ${fmtTok(a.tokens).padStart(7)}`);
    }
  }

  if (r.mcp.length) {
    line();
    line('  MCP servers                calls  via code  errors  sessions  time      tools used');
    for (const m of r.mcp) {
      const note = m.configured === false ? '  (not in config)' : m.enabled === false ? '  (disabled)' : '';
      line(`     ${m.name.slice(0, 23).padEnd(23)} ${String(m.calls).padStart(5)}  ${String(m.viaCode).padStart(8)}  ${String(m.errors).padStart(6)}  ${String(m.sessions).padStart(8)}  ${fmtMs(m.durationMs).padEnd(8)}  ${Object.keys(m.tools).length || '-'}${note}`);
    }
  }

  const w = r.waste;
  if (w.delegations) {
    line();
    line(`  Possibly unnecessary delegations: ${w.delegations}/${c.delegations}  (≤ ${fmtMs(w.durationMs)}, ≤ ${fmtTok(w.tokens)} tokens, ≤ $${w.cost.toFixed(2)})`);
    line(`     ${Object.entries(w.byType).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    for (const d of r.delegations.filter((d) => d.flags.length).slice(0, 10)) {
      line(`     - ${d.agent}: "${d.description}"  ${fmtMs(d.durationMs)}, ${fmtTok(d.tokens)} tok`);
      for (const f of d.flags) line(`         ${f.type}: ${f.detail}`);
    }
  }

  const costly = r.sessions.filter((x) => x.flagged).sort((a, b) => b.wasteTokens - a.wasteTokens).slice(0, 10);
  if (costly.length) {
    line();
    line('  Sessions with flagged delegations     flagged  waste time  waste tok  session tok');
    for (const x of costly) {
      line(`     ${(x.title || x.id).slice(0, 34).padEnd(34)} ${`${x.flagged}/${x.delegations}`.padStart(7)}  ${fmtMs(x.wasteMs).padStart(10)}  ${fmtTok(x.wasteTokens).padStart(9)}  ${fmtTok(x.tokens).padStart(11)}`);
    }
  }

  const how = r.decisions.reduce((m, d) => ({ ...m, [d.how]: (m[d.how] || 0) + 1 }), {});
  if (r.decisions.length) {
    line();
    line(`  Why skills/agents ran (observed): ${Object.entries(how).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  }
  line();
  if (args.json) line(`  ✔ Trace JSON written to ${resolve(args.json)}`);
}

main().catch((err) => {
  process.stderr.write(`skillmap: ${err.message}\n`);
  process.exit(1);
});
