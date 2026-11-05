// Shared module: edit lib/clipboard.js in ~/.config/herdr-app; sync-lib.sh copies it into every
// mod that imports it.
import { exec, notify } from "herdr";

// Copies `text` to the clipboard and confirms with a toast titled `title` (default "Copied") that
// shows the text. It uses pbcopy, so it works on macOS only; elsewhere the toast says "Copy
// failed". The text goes in as $1, never through shell quoting.
export function copy(text, title) {
  exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text])
    .then((r) => notify(r.code === 0 ? { title: title ?? "Copied", body: text, timeout: 2000 } : { title: "Copy failed", body: r.stderr, level: "error" }))
    .catch((e) => notify({ title: "Copy failed", body: String(e), level: "error" }));
}
