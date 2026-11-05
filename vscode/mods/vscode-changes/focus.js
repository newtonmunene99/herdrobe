// Shared module: edit lib/focus.js in ~/.config/herdr-app; sync-lib.sh copies it into every mod
// that imports it.
import { focused, panes, spaces } from "herdr";

// Where the person is working now: the focused pane's live folder (`cwd`, else the active space's
// folder), the machine it is on (`on`: null for this computer) and the active space's id.
// A focused layout terminal block has no pane, so its machine comes from its `machine/tN`
// address; otherwise it is the active space's machine. A folder on another machine has no local
// checkout: callers skip workspace contexts and local git when `on` is set.
export function focusPlace() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on: machineOf(f, space), space: space?.id ?? null };
}

// The machine the focus `f` is on, or null for this computer: a focused layout terminal block
// (no pane) by its `machine/tN` address, anything else by the active space.
function machineOf(f, space) {
  if (f?.pane !== null) return space?.machine ?? null;
  return f.terminal?.includes("/") ? f.terminal.split("/")[0] : null;
}
