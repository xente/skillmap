// skillmap — watch the runtimes' session stores and say when something changed.
// Claude Code appends to JSONL transcripts, OpenCode writes to its SQLite file
// (and its -wal), so watching the files is enough: no hooks to install.

import { watch, existsSync } from 'node:fs';
import { join, dirname, basename, sep } from 'node:path';
import * as claude from './claude.mjs';
import * as opencode from './opencode.mjs';
import { RUNTIMES } from './load.mjs';

const DEBOUNCE_MS = 750;

/**
 * Call `onChange` (debounced) whenever a session of the selected runtimes may
 * have changed. Runs are serialized: a change during a run triggers one more.
 * @param {{ root?: string, runtime?: string, all?: boolean, db?: string, claudeDir?: string }} args  CLI options
 * @param {() => Promise<void>} onChange
 * @returns {() => void} stop watching
 */
export function watchSessions(root, args, onChange) {
  const watchers = [];
  let timer = null, running = false, again = false;

  const run = async () => {
    if (running) { again = true; return; }
    running = true;
    try { await onChange(); } catch (err) { process.stderr.write(`skillmap: reload failed: ${err.message}\n`); }
    running = false;
    if (again) { again = false; run(); }
  };
  const poke = () => { clearTimeout(timer); timer = setTimeout(run, DEBOUNCE_MS); };

  const runtimes = RUNTIMES[args.runtime || 'all'];
  if (runtimes.includes('claude-code')) {
    const projects = join(args.claudeDir || claude.defaultConfigDir(), 'projects');
    const key = root && !args.all ? claude.projectKey(root) : null;
    if (existsSync(projects)) {
      watchers.push(watch(projects, { recursive: true }, (_, file) => {
        if (!file || !key) return poke();
        const folder = String(file).split(sep)[0];
        if (folder === key || folder.startsWith(key + '-')) poke();
      }));
    }
  }
  if (runtimes.includes('opencode')) {
    const db = args.db || opencode.defaultDbPath();
    if (existsSync(dirname(db))) {
      watchers.push(watch(dirname(db), (_, file) => { if (!file || String(file).startsWith(basename(db))) poke(); }));
    }
  }

  return () => { clearTimeout(timer); for (const w of watchers) w.close(); };
}
