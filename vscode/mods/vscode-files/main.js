// A lazy file browser with bounded read-only previews. It browses the focused pane's folder as the
// stock Files mod does, or, when context.js gives that folder a workspace context, the folder
// roots the context lists, each as a collapsible section.
// Clicking a file opens it in ttt (see openInTtt); remote spaces keep the in-panel preview.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { panes, focused, exec, hc, run, readTextFile, watchFolder, theme, settings, window } from "herdr";
import { contextFor } from "./context.js";
import { focusPlace } from "./focus.js";
import { READ, statusLetter, statusEntries } from "./git-read.js";

// Hands a file to one specific running ttt. ttt listens for this only with "reuseWindow": true in
// ~/.config/ttt/settings.json, on a socket in its private per-user temp folder whose name ends in
// the editor's pid in base 36. The socket is checked first because, when TTT_FORWARD_SOCKET can't
// be reached, ttt falls back to the newest editor anywhere, which may be in another space.
// stdin is /dev/null because ttt never forwards when stdin is a pipe (it reads it as a buffer).
const FORWARD = 'd=${TMPDIR:-$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null)}; d=${d:-/tmp}; d="${d%/}/ttt-$(id -u)"; '
  + 'for s in "$d"/*-"$1".sock; do [ -S "$s" ] && TTT_FORWARD_SOCKET="$s" exec ttt "$2" </dev/null; done; exit 3';

// Opens `path` in a ttt already running in the shown tab, else in a new ttt split to the right
// of the focused pane. --new-window keeps that new ttt from forwarding to an editor elsewhere.
async function openInTtt(path) {
  const f = focused(), here = panes().filter(p => p.tab === f?.tab && p.terminal);
  for (const p of here) {
    const r = await hc(["get", p.terminal, "--json"]).catch(() => null);
    let fg = null;
    try { fg = r?.code === 0 ? JSON.parse(r.stdout).foreground : null; } catch { /* not this one */ }
    if (fg?.name !== "ttt" || !fg.pid) continue;
    const sent = await exec("sh", ["-c", FORWARD, "ttt-open", fg.pid.toString(36), path]).catch(() => null);
    if (sent?.code === 0) return run("pane.focus", { pane: p.pane });
  }
  const beside = here.find(p => p.pane === f?.pane) ?? here[0];
  const argv = ["ttt", "--new-window", path];
  if (beside) run("pane.split", { direction: "right", pane: beside.pane, argv });
  else run("tab.new", { argv });
}

// Where the panel looks: the focused pane's live folder, its machine and the active space (see
// focusPlace).
const location = focusPlace;

// Workspace contexts describe local checkouts; a remote space keeps the single-folder view.
function rootsFor({ cwd, on }) {
  const ctx = on ? null : contextFor(cwd);
  if (!ctx?.roots?.length) return { ctx: null, roots: cwd ? [{ id: "", dir: cwd }] : [] };
  return { ctx, roots: ctx.roots };
}
// Identifies what the panel shows: machine, space and root folders. When it changes, refresh
// stashes the open folders, file and collapsed sections under the old key and restores the new
// one's, so each space keeps its own tree.
function key() {
  const loc = location(), { roots } = rootsFor(loc);
  return JSON.stringify({ on: loc.on, space: loc.space, dirs: roots.map(r => r.dir) });
}
// The `entries` and `folders` key for folder `rel` ("" for the top) under root `rid`.
const at = (rid, rel) => `${rid}:${rel}`;
// Editor languages for extensions the preview does not know by name; others pass through.
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
// Entry caps: per listed folder, and across the whole tree. directory() lists one entry past 500
// so loadFolder can tell a folder was cut; the limit note in render spells out both numbers.
const PER_FOLDER = 500, TOTAL = 5000;

// Lists one folder on `on`'s machine as [{ name, dir }], skipping .git and keeping dotfiles.
// Links to folders count as folders, dangling links as files. Throws when the folder cannot be
// listed, including when it no longer exists.
async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Reparse points keep directory attributes even when dangling; check their target.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replaceAll("'", "''") + "'"]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// Change marks keyed by path relative to `dir`. Git prints repo-relative paths, so strip the
// folder's prefix inside its repo: this also sidesteps symlinked spellings of the same folder.
async function changeMarks(dir, on) {
  const prefix = await exec("git", ["rev-parse", "--show-prefix"], { cwd: dir, on }).catch(() => null);
  if (prefix?.code !== 0) return {};
  const p = prefix.stdout.trim();
  // READ writes nothing under .git: the folder watch would refresh again.
  const status = await exec("git", [...READ, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", "."], { cwd: dir, on }).catch(() => null);
  const marks = {};
  if (status?.code === 0) for (const { xy, path } of statusEntries(status.stdout).slice(0, TOTAL)) {
    if (path.startsWith(p)) marks[path.slice(p.length)] = statusLetter(xy);
  }
  return marks;
}

// The panel: a lazy tree per root from rootsFor, listing a folder only once it is opened, with
// git change letters on its entries and a read-only preview for files it does not hand to ttt.
export default class Files extends View {
  // Starts loading. `saved` holds each key's open folders, file and collapsed sections. The
  // 10-second timer is the fallback for remote spaces, which are never watched, and for folders
  // that cannot be.
  init(_props, cx) {
    this.saved = new Map();
    this.roots = []; this.entries = new Map(); this.folders = new Set(); this.pending = new Set();
    this.marks = {}; this.missing = new Set(); this.collapsed = new Set(); this.errors = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  // Starts one watchFolder loop per root for a local context, at most once per context; each loop
  // ends when the context changes.
  watch(context, cx) {
    if (context.on || this.watching === context) return;
    this.watching = context;
    for (const root of context.roots) cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root.dir); if (this.current(context)) this.refresh(cx); } }
      catch { /* A folder that cannot be watched still refreshes on the timer. */ }
    });
  }

  // Whether `context` is still the shown one and focus has not moved to another folder; async work
  // checks it before writing results.
  current(context) {
    return this.context === context && key() === context.key;
  }

  // The shown root with id `rid`.
  root(rid) { return this.roots.find(r => r.id === rid); }

  // How many entries are loaded across the tree, leaving out folder key `except`.
  used(except) {
    return [...this.entries.entries()].filter(([k]) => k !== except).reduce((n, [, e]) => n + e.length, 0);
  }

  // Lists one folder into `entries`, folders first then by name, within PER_FOLDER and what is left
  // of TOTAL, and sets `limited` when it had to cut. A result arriving after the context changed or
  // the folder was closed is dropped. Throws when the folder cannot be listed.
  async loadFolder(rid, rel, context) {
    const root = context.roots.find(r => r.id === rid);
    const entries = await directory(rel ? `${root.dir}/${rel}` : root.dir, context.on);
    if (!this.current(context) || (rel && !this.folders.has(at(rid, rel)))) return;
    const used = this.used(at(rid, rel));
    this.entries.set(at(rid, rel), entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  // Re-lists every root and its open folders and reloads change letters, one task at a time.
  // A new key() first stashes the old view under its key and restores the new one's. An optional
  // root that fails to load is hidden; any other shows its error in place of its rows.
  refresh(cx) {
    const loc = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file, collapsed: this.collapsed });
      const saved = this.saved.get(next), { ctx, roots } = rootsFor(loc);
      this.context = { key: next, on: loc.on, roots }; this.roots = roots; this.ctx = ctx; this.on = loc.on;
      this.entries = new Map(); this.folders = new Set(saved?.folders); this.collapsed = new Set(saved?.collapsed);
      this.pending = new Set(); this.marks = {}; this.missing = new Set(); this.errors = {};
      this.show(null); this.watching = null; this.limited = false; this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!this.roots.length || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        const marks = {}, missing = new Set(), errors = {};
        for (const root of context.roots) {
          try {
            marks[root.id] = await this.loadRoot(root, context);
          } catch (e) {
            if (root.optional) missing.add(root.id); else errors[root.id] = String(e);
          }
          if (!this.current(context)) return;
        }
        this.marks = marks; this.missing = missing; this.errors = errors;
        this.watch(context, cx);
      } finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  // A root's top folder and every folder open under it, then its git status letters. Stops early
  // (returning nothing) if the focused folder changes meanwhile; the caller checks that too.
  async loadRoot(root, context) {
    await this.loadFolder(root.id, "", context);
    for (const folder of [...this.folders].filter(f => f.startsWith(at(root.id, "")))) {
      if (!this.current(context)) return undefined;
      await this.loadFolder(root.id, folder.slice(root.id.length + 1), context);
    }
    return changeMarks(root.dir, context.on);
  }

  // Opens or closes folder `rel`. Closing forgets its open subfolders too, so reopening shows them
  // shut; opening lists it once, however often it is clicked meanwhile (`pending`).
  toggle(rid, rel, cx) {
    const k = at(rid, rel);
    if (this.folders.has(k)) {
      for (const folder of [...this.folders]) if (folder === k || folder.startsWith(k + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(k);
      if (!this.entries.has(k) && !this.pending.has(k)) {
        const context = this.context;
        this.pending.add(k);
        cx.spawn(async cx => {
          try { await this.loadFolder(rid, rel, context); }
          catch (e) { if (this.current(context)) this.errors[rid] = String(e); }
          finally { if (this.context === context) this.pending.delete(k); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // Opens a file in ttt on this machine; a remote space shows it in the panel's preview instead.
  open(rid, rel, cx) {
    const root = this.root(rid);
    if (this.on || !root) return this.show({ rid, rel }, cx);
    cx.spawn(async () => openInTtt(`${root.dir}/${rel}`));
  }

  // `file` is { rid, rel }.
  show(file, cx) {
    this.code?.release(); this.code = null; this.file = file; this.fileError = null;
    if (!file || !cx) return;
    const context = this.context, root = this.root(file.rid), on = this.on;
    if (!root) { this.file = null; return; }
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root.dir}/${file.rel}`, { on });
        if (this.file !== file || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = file.rel.includes(".") ? file.rel.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === file && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // Appends the rows of one folder's entries to `out`, depth first through open folders, indented
  // 18px a level. Stops at TOTAL rows or 40 levels deep.
  rows(rid, prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(at(rid, prefix)) ?? []) {
      if (out.length >= TOTAL) break;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(at(rid, rel)), mark = this.marks[rid]?.[rel];
      out.push(h_flex().id(`file-${rid}-${rel}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(rid, rel, cx) : this.open(rid, rel, cx))
        .child(entry.dir ? svg(`mods/vscode-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/vscode-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(rid, rel, depth + 1, out, t);
    }
    return out;
  }

  // One root's rows; a context's root gets a collapsible section header, a plain folder none.
  section(root, out, t) {
    if (this.missing.has(root.id)) return out;
    const shut = this.collapsed.has(root.id), depth = root.label ? 1 : 0;
    if (root.label) out.push(h_flex().id(`root-${root.id}`).h(26).flex_none().px(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { shut ? this.collapsed.delete(root.id) : this.collapsed.add(root.id); cx.notify(); })
      .child(svg(`mods/vscode-files/chevron-${shut ? "right" : "down"}.svg`).size(12).flex_none().text_color(t.dim))
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(root.label))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(root.sub)));
    if (shut) return out;
    const before = out.length;
    this.rows(root.id, "", depth, out, t);
    if (out.length === before) out.push(div().pl(8 + depth * 18).py(6).text_size(12).text_color(t.dim)
      .child(this.errors[root.id] || (this.loading ? "Loading files…" : "No files")));
    return out;
  }

  // Draws the header, then the tree, or the preview while a file is shown. It refreshes here when
  // key() changes, since moving focus to another folder redraws the panel without a timer tick.
  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), plain = this.roots[0];
    const title = this.file ? this.file.rel : this.ctx?.title ? this.ctx.title : plain?.dir.split(/[\\/]/).pop() ?? "";
    return v_flex().id("files").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(35).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(title)))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .children(this.roots.reduce((out, root) => this.section(root, out, t), []))
        .when(!this.roots.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child("No folder")))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
