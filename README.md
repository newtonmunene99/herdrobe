# herdrobe

Ready-made layouts for the [Herdr](https://herdr.dev) app: pick one, let your coding agent install
it, and switch to it with a key.

## About

Herdr draws its whole window from files: layouts, mods (small JavaScript panels), themes and keys
in `~/.config/herdr-app`. That makes it easy to reshape, but a complete look is many files that
have to fit together. herdrobe is a wardrobe of those complete looks. Each folder is one outfit,
laid out exactly like `~/.config/herdr-app`, so installing it is copying files across.

Every outfit is for people who already run Herdr, usually with several coding agents at once.
Each one is self-contained: no build step, no `package.json`, nothing to install beyond the
programs its README lists. It never replaces Herdr's own layouts, so switching back is always one
key away. Each folder also carries a `RECIPE.md`, a written brief precise enough for an agent to
rebuild the outfit from scratch on a newer Herdr if the files ever stop fitting.

| Layout | |
|---|---|
| [**VS Code**](vscode/) | Two layouts sharing one set of mods. **VS Code**: activity bar, sidebar for spaces, agents, files and changes, editor tabs, Git Graph history, status bar. **VS Code · Inbox**: agents sorted into Needs you, Finished, Working and Settled, with Changes and History in a right sidebar |

## Installation

Paste this to any coding agent on the machine with Herdr, with the layout's folder:

```
Run `herdr-app --skill` and read the guide it points to, then add this layout: github.com/newtonmunene99/herdrobe/tree/main/vscode
```

`herdr-app --skill` is Herdr's manual for agents; it points them to the guide that says how to
install a layout safely: read everything first, never overwrite your files, merge the keys, and
check each mod. Each folder's README has the manual steps, what it needs and what it runs.

## Usage

- **Switch layouts** with `ctrl-shift-l` (`cmd-shift-l` in some layouts), or pick one in
  Settings → Look. Herdr's own layouts stay installed, so you can always switch back.
- **Update** by having your agent overwrite your copies with the folder's latest files. Herdr
  never updates layouts or mods from others by itself. Your `keys.json` stays yours.
- **Remove** a layout by deleting its files from `~/.config/herdr-app` (the folder's README lists
  them) and its `layout:<name>` sections from `keys.json`.
- **If something breaks**, `ctrl-alt-shift-escape` always resets Herdr to its default layout, and
  `herdr-app status` lists any file or mod that failed to load.

## Contributing

Fixes, new layouts and better recipes are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). To
report a security problem privately, see [SECURITY.md](SECURITY.md).

## License

Apache 2.0, see [LICENSE](LICENSE). Some mods began as copies of Herdr's own mods; each folder's
`NOTICE` says which.
