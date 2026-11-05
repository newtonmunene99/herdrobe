// The discard confirmation: a second copy of vscode-changes opened as a dialog, as History opens
// its checkout and branch dialogs. It runs the git writes itself, then sets CHANGED so every
// Changes panel rescans at once (a remote space has no folder watch to notice).
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, openOverlay, closeOverlay, setShared } from "herdr";

// Shared key set (to Date.now()) after a discard; a panel rescans when it differs from the last
// value it saw.
export const CHANGED = "vscode-changes.changed";

// Asks before discarding `files` (Changes-group rows of one section) in repo `repo` on machine
// `on`. `title` is the question ("Discard changes to main.js?"). Conflicted files
// are left out; with nothing left there is nothing to ask.
export function askDiscard({ title, repo, on, files }) {
  const tracked = files.filter((f) => !f.fresh && f.status !== "U").map((f) => f.path);
  const untracked = files.filter((f) => f.fresh).map((f) => f.path);
  if (!tracked.length && !untracked.length) return;
  openOverlay({ mod: "vscode-changes", kind: "dialog", width: 440, height: 180, props: { dialog: "discard", title, repo, on, tracked, untracked } });
}

// What a discard of `p` does, in words: "2 files reverted, 1 untracked file deleted".
function summary(p) {
  const n = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  return [p.tracked.length && `${n(p.tracked.length, "file")} reverted`, p.untracked.length && `${n(p.untracked.length, "untracked file")} deleted`]
    .filter(Boolean).join(", ");
}

// The dialog's state on `view` (the dialog copy): its props, busy flag and last error.
export function initDiscard(view, p, cx) {
  view.dialog = p; view.busy = false; view.error = null; view.handle = cx.focus_handle();
  view.handle.focus();
}

// Reverts the tracked files to what is staged (`git restore`, so a staged part stays staged) and
// deletes the untracked ones (`git clean -f`, only the files listed). On success it sets CHANGED
// and closes; on failure it shows git's error and stays open.
function confirm(view, cx) {
  const p = view.dialog;
  if (view.busy) return;
  view.busy = true; view.error = null;
  cx.spawn(async (cx) => {
    try {
      const steps = [p.tracked.length && ["restore", "--", ...p.tracked], p.untracked.length && ["clean", "-f", "-q", "--", ...p.untracked]].filter(Boolean);
      for (const args of steps) {
        const r = await exec("git", args, { cwd: p.repo, on: p.on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
      }
      setShared(CHANGED, Date.now());
      closeOverlay(p.overlay);
    } catch (e) { view.error = String(e.message ?? e); view.busy = false; cx.notify(); }
  });
  cx.notify();
}

// Draws the dialog: what goes, that it can't be undone, Cancel and Discard. Enter discards,
// Escape cancels.
export function renderDiscard(view) {
  const t = theme(), p = view.dialog;
  const btn = (id, label, primary, action) => h_flex().id(id).h(30).px(14).items_center().rounded(7).cursor_pointer()
    .when(primary, (e) => e.bg(t.ansi1).text_color(t.background)).when(!primary, (e) => e.border_1().border_color(t.input))
    .hover((s) => s.opacity(0.88)).on_click(action).child(label);
  return v_flex().id("discard-dialog").track_focus(view.handle).size_full().p(18).gap(10).bg(t.popover).text_size(13).text_color(t.foreground)
    .on_key_down((e, cx) => {
      if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); }
      else if (e.key === "enter") { confirm(view, cx); cx.stop_propagation(); }
    })
    .child(div().font_semibold().text_size(14).truncate().child(p.title))
    .child(div().text_color(t.muted).child(`${summary(p)}. This can't be undone.`))
    .when(Boolean(view.error), (e) => e.child(div().text_color(t.ansi1).text_size(12).child(view.error)))
    .child(div().flex_1())
    .child(h_flex().gap(8).justify_end()
      .child(btn("cancel", "Cancel", false, () => closeOverlay(p.overlay)))
      .child(btn("ok", view.busy ? "Discarding…" : "Discard", true, (_e, cx) => confirm(view, cx))));
}
