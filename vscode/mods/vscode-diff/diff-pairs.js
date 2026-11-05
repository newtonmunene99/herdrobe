// Shared module lib/diff-pairs.js: every mod that imports it carries an identical copy, so change all
// copies together (in the source home, edit lib/diff-pairs.js and sync-lib.sh copies it on save).
// Turns a unified diff into side-by-side rows for vscode-diff. Pure; tests in lib/diff-pairs.test.js.
//
// A row is { kind: "hunk", text } (an "@@ … @@" line) or { kind: "pair", left, right }, where a
// side is { n, text, type } (line number, text, " " | "-" | "+") or null for an empty cell.

// Rows for the unified diff `lines` (from the first "@@" on). Context lines sit on both sides. In
// each run of removed lines followed by added ones, the i-th removed line faces the i-th added
// one, and leftovers face an empty cell, as in VS Code's side-by-side view. "\ No newline at end
// of file" markers are dropped.
export function pairRows(lines) {
  const rows = [];
  let old = 0, next = 0, removed = [], added = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) rows.push({ kind: "pair", left: removed[i] ?? null, right: added[i] ?? null });
    removed = []; added = [];
  };
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) { flush(); old = +hunk[1]; next = +hunk[2]; rows.push({ kind: "hunk", text: line }); continue; }
    const type = line[0], text = line.slice(1);
    if (type === "-") removed.push({ n: old++, text, type });
    else if (type === "+") added.push({ n: next++, text, type });
    else if (type === " " || line === "") { flush(); rows.push({ kind: "pair", left: { n: old++, text, type: " " }, right: { n: next++, text, type: " " } }); }
  }
  flush();
  return rows;
}

// Rows for a file that is all new (an untracked file): every line on the right, the left empty.
export function addedRows(text) {
  return text.replace(/\n$/, "").split("\n").map((line, i) => ({ kind: "pair", left: null, right: { n: i + 1, text: line, type: "+" } }));
}

// How many lines `rows` add and remove: { add, del }.
export function rowCounts(rows) {
  let add = 0, del = 0;
  for (const r of rows) {
    if (r.kind !== "pair") continue;
    if (r.left?.type === "-") del++;
    if (r.right?.type === "+") add++;
  }
  return { add, del };
}
