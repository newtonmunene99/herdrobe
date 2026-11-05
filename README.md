# herdrobe

A wardrobe of layouts for the [Herdr](https://herdr.dev) app. Each folder is one outfit: a layout
with the mods, themes and keys it needs, laid out like `~/.config/herdr-app`, plus a `RECIPE.md`
an agent can rebuild it from.

| Layout | |
|---|---|
| [**VS Code**](vscode/) | Two layouts sharing one set of mods. **VS Code**: activity bar, sidebar for spaces, agents, files and changes, editor tabs, Git Graph history, status bar. **VS Code · Inbox**: agents sorted into Needs you, Finished, Working and Settled, with Changes and History in a right sidebar |

## Install one

Paste this to any coding agent on the machine with Herdr, with the layout's folder:

```
Run `herdr-app --skill` and read the guide it points to, then add this layout: github.com/newtonmunene99/herdrobe/tree/main/vscode
```

`herdr-app --skill` is Herdr's manual for agents; it points them to the guide that says how to
install a layout safely.

Each folder's README has the manual steps, what it needs and what it runs.

## License

Apache 2.0, see [LICENSE](LICENSE). Some mods began as copies of Herdr's own mods; each folder's
`NOTICE` says which.
