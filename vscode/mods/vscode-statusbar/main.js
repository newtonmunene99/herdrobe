// VS Code-style status bar: a blue "remote" corner with the space's machine (click: the machine
// switcher, machines.js), then branch and agents; the layout name on the right opens a picker of
// every layout. It is the mod that tracks the Inbox (inbox.js): it is on screen in both VS Code
// layouts from launch. When context.js gives the focused folder a workspace context, it also
// shows that context's badge. It runs naming.js's nameSpaces() on a timer; the published
// naming.js does nothing.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, agents, theme, run, shared, nextCommand, props, layouts, openOverlay, closeOverlay } from "herdr";
import { contextFor, openHistory } from "./context.js";
import { nameSpaces } from "./naming.js";
import { focusPlace } from "./focus.js";
import { copy } from "./clipboard.js";
import { inboxView, trackInbox, lookTick } from "./inbox.js";
import { openMachineMenu, machineMenu } from "./machines.js";

// The active space and the focused folder's workspace context. Contexts describe checkouts on
// this computer, so a folder on another machine (see focusPlace) never has one.
function contextHere() {
  const place = focusPlace(), space = spaces().find((s) => s.active);
  return { space, ctx: place.on ? null : contextFor(place.cwd) };
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
// layout popup instead (see openLayoutMenu), and with { machineMenu: true } the machine switcher.
export default class StatusBar extends View {
  // Listens for this mod's key commands and starts the naming and settling timers.
  init(_props, cx) {
    // The popup copies only draw their lists: no tracking, renaming or timers.
    if (props()?.layoutMenu || props()?.machineMenu) return;
    // keys.json binds cmd-shift-h to "vscode-statusbar.history" and cmd-shift-l to
    // "vscode-statusbar.layouts"; "vscode-statusbar.machines" (unbound) opens the machine
    // switcher. This bar is always shown, so the keys work from any view.
    cx.spawn(async () => {
      for (;;) {
        const c = String(await nextCommand()).split(/[.:]/).pop();
        const { ctx } = contextHere();
        if (c === "history" && ctx?.history) openHistory(run, spaces, ctx.history);
        if (c === "layouts") openLayoutMenu();
        if (c === "machines") openMachineMenu();
      }
    });
    // Space naming lives in naming.js (a no-op in the published copy); it runs every 2000 ms.
    cx.timer.every(2000, () => nameSpaces());
    // Settles a finished agent once it has been looked at for a while (inbox.js): a cheap check.
    cx.timer.every(1000, () => lookTick());
    nameSpaces();
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
    if (props()?.machineMenu) return machineMenu();
    const t = theme();
    const { space, ctx } = contextHere();
    const badge = ctx?.badge;
    const list = agents();
    // Renders run on every agent change, which is exactly when the inbox needs updating.
    trackInbox();
    const working = list.filter((a) => a.status === "working").length;
    // Finished is empty unless the layout shows the Inbox; its first is the agents list's top card.
    const { needs: blocked, finished } = inboxView(list);
    const needs = blocked.length;
    const current = layoutName(shared("layout"));
    return h_flex().size_full().items_center().text_size(11.5).text_color(t.foreground)
      .child(h_flex().id("remote").h_full().px(9).gap(5).items_center().flex_none().bg(t.accent).text_color(t.accent_foreground)
        .cursor_pointer().hover((s) => s.opacity(0.9)).tooltip("Switch machine")
        .on_click((_e, cx) => { cx.spawn(() => openMachineMenu()); })
        .child(svg(ICON("remote")).size(12))
        .child(space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(this.item("branch", [svg(ICON("git-branch")).size(12), div().child(space.branch)], "Git branch")))
      .when(Boolean(badge), (el) => el.child(this.item("context", [
        div().text_color(t.accent).child(badge.mark ?? ""),
        div().child(badge.text),
      ], badge.tooltip, badge.copy ? () => copy(badge.copy, badge.copied) : null)))
      .child(this.item("agents", [
        svg(ICON("bot")).size(13),
        div().child(`${list.length}`),
        div().text_color(t.working).child(working ? `· ${working} working` : ""),
      ], "Agents", () => run("agent.next")))
      .when(needs > 0, (el) => el.child(this.item("needs", [div().size(7).rounded(4).bg(t.blocked), div().child(`${needs} needs you`)], "Go to the next agent", () => run("agent.next"))))
      .when(finished.length > 0, (el) => el.child(this.item("finished", [div().size(7).rounded(4).bg(t.done), div().child(`${finished.length} finished`)],
        "Go to the first finished agent", () => run("pane.focus", { pane: finished[0].pane }))))
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
