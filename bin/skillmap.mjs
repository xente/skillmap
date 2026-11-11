#!/usr/bin/env node
// skillmap CLI — scan an AI project folder and build a visual report.
//
//   skillmap <project-folder> [options]
//   skillmap trace [project-folder] [options]   runtime traces (OpenCode, Claude Code)
//   skillmap live                               live status of one session (herdr pane)
//   skillmap --global                           every project's sessions: tokens, cost, history
//   skillmap app                                the same, in its own window
//
// Options:
//   -o, --out <file>     Output HTML file (default: <project>/.skillmap/skillmap.html)
//   -j, --json <file>    Also write the raw graph as JSON
//       --open           Open the report in the default browser
//   -h, --help           Show help

import { resolve, join, basename } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { scan } from '../lib/scan.mjs';
import { buildGraph, analyze } from '../lib/analyze.mjs';
import { buildPayload, writeReport } from '../lib/report.mjs';
import { serveReport } from '../lib/serve.mjs';
import { analyzeRuntime } from '../lib/runtime/analyze.mjs';
import { RUNTIMES, runtimeLabel, loadAllTraces } from '../lib/runtime/load.mjs';
import { watchSessions } from '../lib/runtime/watch.mjs';
import { enableCache } from '../lib/runtime/claude.mjs';
import { live } from '../lib/live.mjs';
import { buildGlobalPayload, writeGlobalReport, serveGlobal } from '../lib/global.mjs';
import { homedir } from 'node:os';

const REPORT_DIR = '.skillmap';

const HELP = `skillmap — visualize a project's skills, agents and how they connect

Usage:
  skillmap <project-folder> [options]
  skillmap trace [project-folder] [options]
  skillmap live                   Live status of one agent session (herdr pane)
  skillmap --global [options]     Every project's sessions in one page: tokens and cost
                                  over time, by project, editor, model and agent
  skillmap app [options]          The same, in its own window (Chrome, Edge, Brave or
                                  Chromium); Ctrl+C stops it. Takes the --global options

Options:
  -o, --out <file>   Output HTML file   (default: <project>/.skillmap/skillmap.html)
  -j, --json <file>  Also write raw graph JSON
      --open         Open the report in your browser
      --watch        Serve the report on localhost and update the Runtime tab
                     live as sessions change (instead of writing a file)
      --port <n>     Port for --watch (default 4317; if taken by another
                     project's server, the next free one is used)
      --global       Global report across all projects instead of one folder.
                     Served on localhost (--port, --open); opening a session
                     loads its project's report with the session's flow. With
                     -o it writes a static page instead, without that. Takes --since,
                     --runtime, --db and --claude-dir
      --no-trace     Skip the Runtime tab (OpenCode / Claude Code session traces)
      --include-thinking
                     Embed the model's reasoning text in the report (large; may
                     contain sensitive details — don't share the report blindly)
  -h, --help         Show this help

Runtime options (report + trace; read local session history):
      --runtime <r>  opencode, claude or all (default all: whichever has sessions)
      --all          Every project, not just <project-folder>
      --since <age>  Only sessions newer than this (e.g. 7d, 12h; default 30d)
      --db <file>    OpenCode database (default ~/.local/share/opencode/opencode.db;
                     OpenCode needs Node 22.5+)
      --claude-dir <dir>
                     Claude Code config folder (default $CLAUDE_CONFIG_DIR or ~/.claude)

Examples:
  skillmap .
  skillmap ~/code/my-app --open
  skillmap . -o reports/skillmap.html --json reports/skillmap.json
  skillmap . --watch --open
  skillmap trace . --since 7d
`;

function parseArgs(argv) {
  const args = { _: [], open: false, all: false, since: '30d', trace: true, runtime: 'all', watch: false, port: 4317 };
  if (argv[0] === 'trace' || argv[0] === 'live') { args.command = argv[0]; argv = argv.slice(1); }
  else if (argv[0] === 'app') { args.global = true; args.appWindow = true; argv = argv.slice(1); } // the global report in its own window
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('-')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--open') args.open = true;
    else if (a === '--all') args.all = true;
    else if (a === '--watch') args.watch = true;
    else if (a === '--global') args.global = true;
    else if (a === '--port') { args.port = Number(value(++i, a)); args.portSet = true; }
    else if (a === '--no-trace') args.trace = false;
    else if (a === '--include-thinking') args.thinking = true;
    else if (a === '--since') args.since = value(++i, a);
    else if (a === '--db') args.db = value(++i, a);
    else if (a === '--claude-dir') args.claudeDir = value(++i, a);
    else if (a === '--runtime') args.runtime = value(++i, a);
    else if (a === '-o' || a === '--out') args.out = value(++i, a);
    else if (a === '-j' || a === '--json') args.json = value(++i, a);
    else if (a.startsWith('--out=')) args.out = a.slice(6);
    else if (a.startsWith('--json=')) args.json = a.slice(7);
    else if (a.startsWith('-') && a !== '-') throw new Error(`unknown option ${a} (see --help)`);
    else args._.push(a);
  }
  if (args._.length > 1) throw new Error(`expected one project folder, got ${args._.length} (see --help)`);
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error(`--port expects a port number, got "${args.port}"`);
  if (!RUNTIMES[args.runtime]) throw new Error(`--runtime expects ${Object.keys(RUNTIMES).join(', ')}, got "${args.runtime}"`);
  return args;
}

let runtimeNote = '';
// Runtime traces are a bonus on the static report: never fail the scan over them.
async function loadRuntime(root, args) {
  try {
    const { traces, mcpServers, sources, notes } = await loadAllTraces(root, args);
    if (!traces.length) {
      runtimeNote = notes.length && args.runtime !== 'all' ? notes.join('; ') : `no ${runtimeLabel(RUNTIMES[args.runtime])} sessions for this folder in the last ${args.since}`;
      return null;
    }
    return { source: sources.join('+'), sources, since: args.since, thinking: Boolean(args.thinking), traces, analysis: analyzeRuntime(traces, { mcpServers }) };
  } catch (err) {
    runtimeNote = err.message;
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'trace' && !args.help) return trace(args);
  if (args.command === 'live' && !args.help) return live(args);
  if (args.global && !args.help) return globalReport(args);
  if (args.all) throw new Error('--all only applies to `skillmap trace`');
  if (args.help || args._.length === 0) { process.stdout.write(HELP); process.exit(args.help ? 0 : 1); }

  const root = resolve(args._[0]);
  const t0 = Date.now();

  const { docs } = scan(root);
  const graph = buildGraph(docs);
  const analysis = analyze(graph);
  if (args.watch) return serveLive(root, args, { docs, graph, analysis });
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
    line(`     Runtime (${runtimeLabel(runtime.sources)}, last ${args.since}): ${r.counts.sessions} sessions · ${r.counts.delegations} delegations · ${r.waste.delegations} flagged`);
  } else if (args.trace && runtimeNote) line(`     Runtime: ${runtimeNote}`);
  if (args.json) line(`  ✔ Graph JSON written to ${resolve(args.json)}`);
  line(`  ⏱  ${Date.now() - t0} ms`);

  if (args.open) openBrowser(out);
}

// --global: every project's sessions in one page, written to the home folder
async function globalReport(args) {
  if (args._.length) throw new Error('--global covers every project: it takes no project folder');
  const t0 = Date.now();
  if (!args.out) enableCache(); // served: later reloads only re-read the session files that changed
  const { traces, mcpServers, sources, notes } = await loadAllTraces(process.cwd(), { ...args, all: true });
  if (!traces.length) throw new Error(notes.length ? notes.join('; ') : `no ${runtimeLabel(RUNTIMES[args.runtime])} sessions in the last ${args.since}`);
  const payload = buildGlobalPayload(traces, { since: args.since, sources, notes, mcpServers });
  const line = (s = '') => process.stdout.write(s + '\n');
  const subs = payload.rows.length - traces.length;
  const head = () => {
    line();
    line(`  ◍  SkillMap global · ${runtimeLabel(sources)} · last ${args.since}`);
    line('  ' + '─'.repeat(56));
    line(`     ${traces.length} sessions (+ ${subs} subagent) in ${new Set(traces.map((t) => t.directory)).size} projects`);
    for (const n of notes) line(`     ! ${n}`);
    line();
  };
  // -o writes a static page (no session detail); otherwise it is served on localhost
  if (args.out) {
    const out = writeGlobalReport(resolve(args.out), payload);
    head();
    line(`  ✔ Report written to ${out}  (static: the session detail needs the served page)`);
    line(`  ⏱  ${Date.now() - t0} ms`);
    if (args.open) openBrowser(out);
    return;
  }
  const reload = () => loadAllTraces(process.cwd(), { ...args, all: true });
  const server = await serveGlobal({ port: args.port, strict: args.portSet, payload, traces, mcpServers, sources, since: args.since, reload });
  head();
  line(`  ✔ ${server.url}  (localhost only · Ctrl+C to stop)`);
  line(`  ⏱  ${Date.now() - t0} ms`);
  if (args.appWindow) openAppWindow(server.url);
  else if (args.open) openBrowser(server.url);
  const quit = () => { server.close(); process.exit(0); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}

// A Chromium browser's app mode: the page in a window of its own, without tabs or address bar.
// Falls back to a normal browser tab when none is installed.
function openAppWindow(url) {
  const flags = [`--app=${url}`, '--window-size=1440,900'];
  const tries = process.platform === 'darwin'
    ? ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium']
        .filter((n) => [`/Applications/${n}.app`, join(homedir(), 'Applications', `${n}.app`)].some(existsSync))
        .map((n) => ['open', ['-na', n, '--args', ...flags]])
    : process.platform === 'win32'
      ? ['chrome', 'msedge', 'brave'].map((n) => ['cmd', ['/c', 'start', '""', n, ...flags]])
      : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'].map((n) => [n, flags]);
  const next = (i) => {
    if (i >= tries.length) { process.stderr.write('  ! No Chrome, Edge or Brave found for a window of its own: opening a browser tab.\n'); return openBrowser(url); }
    execFile(tries[i][0], tries[i][1], (err) => { if (err) next(i + 1); });
  };
  next(0);
}

function openBrowser(target) {
  // `start` is a cmd.exe builtin, not an executable — it has to go through cmd.
  const [cmd, cmdArgs] = process.platform === 'darwin' ? ['open', [target]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]]
    : ['xdg-open', [target]];
  execFile(cmd, cmdArgs, (err) => {
    if (err) process.stderr.write(`  ! Could not open the browser automatically — open ${target} manually.\n`);
  });
}

// --watch: serve the report and push the runtime to open pages on every change.
// Skills and agents are scanned once; only the sessions are reloaded.
async function serveLive(root, args, scanned) {
  if (!args.trace) throw new Error('--watch shows live sessions, so it cannot be combined with --no-trace');
  enableCache();
  const line = (s = '') => process.stdout.write(s + '\n');
  let runtime = await loadRuntime(root, args);
  let sent = JSON.stringify(runtime);
  let server;
  try {
    server = await serveReport({ port: args.port, strict: args.portSet, root, payload: () => buildPayload({ root, ...scanned, runtime }) });
  } catch (err) {
    if (err.code !== 'SKILLMAP_RUNNING') throw err;
    line(`  ${err.message}`);
    if (args.open) openBrowser(`http://127.0.0.1:${err.port}/`);
    return;
  }
  line('');
  line(`  ◍  SkillMap live · ${basename(root)}`);
  line(`     ${server.url}  (localhost only · Ctrl+C to stop)`);
  line(runtime ? `     ${runtime.analysis.counts.sessions} sessions (${runtimeLabel(runtime.sources)}, last ${args.since})` : `     ${runtimeNote || 'no sessions yet'} — waiting for one`);
  if (args.open) openBrowser(server.url);

  const stop = watchSessions(root, args, async () => {
    const t0 = Date.now();
    const next = await loadRuntime(root, args);
    const json = JSON.stringify(next);
    if (json === sent) return;
    runtime = next;
    sent = json;
    server.send('runtime', runtime);
    line(`     ${new Date().toLocaleTimeString()}  updated · ${runtime ? runtime.analysis.counts.sessions : 0} sessions · ${Date.now() - t0} ms`);
  });
  const quit = () => { stop(); server.close(); process.exit(0); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}

const fmtMs = (ms) => (ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`);
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const pct = (x) => `${Math.round(x * 100)}%`;

async function trace(args) {
  const root = resolve(args._[0] || '.');
  const { traces, mcpServers, sources, notes } = await loadAllTraces(root, args);
  if (!traces.length && notes.length && args.runtime !== 'all') throw new Error(notes.join('; '));
  const r = analyzeRuntime(traces, { mcpServers });
  const label = runtimeLabel(sources.length ? sources : RUNTIMES[args.runtime]);
  if (args.json) writeFileSync(resolve(args.json), JSON.stringify({ root: args.all ? null : root, traces, analysis: r }, null, 2), 'utf8');

  const line = (s = '') => process.stdout.write(s + '\n');
  const c = r.counts;
  line();
  line(`  ◍  SkillMap trace · ${label} · ${args.all ? 'all projects' : basename(root)} · last ${args.since}`);
  line('  ' + '─'.repeat(56));
  line(`     Sessions ${c.sessions}   Subagent sessions ${c.subagentSessions}   Tool calls ${c.toolCalls}`);
  line(`     Skill calls ${c.skillCalls}   Delegations ${c.delegations}   MCP calls ${c.mcpCalls}`);
  if (sources.includes('claude-code')) line('     Claude Code costs are estimates from list prices (it records tokens, not cost).');
  if (!c.sessions) line(`     ! No ${label} sessions found${args.all ? '' : ' for this folder — try --all or a longer --since'}.`);

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
