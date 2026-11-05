// Shared module: edit lib/layout.js in ~/.config/herdr-app; sync-lib.sh copies it into every mod
// that imports it.
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

// Whether `mod` is one of the tabs of the right sidebar's stack ("secondary-body"). Its built-in
// tab strip already names each tab, so a mod shown there drops its own title.
export function inTabStrip(tree, mod) {
  return (findNode(tree, "secondary-body")?.children ?? []).some((c) => c.content?.mod === mod);
}
