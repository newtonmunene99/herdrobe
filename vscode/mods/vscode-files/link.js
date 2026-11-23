// Ctrl/Cmd-clicked file paths in terminals open in ttt, at the line when the click carried one
// ("main.go:42:7"), as the Files panel's clicks do. The layout root's "link_handlers" turns this on.
// Anything ttt shouldn't take (URLs, folders, binary files, paths on another machine, or no ttt
// installed) is passed on, so Herdr's own opener handles it.
import { linkTarget } from "./link-target.js";
import { openInTtt, canOpen } from "./ttt.js";

/** @type {import("herdr").HandleLink} */
export async function handleLink(click) {
  const target = linkTarget(click);
  if (!target || !(await canOpen(target.path))) return "pass";
  await openInTtt(target.arg, { tab: click.source.tab, pane: click.source.pane });
  return "handled";
}
