// Shared module lib/diff-open.js: every mod that imports it carries an identical copy, so change all
// copies together (in the source home, edit lib/diff-open.js and sync-lib.sh copies it on save).
// Opens a file's diff in vscode-diff's preview: the space's Diff tab, or a preview pane split
// beside a given pane (History when it is itself a tab). The next open replaces what the preview
// shows instead of opening another, as VS Code's preview editor does.
//
// A request says what to diff: { repo, on, path, kind, hash?, short? } with `repo` the repo root,
// `on` its machine (null here), `path` repo-relative, and kind "unstaged" (index → working tree),
// "staged" (HEAD → index), "untracked" (a new file) or "commit" (`hash` against its first parent).
import { spaces, panes, shared, setShared, run } from "herdr";

// Shared key: key → { pane, tab, request, seq }, one entry per preview. A key is
// "space:<id>" for a space's Diff tab or "pane:<id>" for a preview split beside that pane; the
// viewer gets its key in props, records its own pane and tab, and shows `request`, reloading
// when `seq` changes. Per screen: another screen's preview starts empty.
export const PREVIEW = "vscode-diff.preview";

// The tab name for a request: the file name and what it shows.
export function diffName(req) {
  const file = req.path.split("/").pop();
  const what = { staged: "staged", unstaged: "working tree", untracked: "untracked" }[req.kind];
  return req.kind === "commit" ? `${file} @ ${req.short ?? req.hash.slice(0, 7)}` : `${file} (${what})`;
}

// Whether the preview `entry` still has its vscode-diff pane on screen.
const alive = (entry) => Boolean(entry?.pane) && panes().some((p) => p.pane === entry.pane && p.mod === "vscode-diff");

// Shows `request` in the preview: the active space's Diff tab, or, with `beside` (a pane id), a
// preview pane split to that pane's right. Reuses the preview while its pane exists, else opens a
// new one (tab.new or pane.split). Entries whose pane has gone are dropped on the way.
export function openDiff(request, { beside } = {}) {
  const space = spaces().find((s) => s.active);
  if (!space) return;
  const key = beside ? `pane:${beside}` : `space:${space.id}`, all = liveEntries(key);
  const entry = alive(all[key]) ? all[key] : null;
  setShared(PREVIEW, { ...all, [key]: { pane: entry?.pane ?? null, tab: entry?.tab ?? null, request, seq: (all[key]?.seq ?? 0) + 1 } });
  const name = diffName(request), props = { preview: true, key };
  if (entry) { if (!beside) { run("tab.select", { id: entry.tab }); run("tab.rename", { id: entry.tab, name }); } return; }
  if (beside) run("pane.split", { pane: beside, direction: "right", mod: "vscode-diff", props });
  else run("tab.new", { space: space.id, mod: "vscode-diff", props, name });
}

// The preview entries worth keeping: live ones, ones still opening (no pane recorded yet), and
// `key`'s own whatever its state.
function liveEntries(key) {
  return Object.fromEntries(Object.entries(shared(PREVIEW) ?? {}).filter(([k, e]) => k === key || !e.pane || alive(e)));
}
