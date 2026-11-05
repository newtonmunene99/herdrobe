// What the Changes panel lists, as pure functions over git's output: the Staged and Changes groups
// of a section, and the rows of its folder tree. No herdr import, so lib/changes-model.test.js
// tests it with `node --test lib/`.
import { statusEntries, statusLetter } from "./git-read.js";

// Line counts for a path no numstat mentioned (untracked files are counted when previewed).
const ZERO = { add: 0, del: 0, binary: false };

// Splits `git status --porcelain=v1 -z --no-renames` output into the section's two groups.
// `prefix` is the section's folder inside the repo ("" for the whole repo); `stagedStats` and
// `changeStats` come from `git diff --cached --numstat` and `git diff --numstat`. A file staged
// and then edited again is in both groups, as in VS Code; a conflicted file only in Changes, as
// U. At most `limit` rows are kept (`limited` says so). Outside the section: `others` counts
// changed files, `stagedOutside` the ones staged, which a plain `git commit` would take along.
export function changeGroups(stdout, prefix, stagedStats, changeStats, limit) {
  const staged = [], changes = [];
  let others = 0, stagedOutside = 0, rows = 0;
  for (const e of statusEntries(stdout)) {
    const conflict = statusLetter(e.xy) === "U", isStaged = !conflict && e.x !== " " && e.x !== "?";
    if (!e.path.startsWith(prefix)) { others++; if (isStaged) stagedOutside++; continue; }
    const base = { path: e.path, short: e.path.slice(prefix.length) };
    const add = (list, row) => { rows++; if (list.length + (list === staged ? changes : staged).length < limit) list.push(row); };
    if (isStaged) add(staged, { ...base, group: "staged", status: statusLetter(`${e.x} `), fresh: false, ...(stagedStats[e.path] ?? ZERO) });
    if (conflict || e.y !== " ") {
      const status = conflict ? "U" : e.y === "?" ? "A" : statusLetter(` ${e.y}`);
      add(changes, { ...base, group: "changes", status, fresh: e.y === "?", ...(changeStats[e.path] ?? ZERO) });
    }
  }
  return { staged, changes, others, stagedOutside, limited: rows > limit };
}

// The rows to draw for one group's `files`: in "list" view one row per file; in "tree" view a
// row per folder (chains of single-child folders joined, "mods/vscode-changes") before its
// files, folders first, both by name. `folded` is a Set of folder ids (`${key}/${path}`) whose
// rows hide their contents. A folder row: { kind: "dir", id, name, path, depth, files } with
// `path` relative to the section and `files` every file under it; a file row: { kind: "file",
// f, depth, flat }.
export function changeRows(files, view, folded, key) {
  if (view !== "tree") return files.map((f) => ({ kind: "file", f, depth: 0, flat: true }));
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.short.split("/");
    parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(f);
  }
  const rows = [];
  walk(root, "", 0, rows, folded, key);
  return rows;
}

// Every file under tree `node`, depth first.
function allFiles(node) {
  return [...node.files, ...[...node.dirs.values()].flatMap(allFiles)];
}

// Adds `node`'s folder rows and file rows to `rows`, `path` being its folder ("" at the top).
function walk(node, path, depth, rows, folded, key) {
  for (const name of [...node.dirs.keys()].sort()) {
    let dir = node.dirs.get(name), label = name;
    // Join single-child chains so a deep path doesn't cost one row per level.
    while (dir.files.length === 0 && dir.dirs.size === 1) {
      const [next, child] = [...dir.dirs.entries()][0];
      label += `/${next}`; dir = child;
    }
    const dirPath = path ? `${path}/${label}` : label, id = `${key}/${dirPath}`;
    rows.push({ kind: "dir", id, name: label, path: dirPath, depth, files: allFiles(dir) });
    if (!folded.has(id)) walk(dir, dirPath, depth + 1, rows, folded, key);
  }
  const byName = (a, b) => a.short.split("/").pop().localeCompare(b.short.split("/").pop());
  for (const f of [...node.files].sort(byName)) rows.push({ kind: "file", f, depth, flat: false });
}
