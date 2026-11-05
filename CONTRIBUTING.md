# Contributing

Thanks for helping dress the herd. Fixes, new layouts and better recipes are all welcome.

## How this repo is laid out

Each top-level folder is one layout, shaped like `~/.config/herdr-app` so an agent can install
it by copying:

```
<layout>/
  layouts/<layout>.json, <layout>.svg   the window, and the picture Settings shows
  mods/<layout>-*/                      its panels
  themes/<layout>-*.json                its colors (optional)
  keys.json                             only a "layout:<layout>" section (optional)
  RECIPE.md                             the brief an agent can rebuild it from
  README.md, preview.png                for people
  NOTICE                                when anything started as someone else's code
```

## Trying a change

Herdr reloads its home folder live, so test there, not in your clone:

1. Copy the layout's `layouts/`, `mods/` and `themes/` files into `~/.config/herdr-app/`.
   If you already have files with those names, back them up first.
2. Switch to it: `herdr-app do layout.switch --name <layout>`.
3. Edit the copies in `~/.config/herdr-app`, watch the window change, then copy your edits back
   into your clone.
4. Before opening a PR:

   ```sh
   for m in ~/.config/herdr-app/mods/<layout>-*; do herdr-app check "$m"; done
   herdr-app status    # "errors": [] means every file loaded
   oxlint              # in your clone's root: no errors
   ```

   [oxlint](https://oxc.rs) (`brew install oxlint`) reads `.oxlintrc.json`: a function may have
   at most 15 independent paths (a whole `switch` counts once) and nest at most 4 blocks deep.
   Long functions, more than 6 parameters and deeply nested callbacks are warnings. Running it
   in `~/.config/herdr-app` finds no config and checks nothing, so run it in the clone, or there
   with `oxlint -c <clone>/.oxlintrc.json mods/<layout>-*`. If a function genuinely needs to
   branch more (a flat dispatch table, say), disable the rule on that line with a reason:
   `// eslint-disable-next-line complexity -- one branch per command`.

Don't commit `*.d.ts` or `jsconfig.json`: Herdr writes them into every mod folder.

## What a good PR has

- **One change.** A fix, a feature or a new layout, not all three.
- **The recipe kept true.** If behaviour, sizes, colors or keys change, update `RECIPE.md` to
  match. It describes what the files do, never what they might do.
- **A screenshot** for anything visible: `herdr-app shot` saves the window as a PNG. Check it for
  space names, agent names and terminal text you don't want public.
- **Agent statuses covered.** If you touch anything that shows agents, check working, blocked,
  done and idle.

## Adding a layout

- Name every mod and theme after the layout (`zed-tabs`, `zed-dark`), so installs don't clash
  and the folder copies cleanly.
- Write `RECIPE.md` in the order Herdr's own guide asks for: what you see, how it behaves,
  built from, watch out, done when. The `vscode` recipe is an example.
- If a mod started as a copy of one of Herdr's (`herdr-app do mod.clone …`), keep its
  `cloned_from` line and add a `NOTICE` naming it. Herdr is Apache 2.0.
- Say in the README which programs the mods run and whether anything reaches the network.
- Add the layout to the table in the top-level README.

## Code style

Mods are plain JavaScript on Herdr's gpui-kit; the generated `herdr.d.ts` and `gpui-kit.d.ts` in
any mod folder are the API reference. Use `theme()` colors rather than hex, animate with
`.frames`, `.spin` or `.loop` rather than timers, and keep comments about *why*.

## License

By contributing you agree your work is licensed under Apache 2.0, like the rest of the repo.
