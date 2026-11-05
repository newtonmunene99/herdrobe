// VS Code-style activity bar: picks which view the sidebar stack shows.
// Clicking the active view (or its key twice) hides the sidebar, as VS Code does.
// It shows only the views the current layout has: in vscode-inbox the left sidebar holds
// Agents and Files, and Changes/History live in the right sidebar ("secondary"), which the
// Changes icon and the changes/history keys toggle instead.
import { View, div, svg } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, run, layout, agents, updates, nextCommand } from "herdr";
import { findNode as find } from "./layout.js";
import { inboxView } from "./inbox.js";

// The path of one of this mod's icons, as svg() wants it.
const ICON = (name) => `mods/vscode-activitybar/${name}.svg`;
// Every view the bar knows: `id` is the view's child id in a sidebar stack of the layout, `key`
// the mod command that toggles it, `icon` its button (null: no button).
const VIEWS = [
  { id: "spaces-view", key: "spaces", icon: "layers", label: "Spaces" },
  { id: "agents-view", key: "agents", icon: "bot", label: "Agents" },
  { id: "files", key: "files", icon: "files", label: "Files" },
  { id: "changes", key: "changes", icon: "git-branch", label: "Changes" },
  // No icon of its own: reached by key, or by the right sidebar's History tab.
  { id: "history", key: "history", icon: null, label: "History" },
];

// Which stack holds this view in the current layout: the left sidebar, the right one, or none.
function placeOf(id) {
  const root = layout();
  const has = (stack) => (find(root, stack)?.children ?? []).some((c) => c.id === id);
  if (has("sidebar-body")) return { stack: "sidebar-body", panel: "sidebar" };
  if (has("secondary-body")) return { stack: "secondary-body", panel: "secondary" };
  return null;
}

// True when the view's sidebar is open and its stack shows that view.
function isShown(id) {
  const place = placeOf(id);
  if (!place) return false;
  const root = layout();
  return !find(root, place.panel)?.hidden && find(root, place.stack)?.active === id;
}

// Hides the view's sidebar when it already shows the view, else selects the view and opens the
// sidebar. A view the current layout lacks does nothing.
function toggleView(id) {
  const place = placeOf(id);
  if (!place) return;
  if (isShown(id)) run("layout.hide", { id: place.panel });
  else {
    run("layout.select", { stack: place.stack, child: id });
    run("layout.show", { id: place.panel });
  }
}

// The activity bar: a button per view the layout has, then Machines and Settings at the bottom.
export default class ActivityBar extends View {
  // Listens for the view keys; each toggles its view as a click on its button would.
  init(_props, cx) {
    // keys.json "layout:vscode" / "layout:vscode-inbox" bind e.g. "vscode-activitybar.files".
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand());
        // Accept "files" as well as a qualified "vscode-activitybar.files".
        const name = c.split(/[.:]/).pop();
        const view = VIEWS.find((v) => v.key === name);
        if (view) toggleView(view.id);
        cx.notify();
      }
    });
  }

  // One 48 px button, with an accent marker when `on` and a count badge when `badge` is set
  // (0 hides it).
  item(id, icon, label, on, action, badge) {
    const t = theme();
    return div().id(`ab-${id}`).w_full().h(48).flex_none().flex().items_center().justify_center().relative()
      .text_color(on ? t.foreground : t.dim).hover((s) => s.text_color(t.foreground))
      .cursor_pointer().tooltip(label).on_click(action)
      // The bar sits on the window's left edge, so the active marker is on its outer (left) side.
      .when(on, (el) => el.child(div().absolute().top(0).bottom(0).left(0).w(2).bg(t.accent)))
      .child(svg(ICON(icon)).size(22))
      .when(Boolean(badge), (el) => el.child(
        div().absolute().top(8).left(26).min_w(16).h(16).px(4).rounded(8).bg(t.accent)
          .flex().items_center().justify_center().text_size(9).font_semibold().text_color(t.accent_foreground)
          .child(String(badge))));
  }

  // Agents badge: blocked agents, plus the finished ones not yet settled when the layout shows
  // the Inbox (inbox.js).
  badge() {
    const v = inboxView(agents());
    return v.needs.length + v.finished.length;
  }

  // Draws the bar; the Settings button shows a "1" when an app update is ready.
  render() {
    const views = VIEWS.filter((v) => v.icon && placeOf(v.id));
    const badge = this.badge();
    return v_flex().size_full()
      .children(views.map((v) => this.item(v.id, v.icon, v.label, isShown(v.id), () => toggleView(v.id), v.key === "agents" ? badge : 0)))
      .child(div().flex_1())
      .child(this.item("account", "circle-user", "Machines", false, () => run("app.settings", { section: "machines" })))
      .child(this.item("settings", "settings", "Settings", false, () => run("app.settings"), updates().app.ready ? "1" : 0));
  }
}
