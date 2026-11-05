// Shared module lib/layout.js: every mod that imports it carries an identical copy, so change all
// copies together (in the source home, edit lib/layout.js and sync-lib.sh copies it on save).
// Questions about Herdr's layout tree (what layout() from "herdr" returns), asked by several mods.
// Pure: callers pass the tree, so this file never imports herdr. The node ids asked about
// (sidebar, secondary, sidebar-body, secondary-body and the views inside them) are defined in
// layouts/vscode.json and layouts/vscode-inbox.json; renaming one there means renaming it in the
// mods that ask for it.

// The node with this id under `node`, searched depth first, or null.
export function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

// Whether any block under `node` (its children or floating blocks, at any depth) shows `mod`.
export function hasMod(node, mod) {
  if (node?.content?.mod === mod) return true;
  return [...(node?.children ?? []), ...(node?.floating ?? [])].some((c) => hasMod(c, mod));
}

// Whether `mod` is one of the tabs of the right sidebar's stack ("secondary-body"). Its built-in
// tab strip already names each tab, so a mod shown there drops its own title.
export function inTabStrip(tree, mod) {
  return (findNode(tree, "secondary-body")?.children ?? []).some((c) => c.content?.mod === mod);
}
