// Git history as a Git Graph-style tab: curved lanes, branch and tag badges, date, author and
// hash columns, and a details panel (message, changed files, diff, actions) docked under the
// list for the clicked commit (Git Graph's "Docked to Bottom"): gpui-kit's virtual lists allow
// no handlers inside rows, so rows report clicks through the list and the controls live below.
// Opened by vscode-changes (History button) and vscode-statusbar (cmd-shift-h) with props
// { label, scopeLabel?, repos: [{ id, label, dir, tagPrefix }] }, or with { follow: true } to
// show the focused pane's repo.
//
// A repo may hold more than the folder it was opened for (a subfolder of a shared repo). Then
// the folder scope (the default, labelled scopeLabel or "This folder") limits history and tags
// to that folder, and the only git writes here are checkout (refused while the repo has
// uncommitted changes) and creating a branch without switching to it, each behind its own
// dialog. A dialog is a second copy of this mod opened as an overlay; it tells the tab through
// shared state.
import { View, div, uniform_list, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, InputState, Input } from "gpui-base";
import { exec, theme, settings, run, props, notify, openOverlay, closeOverlay, shared, setShared, focused, panes, spaces, layout as appLayout } from "herdr";
import { contextFor } from "./context.js";

// Narrower than this (points), rows show only graph and subject and the details panel stacks
// its two halves: Date, Author and Commit alone take about 400, leaving subjects unreadable.
const COMPACT = 700;

// appLayout is Herdr's layout tree (this file's own layout() lays out the commit graph).
function findNode(node, id) {
  return node?.id === id ? node : (node?.children ?? []).map((c) => findNode(c, id)).find(Boolean) ?? null;
}

// In vscode-inbox this view is a tab of the right sidebar ("secondary-body"), whose tab strip
// already says History, so the header drops its own title there.
function inTabStrip() {
  return (findNode(appLayout(), "secondary-body")?.children ?? []).some((c) => c.content?.mod === "vscode-history");
}

// Follow mode: where the focused pane is. A space on another machine has no local checkout.
function focusPlace() {
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const space = spaces().find((s) => s.active);
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, remote: Boolean(space?.machine) };
}

const PAGE = 300;
const ROW = 24, LANE = 14, PAD = 6;
const CHANGED = "vscode-history.changed";
const SEP = "\x1f", END = "\x1e";
// Reads write nothing under .git, so polling never disturbs the repo or an agent's git.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const git = (dir, args) => exec("git", [...READ, ...args], { cwd: dir });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function when(seconds) {
  const d = new Date(seconds * 1000), p = (n) => String(n).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function copy(text, what) {
  exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text])
    .then((r) => notify(r.code === 0 ? { title: `Copied ${what}`, body: text, timeout: 2000 } : { title: "Copy failed", body: r.stderr, level: "error" }))
    .catch((e) => notify({ title: "Copy failed", body: String(e), level: "error" }));
}

// "HEAD -> master, origin/master, tag: x" as badges. origin/HEAD only repeats a branch.
function refs(decoration, remotes, tagPrefix) {
  const out = [];
  for (let ref of decoration.split(", ").filter(Boolean)) {
    if (ref.startsWith("tag: ")) {
      const name = ref.slice(5);
      out.push({ kind: "tag", name: tagPrefix && name.startsWith(tagPrefix) ? name.slice(tagPrefix.length) : name, full: name });
      continue;
    }
    let head = false;
    if (ref.startsWith("HEAD -> ")) { head = true; ref = ref.slice(8); }
    if (ref === "HEAD") { out.push({ kind: "head", name: "HEAD" }); continue; }
    const remote = remotes.find((r) => ref.startsWith(`${r}/`));
    if (remote && ref === `${remote}/HEAD`) continue;
    out.push({ kind: remote ? "remote" : "local", name: ref, head });
  }
  return out;
}

// The `git log` for a page of history: one more commit than shown, to know if there are more.
// Scoped to a folder, it lists only that folder's commits, and only tags under its prefix.
function logArgs(repo, info, scoped, remote, limit) {
  const args = ["log", "--topo-order", "--parents", "--branches", "--tags", ...(remote ? ["--remotes"] : []), "HEAD",
    "-n", String(limit + 1), `--format=%H${SEP}%P${SEP}%D${SEP}%an${SEP}%at${SEP}%s${END}`];
  if (scoped && repo.tagPrefix) args.push("--decorate-refs=refs/heads", "--decorate-refs=refs/remotes", `--decorate-refs=refs/tags/${repo.tagPrefix}*`);
  if (scoped) args.push("--", info.prefix);
  return args;
}

// logArgs' output as commits.
function parseLog(stdout, remotes, tagPrefix) {
  return stdout.split(END).map((s) => s.replace(/^\n/, "")).filter(Boolean).map((line) => {
    const [hash, parents, deco, author, at, subject] = line.split(SEP);
    return { hash, parents: parents ? parents.split(" ") : [], refs: refs(deco, remotes, tagPrefix), author, at: Number(at), subject };
  });
}

// The lane already waiting for `hash`, else the leftmost free one, else a new one at the right.
function claim(lanes, hash) {
  let i = lanes.indexOf(hash);
  if (i >= 0) return i;
  i = lanes.indexOf(null);
  if (i < 0) i = lanes.length;
  lanes[i] = hash;
  return i;
}

// Gives every commit a column and the lanes around it. Columns stay put while a lane lives,
// so a lane keeps its colour; freed columns are reused from the left.
function layout(commits) {
  const lanes = [];
  let width = 1;
  for (const c of commits) {
    const hasChild = lanes.includes(c.hash);
    const col = claim(lanes, c.hash);
    const before = lanes.slice();
    for (let j = 0; j < lanes.length; j++) if (j !== col && lanes[j] === c.hash) lanes[j] = null;
    lanes[col] = c.parents[0] ?? null;
    const parentCols = c.parents.length ? [col] : [];
    for (const p of c.parents.slice(1)) parentCols.push(claim(lanes, p));
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    c.graph = { col, hasChild, before, after: lanes.slice(), parentCols };
    width = Math.max(width, before.length, lanes.length, col + 1);
  }
  return width;
}

// Numbers each diff line once, as vscode-changes does.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

export default class History extends View {
  init(initial, cx) {
    const p = initial ?? props() ?? {};
    if (p.overlay) return this.initDialog(p, cx);
    // Opened without props (herdr-app check, or a stray mod.open): nothing to show yet.
    this.p = { label: p.label ?? "", scopeLabel: p.scopeLabel, repos: p.repos ?? [], select: p.select, select_file: p.select_file };
    this.repoId = this.p.repos[0]?.id;
    this.scope = "folder"; this.remote = true;
    this.limit = PAGE; this.commits = []; this.width = 1; this.more = false;
    this.open = null; this.details = null; this.seen = shared(CHANGED);
    this.repoInfo = {};
    // props { follow: true } (vscode-inbox's right sidebar): show the focused pane's repo.
    this.follow = Boolean(p.follow);
    if (this.follow) this.followFocus(cx);
    else this.load(cx);
    cx.timer.every(10000, (cx) => this.poll(cx));
  }

  // Re-derives the repos when the focused pane moves to another folder: a workspace context's
  // History repos (as cmd-shift-h shows), anything else its git root.
  followFocus(cx) {
    const { cwd, remote } = focusPlace();
    const key = `${remote}:${cwd}`;
    if (key === this.followKey) return;
    this.followKey = key;
    cx.spawn(async (cx) => {
      let next = { label: "", repos: [] }, why = null;
      if (remote) why = "History shows repositories on this computer only.";
      else if (!cwd) why = "Focus a terminal to see its repository's history.";
      else {
        const ctx = contextFor(cwd);
        if (ctx?.history) next = ctx.history;
        else {
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd }).catch(() => null);
          const root = top?.code === 0 ? top.stdout.trim() : null;
          if (root) next = { label: root.split("/").pop(), repos: [{ id: "repo", label: root.split("/").pop(), dir: root, tagPrefix: null }] };
          else why = "The focused terminal isn't in a git repository.";
        }
      }
      if (this.followKey !== key) return; // focus moved again while we looked
      const same = JSON.stringify(next.repos) === JSON.stringify(this.p.repos);
      if (same && !why) return;
      this.p = { label: next.label, scopeLabel: next.scopeLabel, repos: next.repos };
      this.repoId = next.repos[0]?.id;
      this.repoInfo = {}; this.commits = []; this.open = null; this.details = null; this.limit = PAGE;
      this.followWhy = why;
      this.load(cx);
      cx.notify();
    });
  }

  repo() { return this.p.repos.find((r) => r.id === this.repoId); }

  // props.select (and select_file) open History on a commit, once.
  selectRequested(cx) {
    if (!this.p.select || this.selectedOnce) return;
    this.selectedOnce = true;
    const c = this.commits.find((x) => x.hash.startsWith(this.p.select));
    if (c) this.toggle(c, cx, this.p.select_file);
  }

  // Root and the folder's path inside it; null when the folder is missing (an optional root).
  async info(repo) {
    if (this.repoInfo[repo.id] !== undefined) return this.repoInfo[repo.id];
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: repo.dir }).catch(() => null);
    if (top?.code !== 0) return this.repoInfo[repo.id] = null;
    const root = top.stdout.trim();
    const prefix = (await git(repo.dir, ["rev-parse", "--show-prefix"])).stdout.trim().replace(/\/$/, "");
    const remotes = (await git(root, ["remote"])).stdout.split("\n").filter(Boolean);
    return this.repoInfo[repo.id] = { root, prefix, remotes };
  }

  load(cx) {
    const repo = this.repo(), token = {};
    if (!repo) {
      this.loading = false;
      this.error = this.follow ? (this.followWhy ?? "Focus a terminal to see its repository's history.") : "Open History from the Changes panel or with cmd-shift-h.";
      return;
    }
    this.token = token; this.loading = true; this.error = null;
    cx.spawn(async (cx) => {
      try {
        const info = await this.info(repo);
        if (this.token !== token) return;
        if (!info) { this.commits = []; this.error = `${repo.dir} is not a git folder`; return; }
        const scoped = this.scope === "folder" && info.prefix;
        const r = await git(info.root, logArgs(repo, info, scoped, this.remote, this.limit));
        if (this.token !== token) return;
        if (r.code !== 0) throw new Error(r.stderr.trim());
        const commits = parseLog(r.stdout, info.remotes, scoped ? repo.tagPrefix : null);
        this.more = commits.length > this.limit;
        this.commits = commits.slice(0, this.limit);
        this.width = layout(this.commits);
        this.stamp = await this.refStamp(info.root);
        if (this.open && !this.commits.some((c) => c.hash === this.open)) { this.open = null; this.details = null; }
        this.selectRequested(cx);
      } catch (e) { if (this.token === token) this.error = String(e.message ?? e); }
      finally { if (this.token === token) this.loading = false; cx.notify(); }
    });
  }

  // HEAD plus every branch tip: a change means a commit, checkout, fetch or push happened.
  async refStamp(root) {
    const r = await git(root, ["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes"]).catch(() => null);
    const head = await git(root, ["rev-parse", "HEAD"]).catch(() => null);
    return `${head?.stdout ?? ""}${r?.stdout ?? ""}`;
  }

  poll(cx) {
    const info = this.repoInfo[this.repoId];
    if (this.loading || !info) return;
    cx.spawn(async (cx) => { if ((await this.refStamp(info.root)) !== this.stamp) this.load(cx); });
  }

  set(field, value, cx) {
    if (this[field] === value) return;
    this[field] = value; this.limit = PAGE; this.open = null; this.details = null;
    this.load(cx);
  }

  toggle(c, cx, file) {
    if (this.open === c.hash) { this.open = null; this.details = null; cx.notify(); return; }
    this.open = c.hash; this.details = { hash: c.hash, loading: true };
    const info = this.repoInfo[this.repoId], scoped = this.scope === "folder" && info.prefix, details = this.details;
    cx.spawn(async (cx) => {
      try {
        const meta = await git(info.root, ["show", "-s", `--format=%P${SEP}%an${SEP}%ae${SEP}%at${SEP}%cn${SEP}%ct${SEP}%B`, c.hash]);
        const [parents, an, ae, at, cn, ct, body] = meta.stdout.split(SEP);
        // Merges list what they brought in relative to their first parent.
        const stat = await git(info.root, ["diff-tree", "--no-commit-id", "-r", "--numstat", "--root", "-m", "--first-parent", c.hash, ...(scoped ? ["--", info.prefix] : [])]);
        const files = stat.stdout.split("\n").filter(Boolean).map((l) => {
          const [a, d, ...rest] = l.split("\t"), path = rest.join("\t");
          return { path, short: scoped && path.startsWith(info.prefix + "/") ? path.slice(info.prefix.length + 1) : path, add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
        });
        Object.assign(details, { loading: false, parents: parents.trim().split(" ").filter(Boolean), an, ae, at: Number(at), cn, ct: Number(ct), body: body.trim(), files });
        const pick = file && files.find((f) => f.short === file || f.path === file);
        if (pick) this.showDiff(pick, cx);
      } catch (e) { details.loading = false; details.error = String(e.message ?? e); }
      cx.notify();
    });
    cx.notify();
  }

  showDiff(file, cx) {
    const details = this.details, info = this.repoInfo[this.repoId];
    if (details.file === file.path) { details.file = null; details.rows = null; cx.notify(); return; }
    details.file = file.path; details.rows = [{ kind: "", text: "Loading diff…" }];
    cx.spawn(async (cx) => {
      const r = await git(info.root, ["diff-tree", "-p", "--root", "-m", "--first-parent", "--no-color", "--no-ext-diff", details.hash, "--", file.path]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (details.file !== file.path) return;
      const lines = r.code === 0 ? r.stdout.replace(/\n$/, "").split("\n") : [r.stderr];
      const first = lines.findIndex((l) => l.startsWith("@@"));
      details.rows = diffRows(first < 0 ? [file.binary ? "Binary file changed" : "No text diff"] : lines.slice(first, first + 1500));
      cx.notify();
    });
    cx.notify();
  }

  openDialog(dialog, extra) {
    const info = this.repoInfo[this.repoId];
    openOverlay({ mod: "vscode-history", kind: "dialog", width: 440, height: dialog === "branch" ? 210 : 200,
      props: { dialog, root: info.root, repo: this.repo().label, ...extra } });
  }

  openTerminal(c) {
    const info = this.repoInfo[this.repoId];
    run("pane.split", { direction: "down", argv: ["git", "-C", info.root, "show", "--stat", "-p", c.hash] });
  }

  // ---- drawing ----

  laneColor(j) {
    const t = theme(), colors = [t.ansi4, t.ansi5, t.ansi2, t.ansi3, t.ansi6, t.ansi1, t.ansi12, t.ansi13];
    return colors[j % colors.length];
  }

  // Strokes `segs` (lane column → drawing steps), one path per lane so each keeps its colour.
  // Coordinates are local to the cell; "100%" reaches its bottom whatever its height.
  paths(segs, width) {
    const out = [];
    for (const [j, draws] of segs) {
      const b = PathBuilder.stroke(1.6);
      for (const draw of draws) draw(b);
      out.push(window.paint_path(b.build(), this.laneColor(j)).absolute().top(0).left(0).w(width).h_full());
    }
    return out;
  }

  // One commit row's lanes: lines in from the rows above, out to its parents below, its dot.
  graphCell(c, t) {
    const x = (j) => PAD + j * LANE + LANE / 2, mid = ROW / 2, segs = new Map(), width = this.graphWidth();
    const seg = (j, draw) => { if (!segs.has(j)) segs.set(j, []); segs.get(j).push(draw); };
    const curve = (b, x1, y1, x2, y2) => {
      b.move_to(x1, y1);
      if (x1 === x2) b.line_to(x2, y2);
      else b.cubic_bezier_to(x2, y2, x1, (y1 + y2) / 2, x2, (y1 + y2) / 2);
    };
    const { col, hasChild, before, parentCols } = c.graph;
    before.forEach((h, j) => {
      if (h === null) return;
      if (h === c.hash) { if (j !== col || hasChild) seg(j, (b) => curve(b, x(j), 0, x(col), mid)); }
      else seg(j, (b) => curve(b, x(j), 0, x(j), ROW));
    });
    parentCols.forEach((pc) => seg(pc, (b) => curve(b, x(col), mid, x(pc), ROW)));
    const head = c.refs.some((r) => r.head || r.kind === "head"), color = this.laneColor(col);
    return div().relative().flex_none().w(width).h(ROW)
      .children(this.paths(segs, width))
      .child(div().absolute().top(mid - 4).left(x(col) - 4).size(8).rounded(4)
        .when(head, (d) => d.bg(t.background).border_2().border_color(color))
        .when(!head, (d) => d.bg(color)));
  }

  graphWidth() { return PAD * 2 + Math.min(this.width, 16) * LANE; }
  compact() { return (this.paneWidth ?? Infinity) < COMPACT; }

  badge(ref, t) {
    const color = ref.kind === "tag" ? t.muted : ref.kind === "remote" ? t.ansi5 : t.accent;
    return h_flex().flex_none().h(18).px(6).gap(4).items_center().rounded(4).text_size(11)
      .when(ref.kind === "local" || ref.kind === "head", (e) => e.bg(color).text_color(t.accent_foreground))
      .when(ref.kind === "remote" || ref.kind === "tag", (e) => e.border_1().border_color(color).text_color(color))
      .when(Boolean(ref.head), (e) => e.font_semibold())
      .child(ref.kind === "tag" ? `◇ ${ref.name}` : ref.name);
  }

  row(c, t) {
    const open = this.open === c.hash, merge = c.parents.length > 1;
    // A virtual list row: no handlers here, clicks arrive through on_item_click.
    return h_flex().id(`commit-${c.hash}`).h(ROW).flex_none().w_full().items_center()
      .when(open, (e) => e.bg(t.selected))
      .child(this.graphCell(c, t))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center().pr(12)
        .children(c.refs.map((r) => this.badge(r, t)))
        .child(div().min_w(0).truncate().text_color(merge ? t.dim : t.foreground).child(c.subject)))
      .when(!this.compact(), (e) => e
        .child(div().w(150).flex_none().truncate().text_color(t.muted).child(when(c.at)))
        .child(div().w(170).flex_none().truncate().text_color(t.muted).pr(10).child(c.author))
        .child(div().w(80).flex_none().text_color(t.dim).font_family(settings().font_family ?? "Menlo").child(c.hash.slice(0, 7))));
  }

  button(id, label, action, t, danger) {
    return div().id(id).h(26).px(10).flex().flex_none().items_center().rounded(6).text_size(12).cursor_pointer()
      .border_1().border_color(danger ? t.blocked : t.input).text_color(danger ? t.blocked : t.foreground)
      .hover((s) => s.bg(t.hover)).on_click(action).child(label);
  }

  detailsPanel(c, t) {
    const d = this.details;
    const info = this.repoInfo[this.repoId];
    const locals = c.refs.filter((r) => r.kind === "local" && !r.head);
    const mono = settings().font_family ?? "Menlo";
    const left = d.loading ? div().text_color(t.dim).child("Loading…") : d.error ? div().text_color(t.ansi1).child(d.error) : v_flex().gap(3).text_size(12)
      .child(h_flex().gap(6).child(div().text_color(t.dim).child("Commit")).child(div().font_family(mono).child(c.hash)))
      .child(h_flex().gap(6).child(div().text_color(t.dim).child(d.parents.length > 1 ? "Parents" : "Parent"))
        .children(d.parents.map((p) => div().id(`parent-${p}`).font_family(mono).text_color(t.accent).cursor_pointer()
          .on_click((_e, cx) => { const target = this.commits.find((x) => x.hash === p); if (target) this.toggle(target, cx); else copy(p, "parent hash"); })
          .child(p.slice(0, 10)))))
      .child(h_flex().gap(6).child(div().text_color(t.dim).child("Author")).child(div().child(`${d.an} <${d.ae}> · ${when(d.at)}`)))
      .when(d.cn !== d.an || d.ct !== d.at, (e) => e.child(h_flex().gap(6).child(div().text_color(t.dim).child("Committer")).child(div().child(`${d.cn} · ${when(d.ct)}`))))
      .child(div().pt(6).text_size(12.5).child(d.body))
      .child(h_flex().pt(8).gap(6).flex_wrap()
        .child(this.button(`copy-${c.hash}`, "Copy hash", () => copy(c.hash, "commit hash"), t))
        .child(this.button(`subject-${c.hash}`, "Copy subject", () => copy(c.subject, "subject"), t))
        .child(this.button(`term-${c.hash}`, "Open in terminal", () => this.openTerminal(c), t))
        .children(locals.map((r) => this.button(`co-${c.hash}-${r.name}`, `Checkout ${r.name}`, () => this.openDialog("checkout", { target: r.name, detached: false }), t)))
        .child(this.button(`cod-${c.hash}`, "Checkout commit", () => this.openDialog("checkout", { target: c.hash, detached: true, short: c.hash.slice(0, 7) }), t))
        .child(this.button(`br-${c.hash}`, "Create branch…", () => this.openDialog("branch", { hash: c.hash, short: c.hash.slice(0, 7) }), t)));
    const files = !d.files ? [] : d.files;
    const compact = this.compact();
    const right = v_flex().when(compact, (e) => e.w_full().pt(10).mt(8).border_t(1)).when(!compact, (e) => e.w(420).pl(12).border_l(1))
      .flex_none().gap(2).text_size(12).border_color(t.border)
      .child(div().pb(4).text_color(t.dim).child(this.scope === "folder" && info?.prefix ? info.prefix : "Changed files"))
      .children(files.map((f) => h_flex().id(`file-${c.hash}-${f.path}`).h(22).gap(6).px(6).items_center().rounded(5).cursor_pointer()
        .when(d.file === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.showDiff(f, cx))
        .child(div().flex_1().min_w(0).truncate().child(f.short))
        .when(f.add > 0, (e) => e.child(div().text_color(t.ansi2).child(`+${f.add}`)))
        .when(f.del > 0, (e) => e.child(div().text_color(t.ansi1).child(`−${f.del}`)))))
      .when(!d.loading && !files.length, (e) => e.child(div().text_color(t.dim).child("No file changes here")));
    const diff = d.rows ? v_flex().id(`diff-${c.hash}`).mt(8).h(Math.min(360, d.rows.length * 18 + 8)).overflow_y_scrollbar().rounded(6).border_1().border_color(t.border)
      .font_family(mono).text_size(11).children(d.rows.map((row, i) => this.diffRow(row, i, t))) : null;
    return v_flex().id("history-details").h("42%").flex_none().overflow_y_scrollbar().bg(t.surface).border_t(1).border_color(t.border).px(14).py(10)
      .child((compact ? v_flex() : h_flex()).items_start().relative()
        .child(div().when(!compact, (e) => e.flex_1()).w_full().min_w(0).pr(12).child(left)).child(right)
        .child(div().id("close-details").when(compact, (e) => e.absolute().top(0).right(0)).pl(10).cursor_pointer().text_color(t.muted).hover((s) => s.text_color(t.foreground)).tooltip("Close (or click the commit again)")
          .on_click((_e, cx) => { this.open = null; this.details = null; cx.notify(); }).child("✕")))
      .when(Boolean(diff), (e) => e.child(diff));
  }

  diffRow({ kind, number, text }, i, t) {
    if (kind === "@") return div().id(`d${i}`).w_full().px(10).h(18).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().id(`d${i}`).w_full().h(18).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(36).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  segmented(id, options, value, onPick, t) {
    return h_flex().flex_none().h(24).rounded(6).border_1().border_color(t.input).overflow_hidden().text_size(12)
      .children(options.map(([v, label]) => div().id(`${id}-${v}`).h_full().px(10).flex().items_center().cursor_pointer()
        .when(v === value, (e) => e.bg(t.selected).text_color(t.foreground)).when(v !== value, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => onPick(v, cx)).child(label)));
  }

  render(cx) {
    if (this.dialog) return this.renderDialog(cx);
    const t = theme();
    if (this.follow) this.followFocus(cx); // renders run on focus changes: catch moves to another repo
    const compact = this.compact(), tabbed = inTabStrip();
    if (shared(CHANGED) !== this.seen) { this.seen = shared(CHANGED); this.repoInfo = {}; this.load(cx); }
    const repo = this.repo(), info = this.repoInfo[this.repoId];
    const items = this.commits.map((c) => ({ key: c.hash, c }));
    if (this.more) items.push({ key: "more", more: true });
    const openCommit = this.details && this.commits.find((c) => c.hash === this.open);
    // Narrow, the controls wrap onto as many lines as they need instead of overflowing.
    const header = h_flex().min_h(40).py(compact ? 6 : 0).flex_wrap().flex_none().px(12).gap(compact ? 6 : 10).items_center().border_b(1).border_color(t.border).text_size(12)
      .when(!tabbed, (e) => e.child(div().font_semibold().text_size(13).child("History")))
      .when(this.p.repos.length > 1, (e) => e.child(div().text_color(t.dim).child("Repo")).child(this.segmented("repo", this.p.repos.map((r) => [r.id, r.label]), this.repoId, (v, cx) => this.set("repoId", v, cx), t)))
      .when(Boolean(info?.prefix), (e) => e.child(div().text_color(t.dim).child("Scope")).child(this.segmented("scope", [["folder", this.p.scopeLabel ?? "This folder"], ["repo", "Whole repo"]], this.scope, (v, cx) => this.set("scope", v, cx), t)))
      .child(this.segmented("remote", [[true, "Remote branches"], [false, "Local only"]], this.remote, (v, cx) => this.set("remote", v, cx), t))
      .child(div().flex_1())
      .child(div().text_color(t.dim).child(this.loading ? "Loading…" : `${this.commits.length}${this.more ? "+" : ""} commits`))
      .child(div().id("reload").px(6).cursor_pointer().text_color(t.muted).hover((s) => s.text_color(t.foreground)).tooltip("Re-read local git (no fetch)")
        .on_click((_e, cx) => { this.repoInfo = {}; this.load(cx); }).child("⟳"));
    const columns = h_flex().h(26).flex_none().items_center().border_b(1).border_color(t.border).text_size(11).font_semibold().text_color(t.dim)
      .child(div().w(this.graphWidth()).flex_none().pl(PAD).truncate().child(compact ? "" : "Graph"))
      .child(div().flex_1().child("Description"))
      .when(!compact, (e) => e
        .child(div().w(150).flex_none().child("Date"))
        .child(div().w(170).flex_none().child("Author"))
        .child(div().w(80).flex_none().child("Commit")));
    return v_flex().id("history").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12.5)
      .on_size_change((size, cx) => { if (size.width !== this.paneWidth) { this.paneWidth = size.width; cx.notify(); } })
      .child(header).child(columns)
      .when(Boolean(this.error), (e) => e.child(div().p(14).text_color(t.ansi1).child(this.error)))
      .when(!this.error && !this.loading && !this.commits.length, (e) => e.child(div().p(14).text_color(t.dim).child(`No commits in ${repo?.label ?? "this repo"}`)))
      .child(div().flex_1().min_h(0).relative()
        .child(uniform_list("history-rows", items.length, (i) => items[i].key, (range) => items.slice(range.start, range.end).map((it) => it.more
          ? div().id("more").h(ROW).w_full().flex().items_center().justify_center().text_color(t.accent).child(`Load ${PAGE} more`)
          : this.row(it.c, t)))
          .on_item_click((key, cx) => {
            if (key === "more") { this.limit += PAGE; this.load(cx); return; }
            const c = this.commits.find((x) => x.hash === key);
            if (c) this.toggle(c, cx);
          })
          .size_full())
        .child(Scrollbar.vertical("history-rows").viewport_from_layout().absolute().inset_0()))
      .when(Boolean(openCommit), (e) => e.child(this.detailsPanel(openCommit, t)));
  }

  // ---- dialog copy (checkout, create branch) ----

  initDialog(p, cx) {
    this.dialog = p; this.busy = false; this.error = null; this.handle = cx.focus_handle();
    if (p.dialog === "branch") {
      this.input = InputState.new({ placeholder: "new-branch-name" });
      this.input.on("submit", (_e, cx) => this.confirm(cx));
      this.input.focus();
      cx.timer.after(400, () => this.input.focus());
    } else this.handle.focus();
  }

  confirm(cx) {
    const p = this.dialog;
    if (this.busy) return;
    this.busy = true; this.error = null;
    cx.spawn(async (cx) => {
      try {
        if (p.dialog === "checkout") {
          // Checkout swaps the whole working tree, so any change anywhere in the repo blocks it.
          const dirty = await git(p.root, ["status", "--porcelain", "--untracked-files=no"]);
          if (dirty.stdout.trim()) throw new Error(`${p.repo} has uncommitted changes. Commit or stash them first.`);
          const r = await exec("git", p.detached ? ["checkout", "--detach", p.target] : ["switch", p.target], { cwd: p.root });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        } else {
          const name = this.input.value().trim();
          const ok = await exec("git", ["check-ref-format", "--branch", name], { cwd: p.root });
          if (!name || ok.code !== 0) throw new Error(`"${name}" is not a valid branch name`);
          const r = await exec("git", ["branch", name, p.hash], { cwd: p.root });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        setShared(CHANGED, Date.now());
        closeOverlay(p.overlay);
      } catch (e) { this.error = String(e.message ?? e); this.busy = false; cx.notify(); }
    });
    cx.notify();
  }

  renderDialog(cx) {
    const t = theme(), p = this.dialog;
    const title = p.dialog === "branch" ? `Create a branch at ${p.short}` : p.detached ? `Check out commit ${p.short}?` : `Switch to ${p.target}?`;
    const detail = p.dialog === "branch"
      ? `In the ${p.repo} repo. The branch is created only; your checkout stays where it is.`
      : `Changes the whole ${p.repo} checkout${p.detached ? " to a detached HEAD" : ""}. Every agent and terminal working in this repo sees the switch.`;
    const btn = (id, label, primary, action) => h_flex().id(id).h(30).px(14).items_center().rounded(7).cursor_pointer()
      .when(primary, (e) => e.bg(t.solid).text_color(t.solid_foreground)).when(!primary, (e) => e.border_1().border_color(t.input))
      .hover((s) => s.opacity(0.88)).on_click(action).child(label);
    return v_flex().id("history-dialog").track_focus(this.handle).size_full().p(18).gap(10).bg(t.popover).text_size(13).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); }
        else if (e.key === "enter" && p.dialog !== "branch") { this.confirm(cx); cx.stop_propagation(); }
      })
      .child(div().font_semibold().text_size(14).child(title))
      .child(div().text_color(t.muted).child(detail))
      .when(p.dialog === "branch", (e) => e.child(div().h(32).px(10).flex().items_center().rounded(7).border_1().border_color(t.accent)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12.5))))
      .when(Boolean(this.error), (e) => e.child(div().text_color(t.ansi1).text_size(12).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(btn("cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(btn("ok", this.busy ? "Working…" : p.dialog === "branch" ? "Create branch" : "Check out", true, (_e, cx) => this.confirm(cx))));
  }
}
