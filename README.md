# Oxum Dev Dashboard

One window telling you the state of your front-end projects: dev servers, git, GitHub checks, and
local Claude Code sessions. Plus an embedded terminal, so acting on what you see does not mean
leaving the window.

![Dashboard](docs/screenshot.png)

## Install

```bash
npm install
npm run dev          # run from source
npm run dist         # build the installer
```

Windows only. No C++ build tools required: the pty ships as a prebuilt Node-API binary, which loads
in Electron unchanged.

## What each column means

| Column | Reads |
| --- | --- |
| Serveur | The dev process phase, from the terminal output plus a port probe |
| Fichiers | Staged / modified / untracked, counted separately |
| Branche | Current branch, with `↑↓` divergence and a `local` badge when never pushed |
| Checks | Pull request check rollup, or why there is nothing to show |

### Server phases

Not a boolean, because the `start` scripts run `npm run lint` before serving and a two-state model
would report that healthy window as "down".

`arrêté` · `démarrage` · `lint` · `build` · `sert :port` · `watch` · `lint KO` · `build KO` ·
`crash` · `externe :port`

`externe` is the one worth explaining: the dashboard owns the processes it starts, but it also
detects servers started from a terminal and shows them without control buttons. Without that state,
a project you are already serving would read as stopped, which is worse than showing nothing.

`watch` exists because **`design-system` is not a server**: its `start` runs `ng build --watch`, which
opens no port. Nothing about it can be observed from the outside, which is precisely why the
dashboard spawns it and reads its output.

### Checks verdicts

`pas poussée` (no upstream, so no pull request can exist) · `pas de PR` · `aucun check` ·
`en cours` · `OK n` · `KO n`

`aucun check` is deliberately distinct from `OK`: two real open pull requests returned an empty
rollup, and painting that green would be a lie.

## Actions

- **Run** starts `npm run start` in the project's pty. Disabled when a server is already running
  outside the dashboard.
- **Stop** kills the process tree with `taskkill /T`. A plain kill would only reach the `cmd.exe`
  wrapper and leave `ng serve` holding the port.
- **Commit** runs your `commit` alias in the pty. It is a full-screen prompt_toolkit TUI, which is
  the reason this app embeds a real pseudo-terminal rather than a log view.
- **PR** opens the pull request in your browser. Disabled when there is none.

Closing the window asks for confirmation when the dashboard owns running servers, since they die
with it. Servers you started from a terminal are never touched.

## Claude Code sessions

Read from the append-only transcripts under `~/.claude/projects/`, cross-referenced with live
`claude` processes.

`travaille` · `attend` · `dormante` · `terminée`

`dormante` matters: sessions stay open for days, so without it the list would permanently claim
several sessions are active.

**Only metadata is read**: `type`, `timestamp`, `cwd` and `gitBranch`. Message bodies are never
loaded, so no conversation content reaches the dashboard.

A `Stop` / `UserPromptSubmit` hook would give zero-latency updates instead of polling. It is not
installed for you: `~/.claude/settings.json` is your global configuration. Transcript polling is
also the only thing that can reconstruct sessions that were already open before the dashboard
started, so it stays the baseline either way.

## Facts this app is built on

Verified rather than assumed, and each one changed the design:

- **The dev servers bind IPv6 only.** `127.0.0.1:4200` fails while `localhost` answers, so probing
  the IPv4 loopback would report every running server as down.
- **A port does not identify a checkout.** `web-app` served on 4200 while a
  `web-app-tec1455` worktree served on 4202, so identity keys on the repository path
  extracted from the process command line.
- **Windows PowerShell 5.1 wraps arrays.** `ConvertTo-Json` emits `{"value":[...],"Count":n}` rather
  than a bare array, and missing that shape made the probe silently report zero servers while two
  were listening.
- **ANSI must be stripped with the escape anchor.** A bracket pattern without it eats `[ERROR]`
  itself, destroying the markers the parser exists to find.

## Architecture

```
src/shared/contracts.ts        every main <-> renderer type: the single source of truth
src/main/projects/             registry, pty-runner, output-parser, port-probe, project-monitor
src/main/git/ github/ claude/  one service per source, each on its own poll cadence
src/renderer/ui/presenters.ts  domain state -> label + tone, pure and unit tested
src/renderer/ui/               project-table, session-list, terminal-pane
```

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

Covered where the risk actually is: the porcelain and ahead/behind parsers, the PowerShell envelope
and command-line extraction, and the ANSI/marker parsing against real Angular output.
