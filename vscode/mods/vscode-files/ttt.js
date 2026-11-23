// Opens files in ttt (https://tttedit.dev), reusing a ttt already running in the tab. Used by the
// panel's file clicks (main.js) and by Ctrl/Cmd-clicked paths in terminals (link.js).
import { panes, focused, exec, hc, run } from "herdr";

// Hands a file to one specific running ttt. ttt listens for this only with "reuseWindow": true in
// ~/.config/ttt/settings.json, on a socket in its private per-user temp folder whose name ends in
// the editor's pid in base 36. The socket is checked first because, when TTT_FORWARD_SOCKET can't
// be reached, ttt falls back to the newest editor anywhere, which may be in another space.
// stdin is /dev/null because ttt never forwards when stdin is a pipe (it reads it as a buffer).
const FORWARD = 'd=${TMPDIR:-$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null)}; d=${d:-/tmp}; d="${d%/}/ttt-$(id -u)"; '
  + 'for s in "$d"/*-"$1".sock; do [ -S "$s" ] && TTT_FORWARD_SOCKET="$s" exec ttt "$2" </dev/null; done; exit 3';

// The process in the foreground of terminal pane p, or null when hc can't say.
async function foreground(p) {
  const r = await hc(["get", p.terminal, "--json"]).catch(() => null);
  try { return r?.code === 0 ? JSON.parse(r.stdout).foreground : null; } catch { return null; }
}

// Opens `arg` (a path, or "path:line[:col]") in a ttt already running in tab `tab`, else in a new
// ttt split to the right of pane `pane`, else in a new tab. Both default to the focused ones; a
// pane outside that tab (a peek, a layout terminal block) falls back to the tab's first terminal.
// --new-window keeps that new ttt from forwarding to an editor elsewhere.
export async function openInTtt(arg, { tab, pane } = {}) {
  const f = focused();
  tab ??= f?.tab; pane ??= f?.pane;
  const here = panes().filter(p => p.tab === tab && p.terminal);
  for (const p of here) {
    const fg = await foreground(p);
    if (fg?.name !== "ttt" || !fg.pid) continue;
    const sent = await exec("sh", ["-c", FORWARD, "ttt-open", fg.pid.toString(36), arg]).catch(() => null);
    if (sent?.code === 0) return run("pane.focus", { pane: p.pane });
  }
  const beside = here.find(p => p.pane === pane) ?? here[0];
  const argv = ["ttt", "--new-window", arg];
  if (beside) run("pane.split", { direction: "right", pane: beside.pane, argv });
  else run("tab.new", { argv });
}

// True when path is a regular file here and ttt is on PATH, so a link click can be taken.
export async function canOpen(path) {
  const r = await exec("sh", ["-c", 'test -f "$1" && command -v ttt >/dev/null', "can-open", path]).catch(() => null);
  return r?.code === 0;
}
