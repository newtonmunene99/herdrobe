// A file's diff side by side (old left, new right), as a tab or pane in the editor area. Opened by
// vscode-changes and vscode-history through diff-open.js:
//   props { preview: true, key }  a preview: shows whatever its entry in shared PREVIEW asks for,
//                                 replaced by the next click (see openDiff)
//   props { request }             a kept tab (Keep open): one fixed diff, saved with the tab
// The header says what is compared and offers Whole file (all unchanged lines too) and, on a
// preview, Keep open. Unstaged and staged diffs re-read when Changes writes (CHANGED) and every
// 10 s; a commit's never changes.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar } from "gpui-base";
import { exec, readTextFile, shared, setShared, run, theme, settings, focused, panes, props } from "herdr";
import { PREVIEW, diffName } from "./diff-open.js";
import { pairRows, addedRows, rowCounts } from "./diff-pairs.js";
import { READ } from "./git-read.js";

// Shared key vscode-changes sets after it stages, unstages, commits or discards.
const CHANGED = "vscode-changes.changed";
// The path of one of this mod's icons, as svg() wants it.
const ICON = (name) => `mods/vscode-diff/${name}.svg`;
// Height of a diff row in px (the virtual list needs every row the same), the most rows shown,
// and the longest line drawn, in characters.
const ROW = 20, MAX_ROWS = 1500, MAX_LINE = 4000;
// What each kind of request compares, for the header.
const COMPARES = { staged: "HEAD ↔ index", unstaged: "index ↔ working tree", untracked: "new file" };
// Reads and writes this copy's own small settings (Whole file); storage can be missing.
const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* a nicety only */ } };

// The side-by-side rows for `req` (see diff-open.js), with every unchanged line when `whole`.
// Throws with a short reason for binary or unreadable files and when git fails; [] means no
// changes left.
async function readDiff(req, whole) {
  if (req.kind === "untracked") {
    const text = await readTextFile(`${req.repo}/${req.path}`, { on: req.on }).catch(() => null);
    if (text === null) throw new Error("Cannot read this file (binary, too large, or gone)");
    if (text.includes("\0")) throw new Error("Binary file · no text diff");
    return addedRows(text.slice(0, 400000));
  }
  const context = whole ? ["-U99999"] : [];
  const args = req.kind === "commit"
    ? ["diff-tree", "-p", "--root", "-m", "--first-parent", "--no-color", "--no-ext-diff", ...context, req.hash, "--", req.path]
    : ["diff", ...(req.kind === "staged" ? ["--cached"] : []), "--no-color", "--no-ext-diff", "--no-textconv", ...context, "--", req.path];
  const r = await exec("git", [...READ, ...args], { cwd: req.repo, on: req.on });
  if (r.code !== 0) throw new Error((r.stderr || "git diff failed").trim());
  const lines = r.stdout.replace(/\n$/, "").split("\n"), first = lines.findIndex((l) => l.startsWith("@@"));
  if (first >= 0) return pairRows(lines.slice(first));
  if (/^Binary files /m.test(r.stdout)) throw new Error("Binary file changed");
  return [];
}

// The diff viewer: a header over the side-by-side rows.
export default class Diff extends View {
  // Reads its role from props, restores Whole file, records its pane for openDiff, and re-reads
  // working-tree diffs every 10 s for changes made outside Herdr.
  init(initial, cx) {
    const p = initial ?? props() ?? {};
    this.key = p.preview ? p.key : null; this.fixed = p.request ?? null;
    this.whole = load("whole", false);
    this.rows = []; this.counts = { add: 0, del: 0 }; this.note = null; this.limited = false; this.shown = null;
    this.claim(p.pane);
    cx.timer.every(10000, (cx) => { if (this.request() && this.request().kind !== "commit") this.reload(cx); });
  }

  // The request shown: the kept one, or the preview entry's.
  request() { return this.fixed ?? shared(PREVIEW)?.[this.key]?.request ?? null; }

  // Records this preview's pane and tab in its entry, so openDiff reuses it instead of opening
  // another. The pane is `pane` from props when Herdr gives one, else the focused vscode-diff pane
  // (tab.new and pane.split focus the new pane). Runs again on render until it succeeds.
  claim(pane) {
    if (!this.key) return;
    const all = shared(PREVIEW) ?? {}, entry = all[this.key];
    if (!entry || entry.pane === (this.pane ?? pane)) return;
    const taken = new Set(Object.values(all).map((e) => e.pane).filter(Boolean));
    const id = pane ?? focused()?.pane;
    const mine = panes().find((p) => p.pane === id && p.mod === "vscode-diff" && (!taken.has(p.pane) || entry.pane === p.pane));
    if (!mine) return;
    this.pane = mine.pane;
    setShared(PREVIEW, { ...all, [this.key]: { ...entry, pane: mine.pane, tab: mine.tab } });
  }

  // Reads the diff for the current request; a newer reload wins.
  reload(cx) {
    const req = this.request(), token = {};
    this.token = token;
    if (!req) { this.rows = []; this.note = null; return; }
    cx.spawn(async (cx) => {
      let rows = [], note = null;
      try { rows = await readDiff(req, this.whole); } catch (e) { note = String(e.message ?? e); }
      if (this.token !== token) return;
      if (!rows.length && !note) note = `No changes left in ${diffName(req)}`;
      this.rows = rows.slice(0, MAX_ROWS); this.limited = rows.length > MAX_ROWS; this.counts = rowCounts(rows); this.note = note;
      cx.notify();
    });
  }

  // Turns the preview into a tab of its own: opens a kept tab with the request in its props
  // (saved with the tab), then closes the preview tab or pane and forgets its entry, so the next
  // click starts a fresh preview.
  keepOpen() {
    const req = this.request(), all = { ...shared(PREVIEW) }, entry = all[this.key];
    if (!req) return;
    run("tab.new", { mod: "vscode-diff", props: { request: req }, name: diffName(req) });
    delete all[this.key];
    setShared(PREVIEW, all);
    if (this.key.startsWith("pane:")) { if (entry?.pane) run("pane.close", { pane: entry.pane }); }
    else if (entry?.tab) run("tab.close", { id: entry.tab });
  }

  // A text button in the header; `on` marks a toggle that is switched on.
  button(id, label, tip, on, action, t) {
    return div().id(id).h(22).px(8).flex().flex_none().items_center().rounded(5).text_size(11.5).cursor_pointer()
      .bg(on ? t.selected : t.background).border_1().border_color(on ? t.accent : t.input).text_color(on ? t.foreground : t.muted)
      .hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click((_e, cx) => action(cx)).child(label);
  }

  // The 36px header: the file (folder dimmed), what is compared, line counts, Whole file and,
  // on a preview, Keep open.
  header(req, t) {
    const parts = req ? req.path.split("/") : [], name = parts.pop() ?? "";
    const compares = !req ? "" : req.kind === "commit" ? `${req.short}^ ↔ ${req.short}` : COMPARES[req.kind];
    const toggle = (cx) => { this.whole = !this.whole; save("whole", this.whole); this.shown = null; cx.notify(); };
    return h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(12.5)
      .child(svg(ICON("file-diff")).size(14).flex_none().text_color(t.muted))
      .child(h_flex().min_w(0).flex_shrink(1)
        .when(parts.length > 0, (e) => e.child(div().truncate().text_color(t.dim).child(parts.join("/") + "/")))
        .child(div().flex_none().font_semibold().child(name || "Diff")))
      .when(Boolean(compares), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(compares)))
      .when(this.counts.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${this.counts.add}`)))
      .when(this.counts.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${this.counts.del}`)))
      .child(div().flex_1())
      .when(Boolean(req) && req.kind !== "untracked", (e) => e.child(this.button("whole", "Whole file", "Show the unchanged lines too", this.whole, toggle, t)))
      .when(Boolean(req) && Boolean(this.key), (e) => e.child(this.button("keep", "Keep open", "Keep this diff in a tab of its own", false, () => this.keepOpen(), t)));
  }

  // One side of a pair row: line number and text, tinted removed or added; null is an empty cell.
  cell(side, t) {
    const el = h_flex().flex_1().min_w(0).h_full().items_center();
    if (!side) return el.bg(t.raised + "80");
    const tint = side.type === "-" ? t.ansi1 + "22" : side.type === "+" ? t.ansi2 + "22" : null;
    return el.when(Boolean(tint), (e) => e.bg(tint))
      .child(div().w(44).flex_none().pr(8).text_right().text_color(t.dim).child(String(side.n)))
      .child(div().flex_1().min_w(0).truncate().child(side.text.slice(0, MAX_LINE) || " "));
  }

  // One row: a hunk header across both sides, or the old and new line side by side.
  row(r, t) {
    if (r.kind === "hunk") return div().w_full().h(ROW).px(12).flex().items_center().bg(t.raised).text_color(t.dim).truncate().child(r.text);
    return h_flex().w_full().h(ROW).child(this.cell(r.left, t)).child(div().w(1).h_full().flex_none().bg(t.border)).child(this.cell(r.right, t));
  }

  // Draws the viewer; reloads first when the request, its seq, Whole file or a Changes write
  // has moved on since the last draw.
  render(cx) {
    if (this.key && !this.pane) this.claim();
    const req = this.request(), seq = this.key ? shared(PREVIEW)?.[this.key]?.seq : 0;
    const sig = JSON.stringify([req, seq, this.whole, req?.kind === "commit" ? 0 : shared(CHANGED)]);
    if (sig !== this.shown) { this.shown = sig; this.reload(cx); }
    const t = theme(), rows = this.rows;
    const message = !req ? "Click a file in Changes or History to see its diff here." : this.note;
    return v_flex().id("diff").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(this.header(req, t))
      .when(Boolean(message), (e) => e.child(div().p(16).text_size(12.5).text_color(t.dim).child(message)))
      .when(!message, (e) => e.child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5)
        .child(v_virtual_list("diff-rows", rows.length, ROW, (i) => String(i), (range) => rows.slice(range.start, range.end).map((r) => this.row(r, t))).size_full())
        .child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0())))
      .when(!message && this.limited, (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child(`Showing the first ${MAX_ROWS} rows`)));
  }
}
