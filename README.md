# Oxum Dev Dashboard

A terminal with a status strip above it. The strip tells you where each front-end project stands
(dev server, git, GitHub checks); every action it offers runs in a tab of that same terminal, so
nothing ever sends you to an external console.

![Dashboard](docs/screenshot.png)

## Install

```bash
npm install
npm run dev          # run from source
npm run dist         # build the installer and the portable build
```

`dist` produces three artifacts in `release/`, and the choice between them is a measured trade-off:

| Artifact | Install | Time to a window |
| --- | --- | --- |
| `…-1.0.0-x64.exe` (NSIS installer) | yes | ~10 s |
| `…-1.0.0-x64.zip` | no, unpack once | ~10 s |
| `…-1.0.0-portable.exe` | no, single file | **~26 s, every launch** |

The single-file portable target unpacks the whole ~100 MB app into `%TEMP%` at **every** start, and it
does not cache: measured at 30 s cold and 26,5 s on the next launch, against 9,6 s once unpacked. Prefer
the zip unless you really need one self-contained file, on a USB stick for instance.

All three carry the same `appId`, so they read the same settings in `AppData\Roaming`: the install-free
builds are there to avoid an install, not to be isolated. For the same reason the single-instance lock is
shared, and launching one while another runs focuses the window already open instead of starting a
second.

`dev` passes `--watch`, so a change to the **main process** restarts it instead of leaving a
hot-reloaded renderer talking to a stale main. Without it, the two drift apart the moment an IPC
contract changes, and the symptom is a button that quietly does nothing.

Windows only. No C++ build tools required: the pty ships as a prebuilt Node-API binary, which loads
in Electron unchanged.

## What each column means

The three projects are seeded on first launch as **Web**, **Admin** and **Design**. They are only a
starting point: `+ Projet` adds a folder, **double-clicking a project name renames it**, and
everything else is editable in the settings dialog.

The port is not shown in the list: the server pill already says `sert :4201` when it matters.

| Column | Reads |
| --- | --- |
| Serveur | The dev process phase, read from its own terminal output |
| Fichiers | Staged / modified / untracked, counted separately |
| Branche | Current branch, with `↑↓` divergence and a `local` badge when never pushed |
| Checks | Pull request check rollup, or why there is nothing to show |

### Server phases

Not a boolean, because the `start` scripts run `npm run lint` before serving and a two-state model
would report that healthy window as "down".

`arrêté` · `démarrage` · `lint` · `build` · `sert :port` · `watch` · `lint KO` · `build KO` · `crash`

Every one of them describes a process **the dashboard owns**. There used to be an `externe` state,
fed by a port probe that mapped listening ports back to repositories; it went away once every launch
went through the embedded terminal. It was a state nobody could act on, for a situation that had
stopped happening. The trade-off is explicit: if something outside still holds the port, the row says
`arrêté` and the action fails on "address already in use", visibly, in its own tab.

`watch` exists because **`design-system` is not a server**: its `start` runs `ng build --watch`, which
opens no port. Nothing about it can be observed from the outside, which is precisely why the
dashboard spawns it and reads its output.

### Checks verdicts

`pas poussée` (no upstream, so no pull request can exist) · `pas de PR` · `aucun check` ·
`en cours` · `OK n` · `KO n`

`aucun check` is deliberately distinct from `OK`: two real open pull requests returned an empty
rollup, and painting that green would be a lie.

## Actions

Actions are **configuration, per project**. Each one is a command line, a shell profile to run it in,
and a role; the buttons on a row are that list, in order. Nothing about `Run` or `Commit` is wired in
the code any more, they are only what a project ships with by default.

A **role** is what makes an action behave:

| Role | Owns the row's server state | Replaced by `Stop` while running | Tab closable |
|---|---|---|---|
| `server` | yes, its output is parsed for build markers | yes | only once stopped |
| `task` | no | no | always |

A project has **at most one `server` action**: a row holds a single server state, so two of them would
have two processes writing the same phase and the last one to print would win. Promoting an action
demotes the previous holder.

Defaults on a new project, and why each ships with the shell it does:

- **Run** → `npm run start` in **cmd**, because a pty does not resolve the `.cmd` shims that make a
  bare `npm` work. Disabled when a server is already running outside the dashboard.
- **Commit** → `commit` in **Git Bash**, because it is a shell **alias**: bash does not expand aliases
  in a non-interactive shell, so it is run with `-ic`. It is a full-screen prompt_toolkit TUI, which is
  the reason this app embeds a real pseudo-terminal rather than a log view.

The command is handed to the shell as a **single argument**, so `&&`, quotes and paths with spaces
survive. An unrecognised shell falls back to cmd's `/c` rather than guessing a flag.

Two buttons are not actions, because they open something instead of running a command: **PR** (the
pull request in your browser, disabled when there is none) and **`>_`** (a shell in the repository).

**Stop** kills the process tree with `taskkill /T`. A plain kill would only reach the `cmd.exe`
wrapper and leave `ng serve` holding the port. Deleting an action closes its tab for the same reason:
a running server with no button left to stop it would keep the port for good.

Closing the window asks for confirmation when the dashboard owns running servers, since they die
with it. Servers you started from a terminal are never touched.

## Settings

The gear in the top bar opens a dialog with two sections.

**Projects** are configuration, not code. Add, rename, repoint or remove them without rebuilding, and
edit their actions in place. Adding one means picking a folder: the type (`server` / `watch`) and the
port are **inferred from the repository's own `package.json`**, read through the `server` action's
command and following one level of `npm run` indirection so a delegating start script still reads
correctly. Both stay overridable, and leaving them blank means "keep following the manifest", so a
project whose start script changes needs no edit.

`Détecter les dépôts` scans the projects root and offers every folder with a runnable `start` script,
marking the ones already added. Validation runs as you type and blocks saving only on something
structurally broken (missing folder, two projects on the same repository, two `server` actions). A
repository without `.git`, a missing `package.json` or an action pointing at a script that does not
exist are warnings: each breaks one button at most, and a folder is a perfectly valid row.

Renaming changes the label only. The id stays derived from the folder, which is what stops a rename
from orphaning a running terminal.

**Terminal** holds the default profile, the font size (9 to 28 px, 14 by default, applied live to every
tab) and, per profile, the binary path, arguments and starting directory. Editing a path marks the
profile as custom and it then wins over detection.

Everything still lives in `settings.json`, so hand-editing remains possible; the dialog and the file
go through the same validation.

## The terminal

The terminal is the centre of the window, not a drawer: it takes every pixel the projects strip does
not need. Project output and free-form shells share one tab strip, and dragging the separator resizes
the strip above (its height is remembered).

- **`+`** opens the default profile; the **caret** next to it lists the others.
- Profiles are **probed on disk**, so the menu only offers shells that exist. On a machine with
  Git Bash, PowerShell 5.1, cmd and WSL, those four appear and PowerShell 7 does not.
- **Click a project row** to open a shell sitting in that repository, or to come back to the one
  already open there. It reuses rather than stacking, because a whole row is far too easy to click by
  accident to be allowed to pile up terminals. Clicks on a button, a field or the project name are left
  to those controls. **`>_`** does the same thing and stays for the keyboard, a row not being focusable.
  A second shell in the same repository comes from `+`.
- **Double-click a tab name to rename it.** Enter commits, Escape cancels. A renamed tab keeps its
  name even if you relaunch the same command.
- **Drag a tab to reorder the strip.** The marker on the target tab shows which side the drop lands on.
  The order is held by the main process alongside the sessions, so a hot reload does not shuffle it
  back.
- A tab can be closed as soon as it has nothing left to do: shells always, a `task` action always, a
  `server` action once it has stopped. A running server has no close button because `Stop` is the
  deliberate way to end it. A green dot marks a live process.

Git Bash is launched with `-i`, which means **your aliases work**: typing `commit` in a shell tab
behaves exactly as it does in Windows Terminal.

Profiles live in `settings.json` under `shellProfiles` and are merged over the detected ones **by
id**, so pointing at a Git Bash installed somewhere unusual takes three lines:

```json
{
  "defaultShellProfileId": "git-bash",
  "shellProfiles": [
    { "id": "git-bash", "label": "Git Bash", "file": "D:/Git/bin/bash.exe", "args": ["-i"], "cwd": "~/oxum" }
  ]
}
```

`cwd` accepts a leading `~`. A malformed entry is dropped rather than reaching `pty.spawn`.

## Facts this app is built on

Verified rather than assumed, and each one changed the design:

- **A port does not identify a checkout.** `web-app` served on 4200 while a
  `web-app-tec1455` worktree served on 4202, which is why a row is keyed on its repository
  path and never on a port.
- **ANSI must be stripped with the escape anchor.** A bracket pattern without it eats `[ERROR]`
  itself, destroying the markers the parser exists to find.
- **A hot-reloaded renderer will happily talk to a stale main.** `electron-vite dev` only watches the
  main process with `--watch`; without it, changing an IPC contract mid-session leaves half the app on
  the old shape and the symptom is a button that quietly does nothing.

## Architecture

```
src/shared/contracts.ts        every main <-> renderer type: the single source of truth
src/main/projects/             registry, inference, output-parser, project-monitor
src/main/git/ github/          one service per source, each on its own poll cadence
src/main/terminal/             shell profiles and the pty session manager
src/main/window.ts             the dashboard window + the page loader both windows share
src/main/settings-window.ts    the settings window, independent and bounds-remembering
src/renderer/index.html        the dashboard
src/renderer/settings.html     the settings window, a second renderer over the same bridge
src/renderer/ui/presenters.ts  domain state -> label + tone, pure and unit tested
src/renderer/ui/               project-table, terminal-pane, settings-form
```

Two windows, one preload: the settings window holds no privilege the dashboard lacks. What it writes
goes through the main process, which broadcasts the new settings so the dashboard rebuilds its table
and its new-tab menu. Settings are **not** a modal dialog: as an overlay it closed whenever a text
selection was released outside the panel, and it hid the very table it configures.

The renderer is sandboxed: `contextIsolation`, no `nodeIntegration`, a locked-down CSP, and no
remote content. It reaches nothing except the channels declared in `contracts.ts`. All text goes
through `textContent`, since branch names, error messages and pull request titles come from outside.

Running from source uses a separate data directory (`…\oxum-dev-dashboard-dev`), so a dev run never
fights an installed build over settings or the single-instance lock.

## Tests

```bash
npm test         # Vitest on the pure units
npm run lint
npm run typecheck
```

Covered where the risk actually is: the porcelain and ahead/behind parsers, the ANSI/marker parsing
against real Angular output, the action list (migration, one-server invariant, unique ids), the
shell-per-action mapping, and the resizer geometry, whose direction had inverted once and is now
locked by a test rather than by eye.
