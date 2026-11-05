// Shared module lib/focus.js: every mod that imports it carries an identical copy, so change all
// copies together (in the source home, edit lib/focus.js and sync-lib.sh copies it on save).
import { focused, panes, spaces } from "herdr";

// Where the person is working now: the focused pane's live folder (`cwd`, else the active space's
// folder), the machine it is on (`on`: null for this computer) and the active space's id.
// A focused layout terminal block has no pane, so its machine comes from its `machine/tN`
// address; otherwise it is the active space's machine. A folder on another machine has no local
// checkout: callers skip workspace contexts and local git when `on` is set.
//
// While a mod pane has the focus (a diff tab, History), it has no folder of its own, so the
// place stays the last one a terminal gave in the same space: the panels keep showing what was
// being reviewed instead of jumping to the space's folder. Each copy of this file keeps its own.
export function focusPlace() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const id = space?.id ?? null;
  if (pane?.mod && last?.space === id) return last;
  const place = { cwd: folderOf(pane, f, space), on: machineOf(f, space), space: id };
  if (!pane?.mod) last = place;
  return place;
}

// The folder the focus is in: the focused pane's live one, else the focus's own (a layout
// terminal block), else the active space's, else null.
function folderOf(pane, f, space) {
  return pane?.cwd || f?.cwd || space?.folder || null;
}

// The last place a non-mod focus gave (see focusPlace), or null.
let last = null;

// The machine the focus `f` is on, or null for this computer: a focused layout terminal block
// (no pane) by its `machine/tN` address, anything else by the active space.
function machineOf(f, space) {
  if (f?.pane !== null) return space?.machine ?? null;
  return f.terminal?.includes("/") ? f.terminal.split("/")[0] : null;
}
