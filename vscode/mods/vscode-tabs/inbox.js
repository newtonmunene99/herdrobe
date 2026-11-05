// Shared module lib/inbox.js: every mod that imports it carries an identical copy, so change all
// copies together (in the source home, edit lib/inbox.js and sync-lib.sh copies it on save).
// The Inbox: which agents finished and haven't been settled. Herdr turns "done" into "idle" the
// moment anyone looks, so a glance makes a finished agent look handled; the Inbox keeps it in
// Finished until the person settles it or has really looked at it. The rules are in
// inbox-rules.js; this file reads and writes their record in shared "vscode.inbox".
//
// Readers call inboxView() and settle(). vscode-statusbar, on screen in both VS Code layouts
// from launch, is the one that calls trackInbox() and lookTick(), so no finish is missed while
// another view or layout is showing.
import { agents, terminals, shared, setShared, window, layout } from "herdr";
import { hasMod } from "./layout.js";
import { copyBox, track, settle as settleIn, lookStep, view } from "./inbox-rules.js";

// The shared key holding the record.
const KEY = "vscode.inbox";

// Whether the Inbox shows: the shown layout has vscode-agents, the only place to Settle. So a
// layout cloned from vscode-inbox keeps Finished, and plain vscode (Herdr's agents mod) doesn't.
export function inboxOn() {
  return hasMod(layout(), "vscode-agents");
}

// The agents in `list` in the Inbox's four sections, in their one order: { on, needs, finished,
// working, settled, when(a) } (see view in inbox-rules.js). With the Inbox off, finished is
// empty. Call it in render: it re-runs whenever agents or the record change.
export function inboxView(list) {
  return view(copyBox(shared(KEY)), list, inboxOn());
}

// Moves the agents at `addresses` from Finished to Settled.
export function settle(addresses) {
  const box = copyBox(shared(KEY));
  settleIn(box, addresses, Date.now());
  setShared(KEY, box);
}

// Records every agent's status change since the last call; call it on every render of the one
// tracking mod (renders follow agent changes). It writes only when something changed, or once
// when no record exists yet so readers find one.
export function trackInbox() {
  const had = shared(KEY);
  const box = copyBox(had);
  const live = new Set(terminals().map((t) => t.address));
  if (track(box, agents(), live, Date.now()) || !had) setShared(KEY, box);
}

// The look-to-settle count, kept only in this copy (only the tracking mod ticks it).
let looking = null;
// Settles the focused finished agent once it has stayed focused, with the window in front, for
// LOOK_MS; call it once a second. Clicking straight past one leaves it in Finished.
export function lookTick() {
  const a = agents().find((x) => x.focused);
  const finished = a && window()?.active && shared(KEY)?.finished?.[a.address];
  const step = lookStep(looking, finished ? a.address : null, Date.now());
  looking = step.looking;
  if (step.settle) settle([step.settle]);
}
