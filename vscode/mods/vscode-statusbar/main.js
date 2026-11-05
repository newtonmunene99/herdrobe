// VS Code-style status bar: a blue "remote" corner with the space's machine, then branch and
// agents; the layout name on the right opens a picker of every layout. When context.js gives the
// focused folder a workspace context, it also shows that context's badge. It runs naming.js's
// nameSpaces() on a timer; the published naming.js does nothing.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, agents, panes, terminals, focused, theme, run, shared, setShared, exec, notify, nextCommand, window, props, layouts, openOverlay, closeOverlay } from "herdr";
import { contextFor, openHistory } from "./context.js";
import { nameSpaces } from "./naming.js";

// The inbox: which agents finished and haven't been settled. Herdr turns "done" into "idle"
// the moment anyone looks, so a glance makes a finished agent look handled; this keeps it until
// the person settles it (vscode-agents' Settle). This bar owns the tracking because it is on
// screen in both VS Code layouts from launch, so no finish is missed while another view or
// layout is showing. vscode-tabs and vscode-activitybar only read it; vscode-agents' Settle also
// moves an agent from finished to settled.
//   prev:     address -> last status seen (persisted: survives restarts and layout switches)
//   since:    address -> ms of the last status change
//   finished: address -> ms it finished
//   settled:  address -> ms it was settled
const INBOX = "vscode.inbox";
// One week in ms: how long the inbox keeps the stamps of a terminal that has gone.
const WEEK = 7 * 86400000;

// Returns a copy of the shared inbox whose four maps can be changed freely before setShared.
// vscode-agents carries the same helper as inbox().
function readInbox() {
  const s = shared(INBOX) ?? {};
  return { prev: { ...s.prev }, since: { ...s.since }, finished: { ...s.finished }, settled: { ...s.settled } };
}

// Records every status change in `list` since the last call and forgets long-gone terminals.
// This bar is the only writer of prev and since and the only one that stamps finished; it
// writes the record even with nothing changed when none exists yet, so readers find it.
function trackInbox(list) {
  const box = readInbox();
  const now = Date.now();
  let dirty = !shared(INBOX);
  for (const a of list) {
    const was = box.prev[a.address];
    if (was === a.status) continue;
    dirty = true;
    noteChange(box, a, was, now);
  }
  if (forgetGone(box, now)) dirty = true;
  if (dirty) setShared(INBOX, box);
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
  // finishing, or glanced at before we saw "done": only counts if it isn't the focused one.
  // A focused agent that lands here is settled by settleLooked() once actually looked at.
  const finished = s === "done" || (was === "working" && s === "idle" && !a.focused);
  if (finished && !box.finished[a.address] && !box.settled[a.address]) box.finished[a.address] = now;
}

// Forgets terminals that are gone, once their last stamp is a week old. True if any went.
function forgetGone(box, now) {
  const live = new Set(terminals().map((t) => t.address));
  let gone = false;
  for (const address of Object.keys(box.prev)) {
    if (live.has(address)) continue;
    const last = Math.max(box.since[address] ?? 0, box.finished[address] ?? 0, box.settled[address] ?? 0);
    if (now - last < WEEK) continue;
    for (const k of ["prev", "since", "finished", "settled"]) delete box[k][address];
    gone = true;
  }
  return gone;
}

// A finished agent that stays focused, with the Herdr window in front, for LOOK_MS has been
// looked at: settle it. Clicking straight past it (less than LOOK_MS) leaves it in Finished.
const LOOK_MS = 5000;
// The finished agent being looked at now and since when (ms), or null; lives only in this copy.
let looking = null; // { address, since }
// Starts, continues or ends the look at the focused finished agent; called once a second.
// Any change of focus, or the window going to the background, restarts the count.
function settleLooked() {
  const box = shared(INBOX);
  const a = agents().find((x) => x.focused);
  if (!a || !window()?.active || !box?.finished?.[a.address]) { looking = null; return; }
  const now = Date.now();
  if (looking?.address !== a.address) { looking = { address: a.address, since: now }; return; }
  if (now - looking.since < LOOK_MS) return;
  const next = { ...box, finished: { ...box.finished }, settled: { ...box.settled, [a.address]: now } };
  delete next.finished[a.address];
  setShared(INBOX, next);
  looking = null;
}

// Contexts describe checkouts on this computer, so a space on another machine never has one.
function contextHere() {
  const space = spaces().find((s) => s.active), f = focused();
  if (!space || space.machine) return { space, ctx: null };
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { space, ctx: contextFor(pane?.cwd || f?.cwd || space.folder) };
}

// The path of one of this mod's icons, as image() and svg() want it.
const ICON = (name) => `mods/vscode-statusbar/${name}.svg`;

// Friendly names for the layout switcher; anything else shows its file name.
const LAYOUT_NAMES = { vscode: "VS Code", "vscode-inbox": "VS Code · Inbox", main: "Herdr", terminals: "Terminals", win98: "Herdr 98" };
// The name to show for a layout.
const layoutName = (name) => LAYOUT_NAMES[name] ?? String(name ?? "");
// Height of one row of the layout popup, px; openLayoutMenu sizes the popup from it.
const MENU_ROW = 26;

// Every layout, Herdr's own included, as a popup: this same mod opened with { layoutMenu: true }.
function openLayoutMenu() {
  openOverlay({ mod: "vscode-statusbar", kind: "popup", width: 220, height: layouts().length * MENU_ROW + 10, props: { layoutMenu: true } });
}

// The status bar, docked in both VS Code layouts; with props { layoutMenu: true } it is the
// layout popup instead (see openLayoutMenu).
export default class StatusBar extends View {
  // Listens for this mod's key commands and starts the naming and settling timers.
  init(_props, cx) {
    // The layout popup copy only draws its list: no tracking, renaming or timers.
    if (props()?.layoutMenu) return;
    // keys.json binds cmd-shift-h to "vscode-statusbar.history" and cmd-shift-l to
    // "vscode-statusbar.layouts": this bar is always shown, so the keys work from any view.
    cx.spawn(async () => {
      for (;;) {
        const c = String(await nextCommand()).split(/[.:]/).pop();
        const { ctx } = contextHere();
        if (c === "history" && ctx?.history) openHistory(run, spaces, ctx.history);
        if (c === "layouts") openLayoutMenu();
      }
    });
    // Space naming lives in naming.js (a no-op in the published copy); it runs every 2000 ms.
    cx.timer.every(2000, () => nameSpaces());
    // Settles a finished agent once it has been looked at (see settleLooked): a cheap check.
    cx.timer.every(1000, () => settleLooked());
    nameSpaces();
  }

  // Copies `text` to the clipboard and says so in a toast titled `title`. It uses pbcopy, so it
  // works on macOS only; elsewhere the toast reports the failure.
  copy(text, title) {
    exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text])
      .then((r) => notify(r.code === 0 ? { title: title ?? "Copied", body: text, timeout: 2000 } : { title: "Copy failed", body: r.stderr, level: "error" }))
      .catch((e) => notify({ title: "Copy failed", body: String(e), level: "error" }));
  }

  // One status bar entry; it is clickable and highlights on hover only when given an action.
  item(id, children, tip, action) {
    const t = theme();
    return h_flex().id(id).h_full().px(7).gap(4).items_center().flex_none()
      .when(Boolean(action), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(action))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .children(children);
  }

  // Draws the bar and updates the inbox. The popup copy returns before trackInbox, so only the
  // docked bar writes the inbox.
  render() {
    if (props()?.layoutMenu) return this.layoutMenu();
    const t = theme();
    const { space, ctx } = contextHere();
    const badge = ctx?.badge;
    const list = agents();
    // Renders run on every agent change, which is exactly when the inbox needs updating.
    trackInbox(list);
    const working = list.filter((a) => a.status === "working").length;
    const needs = list.filter((a) => a.status === "blocked").length;
    // vscode-inbox only: finished agents not yet settled, oldest first (the next to look at).
    const inbox = shared("layout") === "vscode-inbox";
    const finishedAt = shared(INBOX)?.finished ?? {};
    const finished = inbox ? list.filter((a) => a.status !== "blocked" && finishedAt[a.address])
      .sort((x, y) => finishedAt[x.address] - finishedAt[y.address]) : [];
    const current = layoutName(shared("layout"));
    return h_flex().size_full().items_center().text_size(11.5).text_color(t.foreground)
      .child(h_flex().id("remote").h_full().px(9).gap(5).items_center().flex_none().bg(t.accent).text_color(t.accent_foreground)
        .cursor_pointer().hover((s) => s.opacity(0.9)).tooltip("Machines")
        .on_click(() => run("app.settings", { section: "machines" }))
        .child(svg(ICON("remote")).size(12))
        .child(space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(this.item("branch", [svg(ICON("git-branch")).size(12), div().child(space.branch)], "Git branch")))
      .when(Boolean(badge), (el) => el.child(this.item("context", [
        div().text_color(t.accent).child(badge.mark ?? ""),
        div().child(badge.text),
      ], badge.tooltip, badge.copy ? () => this.copy(badge.copy, badge.copied) : null)))
      .child(this.item("agents", [
        svg(ICON("bot")).size(13),
        div().child(`${list.length}`),
        div().text_color(t.working).child(working ? `· ${working} working` : ""),
      ], "Agents", () => run("agent.next")))
      .when(needs > 0, (el) => el.child(this.item("needs", [div().size(7).rounded(4).bg(t.blocked), div().child(`${needs} needs you`)], "Go to the next agent", () => run("agent.next"))))
      .when(finished.length > 0, (el) => el.child(this.item("finished", [div().size(7).rounded(4).bg(t.done), div().child(`${finished.length} finished`)],
        "Go to the agent that finished first", () => run("pane.focus", { pane: finished[0].pane }))))
      .child(div().flex_1())
      .child(this.item("palette", [div().child("⇧⌘P Commands")], "Command palette", () => run("app.palette")))
      .child(this.item("layout", [div().child(`Layout: ${current}`)], "Switch layout (cmd-shift-l)", () => openLayoutMenu()));
  }

  // Draws the layout popup: every layout, the shown one ticked. A pick closes the popup and
  // switches unless it is the shown one.
  layoutMenu() {
    const t = theme();
    const now = shared("layout");
    return v_flex().id("layout-menu").size_full().p(5).gap(1).bg(t.popover).text_size(12.5)
      .children(layouts().map((name) => h_flex().id(`layout-${name}`).h(MENU_ROW).px(8).gap(8).items_center().flex_none().rounded(5)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => { closeOverlay(props().overlay); if (name !== now) run("layout.switch", { name }); })
        .child(div().w(12).text_color(t.accent).child(name === now ? "✓" : ""))
        .child(div().flex_1().truncate().text_color(name === now ? t.foreground : t.muted).child(layoutName(name)))));
  }
}
