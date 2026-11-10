// Uncommitted changes with a commit box and a push button per repo; clicking a file shows its
// diff in the Diff tab (vscode-diff, through diff-open.js). Files are in
// two groups, as in VS Code: Staged (− unstages) and Changes (+ stages, ↶ discards after asking,
// see discard.js), as a folder tree or a flat list (model.js). Commit commits what is staged, or
// everything in the section when nothing is.
// One section covers the focused pane's whole repo, as the stock Changes mod does. When context.js
// gives that folder a workspace context, there is one section per folder root it lists, and each
// lists and commits ONLY paths under its folder: a repo shared with other projects would
// otherwise have its unrelated work swept up by a repo-wide `git add -A`.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, exec, watchFolder, theme, run, layout, shared, setShared, props } from "herdr";
import { contextFor, openHistory, ROOT_IDS } from "./context.js";
import { inTabStrip } from "./layout.js";
import { focusPlace } from "./focus.js";
import { READ, GIT_TIMEOUT, numstatEntries } from "./git-read.js";
import { openDiff } from "./diff-open.js";
import { changeGroups, changeRows } from "./model.js";
import { CHANGED, askDiscard, initDiscard, renderDiscard } from "./discard.js";

// The path of one of this mod's icons, as svg() wants it.
const ICON = (name) => `mods/vscode-changes/${name}.svg`;
// Height in px of a file or folder row, and of a group's header row.
const ROW_H = 28, GROUP_H = 24;
// Reads and writes this copy's own small settings (the list/tree view); storage can be missing.
const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* a nicety only */ } };

// Where the panel looks: the focused pane's live folder and its machine (see focusPlace).
const location = focusPlace;
// Workspace contexts describe local checkouts; a remote space keeps the single whole-repo section.
function sectionsFor({ cwd, on }) {
  const ctx = on ? null : contextFor(cwd);
  if (!ctx?.roots?.length) return cwd ? [{ id: "", dir: cwd, whole: true }] : [];
  return ctx.roots.map(({ id, label, dir, optional }) => ({ id, label, dir, optional }));
}
// Identifies what the panel shows: the machine plus every section folder. When it changes,
// refresh drops all section state and clears the commit boxes; render compares it on every redraw.
function key() {
  const loc = location();
  return JSON.stringify({ on: loc.on, dirs: sectionsFor(loc).map((s) => s.dir) });
}
// The most changed files listed per section; past it the section says so (`limited`).
const LIMIT = 1000;

// One section's state from git. `files` paths are repo-relative; `prefix` is the section
// folder inside its repo ("" for a whole-repo section).
async function scan(section, on) {
  const run = (args, cwd) => exec("git", [...READ, ...args], { cwd, on, timeout: GIT_TIMEOUT });
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: section.dir, on, timeout: GIT_TIMEOUT });
  if (top.code !== 0) throw new Error("Not a git repository");
  const repo = top.stdout.trim();
  const prefix = section.whole ? "" : (await run(["rev-parse", "--show-prefix"], section.dir)).stdout.trim();
  const dir = section.whole ? repo : section.dir;
  const status = await run(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], repo);
  if (status.code !== 0) throw new Error(status.stderr);
  const hasHead = (await run(["rev-parse", "--verify", "HEAD"], repo)).code === 0;
  // Staged lines (HEAD, or nothing before the first commit, to the index) and unstaged ones
  // (the index to the working tree).
  const numstat = async (...from) => {
    const r = await run(["diff", ...from, "--numstat", "-z", "--no-renames", "--", "."], dir);
    if (r.code !== 0) throw new Error(r.stderr);
    return numstatEntries(r.stdout);
  };
  const groups = changeGroups(status.stdout, prefix, await numstat("--cached"), await numstat(), LIMIT);
  const files = [...groups.staged, ...groups.changes];
  const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"], repo)).stdout.trim();
  // No upstream (a fresh branch): no push button rather than a guess at the remote.
  const ahead = await run(["rev-list", "--count", "@{u}..HEAD"], repo);
  return { repo, prefix, dir, ...groups, files, hasHead,
    branch: branch === "HEAD" ? "detached" : branch, ahead: ahead.code === 0 ? Number(ahead.stdout.trim()) || 0 : 0 };
}

// Whether two { sid, path, group } name the same row: a file staged and edited again has two.
const sameFile = (a, b) => a.sid === b.sid && a.path === b.path && a.group === b.group;

// The panel: one section per folder from sectionsFor, each with its file list, commit box and
// push button.
export default class Changes extends View {
  // Prepares the commit boxes and starts loading, or, opened as an overlay, the discard dialog.
  // The 10-second timer is the fallback for what the folder watch misses: remote spaces, which
  // are never watched, and folders that cannot be.
  init(initial, cx) {
    const p = initial ?? props() ?? {};
    if (p.overlay) return initDiscard(this, p, cx);
    this.sections = []; this.state = {}; this.inputs = {};
    this.collapsed = new Set(); this.handle = cx.focus_handle();
    // "tree" or "list"; folded folder ids (see changeRows); the row under the pointer, whose
    // stage / unstage / discard buttons show; the last discard seen (CHANGED).
    this.view = load("view", "tree"); this.folded = new Set(); this.hovered = null; this.seen = shared(CHANGED);
    // InputState.new throws inside render, and refresh can run from render when the focused
    // folder changes, so every section id sectionsFor can return gets its box up front.
    for (const id of ["", ...ROOT_IDS]) this.input(id);
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  // One commit box per section id, kept across refreshes so typing is never lost.
  input(id) {
    if (this.inputs[id]) return this.inputs[id];
    const input = InputState.new({ placeholder: "Commit message" });
    input.on("change", (_e, cx) => {
      const s = this.state[id]; if (!s) return;
      const had = Boolean(s.message.trim());
      s.message = input.value();
      if (had !== Boolean(s.message.trim())) cx.notify();
    });
    input.on("submit", (_e, cx) => this.commit(id, cx));
    input.on("focus", (_e, cx) => { this.typing = id; cx.notify(); });
    input.on("blur", (_e, cx) => { if (this.typing === id) this.typing = null; cx.notify(); });
    return this.inputs[id] = input;
  }

  // Starts one watchFolder loop per section for a local context, at most once per context; each
  // loop ends when the context changes. It watches the scanned folder (the repo top for a whole-repo
  // section) and relies on READ: a git write under .git would wake the watch after every refresh.
  watch(context, cx) {
    if (context.on || this.watching === context) return;
    this.watching = context;
    for (const section of context.sections) cx.spawn(async (cx) => {
      try {
        while (this.context === context) {
          await watchFolder(this.state[section.id]?.dir ?? section.dir);
          if (this.context === context) this.refresh(cx);
        }
      } catch { /* A folder that cannot be watched still refreshes on the timer. */ }
    });
  }

  // Whether a commit or push is running in any section; refresh waits until it ends.
  busy() { return Object.values(this.state).some((s) => s.busy); }

  // Rescans every section, one after another. A new key() first resets all state, the selection
  // and the watch. It does nothing while a scan or git action runs; act refreshes when it
  // finishes. An optional section whose folder fails to scan is hidden rather than shown as an
  // error. The selection (the row the Diff tab shows) clears when that row is gone.
  refresh(cx) {
    if (this.loading || this.busy()) return;
    const loc = location(), next = key();
    if (next !== this.context?.key) {
      this.sections = sectionsFor(loc);
      this.context = { key: next, on: loc.on, sections: this.sections };
      this.state = {}; this.open = null; this.watching = null; this.error = null;
      // State first: if resetting a box ever throws, render still finds every section.
      for (const s of this.sections) this.state[s.id] = { files: [], staged: [], changes: [], others: 0, stagedOutside: 0, message: "", note: null, busy: null, loaded: false };
      for (const s of this.sections) this.input(s.id).set_value("");
    }
    if (!this.sections.length) return;
    const context = this.context;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        for (const section of context.sections) {
          const s = this.state[section.id];
          try { Object.assign(s, await scan(section, context.on), { error: null, missing: false }); }
          catch (e) {
            if (section.optional) s.missing = true;
            else Object.assign(s, { error: String(e.message ?? e), files: [], staged: [], changes: [], others: 0, stagedOutside: 0, ahead: 0 });
          }
          s.loaded = true;
          if (this.context !== context) return;
        }
        this.watch(context, cx);
        const all = this.visible().flatMap((sec) => this.state[sec.id].files.map((f) => ({ sid: sec.id, path: f.path, group: f.group })));
        if (this.open && !all.some((o) => sameFile(o, this.open))) this.open = null;
      } finally { this.loading = false; cx.notify(); }
    });
  }

  // A workspace context's History (its repos); elsewhere the one repo this panel shows.
  history() {
    const loc = location(), ctx = loc.on ? null : contextFor(loc.cwd), plain = this.state[""];
    if (ctx?.history) return openHistory(run, spaces, ctx.history);
    if (!plain?.repo) return;
    const name = plain.repo.split("/").pop();
    openHistory(run, spaces, { label: name, repos: [{ id: "repo", label: name, dir: plain.repo, tagPrefix: null }] });
  }

  // The sections to draw: every one with state, minus optional ones whose folder is missing.
  visible() { return this.sections.filter((sec) => this.state[sec.id] && !this.state[sec.id].missing); }

  // Shows the diff of `path` in `group` ("staged" or "changes") in the Diff tab (diff-open.js)
  // and marks its row. An untracked file is shown as all new.
  pick(sid, path, group, cx) {
    const s = this.state[sid], f = s?.files.find((x) => x.path === path && x.group === group);
    if (!f) return;
    this.open = { sid, path, group };
    openDiff({ repo: s.repo, on: this.context.on, path, kind: group === "staged" ? "staged" : f.fresh ? "untracked" : "unstaged" });
    cx.notify();
  }

  // Runs git steps in order for one section, then refreshes. `label` shows on its button.
  act(id, label, steps, done, cx) {
    const s = this.state[id], context = this.context;
    if (!s || s.busy || this.loading) return;
    s.busy = label; s.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const [args, cwd] of steps) {
          const r = await exec("git", args, { cwd, on: context.on, timeout: GIT_TIMEOUT });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (this.context === context) done?.();
        // Tells open Diff tabs (and other Changes panels) that the index or files moved.
        setShared(CHANGED, Date.now());
      } catch (e) { if (this.context === context) s.note = `${label.replace("…", "")} failed: ${e.message ?? e}`; }
      finally { s.busy = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // Commits what is staged (`git commit`, the index as it is). With nothing staged it commits
  // everything in the section's folder (`-- .` from it), as before staging existed. A plain
  // commit takes the whole index, so in a section that covers part of a shared repo it refuses
  // while anything outside the folder is staged, rather than committing someone else's work.
  commit(id, cx) {
    const s = this.state[id], message = s?.message.trim();
    if (!message || !s.files.length) return;
    const clear = () => { s.message = ""; this.inputs[id].set_value(""); };
    if (!s.staged.length) return this.act(id, "Committing…", [[["add", "-A", "--", "."], s.dir], [["commit", "-m", message, "--", "."], s.dir]], clear, cx);
    if (s.stagedOutside) {
      s.note = `${s.stagedOutside} file${s.stagedOutside === 1 ? " is" : "s are"} staged outside this folder and would be committed too. Unstage ${s.stagedOutside === 1 ? "it" : "them"} first.`;
      return cx.notify();
    }
    this.act(id, "Committing…", [[["commit", "-m", message], s.repo]], clear, cx);
  }

  // Stages `path` (repo-relative; a folder stages everything under it). -A also stages deletions.
  stage(id, path, cx) {
    const s = this.state[id];
    this.act(id, "Staging…", [[["add", "-A", "--", path], s.repo]], null, cx);
  }

  // Unstages `path`, keeping its changes in the working tree. Before the first commit there is no
  // HEAD to restore from, so it drops the path from the index instead.
  unstage(id, path, cx) {
    const s = this.state[id];
    this.act(id, "Unstaging…", [[s.hasHead ? ["restore", "--staged", "--", path] : ["rm", "--cached", "-r", "-q", "--", path], s.repo]], null, cx);
  }

  // Asks before discarding `files` (Changes rows) of section `id`; `title` is the question.
  discard(id, files, title) {
    const s = this.state[id];
    if (s.busy || this.loading) return;
    askDiscard({ title, repo: s.repo, on: this.context.on, files });
  }

  // Pushes the whole branch to its upstream; a rejected push shows git's reason, never pulls.
  push(id, cx) {
    const s = this.state[id];
    if (s?.ahead) this.act(id, "Pushing…", [[["push"], s.repo]], null, cx);
  }

  // One small icon button on a row. `action(cx)` runs on click without the click reaching the row.
  iconButton(id, icon, tip, action, t) {
    return div().id(id).size(20).flex().flex_none().items_center().justify_center().rounded(4).cursor_pointer()
      .hover((st) => st.bg(t.raised)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(svg(ICON(icon)).size(13).text_color(t.muted));
  }

  // Tracks which row the pointer is on, so only that row shows its buttons.
  hover(rowId) {
    return (h, cx) => { this.hovered = h ? rowId : this.hovered === rowId ? null : this.hovered; cx.notify(); };
  }

  // The buttons of a row in `group` whose `target` is { path, files, title }: the repo-relative
  // path and the files it covers, and the question discard asks. − (unstage) on Staged rows; ↶
  // (discard) and + (stage) on Changes rows. A fixed-width slot, filled only while the row is
  // hovered and nothing is running, so rows never shift.
  actions(sid, group, rowId, { path, files, title }, t) {
    const s = this.state[sid], box = h_flex().w(44).flex_none().gap(2).justify_end();
    if (this.hovered !== rowId || s.busy || this.loading) return box;
    if (group === "staged") return box.child(this.iconButton(`${rowId}-unstage`, "minus", "Unstage", (cx) => this.unstage(sid, path, cx), t));
    return box
      .when(files.some((f) => f.status !== "U"), (e) => e.child(this.iconButton(`${rowId}-discard`, "undo-2", "Discard changes", () => this.discard(sid, files, title), t)))
      .child(this.iconButton(`${rowId}-stage`, "plus", "Stage", (cx) => this.stage(sid, path, cx), t));
  }

  // A group's header: STAGED or CHANGES, its count, and buttons that act on the whole group.
  groupRow(sec, group, files, t) {
    const s = this.state[sec.id], rowId = `group-${sec.id}-${group}`;
    // Discard keeps what is staged, so with a Staged group the question says "unstaged".
    const title = `Discard all ${s.staged.length ? "unstaged " : ""}changes${sec.label ? ` in ${sec.label}` : ""}?`;
    return h_flex().id(rowId).h(GROUP_H).flex_none().pl(8).pr(4).gap(6).items_center().on_hover(this.hover(rowId))
      .child(div().flex_1().text_size(10.5).font_semibold().text_color(t.muted).child(group === "staged" ? "STAGED" : "CHANGES"))
      .child(div().px(5).rounded(8).bg(t.raised).text_size(10.5).text_color(t.foreground).child(String(files.length)))
      .child(this.actions(sec.id, group, rowId, { path: s.prefix || ".", files, title }, t));
  }

  // A folder of the tree: chevron, name and file count; clicking folds or unfolds it.
  dirRow(sid, group, row, t) {
    const s = this.state[sid], rowId = `dir-${sid}-${row.id}`, shut = this.folded.has(row.id);
    return h_flex().id(rowId).h(ROW_H).flex_none().pl(6 + row.depth * 14).pr(4).gap(6).items_center().rounded(7).cursor_pointer()
      .hover((st) => st.bg(t.hover)).on_hover(this.hover(rowId))
      .on_click((_e, cx) => { if (shut) this.folded.delete(row.id); else this.folded.add(row.id); cx.notify(); })
      .child(svg(ICON(`chevron-${shut ? "right" : "down"}`)).size(12).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(row.name))
      .child(div().text_size(11).text_color(t.dim).child(String(row.files.length)))
      .child(this.actions(sid, group, rowId, { path: s.prefix + row.path, files: row.files, title: `Discard changes in ${row.name}?` }, t));
  }

  // One changed file: status letter, its name (in the flat list after its folder, dimmed), line
  // counts and buttons. Clicking it toggles its diff.
  fileRow(sid, { f, depth, flat }, t) {
    const parts = f.short.split("/"), name = parts.pop(), rowId = `change-${sid}-${f.group}-${f.path}`;
    const open = Boolean(this.open) && sameFile(this.open, { sid, path: f.path, group: f.group });
    const letter = f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.blocked;
    return h_flex().id(rowId).h(ROW_H).flex_none().pl(8 + depth * 14).pr(4).gap(8).items_center().rounded(7).cursor_pointer()
      .when(open, (e) => e.bg(t.selected)).hover((st) => st.bg(t.hover)).on_hover(this.hover(rowId))
      .on_click((_e, cx) => this.pick(sid, f.path, f.group, cx))
      .child(div().w(14).flex_none().text_size(11).text_color(letter).child(f.status))
      .child(h_flex().flex_1().min_w(0)
        .when(flat && parts.length > 0, (e) => e.child(div().text_color(t.dim).truncate().child(parts.join("/") + "/")))
        .child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
      .child(this.actions(sid, f.group, rowId, { path: f.path, files: [f], title: `Discard changes to ${name}?` }, t));
  }

  // A section's file list: each non-empty group's header and rows, as a tree or a flat list. The
  // whole panel scrolls, so the list takes the height it needs.
  fileList(sec, t) {
    const s = this.state[sec.id], rows = [];
    for (const group of ["staged", "changes"]) {
      if (!s[group].length) continue;
      rows.push(this.groupRow(sec, group, s[group], t));
      for (const row of changeRows(s[group], this.view, this.folded, `${sec.id}:${group}`)) {
        rows.push(row.kind === "dir" ? this.dirRow(sec.id, group, row, t) : this.fileRow(sec.id, row, t));
      }
    }
    return v_flex().id(`files-${sec.id}`).flex_none()
      .px(6).pb(4).when(!sec.label, (e) => e.pt(6)).children(rows)
      .when(!rows.length, (e) => e.child(div().px(8).py(6).text_size(12).text_color(t.dim).child(s.error || (s.loaded ? "No uncommitted changes" : "Loading changes…"))));
  }

  // One section: a collapsible header (labelled workspace sections only) with repo, branch, commits
  // to push and line totals; its file list; notes; and the commit box with Commit and Push.
  section(sec, t) {
    const s = this.state[sec.id], shut = this.collapsed.has(sec.id), repoName = s.repo?.split("/").pop() ?? "";
    const add = s.files.reduce((n, f) => n + f.add, 0), del = s.files.reduce((n, f) => n + f.del, 0);
    const canCommit = Boolean(s.message.trim() && s.files.length && !s.busy && !this.loading);
    const button = (id, label, on, action) => div().id(id).h(32).px(12).flex().flex_none().items_center().rounded(8).text_size(12)
      .bg(on ? t.solid : t.raised).text_color(on ? t.solid_foreground : t.dim).when(on, (e) => e.cursor_pointer()).on_click(action).child(label);
    return v_flex().flex_none().border_b(1).border_color(t.border)
      .when(Boolean(sec.label), (el) => el.child(h_flex().id(`section-${sec.id}`).h(30).flex_none().px(10).gap(7).items_center().cursor_pointer().hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => { shut ? this.collapsed.delete(sec.id) : this.collapsed.add(sec.id); cx.notify(); })
        .child(svg(`mods/vscode-changes/chevron-${shut ? "right" : "down"}.svg`).size(12).flex_none().text_color(t.dim))
        .child(div().text_size(11).font_semibold().text_color(t.muted).child(sec.label))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(s.repo ? `${repoName} · ${s.branch}` : ""))
        .when(s.ahead > 0, (e) => e.child(div().text_size(11).text_color(t.accent).child(`↑${s.ahead}`)))
        .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))))
      .when(!shut, (el) => el
        .child(this.fileList(sec, t))
        .when(s.limited, (e) => e.child(div().px(14).pb(4).text_size(11).text_color(t.dim).child(`Showing the first ${LIMIT.toLocaleString()} changed files`)))
        .when(!sec.whole && s.others > 0, (e) => e.child(div().px(14).pb(6).text_size(11).text_color(t.dim)
          .child(`${s.others} more change${s.others === 1 ? "" : "s"} elsewhere in ${repoName}`)))
        .when(Boolean(s.note), (e) => e.child(div().px(14).pb(6).text_size(11).text_color(t.ansi1).child(s.note)))
        .when(Boolean(s.repo), (e) => e.child(h_flex().px(10).pb(10).pt(2).gap(8)
          .child(div().id(`message-${sec.id}`).flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing === sec.id ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input(sec.id)).h_full().text_size(12).text_color(t.foreground)))
          .child(button(`commit-${sec.id}`, s.busy === "Committing…" ? s.busy : s.staged.length ? "Commit" : "Commit all", canCommit, (_e, cx) => this.commit(sec.id, cx)))
          .when(s.ahead > 0, (r) => r.child(button(`push-${sec.id}`, s.busy === "Pushing…" ? s.busy : `Push ↑${s.ahead}`, !s.busy && !this.loading, (_e, cx) => this.push(sec.id, cx)))))));
  }

  // Draws the header totals, the sections and the diff list. It refreshes here when key()
  // changes, since moving focus to another folder redraws the panel without a timer tick.
  render(cx) {
    if (this.dialog) return renderDiscard(this);
    if (shared(CHANGED) !== this.seen) { this.seen = shared(CHANGED); this.refresh(cx); }
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), shown = this.visible(), files = shown.flatMap((sec) => this.state[sec.id].files);
    const count = new Set(shown.flatMap((sec) => this.state[sec.id].files.map((f) => `${sec.id}:${f.path}`))).size;
    const toggle = (cx) => { this.view = this.view === "tree" ? "list" : "tree"; save("view", this.view); cx.notify(); };
    const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
    const tabbed = inTabStrip(layout(), "vscode-changes");
    return v_flex().id("changes").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = null; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(tabbed ? 36 : 35).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(!tabbed, (el) => el
          .child(div().font_semibold().child("Changes"))
          .child(div().id("history").px(6).h(20).flex().items_center().rounded(4).text_size(11).text_color(t.muted).cursor_pointer()
            .hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip("Git history (cmd-shift-h)").on_click(() => this.history()).child("History")))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${count} file${count === 1 ? "" : "s"}`))
        .child(this.iconButton("view-toggle", this.view === "tree" ? "list" : "list-tree", this.view === "tree" ? "View as list" : "View as tree", toggle, t))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      // The sections fill the panel and scroll together; diffs open in the Diff tab.
      .child(v_flex().id("changes-sections").flex_1().min_h(0).overflow_y_scrollbar()
        .children(shown.map((sec) => this.section(sec, t)))
        .when(!shown.length, (e) => e.child(div().p(14).text_color(t.dim).child("No folder"))));
  }
}
