# Projects

One row per watched repository. `+ Project` adds a folder; double-click a name to rename it; drag a
row to reorder the table (the order is kept everywhere: settings, new-tab menu, servers window).

| Column | Shows |
| --- | --- |
| Server | the dev server's phase, read from its own output |
| Files | staged, modified and untracked files, counted apart |
| Branch | the current branch, `↑↓` against its remote, `local` when never pushed |
| Checks | the pull request's checks, or why there is nothing to show |
| Workflows | whether CI is running on the project |

## Server phases

`stopped` · `starting` · `lint` · `build` · `serving :port` · `watch` · `lint failed` · `build failed` · `crashed`

`watch` is a library built with `--watch`: it opens no port, and the phase comes from its output.
A server started outside the app is not seen: the row says `stopped`, and starting it fails on
"address already in use" in its own tab.

## Checks

`not pushed` · `no PR` · `no checks` · `en cours` · `OK n` · `KO n`. `no checks` is not green: the
pull request exists and nothing ran on it.

## Actions

The buttons of a row are its actions, set per project in the settings. Each one is a command, the
shell it runs in, and a role:

- **server**: owns the row's server phase; its button becomes **Stop** while it runs. A project has
  at most one.
- **task**: anything else, run in its own tab.

A new project gets **Run** (`npm run start`, a server). Clicking Run on a running server restarts it,
waiting for the port to be released. **Stop** ends the whole process tree, so `ng serve` does not keep
the port. The **PR** button opens the pull request in the browser, and **`>_`** a shell in the
repository.

The folder icon opens the repository in Explorer.

Closing the window asks first when servers started by the app are still running: they stop with it.
