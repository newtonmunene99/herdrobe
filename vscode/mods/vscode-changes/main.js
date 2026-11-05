// Uncommitted changes with a diff preview, a commit box and a push button per repo.
// One section covers the focused pane's whole repo, as the stock Changes mod does. When context.js
// gives that folder a workspace context, there is one section per folder root it lists, and each
// lists and commits ONLY paths under its folder: a repo shared with other projects would
// otherwise have its unrelated work swept up by a repo-wide `git add -A`.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, exec, readTextFile, watchFolder, theme, settings, run, layout } from "herdr";
import { contextFor, openHistory, ROOT_IDS } from "./context.js";
import { inTabStrip } from "./layout.js";
import { focusPlace } from "./focus.js";
import { READ, statusLetter, diffRows } from "./git-read.js";

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
// Counts the lines in `text`; a trailing newline does not start another line.
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// One section's state from git. `files` paths are repo-relative; `prefix` is the section
// folder inside its repo ("" for a whole-repo section).
async function scan(section, on) {
  const run = (args, cwd) => exec("git", [...READ, ...args], { cwd, on });
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: section.dir, on });
  if (top.code !== 0) throw new Error("Not a git repository");
  const repo = top.stdout.trim();
  const prefix = section.whole ? "" : (await run(["rev-parse", "--show-prefix"], section.dir)).stdout.trim();
  const dir = section.whole ? repo : section.dir;
  const status = await run(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], repo);
  if (status.code !== 0) throw new Error(status.stderr);
  const hasHead = (await run(["rev-parse", "--verify", "HEAD"], repo)).code === 0;
  const stats = numstats(await lineDiffs(run, dir, hasHead));
  const { files, others, limited } = statusFiles(status.stdout, prefix, stats);
  const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"], repo)).stdout.trim();
  // No upstream (a fresh branch): no push button rather than a guess at the remote.
  const ahead = await run(["rev-list", "--count", "@{u}..HEAD"], repo);
  return { repo, prefix, dir, files, others, limited, hasHead,
    branch: branch === "HEAD" ? "detached" : branch, ahead: ahead.code === 0 ? Number(ahead.stdout.trim()) || 0 : 0 };
}

// The diffs that give line counts: against HEAD, or, before the first commit, staged plus unstaged.
async function lineDiffs(run, dir, hasHead) {
  const numstat = (...from) => run(["diff", ...from, "--numstat", "-z", "--no-renames", "--", "."], dir);
  return hasHead ? [await numstat("HEAD")] : [await numstat("--cached"), await numstat()];
}

// Added and deleted lines per repo-relative path, summed over `git diff --numstat -z` results.
function numstats(results) {
  const stats = {};
  for (const result of results) {
    if (result.code !== 0) throw new Error(result.stderr);
    for (const entry of result.stdout.split("\0")) {
      const [a, d, ...parts] = entry.split("\t");
      if (!parts.length) continue;
      const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
      stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
    }
  }
  return stats;
}

// The section's files from `git status --porcelain=v1 -z`, up to LIMIT; `others` counts changes
// elsewhere in the repo, outside the section's folder.
function statusFiles(stdout, prefix, stats) {
  const files = [];
  let others = 0;
  const entries = stdout.split("\0").filter(Boolean);
  for (const entry of entries) {
    const xy = entry.slice(0, 2), path = entry.slice(3);
    if (!path.startsWith(prefix)) { others++; continue; }
    if (files.length >= LIMIT) continue;
    files.push({ path, short: path.slice(prefix.length), status: statusLetter(xy), fresh: xy === "??", ...(stats[path] ?? { add: 0, del: 0 }) });
  }
  return { files, others, limited: entries.length - others > LIMIT };
}

// The panel: one section per folder from sectionsFor, each with its file list, commit box and
// push button, over one diff preview of the file picked in any section.
export default class Changes extends View {
  // Prepares the commit boxes and starts loading. The 10-second timer is the fallback for what the
  // folder watch misses: remote spaces, which are never watched, and folders that cannot be.
  init(_props, cx) {
    this.sections = []; this.state = {}; this.inputs = {}; this.rows = []; this.diffWidth = 0;
    this.collapsed = new Set(); this.handle = cx.focus_handle();
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

  // Rescans every section, one after another, and reloads the open diff. A new key() first resets
  // all state, the selection and the watch. It does nothing while a scan or git action runs; act
  // refreshes when it finishes. An optional section whose folder fails to scan is hidden rather than
  // shown as an error. The first changed file opens unless the person closed the preview.
  refresh(cx) {
    if (this.loading || this.busy()) return;
    const loc = location(), next = key();
    if (next !== this.context?.key) {
      this.sections = sectionsFor(loc);
      this.context = { key: next, on: loc.on, sections: this.sections };
      this.state = {}; this.open = null; this.closed = false; this.watching = null; this.error = null; this.setLines([]);
      // State first: if resetting a box ever throws, render still finds every section.
      for (const s of this.sections) this.state[s.id] = { files: [], others: 0, message: "", note: null, busy: null, loaded: false };
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
            else Object.assign(s, { error: String(e.message ?? e), files: [], others: 0, ahead: 0 });
          }
          s.loaded = true;
          if (this.context !== context) return;
        }
        this.watch(context, cx);
        const all = this.visible().flatMap((sec) => this.state[sec.id].files.map((f) => ({ sid: sec.id, path: f.path })));
        if (this.open && !all.some((o) => o.sid === this.open.sid && o.path === this.open.path)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && all.length) this.open = all[0];
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (this.context === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
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

  // Fills the diff preview with `open`'s changes, if it is still the file shown in `context`.
  // A new file (untracked, or added before the first commit) is read from disk as all-added lines,
  // which also recounts its `add`; other files use `git diff` against HEAD, or against the index
  // before the first commit. Binary files get a one-line note, and the preview is capped at 1500
  // lines of 4000 characters. Throws when git fails; refresh and pick show the error.
  async load(open, context) {
    const s = this.state[open.sid], file = s?.files.find((f) => f.path === open.path);
    if (!file) return;
    const on = context.on;
    let lines;
    if (file.fresh || (!s.hasHead && file.status === "A")) {
      const text = await readTextFile(`${s.repo}/${file.path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(s.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path], { cwd: s.repo, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (this.context === context && this.open === open) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  // Replaces the diff rows and the scroll width, estimated at 7px a character plus the gutter.
  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  // Shows `path`'s diff, or closes the preview when it is already shown. A closed preview stays
  // closed across refreshes (`closed`) instead of reopening the first file.
  pick(sid, path, cx) {
    const same = this.open?.sid === sid && this.open?.path === path;
    this.open = same ? null : { sid, path }; this.setLines([]);
    this.closed = !this.open;
    const context = this.context, open = this.open;
    if (open) cx.spawn(async (cx) => {
      try { await this.load(open, context); }
      catch (e) { if (this.context === context && this.open === open) this.setLines([`Cannot preview this diff (too large or unreadable): ${e}`]); }
      cx.notify();
    });
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
          const r = await exec("git", args, { cwd, on: context.on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (this.context === context) done?.();
      } catch (e) { if (this.context === context) s.note = `${label.replace("…", "")} failed: ${e.message ?? e}`; }
      finally { s.busy = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // Stages and commits only this section's folder (`-- .` from it): the rest of a shared repo
  // stays untouched, even if it was already staged.
  commit(id, cx) {
    const s = this.state[id], message = s?.message.trim();
    if (!message || !s.files.length) return;
    this.act(id, "Committing…", [[["add", "-A", "--", "."], s.dir], [["commit", "-m", message, "--", "."], s.dir]],
      () => { s.message = ""; this.inputs[id].set_value(""); }, cx);
  }

  // Pushes the whole branch to its upstream; a rejected push shows git's reason, never pulls.
  push(id, cx) {
    const s = this.state[id];
    if (s?.ahead) this.act(id, "Pushing…", [[["push"], s.repo]], null, cx);
  }

  // One diff line: a hunk header, or a numbered added, removed or context line. Its 20px height
  // must match the row height given to v_virtual_list in render.
  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  // One changed file: status letter, its folder (dimmed) and name relative to the section, and its
  // line counts. Clicking it toggles its diff.
  fileRow(sid, f, t) {
    const parts = f.short.split("/"), name = parts.pop(), open = this.open?.sid === sid && this.open?.path === f.path;
    return h_flex().id(`change-${sid}-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(open, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(sid, f.path, cx))
      .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
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
        // At most six rows tall, so two busy sections still leave room for the diff.
        .child(v_flex().id(`files-${sec.id}`).flex_none().h(s.files.length ? Math.min(6, s.files.length) * 28 + 4 : "auto").overflow_y_scrollbar()
          .px(6).pb(4).when(!sec.label, (e) => e.pt(6)).children(s.files.map((f) => this.fileRow(sec.id, f, t)))
          .when(!s.files.length, (e) => e.child(div().px(8).py(6).text_size(12).text_color(t.dim).child(s.error || (s.loaded ? "No uncommitted changes" : "Loading changes…")))))
        .when(s.limited, (e) => e.child(div().px(14).pb(4).text_size(11).text_color(t.dim).child(`Showing the first ${LIMIT.toLocaleString()} changed files`)))
        .when(!sec.whole && s.others > 0, (e) => e.child(div().px(14).pb(6).text_size(11).text_color(t.dim)
          .child(`${s.others} more change${s.others === 1 ? "" : "s"} elsewhere in ${repoName}`)))
        .when(Boolean(s.note), (e) => e.child(div().px(14).pb(6).text_size(11).text_color(t.ansi1).child(s.note)))
        .when(Boolean(s.repo), (e) => e.child(h_flex().px(10).pb(10).pt(2).gap(8)
          .child(div().id(`message-${sec.id}`).flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing === sec.id ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input(sec.id)).h_full().text_size(12).text_color(t.foreground)))
          .child(button(`commit-${sec.id}`, s.busy === "Committing…" ? s.busy : "Commit", canCommit, (_e, cx) => this.commit(sec.id, cx)))
          .when(s.ahead > 0, (r) => r.child(button(`push-${sec.id}`, s.busy === "Pushing…" ? s.busy : `Push ↑${s.ahead}`, !s.busy && !this.loading, (_e, cx) => this.push(sec.id, cx)))))));
  }

  // Draws the header totals, the sections and the diff list. It refreshes here when key()
  // changes, since moving focus to another folder redraws the panel without a timer tick.
  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), shown = this.visible(), files = shown.flatMap((sec) => this.state[sec.id].files);
    const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
    const tabbed = inTabStrip(layout(), "vscode-changes");
    return v_flex().id("changes").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = null; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(tabbed ? 30 : 42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(!tabbed, (el) => el
          .child(div().font_semibold().child("Changes"))
          .child(div().id("history").px(6).h(20).flex().items_center().rounded(4).text_size(11).text_color(t.muted).cursor_pointer()
            .hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip("Git history (cmd-shift-h)").on_click(() => this.history()).child("History")))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${files.length} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      // Sections size to their content (each file list scrolls on its own); the diff gets the
      // rest. A max_h on a scrolling box made it fill the whole cap instead.
      .child(v_flex().id("changes-sections").flex_none()
        .children(shown.map((sec) => this.section(sec, t)))
        .when(!shown.length, (e) => e.child(div().p(14).text_color(t.dim).child("No folder"))))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))));
  }
}
