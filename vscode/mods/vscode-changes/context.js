// Workspace context for the vscode mods: given a folder, what extra structure to show. This
// copy knows no particular workspace layout, so every folder is shown as itself. A personal
// copy can return extra folder roots, History repos, a status bar badge or a space name; see
// the shape below. Herdr mods can't import outside their own folder: vscode-files,
// vscode-changes, vscode-statusbar and vscode-history each carry an identical copy.
//
// contextFor(path) -> null, or {
//   title:     header text for the folder (Files)
//   roots:     [{ id, label, sub, dir, optional }] folders shown as sections (Files, Changes);
//              Changes lists and commits only paths under each
//   history:   { label, scopeLabel, repos: [{ id, label, dir, tagPrefix }] } for History
//   badge:     { mark, text, tooltip, copy } for the status bar (mark in the accent colour;
//              click copies `copy` and says `copied`)
//   spaceName: a name for a space whose terminals sit here (the status bar names unnamed spaces)
// }

export function contextFor(_path) {
  return null;
}

// Opens the History tab for `props`, or selects the one already open for the same label in
// the active space. `run` and `spaces` are the herdr module's, passed in so this file stays
// free of herdr imports.
export function openHistory(run, spaces, props) {
  const name = `History · ${props.label}`;
  const tab = spaces().find((s) => s.active)?.tabs.find((t) => t.name === name);
  if (tab) run("tab.select", { id: tab.id });
  else run("tab.new", { name, mod: "vscode-history", props });
}
