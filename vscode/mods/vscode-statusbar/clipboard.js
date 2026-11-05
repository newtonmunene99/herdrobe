// Shared module lib/clipboard.js: every mod that imports it carries an identical copy, so change all
// copies together (in the source home, edit lib/clipboard.js and sync-lib.sh copies it on save).
import { exec, notify } from "herdr";

// Copies `text` to the clipboard and confirms with a toast titled `title` (default "Copied") that
// shows the text. It uses pbcopy, so it works on macOS only; elsewhere the toast says "Copy
// failed". The text goes in as $1, never through shell quoting.
export function copy(text, title) {
  exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text])
    .then((r) => notify(r.code === 0 ? { title: title ?? "Copied", body: text, timeout: 2000 } : { title: "Copy failed", body: r.stderr, level: "error" }))
    .catch((e) => notify({ title: "Copy failed", body: String(e), level: "error" }));
}
