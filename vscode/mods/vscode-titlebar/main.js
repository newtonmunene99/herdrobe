// VS Code-style title bar: a centred "command center" box that opens the command palette,
// and sidebar toggles on the right. The whole bar drags the window (window_drag in the layout).
// A right-sidebar toggle appears when the layout has one ("secondary", in vscode-inbox).
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, spaces, layout, window } from "herdr";

const ICON = (name) => `mods/vscode-titlebar/${name}.svg`;
const stop = (_e, cx) => cx.stop_propagation();

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class TitleBar extends View {
  button(id, child, tip, action, on) {
    const t = theme();
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_mouse_down("left", stop).on_click(action).child(child);
  }

  render() {
    const t = theme();
    const w = window();
    const root = layout();
    const space = spaces().find((s) => s.active);
    const sidebarOpen = !find(root, "sidebar")?.hidden;
    const secondary = find(root, "secondary");
    const label = space ? `${space.name}${space.machine ? ` [${space.machine}]` : ""}` : "Herdr";
    return h_flex().size_full().px(8).items_center().text_size(12)
      // Left: room for the macOS traffic lights; elsewhere nothing.
      .child(div().flex_1().min_w(w?.platform === "macos" && !w?.fullscreen ? 76 : 0))
      .child(h_flex().id("command-center").w_2_5().max_w(600).min_w(160).h(24).px(8).gap(6).items_center().justify_center()
        .rounded(6).bg(t.raised).border(1).border_color(t.input).text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop).on_click(() => run("app.palette")).tooltip("Search commands")
        .child(svg(ICON("search")).size(13).flex_none())
        .child(div().truncate().child(label)))
      .child(h_flex().flex_1().justify_end().gap(4).items_center()
        .child(this.button("toggle-sidebar", svg(ICON("panel-left")).size(15), "Toggle sidebar", () => run("layout.toggle", { id: "sidebar" }), sidebarOpen))
        .when(Boolean(secondary), (el) => el.child(this.button("toggle-secondary", svg(ICON("panel-right")).size(15), "Toggle Changes and History",
          () => run("layout.toggle", { id: "secondary" }), !secondary?.hidden)))
        .when(Boolean(w?.buttons), (el) => el
          .child(this.button("minimize", "−", "Minimize", () => run("window.minimize")))
          .child(this.button("maximize", "□", "Maximize", () => run("window.maximize")))
          .child(this.button("close-window", "✕", "Close", () => run("window.close")))));
  }
}
