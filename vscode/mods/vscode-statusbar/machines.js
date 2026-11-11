// The machine switcher: the status bar's remote corner opens it as a popup. It lists each machine
// with its spaces; picking a space switches to it (and so to its machine), and each connected
// machine offers a new space there. Settings → Machines stays one click away for adding machines.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, machines, hc, run, theme, props, openOverlay, closeOverlay } from "herdr";

const WIDTH = 280;
// Row heights, px; openMachineMenu sizes the popup from them.
const ROW = 26, HEAD = 24, RULE = 7, PAD = 10;
// Past this the list scrolls.
const MAX_HEIGHT = 420;

// Saved machines as [{ name, state }] from `hc machine ls`, or [] when it can't answer.
async function savedMachines() {
  try {
    const r = await hc(["machine", "ls", "--json"]);
    if (r.code !== 0) return [];
    return (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary).map((m) => ({ name: m.name, state: m.state }));
  } catch { return []; }
}

// This computer (name null) first, then every other machine by name: saved ones, plus any a
// space or layout document names. A machine hc didn't list counts as connected while its
// layout is readable.
function machineList(saved) {
  const docs = machines();
  const names = new Set([...saved.map((m) => m.name), ...spaces().map((s) => s.machine), ...docs.map((m) => m.name)].filter(Boolean));
  const state = (name) => saved.find((m) => m.name === name)?.state
    ?? (docs.find((m) => m.name === name)?.layout === "ready" ? "connected" : "unreachable");
  return [{ name: null, state: "connected" }, ...[...names].sort().map((name) => ({ name, state: state(name) }))];
}

// Opens the switcher at the pointer, sized to fit (up to MAX_HEIGHT): this mod again, with
// props { machineMenu: true, saved }.
export async function openMachineMenu() {
  const saved = await savedMachines();
  const all = spaces();
  const rows = machineList(saved).reduce((h, m) =>
    h + HEAD + all.filter((s) => (s.machine ?? null) === m.name).length * ROW + (m.state === "connected" ? ROW : 0), 0);
  const height = Math.min(MAX_HEIGHT, rows + RULE + ROW + PAD);
  openOverlay({ mod: "vscode-statusbar", kind: "popup", width: WIDTH, height, props: { machineMenu: true, saved } });
}

// Draws the switcher. Spaces are read live, so it follows changes while open.
export function machineMenu() {
  const t = theme();
  const { overlay, saved } = props();
  const close = () => closeOverlay(overlay);
  const all = spaces();
  const row = (id, children, onClick) => h_flex().id(id).h(ROW).px(8).gap(8).items_center().flex_none().rounded(5)
    .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => { close(); onClick(); })
    .children(children);
  const group = ({ name, state }) => {
    const key = name ?? "local";
    const connected = state === "connected";
    const head = h_flex().h(HEAD).px(8).gap(7).items_center().flex_none().text_size(11).text_color(t.dim)
      .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
      .child(div().flex_1().truncate().child(name ?? "This computer"))
      .when(!connected, (el) => el.child(div().flex_none().child(String(state ?? "asleep").replace(/_/g, " "))));
    const mine = all.filter((s) => (s.machine ?? null) === name).map((s) => row(`space-${s.id}`, [
      div().w(12).text_color(t.accent).child(s.active ? "✓" : ""),
      div().flex_1().truncate().text_color(s.active ? t.foreground : t.muted).child(s.name),
    ], () => { if (!s.active) run("space.select", { id: s.id }); }));
    const add = connected ? [row(`new-${key}`, [
      div().w(12).text_color(t.dim).child("+"),
      div().flex_1().truncate().text_color(t.muted).child(`New space on ${name ?? "this computer"}`),
    ], () => run("space.new", { machine: name ?? "" }))] : [];
    return [head, ...mine, ...add];
  };
  return v_flex().id("machine-menu").size_full().p(5).bg(t.popover).text_size(12.5)
    .child(v_flex().id("machine-list").flex_1().min_h(0).gap(1).overflow_y_scroll()
      .children(machineList(saved ?? []).flatMap(group)))
    .child(div().h(1).mx(8).my(3).flex_none().bg(t.border))
    .child(row("manage", [
      div().w(12),
      div().flex_1().text_color(t.muted).child("Manage machines…"),
    ], () => run("app.settings", { section: "machines" })));
}
