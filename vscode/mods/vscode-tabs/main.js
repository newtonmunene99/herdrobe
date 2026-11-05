// VS Code-style editor tabs for the shown space's tabs: square tabs, a thin accent line on top
// of the active one, close on the active/hovered tab, drag to reorder, double-click to rename.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, agents, run, openOverlay, theme, shared } from "herdr";

// Path of this mod's own SVG icon called name.
const ICON = (name) => `mods/vscode-tabs/${name}.svg`;
// Mouse handler that keeps a press on a button from starting a tab drag or reaching the strip.
const stop = (_e, cx) => cx.stop_propagation();

// The tab strip: the shown space's tabs, then the New terminal and Split right buttons.
export default class Tabs extends View {
  // Starts with no tab pressed or hovered: pressed is the index in the strip of the tab a drag
  // started on, hovered the id of the tab under the pointer.
  init() {
    this.pressed = null;
    this.hovered = null;
  }

  // Program of the tab's agent pane if it has one, else its first pane.
  program(tab) {
    const list = panes().filter((p) => p.tab === tab.id);
    return (list.find((p) => p.program?.agent) ?? list[0])?.program ?? null;
  }

  // The tab's status. In vscode-inbox, "done" means finished and not yet settled (the
  // shared "vscode.inbox" record vscode-statusbar keeps), not Herdr's done, which clears on a
  // glance; same priority as Herdr's: blocked > done > working > idle.
  status(c) {
    if (shared("layout") !== "vscode-inbox") return c.status;
    const finished = shared("vscode.inbox")?.finished ?? {};
    const here = agents().filter((a) => a.tab === c.id);
    if (here.some((a) => a.status === "blocked")) return "blocked";
    if (here.some((a) => finished[a.address])) return "done";
    if (here.some((a) => a.status === "working")) return "working";
    return "idle";
  }

  // Draws tab c, at index i of shown (space's tabs), with its program's icon, name and one slot
  // for status or close. Releasing a press on another tab moves the pressed one there; a click
  // selects it, a double-click renames it and a right-click opens Herdr's tab menu.
  tab(c, i, shown, space) {
    const t = theme();
    const program = this.program(c);
    const status = this.status(c);
    const name = c.named ? c.name : program?.name ?? c.name;
    const showClose = c.active || this.hovered === c.id;
    return h_flex().id(`tab-${c.id}`).h_full().pl(12).pr(6).gap(6).items_center().flex_none().relative()
      .text_size(12.5).border_r(1).border_color(t.border)
      .bg(c.active ? t.background : t.chrome).text_color(c.active ? t.foreground : t.muted)
      .when(!c.active, (el) => el.border_b(1))
      .hover((s) => s.text_color(t.foreground))
      .on_hover((h, cx) => { this.hovered = h ? c.id : this.hovered === c.id ? null : this.hovered; cx.notify(); })
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
      .on_mouse_up("left", () => {
        const from = this.pressed;
        this.pressed = null;
        if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex((x) => x.id === c.id) + 1 });
        else run("tab.select", { id: c.id });
      })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
      .when(c.active, (el) => el.child(div().absolute().top(0).left(0).right(0).h(1).bg(t.accent)))
      .when(Boolean(program?.icon), (el) => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
      .child(div().max_w(180).truncate().child(c.zoomed ? `${name} (zoomed)` : name))
      // One 18px slot on the right: status while idle, ✕ when hovered or active (like VS Code's dirty dot).
      .child(div().id(`slot-${c.id}`).size(18).flex_none().flex().items_center().justify_center().rounded(4)
        .when(showClose, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); })
          .child(svg(ICON("close")).size(12)))
        .when(!showClose && status === "working", (el) => el.child(svg(ICON("spinner")).size(12).text_color(t.working).spin(900)))
        .when(!showClose && (status === "blocked" || status === "done"), (el) => el.child(div().size(7).rounded(4).bg(t[status]))));
  }

  // Draws a 24px button showing this mod's icon, with tooltip tip, that runs action on click.
  action(id, icon, tip, action) {
    const t = theme();
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_mouse_down("left", stop).on_click(action).child(svg(ICON(icon)).size(14));
  }

  // Draws the strip for the active space. A release anywhere on it ends a drag, and the scroll
  // wheel moves to the previous or next tab. Runs again on every live-data change.
  render() {
    const t = theme();
    const space = spaces().find((p) => p.active);
    const shown = space?.tabs ?? [];
    return h_flex().size_full().min_w(0).items_center().bg(t.chrome).rounded_t(8)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel((e) => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").h_full().min_w(0).overflow_x_scrollbar().children(shown.map((c, i) => this.tab(c, i, shown, space))))
      // The empty strip right of the tabs carries the bar's bottom border, as in VS Code.
      .child(h_flex().flex_1().h_full().pr(8).gap(2).items_center().border_b(1).border_color(t.border)
        .child(this.action("tab-new", "plus", "New terminal", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
        .child(div().flex_1())
        .child(this.action("split-right", "split-right", "Split right", () => run("pane.split", { direction: "right" }))));
  }
}
