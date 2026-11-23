// Shared module lib/link-target.js: every mod that imports it carries an identical copy, so change
// all copies together (in the source home, edit lib/link-target.js and sync-lib.sh copies it on save).
// Turns a Ctrl/Cmd-clicked terminal link (herdr's LinkClick) into what to hand ttt: the file,
// with ":line[:col]" when the click carried one. Pure: never imports herdr, so node can test it.

// Extensions ttt would show as noise; clicks on these go to the next handler (Herdr's opener).
const BINARY = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "tiff", "heic", "avif", "pdf",
  "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "tar", "dmg", "pkg", "iso",
  "mp3", "mp4", "m4a", "mov", "mkv", "webm", "wav", "flac", "ogg",
  "woff", "woff2", "ttf", "otf", "so", "dylib", "dll", "exe", "a", "o", "class", "jar", "wasm",
  "sqlite", "db",
]);

// A position at the end of a path as compilers and test runners print it: "f.go:42", "f.go:42:7",
// "f.go:42:7:" (a trailing colon before the message), "f.cs(42,7)" or "f.cs(42)".
const COLONS = /:(\d+)(?::(\d+))?:?$/;
const PARENS = /\((\d+)(?:,\s*(\d+))?\)$/;

// The { line, col } at the end of text and the text without it; line and col are null when absent.
function splitPosition(text) {
  const m = COLONS.exec(text) ?? PARENS.exec(text);
  if (!m) return { rest: text, line: null, col: null };
  return { rest: text.slice(0, m.index), line: Number(m[1]), col: m[2] ? Number(m[2]) : null };
}

// The lowercase extension of path's last segment, "" when it has none.
function extension(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

// What to open for click: { path, arg } where arg is "path[:line[:col]]" for ttt, or null when
// ttt shouldn't take it (a URL, a remote or unresolved path, a binary file). Herdr may or may not
// have already cut the position off link.path, so it is taken from the path first, then link.raw.
export function linkTarget(click) {
  const link = click?.link;
  if (link?.kind !== "file" || !link.path || click.source?.machine) return null;
  const own = splitPosition(link.path);
  const path = own.rest;
  if (!path.startsWith("/") || BINARY.has(extension(path))) return null;
  const pos = own.line != null ? own : splitPosition(link.raw ?? "");
  if (pos.line == null) return { path, arg: path };
  return { path, arg: pos.col != null ? `${path}:${pos.line}:${pos.col}` : `${path}:${pos.line}` };
}
