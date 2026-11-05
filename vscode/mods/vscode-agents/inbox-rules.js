// Shared module lib/inbox-rules.js: every mod that imports it carries an identical copy, so change all
// copies together (in the source home, edit lib/inbox-rules.js and sync-lib.sh copies it on save).
// The Inbox's rules as pure steps over its record, so they can be tested without Herdr
// (lib/inbox.test.js, `node --test lib/`). Only inbox.js imports this file; mods use inbox.js.
//
// The record ("box"), keyed by agent address:
//   prev:     last status seen (survives restarts and layout switches)
//   since:    ms of the last status change
//   finished: ms it finished, until settled or working again
//   settled:  ms it was settled (by Settle, or by being looked at for LOOK_MS)

// One week in ms: how long the record keeps the stamps of a terminal that has gone.
export const WEEK = 7 * 86400000;
// How long a finished agent must stay focused, with the window in front, to count as looked at.
export const LOOK_MS = 5000;
// The record's four maps, in the order they are listed above.
const MAPS = ["prev", "since", "finished", "settled"];

// A copy of record `s` (or an empty one) whose four maps can be changed freely.
export function copyBox(s) {
  return Object.fromEntries(MAPS.map((k) => [k, { ...s?.[k] }]));
}

// Records every status change in `list` (agents: address, status, focused) at time `now`, and
// forgets terminals missing from `live` (a Set of addresses) once their last stamp is a WEEK
// old. Changes `box` in place; true if anything changed.
export function track(box, list, live, now) {
  let changed = false;
  for (const a of list) {
    const was = box.prev[a.address];
    if (was === a.status) continue;
    changed = true;
    noteChange(box, a, was, now);
  }
  return forgetGone(box, live, now) || changed;
}

// Records agent `a` moving from status `was` to its current one.
function noteChange(box, a, was, now) {
  const s = a.status;
  box.since[a.address] = now;
  box.prev[a.address] = s;
  // New work: whatever it finished before is no longer the news.
  if (s === "working") { delete box.finished[a.address]; delete box.settled[a.address]; }
  // Needing an answer replaces "finished", so answering it can't bring back a stale card.
  if (s === "blocked") delete box.finished[a.address];
  // Herdr's "done" means it finished while nobody was looking (even the focused agent, when
  // the window is in the background): that always counts. Working -> idle means it was seen
  // finishing, or glanced at before "done" arrived: it counts only if it isn't the focused one,
  // which lookStep settles once it has really been looked at.
  const finished = s === "done" || (was === "working" && s === "idle" && !a.focused);
  if (finished && !box.finished[a.address] && !box.settled[a.address]) box.finished[a.address] = now;
}

// Forgets terminals missing from `live` whose last stamp is a WEEK old. True if any went.
function forgetGone(box, live, now) {
  let gone = false;
  for (const address of Object.keys(box.prev)) {
    if (live.has(address)) continue;
    const last = Math.max(box.since[address] ?? 0, box.finished[address] ?? 0, box.settled[address] ?? 0);
    if (now - last < WEEK) continue;
    for (const k of MAPS) delete box[k][address];
    gone = true;
  }
  return gone;
}

// Moves `addresses` from finished to settled, stamped `now`, in place. A settled agent can't
// finish again until it works again (noteChange clears both stamps then).
export function settle(box, addresses, now) {
  for (const a of addresses) { delete box.finished[a]; box.settled[a] = now; }
}

// One tick of the look-to-settle count. `looking` is the previous result's `looking` (null at
// first); `address` is the focused agent if it is finished and the window is in front, else
// null. Any change of agent, or a tick with null, restarts the count. Returns the next
// `looking` and the address to settle now, if any.
export function lookStep(looking, address, now) {
  if (!address) return { looking: null, settle: null };
  if (looking?.address !== address) return { looking: { address, since: now }, settle: null };
  if (now - looking.since < LOOK_MS) return { looking, settle: null };
  return { looking: null, settle: address };
}

// Sorters: pinned agents first, then by `stamps` (ms by address), oldest or newest first.
const oldest = (stamps) => (x, y) => (y.pinned - x.pinned) || ((stamps[x.address] ?? 0) - (stamps[y.address] ?? 0));
const newest = (stamps) => (x, y) => (y.pinned - x.pinned) || ((stamps[y.address] ?? 0) - (stamps[x.address] ?? 0));

// The agents in `list` split into the Inbox's four sections, each in its one order:
//   needs     blocked, pinned then waiting longest first
//   finished  finished and not settled, pinned then finished longest ago first ([] when !on)
//   working   working and not finished, pinned then newest change first
//   settled   everyone else, pinned then newest change first
// `when(a)` is the ms that a's section is about: when it finished, else its last change.
export function view(box, list, on) {
  const isFinished = (a) => on && a.status !== "blocked" && Boolean(box.finished[a.address]);
  const needs = list.filter((a) => a.status === "blocked").sort(oldest(box.since));
  const finished = list.filter(isFinished).sort(oldest(box.finished));
  const working = list.filter((a) => a.status === "working" && !isFinished(a)).sort(newest(box.since));
  const shown = new Set([...needs, ...finished, ...working].map((a) => a.address));
  const settled = list.filter((a) => !shown.has(a.address)).sort(newest(box.since));
  const when = (a) => (isFinished(a) ? box.finished[a.address] : box.since[a.address]);
  return { on, needs, finished, working, settled, when };
}
