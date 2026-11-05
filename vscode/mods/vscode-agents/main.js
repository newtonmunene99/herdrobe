// VS Code-style agents sidebar for the vscode-inbox layout: every space's agents in folding
// sections, so nothing that needs you gets lost.
//   Needs you  blocked agents, as cards showing the line they're waiting on
//   Finished   finished and not yet settled, as cards with Settle (the header has Settle all)
//   Working    one row per working agent
//   Settled    everything else (folded)
// The sections and their order come from the Inbox (inbox.js), which vscode-statusbar tracks (it
// is on screen from launch, so finishes aren't missed while this view or layout isn't showing).
// This mod draws them and settles.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, spaces, panes, run, theme, shared, setShared, setAgentOrder, hc, nextCommand, openOverlay, pickFolder } from "herdr";
import { inboxView, settle } from "./inbox.js";

// The ring spinner shipped with vscode-tabs, so both mods spin the same icon.
const SPINNER = "mods/vscode-tabs/spinner.svg";
// Path of workspace-chrome's chevron icon pointing dir ("down" or "right").
const CHEVRON = (dir) => `mods/workspace-chrome/chevron-${dir}.svg`;

// Space colours: copied whole from Herdr's picker mod (mods/picker/main.js) so both always
// agree. Kept by space id in shared "space.colors": a theme colour name or a picked #rrggbb.
// A space seen without one gets the colour fewest spaces use, once, in space order.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
// The theme colour names handed to new spaces; on a tie, and as the fallback, the first wins.
const PROJECT_COLORS = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
// Returns every space's colour by space id, dropping spaces that are gone and giving each new one
// a colour; the home space ("~") gets none. It writes shared "space.colors" only when something
// changed, so calling it from render settles after one redraw instead of looping.
function spaceColors() {
  const ids = new Set(spaces().map((p) => p.id));
  const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
  let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
  for (const p of spaces()) {
    if (kept[p.id] || p.name === "~") continue;
    const uses = (c) => Object.values(kept).filter((v) => v === c).length;
    kept[p.id] = PROJECT_COLORS.reduce((best, c) => (uses(c) < uses(best) ? c : best));
    changed = true;
  }
  if (changed) setShared("space.colors", kept);
  return kept;
}
// Returns the colour of space p's mark: dim for the home space, a picked #rrggbb as is, else the
// MARK swatch or theme colour it names. p needs only id and name.
function spaceColor(t, p) {
  if (p.name === "~") return t.dim;
  const c = spaceColors()[p.id] ?? PROJECT_COLORS[0];
  return c.startsWith("#") ? c : (MARK[c] ?? t[c]);
}

// Strips the leading glyphs (spinners, status marks) agents put in front of their titles.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}~]+/u, "").trim();

// Formats a time in ms since the epoch as a short age ("now", "4m", "2h", "3d"); "" for none.
function ago(ms) {
  if (!ms) return "";
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// Draws program p's icon at size px, a one-colour glyph tinted with color; null if it has none.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// Reads the JSON value this copy saved under key, or fallback when it is missing or unreadable.
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}
// Saves value as JSON under key in this copy's localStorage, ignoring failures.
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* per-window nicety only */ }
}

// The agents sidebar: a space filter header over the four folding sections.
export default class VscodeAgents extends View {
  // Restores the folded sections and the space filter saved by this copy, starts the timers that
  // refresh ages and blocked agents' questions, and listens for key commands.
  init(_props, cx) {
    this.waiting = {}; // address -> the line a blocked agent is waiting on
    this.open = { needs: true, finished: true, working: true, settled: false, ...load("open", {}) };
    this.filter = load("filter", null); // a space id, or null for every space
    this.picking = false;
    cx.timer.every(30000, (cx) => cx.notify()); // keeps the "4m" ages fresh
    cx.timer.every(5000, (cx) => this.readWaiting(cx));
    this.readWaiting(cx);
    // keys.json can bind "vscode-agents.settle": settles the focused agent if it's Finished.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand()).split(/[.:]/).pop();
        const a = agents().find((x) => x.focused);
        if (c === "settle" && a && inboxView([a]).finished.length) settle([a.address]);
        cx.notify();
      }
    });
  }

  // The question a blocked agent is asking: the last line on its screen with real words,
  // preferring one with "?", without box drawing or prompt glyphs.
  readWaiting(cx) {
    const blocked = agents().filter((a) => a.status === "blocked");
    if (!blocked.length) return;
    cx.spawn(async (cx) => {
      for (const a of blocked) {
        const r = await hc(["read", a.address, "--lines", "40"]).catch(() => null);
        if (r?.code !== 0) continue;
        const lines = r.stdout.split("\n").map((l) => l.replace(/[│┃╭╮╰╯─━┌┐└┘|>❯]+/g, " ").replace(/\s+/g, " ").trim())
          .filter((l) => /\p{L}{3}/u.test(l) && !/^(esc|enter|tab|shift)\b/i.test(l));
        const q = lines.reverse().find((l) => l.includes("?")) ?? lines[0] ?? "";
        this.waiting[a.address] = q.length > 110 ? `${q.slice(0, 108)}…` : q;
      }
      cx.notify();
    });
  }

  // The name to show for agent a: its tab's name if someone named the tab, else its cleaned title
  // when that says more than the program's name, else the program or tab name. tabs maps tab
  // id to tab.
  label(a, tabs) {
    const tab = tabs.get(a.tab);
    const title = clean(a.title);
    if (tab?.named) return tab.name;
    return title && title !== a.program?.name ? title : a.program?.name ?? a.tab_name;
  }

  // "web", or "web · vps" for an agent on another machine (address "vps/t7").
  where(a) {
    const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
    return machine ? `${a.space_name} · ${machine}` : a.space_name;
  }

  // Folds or unfolds section id and remembers it for this copy.
  toggle(id, cx) {
    this.open[id] = !this.open[id];
    save("open", this.open);
    cx.notify();
  }

  // Draws the header row of section id, listing the agents in items: chevron, name, count, and
  // Settle all on Finished. Clicking it folds or unfolds the section.
  section(id, name, items, t) {
    const open = this.open[id];
    return h_flex().id(`sec-${id}`).h(22).px(10).gap(4).items_center().flex_none().cursor_pointer()
      .border_t(1).border_color(t.border).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggle(id, cx))
      .child(svg(CHEVRON(open ? "down" : "right")).size(11).text_color(t.dim))
      .child(div().flex_1().text_size(10.5).font_semibold().text_color(t.foreground).child(name.toUpperCase()))
      .when(id === "finished" && items.length > 0, (el) => el.child(
        div().id("settle-all").px(6).h(16).flex().items_center().rounded(3).text_size(10.5).text_color(t.muted)
          .hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip("Settle every finished agent shown")
          .on_click((_e, cx) => { cx.stop_propagation(); settle(items.map((a) => a.address)); cx.notify(); })
          .child("Settle all")))
      .child(div().px(5).rounded(8).bg(t.raised).text_size(10.5).text_color(t.foreground).child(String(items.length)));
  }

  // Draws agent a as a card in section kind ("needs" or "finished"): where it is, how long it has
  // been blocked or finished (v.when, from the Inbox view), its name, then the question it waits
  // on or a Settle button. Clicking the card focuses its pane.
  card(a, kind, v, tabs, t) {
    const edge = kind === "needs" ? t.blocked : t.done;
    const when = v.when(a);
    const sub = kind === "needs"
      // Up to two lines of the question: wraps, then clips at two lines' height.
      ? h_flex().gap(5).items_start().min_w(0)
          .child(div().size(7).mt(4).rounded(4).bg(t.blocked).flex_none())
          .child(div().flex_1().min_w(0).max_h(35).overflow_hidden().whitespace_normal().text_color(t.muted)
            .child(this.waiting[a.address] ? `“${this.waiting[a.address]}”` : "Waiting for you"))
      : h_flex().gap(6).items_center()
          .child(div().flex_1().truncate().text_color(t.dim).child("Finished"))
          .child(div().id(`settle-${a.address}`).px(7).h(18).flex().items_center().rounded(3).border(1).border_color(t.input)
            .text_size(11).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); settle([a.address]); cx.notify(); })
            .child("✓ Settle"));
    return v_flex().id(`card-${a.address}`).mx(6).my(3).px(9).py(7).gap(2).rounded(5).relative()
      .bg(a.focused ? t.selected : t.background).border(1).border_color(t.border)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .child(div().absolute().left(0).top(6).bottom(6).w(2).rounded(1).bg(edge))
      .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.muted)
        .child(div().size(9).rounded(2).bg(spaceColor(t, { id: a.space, name: a.space_name })).flex_none())
        .child(div().flex_1().truncate().child(this.where(a)))
        .when(a.pinned, (el) => el.child(div().text_size(10).text_color(t.dim).child("pinned")))
        .child(div().text_size(11).text_color(t.dim).child(ago(when))))
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(icon(a.program, 14, t.foreground) ?? div())
        .child(div().flex_1().truncate().text_size(13).text_color(t.foreground).font_semibold().child(this.label(a, tabs))))
      .child(div().text_size(11.5).child(sub));
  }

  // Draws agent a as one line in section kind ("working" or "settled"): a spinner or a hollow dot,
  // where it is, its name and the time since its status last changed.
  row(a, kind, v, tabs, t) {
    return h_flex().id(`row-${a.address}`).h(24).px(12).gap(7).items_center().cursor_pointer()
      .bg(a.focused ? t.selected : t.background).hover((s) => s.bg(t.hover))
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .child(kind === "working"
        ? svg(SPINNER).size(11).text_color(t.working).spin(900)
        : div().size(7).rounded(4).border(1).border_color(t.dim))
      .child(div().size(8).rounded(2).bg(spaceColor(t, { id: a.space, name: a.space_name })).flex_none())
      .child(div().flex_1().truncate().text_size(12.5).text_color(t.muted).child(`${this.where(a)} · ${this.label(a, tabs)}`))
      .child(div().text_size(11).text_color(t.dim).child(ago(v.when(a))));
  }

  // Draws the AGENTS title with the space filter button and, while picking, the dropdown of
  // spaces and space actions under it.
  header(t) {
    const all = spaces();
    const current = all.find((s) => s.id === this.filter);
    const head = h_flex().h(30).px(10).gap(6).items_center().flex_none()
      .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child("AGENTS"))
      .child(h_flex().id("filter").h(20).px(7).gap(5).items_center().rounded(4).cursor_pointer()
        .border(1).border_color(current ? t.accent : t.input).text_size(11.5).text_color(t.foreground)
        .hover((s) => s.bg(t.hover)).tooltip("Spaces: show one, switch, or make a new one")
        .on_click((_e, cx) => { this.picking = !this.picking; cx.notify(); })
        .when(Boolean(current), (el) => el.child(div().size(8).rounded(2).bg(spaceColor(t, current))))
        .child(current ? current.name : "All spaces")
        .child(svg(CHEVRON("down")).size(10).text_color(t.dim)));
    if (!this.picking) return head;
    // The one place for spaces: pick one to show its agents and go there, right-click for
    // Herdr's space menu, or make a new one.
    const counts = (id) => {
      const v = inboxView(agents().filter((a) => a.space === id));
      return { blocked: v.needs.length, finished: v.finished.length };
    };
    const dot = (n, color) => h_flex().gap(3).items_center().text_size(11).text_color(t.muted).child(div().size(6).rounded(3).bg(color)).child(String(n));
    const pick = (space) => {
      const c = space ? counts(space.id) : null;
      return h_flex().id(`pick-${space?.id ?? "all"}`).h(24).px(12).gap(7).items_center().cursor_pointer()
        .bg(this.filter === (space?.id ?? null) ? t.selected : t.popover).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          this.filter = space?.id ?? null; save("filter", this.filter); this.picking = false;
          if (space && !space.active) run("space.select", { id: space.id });
          cx.notify();
        })
        // Herdr's own space menu: Rename, Close, New / Open / Remove worktree.
        .when(Boolean(space), (el) => el.on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: space.id } } });
        }))
        .child(space ? div().size(8).rounded(2).bg(spaceColor(t, space)) : div().size(8).rounded(2).border(1).border_color(t.dim))
        .child(div().flex_1().truncate().text_size(12.5).text_color(t.foreground).child(space ? `${space.name}${space.machine ? ` [${space.machine}]` : ""}` : "All spaces"))
        .when(Boolean(c?.blocked), (el) => el.child(dot(c.blocked, t.blocked)))
        .when(Boolean(c?.finished), (el) => el.child(dot(c.finished, t.done)));
    };
    const action = (id, glyph, text, onClick) => h_flex().id(id).h(24).px(12).gap(7).items_center().cursor_pointer()
      .bg(t.popover).hover((s) => s.bg(t.hover)).on_click(onClick)
      .child(div().w(8).text_size(11).text_color(t.dim).child(glyph))
      .child(div().flex_1().text_size(12.5).text_color(t.foreground).child(text));
    const active = all.find((s) => s.active);
    const close = (cx) => { this.picking = false; cx.notify(); };
    return v_flex().flex_none().child(head)
      .child(v_flex().mx(6).mb(4).py(3).rounded(5).bg(t.popover).border(1).border_color(t.border)
        .child(pick(null)).children(all.map(pick))
        .child(div().h(1).mx(8).my(3).bg(t.border))
        .child(action("new-space", "+", "New space", (_e, cx) => { close(cx); run("space.new", {}); }))
        .child(action("open-folder", "▸", "Open folder as space…", (_e, cx) => {
          close(cx);
          cx.spawn(async () => {
            const picked = await pickFolder({ prompt: "Open as a space" });
            if (picked) run("space.new", { folder: picked });
          });
        }))
        .when(Boolean(active), (el) => el.child(action("new-worktree", "⑂", "New worktree…", (_e, cx) => {
          close(cx);
          const folder = panes().find((p) => p.focused)?.cwd ?? active.folder;
          openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: active.id, folder, action: "new" } });
        }))));
  }

  // Sorts the agents into the four sections and draws them, and makes agent.next / agent.prev
  // follow the same order, folded sections included. Runs again on every live-data change.
  render() {
    const t = theme();
    // A filter for a space that's gone shows everything again. A one-space filter follows the
    // space you're in (switched by key or by an agent elsewhere), so the list and the panes
    // always match; "All spaces" stays put.
    if (this.filter && !spaces().some((s) => s.id === this.filter)) this.filter = null;
    const here = spaces().find((s) => s.active);
    if (this.filter && here && here.id !== this.filter) { this.filter = here.id; save("filter", this.filter); }
    const tabs = new Map(spaces().flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
    const all = agents();
    const list = this.filter ? all.filter((a) => a.space === this.filter) : all;
    // The four sections, each already in its order: Needs you and Finished are queues (pinned,
    // then waiting longest first), Working and Settled newest change first.
    const v = inboxView(list);
    const { needs, finished, working, settled } = v;
    setAgentOrder([...needs, ...finished, ...working, ...settled].map((a) => a.address));

    const body = v_flex().id("agents-list").flex_1().min_h(0).overflow_y_scrollbar()
      .child(this.section("needs", "Needs you", needs, t))
      .when(this.open.needs, (el) => el.children(needs.map((a) => this.card(a, "needs", v, tabs, t))))
      .child(this.section("finished", "Finished", finished, t))
      .when(this.open.finished, (el) => el.children(finished.map((a) => this.card(a, "finished", v, tabs, t))))
      .child(this.section("working", "Working", working, t))
      .when(this.open.working, (el) => el.children(working.map((a) => this.row(a, "working", v, tabs, t))))
      .child(this.section("settled", "Settled", settled, t))
      .when(this.open.settled, (el) => el.children(settled.map((a) => this.row(a, "settled", v, tabs, t))));

    return v_flex().size_full().bg(t.background).child(this.header(t)).child(body);
  }
}
