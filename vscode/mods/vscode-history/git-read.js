// Shared module lib/git-read.js: every mod that imports it carries an identical copy, so change all
// copies together (in the source home, edit lib/git-read.js and sync-lib.sh copies it on save).
// Reading git without writing to it, shared by Files, Changes and History. Pure: the mods run git
// themselves (with READ in front of every read) and pass the output here.

// Flags for every read-only git call. They write nothing under .git (no optional locks, no
// fsmonitor cookie, no index refresh), so a mod's folder watch never wakes itself up, and a
// read never fights an agent's own git for the index lock.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

// How long a git call may run, for exec's `timeout`. exec stops a command after 30s by default,
// and in a very large repo `status --untracked-files=all` or `log --topo-order` can take longer.
// A stopped write can leave .git/index.lock behind, so writes get the same room.
export const GIT_TIMEOUT = 120_000;

// One letter for a porcelain XY status code: U conflicted (including AA and DD), D deleted, A added
// or untracked, M anything else that changed. Conflicts come first so a both-added file reads U.
export function statusLetter(xy) {
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "U";
  if (xy.includes("D")) return "D";
  if (xy === "??" || xy.includes("A")) return "A";
  return "M";
}

// The entries of `git status --porcelain=v1 -z --no-renames`: { xy, x, y, path }, x the index
// (staged) letter and y the worktree one (" " for none, "?" for untracked). Without --no-renames
// a rename's old path would follow as a field of its own and be read as an entry.
export function statusEntries(stdout) {
  return stdout.split("\0").filter(Boolean).map((e) => ({ xy: e.slice(0, 2), x: e[0], y: e[1], path: e.slice(3) }));
}

// Added and deleted lines per path, from `git diff --numstat -z` output (without renames):
// { path: { add, del, binary } }, summed when a path appears more than once.
export function numstatEntries(stdout) {
  const stats = {};
  for (const entry of stdout.split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (!parts.length) continue;
    const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
    stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
  }
  return stats;
}

// Numbers each line of a unified diff once: { kind: "@" | "-" | "+" | " " | "", number?, text }.
// Hunk headers reset the counters; "-" lines carry the old line number, "+" and context lines the
// new one. Empty lines become " " so a row never collapses.
export function diffRows(lines) {
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
