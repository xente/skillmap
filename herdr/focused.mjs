// Prints agent, session, cwd, tab and the live pane in that tab, separated by
// \x1f (not a tab: the shell's read would merge empty fields), for herdr's
// focused pane, from `herdr pane list` JSON on stdin. Empty fields when unknown.
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  let panes = [];
  try { panes = JSON.parse(s).result?.panes || []; } catch { /* herdr not answering */ }
  const f = panes.find((p) => p.focused) || {};
  const live = panes.find((p) => p.tab_id === f.tab_id && p.terminal_title_stripped === 'skillmap live');
  const agent = f.agent === 'claude' || f.agent === 'opencode' ? f.agent : '';
  process.stdout.write([agent, agent ? f.agent_session?.value || '' : '', f.foreground_cwd || f.cwd || '', f.tab_id || '', live?.pane_id || ''].join('\x1f') + '\n');
});
