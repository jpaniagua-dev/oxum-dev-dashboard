# Development

```bash
npm install
npm run dev          # run from source, restarting the main process on change
npm test             # Vitest
npm run lint
npm run typecheck
npm run dist         # the installer, the zip and the portable build, in release/
npm run dist:setup   # only the installer, under the name the release carries
npm run dist:zip     # only the zip
```

A run from source uses its own data folder (`%APPDATA%\oxum-dev-dashboard-dev`), so it never fights
an installed build over settings or the single-instance lock. No C++ build tools are needed: the pty
ships as a prebuilt Node-API binary.

## Releases

Pushing a `v*` tag equal to the `package.json` version runs the release workflow: lint, tests,
typecheck, the zip and the installer, then a GitHub release. Only the latest release is kept, so the
`releases/latest` page always shows it. The installer's name carries its version; the zip's does not,
so `releases/latest/download/oxum-dev-dashboard-win-x64.zip` stays permanent. The versioning rule is
in `CLAUDE.md`.

The installer's own hooks (the Start menu uninstall shortcut and the offer to delete the app data) are
in `resources/installer.nsh`.

## Architecture

```
src/shared/contracts.ts        every main <-> renderer type and channel
src/main/                      services: projects, git, github, jira, triage, review, terminal,
                               automation, vault, extensions, explorer, editor, tickets, updates
src/main/spawn/                every process spawn, off the main thread
src/preload/index.ts           the only bridge the renderers have
src/renderer/index.html        the dashboard
src/renderer/settings.html     the settings window, a second renderer over the same bridge
src/renderer/editor.html       an editor window opened from the Explorer, a third one
src/renderer/ui/               one module per panel
```

The renderers are sandboxed: context isolation, no Node integration, a locked Content Security
Policy, no remote content. They reach nothing but the channels declared in `contracts.ts`, and all
text is set with `textContent`.

## Tests

Tests never read the machine they run on: those that need files or repositories build them in a
temporary folder. Fixtures use made-up names, the repository being public.

## Rules for contributors

`CLAUDE.md` (and its copy `AGENTS.md`) holds the invariants and the reasons behind each design
choice. Read the section of the area you change before changing it, and update it with the change.
The user documentation in `docs/` is updated in the same commit as the feature it describes.
