#!/usr/bin/env node
// skillmap CLI — scan an AI project folder and build a visual report.
//
//   skillmap <project-folder> [options]
//
// Options:
//   -o, --out <file>     Output HTML file (default: <project>/.skillmap/skillmap.html)
//   -j, --json <file>    Also write the raw graph as JSON
//       --open           Open the report in the default browser
//   -h, --help           Show help

import { resolve, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { scan } from '../lib/scan.mjs';
import { buildGraph, analyze } from '../lib/analyze.mjs';
import { buildPayload, writeReport } from '../lib/report.mjs';

const REPORT_DIR = '.skillmap';

const HELP = `skillmap — visualize a project's skills, agents and how they connect

Usage:
  skillmap <project-folder> [options]

Options:
  -o, --out <file>   Output HTML file   (default: <project>/.skillmap/skillmap.html)
  -j, --json <file>  Also write raw graph JSON
      --open         Open the report in your browser
  -h, --help         Show this help

Examples:
  skillmap .
  skillmap ~/code/my-app --open
  skillmap . -o reports/skillmap.html --json reports/skillmap.json
`;

function parseArgs(argv) {
  const args = { _: [], open: false };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('-')) throw new Error(`${flag} needs a file path`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--open') args.open = true;
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) { process.stdout.write(HELP); process.exit(args.help ? 0 : 1); }

  const root = resolve(args._[0]);
  const t0 = Date.now();

  const { docs } = scan(root);
  const graph = buildGraph(docs);
  const analysis = analyze(graph);
  const payload = buildPayload({ root, docs, graph, analysis });

  // By default the report lives inside the scanned project, next to what it describes.
  const out = args.out ? resolve(args.out) : join(root, REPORT_DIR, 'skillmap.html');
  if (!args.out && payload.meta.counts.docs === 0) {
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

try {
  main();
} catch (err) {
  process.stderr.write(`skillmap: ${err.message}\n`);
  process.exit(1);
}
