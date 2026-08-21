# oxum-dev-dashboard: project instructions

An embedded terminal with, above it, a status strip over your front-end projects (dev server, git,
GitHub checks). Every action a row offers runs in a tab of that terminal.

## Public repository: keep it anonymous

This repository is **public**, while at runtime the app handles branch names, PR titles, issue keys
and repository paths that belong to whoever runs it. None of that belongs in here. The rules, with no
exceptions:

- **No real data in fixtures or comments**: no real issue key, no colleague's name, no third party's
  GitHub login, no organisation name, no internal repository folder. Fixtures use `web-app`,
  `admin-front`, `design-system`, `example-org`, `PROJ-123`, `dev@example.com`.
- **No screenshot of a real session.** `docs/screenshot.png` is taken on a demonstration setup; a
  working screenshot shows branches, issues and PR titles at a glance, the kind of thing ten greps
  would not find.
- **Tests never read the author's disk.** They write their own fixtures into a temporary directory
  (see `test/project-inference.test.ts`). A test that simply returns when a folder is missing counts
  as passing while asserting nothing, and that is exactly what happened here: three inference tests
  verified nothing anywhere but on one machine.
- Colour tokens stay named `--brand-*`.

## Invariants not to break

- **A boolean is not enough for the server state.** `start` scripts run `npm run lint` before serving,
  so `lint` and `lint-error` are real states. Collapsing them would display "not running" during a
  perfectly healthy phase.
- **A project running `build --watch` is not a server** (no port is opened; the typical case is a
  component library). Its state can only come from its output, so the dashboard has to own the
  process. Do not invent a port for it.
- **A row is identified by its repository path**, never by a port. A worktree of the same project runs
  on another port and has to stay a distinct row.
- **Use `taskkill /T /F` to stop**, not `pty.kill()`: the latter only touches the wrapping `cmd.exe`
  and leaves `ng serve` holding the port.
- **The dashboard only describes processes it owns.** The `external` state and the port probe that fed
  it (`port-probe.ts`, `Get-NetTCPConnection` plus `CommandLine` to the repository path) were removed:
  once everything launches inside the embedded terminal, that was a state nobody could act on, for a
  situation that had stopped happening. The trade-off is accepted: if a server is still running outside
  the dashboard, the row says `stopped` and the action fails visibly on "address in use" in its own tab.
  If that starts happening again, the probe is what to bring back (it knew two non-obvious things:
  probe `localhost` and never `127.0.0.1`, since Angular servers only listen on IPv6; and the array
  wrapping of PowerShell 5.1).
- **Confirm before quitting** while owned processes are running: they die with the app.
- **The renderer stays sandboxed**: no `fs`, no `child_process`, locked CSP, DOM built with
  `textContent` (branch names, errors and PR titles all come from outside).

## Architecture: the terminal is the centre

- **The terminal takes all remaining space** (`flex: 1`); the projects strip has a stored height. Do
  not go back to a collapsible terminal panel: it is the primary surface.
- **Every row action ends up in a terminal tab.** No external terminal, no third-party window.
- **The projects strip must show the projects without scrolling** at its default height. If rows grow,
  adjust `projectsHeight` accordingly.
- The "Claude Code sessions" section was removed on purpose: launching the commands from the projects
  already gives the state. Do not reintroduce it without an explicit request.
- **The version is on screen AND in the window title**, from `app.getVersion()` through the bootstrap.
  Not decoration: three builds of this app can sit side by side (installer, portable, unpacked zip),
  they are identical on screen, and "am I running the new one" was a question nothing here answered.
  The title is the load-bearing half, since it is the only one that reaches the taskbar and the
  alt-tab list, where the question is usually asked about a window that is not in front. Written from
  the **renderer** (`applyVersion`) and never with `setTitle` in the main process: Electron gives the
  window whatever the document title becomes on load, so a title set there is one the page overwrites
  a moment later. `app.getVersion()` and never an import of `package.json`: the renderer is a bundle
  and that file lives inside the asar, so an import would ship the number that was true at build time
  in a place nothing updates. It is also its own element and not the refresh stamp beside it, which
  `stampMessage` overwrites with transient text.
- **Settings are a window, not a modal.** In an overlay, a `click` fires on the common ancestor of its
  `mousedown` and its `mouseup`: selecting text in a field and releasing outside the panel closed the
  box. And a modal hides the very table it configures. The window is **independent** (no `parent`),
  otherwise it would stay pinned above the dashboard and follow it when minimised.
- **Two renderer pages, a single preload.** `index.html` and `settings.html` are two entries declared
  in `electron.vite.config.ts`; forgetting the second one makes it load from disk in dev, with no hot
  reload. Loading goes through `loadRendererPage`, never through a copied `loadURL`.
- **What the settings window writes comes back by broadcast.** The main process sends `SettingsChanged`
  to every window and the dashboard rebuilds from that event. Corollary: the form receives the echo of
  its own save, hence the configuration signature that tells an echo from a genuine external change.
  Without it, the "changes saved" confirmation was wiped immediately.
- **The "unsaved changes" prompt lives in the main process.** Only the window's `close` handler can
  still cancel the close, so the renderer reports its state through `SettingsDirty`; the question is
  asked with `showMessageBoxSync`, since an answer awaited with `await` would arrive too late.

## Terminal

- **A terminal session does not belong to a project.** `TerminalManager` is keyed by `TerminalId`.
  Going back to one key per project would make it impossible to keep a shell open while a server runs,
  which is the normal case.
- **The `Terminal` button and clicking the row are not the same gesture**, and that distinction is the
  point: the row always returns to the repository's single shell, the button opens **a new tab** in its
  folder on every click. The button therefore goes through `openShell` and not `openProjectShell`,
  which leaves those tabs without a `projectId`: invisible to the row's reuse lookup, and never closed
  by `reconcile`. The button was removed once as redundant with the click, which it was not: that
  reading removed the only way to open a second shell on the same repository.
- **Three controls open a terminal in a repository, and they are deliberately identical**: the
  `Terminal` button in the table, the icon in the PR list, and the one in the Git tab's repository
  column. Same gesture, therefore same glyph: `TERMINAL_ICON` lives in `renderer/ui/icons.ts`, which
  exists only for icons with more than one consumer (the sync arrows stay in `git-panel.ts`, the
  chevron in `terminal-pane.ts`). Two copies of a path end up as two slightly different glyphs for the
  same action, and an icon is worth precisely what it is recognised for before being read. Both icons
  go through `createIconButton`, whose `label` parameter is **mandatory**: an icon alone says nothing
  to a screen reader, and making the name optional would guarantee the next icon has none. The PR list
  said `Terminal` in words until then; it was the widest thing on the row after the title, to state
  what the whole app already implies.
- **`.icon-button--row` carries the icon controls of a list row** (reduced size, discreet until their
  row is hovered). One rule for both lists: they were two identical blocks differing only by an opacity
  nobody had chosen, which is exactly how two controls doing the same thing stop looking alike.
- **Clicking a row opens the repository shell, and reuses it.** The gesture is far too easy to trigger
  to stack a tab per click. A repository shell therefore carries a `projectId` **and** no `actionId`:
  any code walking those two fields must accept that pair. The closing rule lives in `isUnreachable`,
  pure and tested, precisely because this case is where it goes wrong.
- **A click on a control must not reach the row** (`closest('button, input, …')`). Without that, a
  click on an action runs it *and* opens a shell, and the rename double-click opens a terminal that
  steals focus from the field that has just appeared.
- **A pane is a GROUP of tabs, not a session.** `TerminalGroup = { tabs, active }`. Before, a pane *was*
  a session and the tab bar was a single one above the whole surface: splitting divided the **view**
  while the bar kept listing every session in the app, which gave two windows under one bar. A split
  now yields a complete terminal, tabs included, and moving a tab from one pane to another is just a
  move between groups. Two invariants carry all of it: **a group is never empty** and **a session is in
  exactly one group**. They are enforced in a single place, `normalizeGroups`.
- **`shared/terminal-groups.ts` is shared on purpose.** The renderer computes a layout, the main
  process validates the same shape with the same functions. Two implementations of "is this layout
  sound" would end up disagreeing, and the consequence (a blank pane, a session with no tab) is
  invisible until you hit it.
- **An orphaned session is adopted, never dropped.** `normalizeGroups` attaches to the last group any
  live session no group mentions. That is the dangerous failure: with no tab anywhere, a process runs
  with nothing to show it or stop it. It is also what makes a freshly launched tab visible before the
  renderer has said where it wanted it.
- **Never detach an xterm terminal from the DOM.** `open()` returns early when the terminal already has
  an element: detaching it leaves it alive but invisible forever. One permanent container per session,
  and `hidden` is toggled. That is also why the surface is a **grid** and why strips, views and
  splitters are all direct children of the surface, placed on **explicit grid lines** (`stripLine`,
  `viewLine`, `splitterLine`, pure and tested). A strip that wrapped its view would force an xterm to
  be moved when its tab changes pane, and therefore killed.
- **Pane layout has a single direction** (`columns` or `rows`), not a nested tree. A deliberate choice
  against Windows Terminal's model: a pane's position follows from its index, which keeps the
  arithmetic pure and testable. Do not mix directions without moving to a real tree.
- **The layout lives in the main process, and it IS the tab order.** There are no longer two
  authorities: the `terminal:reorder` channel and the `Map` insertion order are gone, a tab is where
  its group says it is. The renderer computes the whole structure and sends it, the main process
  validates and rebroadcasts it; `syncLayout` realigns it when a session is born or dies.
- **Clicking a tab shows it in ITS pane**, replacing and shrinking nothing: with one bar per pane, the
  gesture cannot mean anything else. It was the opposite before (the tab took the focused pane's
  place), and that rule no longer has a reason to exist.
- **Closing a pane does not kill its terminals**: its tabs move to the neighbouring pane. A terminal's
  view and its life are two different things; a click in a context menu must not be able to stop a dev
  server.
- **`moveTab` takes the neighbour, not an index.** `before` is the tab to land in front of, read from
  the list **with the dragged tab removed**. An index computed on a list that still contains the
  dragged tab aims one slot too early as soon as you move to the right: that was the bug the old
  `reorderIds` already had, and naming the neighbour makes it impossible.
- **A drop on the strip itself, outside the tabs, appends to the end of that pane.** That is what makes
  an almost empty strip a valid target, and the gesture for "put this terminal in *that* pane" when you
  are aiming at the pane and not at a position.
- **Every visible pane needs its own `fit`.** With a split, each pty has its own geometry: adjusting
  only one would leave the others wrapping their output at the wrong width.
- **Shortcuts are bound on `document` in the capture phase**, otherwise the focused xterm swallows
  them. `Ctrl+Alt` plus a letter, never a digit (Swiss French keyboard), and a guard on `event.repeat`:
  without it, holding the shortcut down opens one shell per repeat.
- **Copy and paste: returning `false` from `attachCustomKeyEventHandler` is not enough.** It only
  prevents xterm's own handling of the key, not the browser's default action: without
  `event.preventDefault()`, the `Ctrl+V` keydown still fires the native `paste` event on xterm's hidden
  textarea, which xterm also listens to, and the text was pasted twice. The decision (copy only when
  there is a selection, `Ctrl+C` stays SIGINT otherwise, AltGr guard) lives in `decideTerminalKey`,
  pure and tested; the pane's context menu goes through the same `copySelection` / `pasteInto` as the
  shortcut.
- **Rendering goes through the WebGL addon**, not the default DOM renderer. The DOM under Chromium's
  GPU compositing left frozen glyphs on screen while scrolling (seen for real); the WebGL canvas is
  repainted whole, so nothing can stay behind. Three rules, each one paid for: the addon is loaded from
  `fitVisible` and **never in `ensure()`**, because a view can be created for a background tab (`write`
  accumulates the history of hidden sessions) and a WebGL canvas initialised under `display: none` is
  born with a wrong geometry that resurfaces as frozen glyphs outside the grid once shown. Every `fit`
  is followed by a full `term.refresh`, since a resize only repaints the new grid and not what the old
  one left around it. And `onContextLoss` disposes the addon (Chromium caps the number of live WebGL
  contexts per page and evicts the oldest): xterm falls back to the DOM renderer on its own, and the
  `failed` state avoids reloading a context that would be evicted again.
- **xterm has to know it is talking to ConPTY** (`windowsPty`, fed by `terminalCompat` in the
  bootstrap). Without it, xterm assumes a Unix pty and **redoes the reflow** of its buffer on every
  resize, while ConPTY reflows and reprints from the console buffer it owns: two owners rewrite the
  same lines from different origins, and the loser leaves characters behind. That is what the "ghost
  letters" seen with a full-screen TUI were. The build number is not decorative, xterm changes
  behaviour at 21376: `parseWindowsBuild` rejects a `0` build rather than guessing, a wrong number
  being worse than no number.
- **`rescaleOverlappingGlyphs: true`.** A character of ambiguous width (`⎿`, `●`, the box-drawing
  lines, the spinner of a Claude Code session) is one cell wide for the font but paints wider. Under
  WebGL only cells marked dirty are repainted, so pixels spilled into a cell nobody touched this frame
  stay on screen. A WebGL-only option, which is exactly our case.
- **No `convertEol`.** It makes a lone `\n` also return the carriage: that is a fix for output piped
  in directly, not for pty output where the line endings are already the ones the program intended.
  Left on, a lone line feed emitted to move down **while keeping the column** (what a TUI redrawing a
  frame in place does) brought the cursor back to column 0: the redraw restarted in the wrong place and
  never covered the tail of the previous frame.
- **The pty is only told when the geometry really changed.** `fitVisible` runs on every render: tab
  change, pane focus, and once per `pointermove` while dragging a splitter. A
  resize to the same size is not free on Windows (ConPTY reprints the screen it holds) and a
  full-screen TUI answers each one by redrawing its whole frame. `View.sent` remembers the last
  announced size; the comparison costs nothing and removes every redundant resize.
- **Clearing is both ends or neither.** `pty.clear()` is a no-op everywhere except on ConPTY, and on
  ConPTY that is the whole point: it keeps its own copy of the screen and reprints it at the next
  repaint it decides, so clearing on the xterm side alone put back the text you had just removed. The
  retained buffer goes with it, otherwise a renderer restart would replay what was cleared.
- **"Close tabs to the right" stops at the pane boundary.** `tabsAfter` only looks at the group of the
  target tab, because with one tab bar per pane, "to the right of this tab" is a statement about *that*
  bar: sweeping up a neighbouring pane's tabs would let a tidying gesture reach a pane nobody was
  looking at. And non-closable tabs are **skipped, not refused**: the count in the label is the number
  that will actually go, and the tooltip says what stays. A menu item promising four closes and doing
  three is a menu you stop believing.
- **`Alt+Shift+W` closes the tab, `Ctrl+Alt+W` closes the pane**, swapped on request in 4.4.0: the
  everyday gesture sits on the everyday chord. `Ctrl+Alt+W` remains the one accepted exception to the
  "no `Ctrl+Alt`" rule, and it holds for that key only: `W` carries no AltGr character on the Swiss
  French layout, so the combination types nothing and there is nothing to mask. It is compared on
  `event.code` and not `event.key` precisely because the assumption is about the **physical** key:
  under a chord some layouts do map, `key` becomes the composed character and the comparison would
  silently stop matching. Any future `Ctrl+Alt` chord must be checked against the layout the same
  way, or it eats a character somebody actually types.
- **A shortcut never closes a non-closable tab.** `Alt+Shift+W` returns silently on a running server,
  just as its tab silently has no cross: `closable` is derived for that, and `Stop` remains the
  deliberate gesture. A shortcut able to kill a build out of habit is exactly what this rule prevents.
- **The surface is never left empty.** Closing the last session used to leave the app dead: the session
  closed, but with zero groups every strip is hidden, and the "+" that could open a new tab lives in
  the strip. The bootstrap rule ("open a shell when there is none") therefore also runs on every
  sessions push: whatever gesture empties the surface, the default shell comes back. One
  `openDefaultShell` for both callers, or the two fallbacks would drift.
- **Nothing redraws under a tab rename.** The double-click that starts a rename on an inactive tab is
  preceded by a click that activates it, and the layout broadcast coming back rebuilt the strip mid-
  edit: the focused input was destroyed and its blur committed the rename before a letter was typed.
  `renderStrips` returns while the rename input is live (checked on the DOM, since entering rename mode
  goes through that very method to build the input), and a rename whose session died is dropped. The
  field's focus is a **microtask**, not a `requestAnimationFrame`: an animation frame is throttled in
  an occluded window and loses the race against the broadcast.
- **URLs printed in a tab are clickable, through our own handler.** `@xterm/addon-web-links` is loaded
  in `ensure()` and not from `fitVisible` like the WebGL addon: it registers a link provider and reads
  nothing about the geometry, so a background tab is a fine place to be born. The handler is **ours**
  rather than the addon's default, which calls `window.open`. That would work by accident, `window.ts`
  turning every window-open request into a `shell.openExternal`, and it would be the only place in the
  app where a URL reaches the browser without passing the main process's `http(s)` check, and a pty
  prints whatever a program sends it, `file://` and `vscode://` included, so the check is the point. It goes
  through `onOpenLink`, a callback like every other side effect of this pane, and calls
  `event.preventDefault()` so the click does not also land on xterm's own mouse handling and start a
  selection under the link that was just followed. The addon is pinned to the `0.12.x` line, which uses
  only `registerLinkProvider`: verified against the published code, because the `0.13.0-beta` line is
  the one that tracks xterm 6 and a beta has no place in a dependency list here.
- **Git Bash is launched with `-i`**, otherwise aliases do not exist in the tab.
- **Profiles are probed on disk** before being offered: a menu entry that fails on click is worse than
  no entry.
- **Renderer logs are forwarded to the main process** (`console-message` in `window.ts`). Without that,
  a renderer exception is invisible from the terminal that launched the app.
- **`closable` is derived, never stored.** A `commit` tab is closable even while running, a shell
  always, a dev server only once stopped (`Stop` remains the deliberate gesture). The first version made
  every project tab permanent, which left a finished `commit` stuck in the bar with no way to close it.
- **The bootstrap returns the live sessions.** The renderer restarts without the main process on every
  hot reload: without this, the tab bar came back empty and the startup shell was reopened every time,
  stacking identical tabs.
- **Renaming a tab sets `renamed`**, which stops a relaunch of the command from overwriting the chosen
  name.
- **No render during a drag.** Replacing the dragged element mid-gesture cancels the drag in Chromium:
  the insertion marker is a class placed on the live nodes, and the bar is only rebuilt once the new
  order comes back from the main process. That is also what makes the display authoritative rather than
  optimistic.
- **The insertion marker is a `box-shadow`, never a border**: a border would change the tab's box and
  shift the whole bar on every `dragover`, which makes the tabs look like they are fleeing the cursor.
- **Changing the font size redoes the `fit`.** The cell size changes, so the number of columns and rows
  changes too: a pty left on the old geometry wraps its output at the wrong width. The bounds live in
  `TERMINAL_FONT_SIZE` (`contracts.ts`), read by the store's clamp, the settings field and the pane's
  fallback, and the store applies them even to a hand-edited file. An unreadable value would otherwise
  have to be fixed in a settings window that has become unreadable.
- **`settings:update` broadcasts, except for the keys in `LOCAL_ONLY_KEYS`.** Those keys are born in
  the dashboard and are written on every splitter release or tab change; sending them back would rebuild
  the table and the terminal in the middle of the gesture. Everything else can come from the settings
  window and must arrive.
- **`asPatch` lives in `store/settings-patch.ts`, not in `ipc.ts`**, because `ipc.ts` imports Electron
  at module level and a test would then require it too. Its list is **the** list of keys the renderer
  may write, and a key missing from it fails in total silence: `pullsHeight`, `jiraHeight` and
  `activeStrip` had been missing since V2 while `renderer/main.ts` was sending them, so tab heights and
  the active tab did not survive a restart. Hence `test/settings-patch.test.ts`, which locks the list in
  both directions.
- **The table does not redraw during an inline edit.** It refreshes on every git cycle, so a refresh in
  the middle of typing would wipe the field.

## Configurable actions

- **An action is configuration, not code.** `Run` and `Commit` no longer exist as hardcoded buttons:
  the list lives in `settings.json` per project, and `defaultActions()` only serves the seeding. Do not
  reintroduce a wired button in `project-table.ts`.
- **At most one `server` action per project.** A row carries a single server state; two `server`
  actions would mean two processes writing the same phase, and the last one to print would win. The
  invariant is held in three places: the store's sanitisation demotes the extras, the role selector
  demotes the previous holder, and `validateActions` reports an `error`.
- **The role decides all the behaviour**, not the name: `server` drives the row's state, is replaced by
  `Stop` while it runs, its tab is not closable and its output is parsed. `task` touches nothing and its
  tab is closable at any time.
- **An action's id never changes.** It is derived from the label at creation time and keys the tab:
  re-deriving it on a rename would orphan the process launched from that very button.
- **The command is passed as a single argument** to the shell (`-ic`, `/c`, `-Command`). Splitting it on
  spaces would break the first quoted path or the first `&&` the user wrote.
- **`Run` is seeded on `cmd`, `Commit` on Git Bash**, and that is not cosmetic: a pty does not resolve
  `.cmd` shims (so a bare `npm` fails) and bash expands no alias when non-interactive (so `commit` does
  not exist without `-ic`). See `resolveActionCommand`.
- **`Run` is a RESTART, `Stop` is unchanged.** Clicking `Run` on a `server` action stops the process
  that is still alive, **waits for it to exit**, then relaunches. The previous rule ("already running:
  I hand back the tab and launch nothing") looked harmless and did the opposite: in any state where the
  row and the sessions contradicted each other, `Run` was displayed and did **nothing at all**, with no
  way for the user to tell "nothing to do" from "this is broken". A restart always does something
  observable, and it *repairs* that contradiction instead of suffering it. Corollary: `canStart` is gone
  from the renderer and the button is never disabled any more. Its tooltip used to blame a "server
  outside the dashboard", a leftover of the removed port probe, and wrong in the state that actually
  reached it. As long as a process runs the button stays `Stop`, so stopping by hand is always possible:
  `canStop` is the one that does not change.
- **A running `task` is never restarted**, only a `server` is. `Commit` triggers husky and lint-staged
  for half a minute: a second click must not kill a commit in flight. The rule lives in `decideRerun`,
  pure and tested, because it has three branches and two of them look alike.
- **The wait before relaunching is not decorative.** `taskkill /T /F` is a *request* that returns well
  before the tree has fallen: relaunching immediately would race the new dev server against the port the
  old one still holds, and the failure would talk about `address in use` for a reason foreign to the
  user's code. Bounded to 8 s anyway (`RESTART_EXIT_TIMEOUT_MS`): a process refusing to die must not
  freeze the button.
- **A pty exit is only reported if the manager still owns the session.** Without that guard in `onExit`,
  the exit of an already removed session described the **old** process while landing on the new one's row
  (`markExited` is keyed by project): the row went `crashed` on top of a perfectly live server, and from
  that state `Run` was displayed, enabled, and permanently inert. The window is real, not theoretical:
  `close()` removes the entry right after requesting the `taskkill`, and a restart removes it on purpose.
  Reproduced by a test driving a real pty (`test/terminal-manager.test.ts`, "exit reporting"), verified
  red without the guard.
- **`Stop` is requested per project, never per terminal.** `stopProjectServer` resolves the session in
  the main process, the only side holding both the sessions and the roles. When the renderer did that
  work (find the `server` action, then the session carrying its id), both hops returned `undefined`
  without a word as soon as the two sides diverged: `Stop` became a dead button. The return value is a
  boolean on purpose, so that "nothing to stop" shows up in the logs.
- **A session always runs with a button able to stop it.** `TerminalManager.reconcile` closes the tabs a
  configuration change makes unreachable: project gone, action gone, or an action launched as `server`
  that no longer is (the row then shows neither `Run` nor `Stop`, and the port would stay held). The rule
  lives in the manager because the role at launch time lives there too.
- **`npm run dev` uses `--watch`.** Without that flag, `electron-vite` hot-reloads the renderer but
  **not** the main process: you end up with a fresh renderer talking to a stale main. That is exactly what
  made `Stop` look broken after the move from `command` to `actionId`: Run worked by luck, Stop found
  nothing any more. Do not remove the flag.
- **The port and the kind are inferred from the `server` action's command**, no longer from a
  `startScript` field. `scriptNameOf` follows an `npm run <x>` into the manifest; any other command is
  interpreted as written. Reintroducing a `startScript` would recreate two places able to contradict each
  other.

## Pull requests tab

- **The top strip has six tabs, and the terminal does not depend on them.** Only the strip's content
  changes; a tab that stole the terminal's space would go against everything else in this app. Adding a
  view means an entry in `STRIP_TABS`, two elements in `index.html`, and a height in `AppSettings`, and
  that height must be added to `asPatch` **and** to `LOCAL_ONLY_KEYS`, or it is dropped in silence (see
  the note on `settings-patch.ts`). The tab's own name has to pass **two** gates as well, `asPatch` and
  `asStrip` in the settings store: `triage` was missing from the second while the first accepted it, so
  every save turned it back into `projects` and the tab was simply never remembered. Both lists are now
  looped over in their tests. A new tab goes at the **end** of the row, whatever its subject: inserting
  it in the middle moves the others under a cursor that has learnt where they are.
- **The folded strip hides its panels by `[role='tabpanel']`, never by a list of classes.** A class that
  sets `display` beats the browser's `[hidden]`, so a folded strip has to hide its panels explicitly.
  The rule used to name `.projects__scroll` and `.pulls`, so the three panels that arrived later with
  their own `display` (`.git`, `.triage`, `.worktrees`) kept painting through the fold while the strip
  shrank around them. A rule extended once per new tab is a rule that gets forgotten, and the symptom
  is silent; the role is already there, because it is what makes the strip a tab list.
- **There is no application title bar any more.** Everything it carried (last refresh, `Refresh`,
  settings, theme) lives in the strip's tab row, which was already a chrome row: two chrome rows
  above a terminal is one too many when the terminal is the subject of the window. The application title
  went with it, the native title bar already saying it. Benefit of the move: that row is the one that
  never collapses, so settings and refresh stay one click away when the strip is folded.
- **`pane-resizer.ts` survived the removal untouched**: it measures the distance from `#projects-pane`
  to the top of the viewport with `getBoundingClientRect` at the moment it needs it, never from a
  constant. The panel simply starts higher. Do not introduce a hardcoded header height there, that is
  precisely what would have broken here.
- **The strip folds down to its tab row** (`stripCollapsed`, a button and `Alt+Shift+A`), to work in the
  terminal without losing sight of anything. **The tab row itself never folds**: a control that hides
  itself leaves no way back. An accepted and intended corollary: clicking a tab while folded unfolds,
  because that is the natural gesture for "show me that". Folding must **clear** the inline height set by
  `attachPaneResizer` (a class does not beat an inline style), unfolding sets it again through the
  resizer so it goes through the same clamping, and the splitter is hidden in between: dragging it would
  write a height across the fold.
- **Double-clicking the tab row also folds**, like a double-click on a title bar. It goes through
  `hitsInteractive`, and that is not a detail: without the guard, double-clicking "Jira" would select
  that tab **and** fold the panel you were asking to see. The chevron stays: the double-click is the
  gesture you find once you know the app, not the one that has to be discoverable.
- **Each tab has its own height** (`projectsHeight`, `pullsHeight`): a four-row table and a
  master-detail list do not have the same needs. `attachPaneResizer` returns a `setHeight` so the tab
  change applies the right one, without duplicating the clamping elsewhere.
- **A `display` set by a class overrides the browser's `[hidden]`.** `.pulls` is `display: grid`, so an
  explicit `.pulls[hidden] { display: none }` was needed: without it the two views stacked on screen.
  Same trap as `.terminal__view`.
- **Clicking a PR row opens the PR in the browser**, and the repository terminal has its own button. The
  two gestures were the other way round until use settled it: faced with a list of pull requests, the
  reflex is to go read the PR, and the terminal is the deliberate gesture. The `hitsInteractive` guard is
  what stops the button from also opening the browser as it leaves the row.
- **The Jira tab's "Open <KEY>" button points at `/browse/<KEY>`**, never at a `/jira/software/...`
  path. A board path needs two things the app does not have: the numeric board id *and* the project's
  style. Verified on a real site: a team-managed project (`style: next-gen`) has its boards under
  `/jira/software/projects/...` while a company-managed one uses `/jira/software/c/projects/...`.
  Guessing between the two would 404 half the time. `/browse/<KEY>` is the one form Jira Cloud resolves
  for every project type. Pinned by a test so nobody "improves" it into a board path.
- **Repositories are derived from the projects** through `git remote get-url origin` (`readRemoteSlug`),
  with a `followPulls` checkbox per project. No second list to keep up to date; accepted corollary, a
  repository you have not cloned cannot be followed.
- **A single `gh pr list` call per repository**, with the "mine" filter applied locally on the `login`
  fields. Filtering on GitHub's side would have cost two calls per repository, its search syntax being
  unable to express that `OR`. The full payload is therefore in the main process, and that is **exactly**
  what made the second sub-view free: do not reintroduce a GitHub-side filter for either of them.
- **Two sub-tabs, `Mine` and `All`**, rather than one widened filter: the two counts
  differ, so a single list would have to choose which one to show in the repository column, and that
  count is the at-a-glance answer the tab exists to give. Both counts therefore sit **on the sub-tabs**,
  because "0 mine / 3 total" answers "is this repository quiet, or am I just not in it?" without
  changing view. The column's count follows the active sub-view, otherwise the badge contradicts the
  list next to it. `pullScope` is persisted (so it is in `asPatch` **and** `LOCAL_ONLY_KEYS`, see the
  note on `settings-patch.ts`).
- **`.subtab` is shared by the Git tab and the PR tab.** It was `.git__view`, renamed: a class named
  after one panel is a class the next panel copies instead of reusing. Same reason as
  `.icon-button--row`.
- **The author is shown as soon as it is not the user**, not only under `All`: a PR waiting for
  your review says "review requested" without saying whose it is, which is the first thing you want to know.
  Hidden when it is yours, for the reason that makes the assignee column disappear under `My
  issues`.
- **Three payload traps, all met for real**: an empty `reviewDecision` means "no review required" and
  is **not** an approval; a review requested from a **team** has no `login` and must be ignored without
  crashing; an empty `statusCheckRollup` is `no-checks`, never `passing`.
- **`PullMonitor` is a separate loop**, its cadence in minutes (`pullsPollSeconds`, 180 s by default).
  It is rebuilt by `reloadProjects` like the projects monitor, because it keys its state and its
  resolved remotes by project.
- **`verdictFor` is shared** with the checks service: two places deciding what "green" means would end
  up disagreeing.
- The polling cadences are not in the UI, like `gitPollSeconds` and `checksPollSeconds`: they are edited
  in `settings.json`.

## Jira tab

- **The API token never goes into `settings.json`.** It lives encrypted by `safeStorage` (DPAPI on
  Windows, tied to the account) in `jira-token.bin`. If encryption is unavailable, `SecretStore.write`
  **refuses** to write rather than falling back to plain text: a secret written in the clear because the
  vault was closed is one nobody notices.
- **The token never travels back to the renderer.** The form receives `hasToken: boolean`, never the
  value; an empty field on save means "keep the stored one", not "clear it".
- **An issue's stage comes from `statusCategory`, not from the status name.** Names are per-project and
  renamed at will ("In review", "Ready for QA"); only the category (`new`, `indeterminate`, `done`)
  means the same thing everywhere. The name stays what is **displayed**, because it is the word the team
  uses.
- **`sprint in openSprints()`** lets Jira answer "which sprint is current" itself, instead of looking up
  a board and then its active sprint.
- **Two possible search endpoints.** Jira Cloud replaced `POST /rest/api/3/search` with
  `GET /rest/api/3/search/jql`, and instances migrate at their own pace. The service tries the new one,
  falls back once to the old one on 404/410, then remembers the answer. Do not "simplify" this down to
  one without checking against a real site.
- **The "Test" button runs a real search**, not a ping: only a real request validates both the
  credentials and the project keys, which are what fails in practice.
- Nothing is queried until site, email and token are all three filled in: an unconfigured install makes
  no request at all.
- **Story points are still not displayed in this tab**, and the reason is unchanged: their field
  (`customfield_xxxxx`) varies from site to site, so a column would cost a discovery call per refresh
  for a number the list does not read. The Triage handoff does now **write** them, through
  `pickStoryPointField` and one lookup per handoff rather than per poll. If a column is ever wanted here,
  that function is what to reuse, and the cadence is the question to answer first.
- **Transitions are read when the menu opens**, never cached: a workflow decides which moves are legal
  from the current status, so a remembered list would offer moves Jira would then refuse. One request
  per right-click is the right price for never lying.
- **A transition is labelled by the status it lands on**, not by its own name: the name is a verb
  ("Start progress") while the user is choosing a destination.
- **"Assign this issue to me" goes through the `accountId` of the token's account**
  (`/rest/api/3/myself`), never through an email: emails are hidden by privacy settings on many sites,
  and the id guarantees the action cannot target anyone else.
- **The display order puts "in progress" first, and it is a stable LOCAL sort.** `orderIssues` sorts on
  the `stage` (so on `statusCategory`, same reason as `presentStage`: "In review" and "Ready for QA" must
  both count as work in progress) and on that key alone, so that the JQL's `ORDER BY` remains the order
  **inside** each group. Without that stability there would be two authorities on the order and the
  second one would be invisible. Done locally and not in JQL: `ORDER BY statusCategory DESC` reads as
  "in progress then to do" **only because** both searches exclude Done, so it would silently invert the
  day someone widens the scope, and Jira's collation of categories is not verifiable from here.
- **Writes refresh immediately** (`afterJiraWrite`): the row you have just changed must show its new
  state without waiting for the five-minute loop.
- **Issue rows are a grid**, not a flex row: their badges are conditional, so in flex no two rows agreed
  on where the status sits. The assignee comes before the status, and the column disappears under « Mes
  tickets » where every row would carry the same name.
- **The assignee filter and the column sort are NOT persisted**, unlike `pullScope`. A hidden filter
  that comes back on the next launch is a list that silently stops showing half the sprint, and the
  cause is a dropdown nobody remembers setting. A PR tab's scope is a preference; a filter is a question
  asked once. The filter is also **reset when the view changes**: `My issues` has no assignee column,
  so a carried-over filter would hide rows there with no way to see it or remove it.
- **A column sort REPLACES the default order, it does not refine it.** Sorting by name *inside* the "in
  progress" group would keep the tab's habit, but it would make the sort lie: whoever clicked "Assignee"
  expects the names to run in order down the whole list. One authority on the order at a time, the one
  that was asked for. Corollary: a header's cycle has **three** states (ascending, descending, back to
  default), otherwise there is no way back to "in progress first".
- **The sort direction applies to the comparison, never by reversing the array.** Reversing also
  reverses the ties: two issues with the same status would swap places on every direction change, which
  makes the list look like it is shuffling rows nobody sorted.
- **Issue keys are compared on their number, not as text.** `localeCompare` puts `PROJ-1000` before
  `PROJ-999`. Invisible until a project passes a power of ten, which any long-lived project did long
  ago.
- **`ASSIGNEE_NONE` is a control character**, not the word "none": the values of this filter are display
  names read from Jira, and any readable sentinel is a name somebody can bear. Since `''` already means
  "everyone", the unassigned case needs a value that cannot collide.
- **The sortable header is INSIDE the scroll area, in `position: sticky`.** Pulled out into its own box,
  it would shift by the width of the scrollbar as soon as the list overflows, and a column misaligned
  with its values is worse than no header. It reuses the `.issue` grid, the only way for a label to stay
  above the column it names.
- **"Create a branch" runs the `dev <ISSUE>` alias, never a command assembled in the renderer.** The
  channel takes a project and a key; the main process assembles `dev <KEY>` after validating the key
  against `ISSUE_KEY_PATTERN`. This is the only place in the app where input from the renderer reaches a
  shell, so the pattern is anchored and deliberately narrow: letters, hyphen, digits. It also requires an
  **interactive bash** (`resolveBashProfile`), because `dev` is a `.bashrc` alias: no bash means no
  command and a message naming the missing shell, rather than a `command not found` in a tab that looks
  like it worked.
- **Choosing the project is a SECOND context menu in the same place**, not a modal and not a real
  submenu. A modal is excluded on principle here (a `mousedown` inside released outside fires a `click`
  on the common ancestor: the bug that got the settings modal removed). A real submenu would need hover
  timers, edge flipping and a keyboard model, that is a menu framework for a list of four repositories.
  And a flat "Create a branch in X" list in the first menu would push the transitions off screen by
  ten projects. The last used project is at the top and says so; it is **session-local**, like a
  shortcut and not like a setting.
- **`context-menu.ts` has no side effect at import time.** Its dismissal listeners are attached on the
  first open: at module load, two DOM-less test files broke.
- **No example placeholder in the settings.** A greyed example reads like a value that is already saved;
  where a placeholder does remain, it is an inferred value, and it is in very pale italics.

## Git tab

- **Reading is pulled, not pushed.** There is no monitor behind this tab: a single row is displayed at a
  time, and probing branches, history and status for every project would cost several times the strip's
  git poll for something nobody is looking at. The renderer asks when it shows the tab, when the
  selection changes, and after every write, which is to say exactly when the answer can have changed.
  The heartbeat, meanwhile, is the git poll's `RowsChanged`: it is the same working tree this tab
  describes.
- **Quick writes go through `execFile`, the commit goes through a terminal tab.** That is not an
  inconsistency, it is the only dividing line that holds: a checkout or a `git add` is instantaneous and
  its result is read in the strip, whereas a commit triggers `husky` and `lint-staged`, which can run for
  half a minute and print everything that explains a refusal. Run silently, that collapses into one
  failure line; run in a tab, it can be watched as if from a shell, which is what the "every action ends
  in a tab" rule demands anyway.
- **The commit message goes through a file, never through `-m`.** Two independent reasons: a message is
  multi-line by convention, so `-m` would let the form decide the message's shape; and the message
  reaches git as **bytes on disk**, so nothing inside it can be read as an option. A subject starting
  with `-` exists, and so does its test.
- **The message file is kept after the commit.** It costs nothing, and when a hook refuses the commit it
  is the only surviving copy of what was typed: deleting it would turn a failing hook into lost work.
- **Amend is a checkbox, armed then clicked.** The same judgement cherry-pick records: a gesture that
  rewrites history must not be one stray click away from the one that does not. Arming pre-fills the
  form with the whole HEAD message (`headMessage`, read via `%B`: `commits[0]` only has the subject,
  and dropping the body would lose the very text an amend edits), never over a draft already typed;
  disarming removes the pre-fill and only the pre-fill. It disarms after use and on every repository
  change, or the next commit would silently rewrite the wrong one. The empty-index rule bends for it
  (`--amend` with nothing staged is a reword), the tooltip names the sha about to be rewritten and
  warns when HEAD is already on the upstream, and the command runs in the same terminal tab with the
  same message file (`git commit --amend --cleanup=strip -F`): it fires the very same hooks.
- **The commit tab carries a reserved `actionId`, `git:`.** It is tied to a project but is **not** one of
  its configured actions: looked up in the action list it finds nothing, so without the exemption case in
  `isUnreachable` every settings save would kill a commit in the middle of a hook. The case is tested,
  like the four others in that function.
- **`run-git.ts` is the only place that calls git.** `execFile` with an argument array and **never a
  shell**: a branch name or a path therefore cannot be read as shell syntax. `git-service.ts` was folded
  onto it rather than keeping its own launcher, otherwise there would be two answers to "how do we call
  git here". Two budgets, not one: 8 s locally, 120 s for the network, a push over VPN not being an
  eight-second operation.
- **`git status --porcelain -z`, never without `-z`.** Without it git **escapes** every non-ASCII path
  (`"src/cr\303\251ation.ts"`) according to `core.quotepath`, which would have to be taken apart, and it
  separates records with newlines that a path can contain. With `-z` the paths are raw. A corollary not
  to lose: a rename occupies **two** fields, and failing to consume the second one adds a phantom file
  and shifts everything after it.
- **The index and working-tree columns are never merged.** `MM` (staged then modified again) is the case
  a single state would flatten, and it is the one where the checkbox would lie about what the commit
  contains. `isStaged` lives in `shared/git-changes.ts` because the renderer ticks the box and the main
  process holds the commit: two definitions of "staged" would end up diverging, exactly like `verdictFor`
  on the checks side. And `?` is **not** a staged state, which a plain `!== ' '` misses.
- **In a diff, headers are tested before markers.** `---` and `+++` start with the deletion and addition
  characters: read as content they consume two line numbers and shift everything that follows. They are
  therefore recognised **with their trailing space**, which tells them apart from a `----` deleted in a
  Markdown file, a real and tested case.
- **`git diff --no-index` exits 1 as soon as it finds a difference.** That is documented and is not a
  failure: it is the only way to see the content of an untracked file, and treating that exit code as an
  error would show an error message for every new file.
- **`pull` is `--ff-only`, deliberately.** A merge or a rebase can stop on a conflict, and this tab has
  nothing to offer someone standing in the middle of a rebase: refusing to start one is the only outcome
  it can honestly explain. A diverged branch is a job for the terminal.
- **`push` becomes `-u origin <branch>` when there is no upstream**, re-read at click time and not from
  what the renderer had seen: this is the first push of every new branch, and a stale answer would turn
  it into an incomprehensible refusal.
- **Checkout stashes nothing and forces nothing**, and it is a **button**, not a click on the row:
  changing what is on disk must not be one stray click inside a list. A checkout blocked by local
  changes fails, and git itself says which files are in the way. An automatic stash would move work
  somewhere nobody asked for or looked at.
- **A branch name is validated by `git check-ref-format`**, not by a regular expression of our own:
  git's rules are subtler than they look (no `..`, no trailing `.lock`, no `@{`) and an approximation
  either refuses a legal name or lets through an illegal one that git will reject later while talking
  about something else.
- **The panel is rebuilt whole on every poll**, so the message draft, the branch name being typed and
  the selection live in `App`, not in the DOM. And refreshing is **suspended while a field has focus**
  (`gitEditing`), same guard and same reason as the table's inline rename.
- **A commit's subject wins over its refs.** `flex: none` on the refs badge was wrong and it showed on
  the first real merge: `HEAD -> main, origin/main, origin/HEAD` did not shrink and left the subject
  **one character**. Refs are context, they shrink first and are capped; the full list stays in the
  tooltip.
- **A path is truncated on the left, a subject on the right.** The end of
  `src/app/feature/x.component.ts` is what tells two files apart; the beginning of `PROJ-412-…` or of
  `feat: …` is what tells two branches or two commits apart. Hence two classes and not one.
  `direction: rtl` alone is not enough: without `unicode-bidi: plaintext`, the box's direction also
  governs the text and reorders leading or trailing punctuation.
- **The diff is capped at 4000 lines, and it says so.** A generated lockfile runs to tens of thousands of
  lines, and one element per line is what freezes the strip. A diff cut in silence reads like a complete
  diff, so the truncation is announced in the view.
- **The diff column opens on the first modified file.** That is the third column's reason to exist, and
  landing on an empty column asks you to click before the tab says anything at all. Only when nothing is
  selected, so it can never tear the view away from a file being read, and only on the Changes view:
  preselecting a commit would run a `git show` for a list nobody opened.
- **`defaultTargetFor` decides which side is shown**, shared by the click and by the preselection: the
  working tree when there is something there, the index otherwise. It is also the only choice that is
  never empty, `git diff` returning nothing for a file that is entirely staged. The index/disk button
  only appears for a file that is both at once, the only case where the question has two answers.
- **A menu opened on LEFT click must stop propagation.** `showContextMenu` closes on any `click`
  reaching `document`, which is correct for all its other callers: they open from `contextmenu`, and a
  right click emits no `click`. The `⋯` button is the first menu opened on left click, and without
  `event.stopPropagation()` the opening click travelled on to the dismissal listener and closed the menu
  in the same tick: a button perfectly dead in use, and invisible in tests.
- **Fetch, pull and push are ALSO icons at the end of the tab row.** They are there and not in the
  header because that is the row of controls: the header is a status line (branch, upstream gap) and
  mixing verbs into it is what made it unreadable. `align-self: center` and a height below the tabs, on
  purpose: an icon as tall as a tab reads like a fourth tab, whereas those three *do* something while a
  tab only changes view.
- **An arrow head is sized against the RENDERED icon, not against the viewBox.** The first version of
  the fetch icon drew its head at 1.3 units in a 16-unit box, about one pixel per barb once rendered at
  14 px: it came out as a whisker and the icon read like a "C". Seen for real, under magnification,
  corrected to 2.2 units.
- **The repository actions are a menu, not buttons.** Fetch, pull, push and "open a terminal here" took
  four buttons on the header line; a status strip is read at a glance, and four controls competing with
  the branch name is no longer a glance. Right click on the header line, plus a `⋯` button kept for the
  reason that kept the chevron next to the fold double-click: the expert gesture does not have to be the
  discoverable one, but there has to be one. The menu is **rebuilt on every open**, like the Jira
  transitions: its labels depend on the state (`Push` becomes "Push and publish the branch" with no
  upstream).
- **`gitPanelState()` and `gitPanelActions()` are extracted for that.** The menu needs exactly the same
  snapshot as the panel; two places assembling it would end up disagreeing, and the failure would be a
  menu offering a `Push` the panel has already disabled.
- **The list/diff boundary is draggable, and it is the LIST's width that is stored.** The unstored
  column absorbs every window resize: spare width is worth something to a diff (long lines of code) and
  nothing to a column of paths. The splitter writes a **custom property** on the grid and not a width on
  the column: a grid track cannot be sized from a drag, but the property that sizes it can. And unlike
  the app's two other splitters, this one **does not refit the terminal**: it moves a boundary *inside*
  the strip, the terminal's box does not move.
- **`git-split.ts` is a third splitter module, not a generalisation.** Same reasoning as for
  `side-resizer.ts`: three different axes (height anchored at the top, width anchored on the right,
  width anchored on the left inside a container), and a resizer's direction is precisely what gets
  written backwards, which has already happened here. All three are therefore pure, tested functions.
- **`gitHeight` defaults to 460**, the largest of them all. Three columns ending in a diff make this the
  tab where you stop glancing and start working; 250 px would show four lines of diff.
- **A repository row's terminal icon is the row's SIBLING, not its child**, and that is the entire reason
  for the `git__repo-line` container. The row is a real `<button>` (so reachable with Tab and responding
  to Enter) and nesting a button inside a button is invalid HTML that browsers silently rearrange, the
  very reason a PR row is a `div`. Here the row keeps its semantics and the icon is a control in its own
  right. An intended consequence: opening a terminal does **not select** the repository, so it triggers
  no git read of a repository nobody opened. It is not disabled by `state.busy`, like the same entry in
  the repository menu: it runs no git command.
- **Cherry-pick is on RIGHT CLICK on a commit, never a row button.** This is the same judgement the
  `Checkout` button records in the other direction: a checkout changes the disk, so it must not be
  reachable by a stray click in a list; a cherry-pick changes **history**, so it must not be reachable at
  all without having been asked for. The history column is scrolled and clicked all day long to read
  diffs. The menu is rebuilt on every open, like the repository one: the target branch is in the labels.
- **A sha is validated, for lack of a `--` to hide behind.** `cherry-pick` takes revisions and not paths,
  so there is no separator to neutralise a value starting with `-`: the guard is the hexadecimal pattern
  itself. It costs nothing, those shas coming from our own `git log`.
- **`GitRepoState.sequencer` is the mandatory other half of cherry-pick.** A conflicting cherry-pick
  stops with `CHERRY_PICK_HEAD` on disk, and from that state *every* other button in the tab fails for a
  reason that has nothing to do with what was clicked. The state is therefore read, shown as an `error`
  badge next to the branch, and the repository menu offers the way out (`--abort` before `--continue`:
  you open this menu because something went wrong, and `--abort` is the one that cannot make things
  worse). The markers are read through `git rev-parse --absolute-git-dir` and **never** by joining
  `.git/` to the repository path: in a worktree, `.git` is a *file*, so the naive version would answer
  "nothing in progress" for every worktree. Merge, revert and rebase are read at the same price, and a
  repository left in the middle of a rebase misleads exactly as much.
- **`--continue` runs with `GIT_EDITOR=true`.** Without it git opens `core.editor` to confirm the
  message, and an editor opened by a silent `execFile` is a command that never returns: the call would
  sit there until the timeout, the repository still mid-operation and nothing on screen to say so. The
  spelling of the flag varies by operation (`--no-edit` exists for some), the environment variable works
  for all of them.
- **A stash is designated by its SHA, never by `stash@{n}`.** The ref is a **position** in a list that
  renumbers on every `drop` and every `pop`: a ref read thirty seconds ago can name a different entry by
  the time of the click, and a `drop` on the wrong entry is lost work nothing here knows how to get back.
  `applyStash` therefore re-reads the list and looks the sha up in it; a vanished entry is **refused**,
  not approximated. The ref is still displayed because it is what `git stash` prints and what you would
  retype in a terminal.
- **`--include-untracked` is a choice, unchecked by default.** A checkout already refuses to overwrite
  tracked changes: those are the ones a stash exists to set aside. New files, a checkout carries along
  without complaint, so sweeping them up by default would move work nobody asked to move. A verified trap
  that goes with it: with **only** untracked files, `git stash` saves nothing at all and still exits 0, so
  "success" is not "something was stashed", and the message shown is git's own sentence.
- **A stash's diff goes through `git stash show -p`, not through `git show`.** A stash entry is a merge
  commit, and `git show` prints *nothing* for a merge unless asked for a combined diff: reusing the
  "commit" branch would show an empty diff for every stash, which reads as "nothing was stashed".
  Corollary: the `stash` diff target carries the sha, like the writes.
- **A stash's actions are a menu, not buttons.** `pop` and `drop` *remove* the entry, and `drop` removes
  it with nothing on screen able to bring it back: neither belongs on a row you also click to read a
  diff. And `drop`'s label says it is permanent: the reflog keeps the commit for a while, but **this tab**
  cannot find it again, and promising a recovery it does not offer would be worse than announcing the
  loss.
- **Discarding a change is a right-click on the file, and the only write here that is confirmed.**
  Three guards, and none of them is redundant. The **gesture** keeps it out of reach of a stray click
  in a list that is clicked all day to read diffs, exactly as cherry-pick and the stash operations
  are. The **dialog** is raised by the main process, on the window, before a single file is touched:
  it names the files (up to eight, then a count) because "3 files" is not enough to catch a selection
  that was one row off, and `defaultId` is Cancel so a stray Enter does nothing. A cancel comes back
  as `ok: false` with a message, which is what it is from the renderer's side; nothing there ever
  learns whether the dialog was answered or the command refused, and neither deserves a different
  line. The confirmation is in the main process for the reason every other question in this app is:
  a page under this CSP has no dialog worth the name, and a modal of our own is the pattern that got
  the settings modal removed.
- **`discardPaths` re-reads the status, like `applyStash` re-reads the stash list.** The renderer's
  snapshot is up to a poll old, and in that window a file can have been staged, committed or created:
  acting on a stale classification would `clean` a path git now tracks. A path with no change left is
  **refused** with "refresh the list", never approximated. Two commands because git has two answers:
  `restore --staged --worktree` for a tracked path (the index half is not optional, `MM` being exactly
  the case where leaving it behind would put the discarded change straight into the next commit), and
  `clean -f` for an untracked one, which has no HEAD version to go back to and is therefore *deleted*.
  The menu label and the message say which of the two is happening, since they are not the same
  promise. A **rename** contributes both of its paths (`change.from` alongside `change.path`): git
  reports it as one record carrying the new name, and restoring only that leaves the old file deleted,
  which is the worse half of the change the reader asked to be rid of.
- **What this tab still does not do, and why**: no conflict resolution, no interactive rebase, no
  hunk-level staging. The reason has not changed: they leave the repository in an intermediate state this
  strip could neither show nor finish, and conflicts stay displayed as `error` in the list rather than
  drowned among the modifications, precisely to send you to the terminal. **Stash**, on the other hand,
  has left that list, and the argument deserves its epitaph: it was aimed at the *gesture* nobody wanted
  (an automatic stash behind a checkout) and not at the object. A stash is a named, listed, complete
  snapshot, and creating one leaves a clean tree. What had to come with the view is the outcome of a
  conflicting `pop`, hence `sequencer`.

## Worktrees tab

- **`git worktree list --porcelain` is the only authority.** A scan of a conventional worktrees folder
  cannot do two things this needs: it misses a worktree created somewhere else (there is one sitting
  next to its own clone in this very workspace), and it cannot tell a live checkout from an entry whose
  folder has been wiped. git answers both, and it answers `locked` and `prunable` for free. The same
  conclusion the shell helper reached before this tab existed.
- **The main checkout is excluded by comparing paths, normalised.** git prints `C:/repos/web-app` while
  a configured project holds `C:\repos\web-app`, so a raw comparison never matches and **every** project
  grows a phantom worktree row that is really itself. Separators folded, case folded (Windows only, and
  git spells the drive letter as it was stored). Pinned twice: once on a fixed string, once on a real
  temporary repository, because only the second proves the format git actually prints.
- **A record ends at the next `worktree` line or at the end of the output**, never at the blank line
  alone: an output that does not end with one would lose its last worktree. Unknown attributes are
  ignored rather than treated as the start of a record, so a future git can add one without breaking the
  parse.
- **`locked` and `prunable` arrive with or without a reason.** `locked` alone is a locked worktree, so
  reading only `locked <reason>` reports it as unlocked, which is the opposite of what it is. Hence
  `string | null` and not a boolean plus a message.
- **The row carries the branch from the registration, not from its `GitState`.** It is the only one that
  survives a folder that is gone: git still knows which branch a prunable worktree was on, while a
  `rev-parse` inside a missing directory can only fail.
- **The working tree is read with `readGitState`, the project table's own function.** It costs two git
  calls per worktree more than a narrower read would, and it is worth it: the alternative is a second
  definition of "modified", "clean" and "ahead" drifting next to the first, which is the failure
  `verdictFor` and `isStaged` already record. `presentGit` then paints these rows with no new presenter.
  Its `stashes` is deliberately not shown: the stash list belongs to the repository, so every worktree
  of one clone would report the same number while looking per-worktree.
- **A prunable worktree is not read at all**, and its terminal button is disabled. Reading it would
  produce an error saying less than the badge does, and a shell opened on a missing folder starts
  wherever the profile's own directory is, which looks like a button that aimed at the wrong row.
- **A flat list, no repository column.** The one tab of the strip that does not select a repository
  first, and that is its reason to exist: the question is the one that spans clones ("where are my
  checkouts, which one holds work I have not committed"), and a column to click through answers it one
  repository at a time, which is the laborious version it replaces.
- **The row is a grid with fixed tracks, and that is load-bearing.** Each row is its **own** grid, so an
  `auto` or `fr` track is sized from that row's content: the first version sized the name and the branch
  that way and no two lines agreed on where either began, which is the alignment a grid was chosen for.
  Only two tracks are free, and both are safe: the branch absorbs the leftover width and is left-aligned
  so its start still lines up, and the state column is `auto` but right-aligned against the terminal
  button so its badges line up on the edge that is read. Same answer as `.issue`, and the same reason.
- **The row IS the button, and clicking it opens a terminal.** A real `<button>` and not a `div`
  carrying one, which is what makes the whole line the target and keeps the row reachable with Tab and
  answerable with Enter. It goes through `openShell` with a `cwd` and no `projectId`, since a worktree is
  not a project and there is nothing for reuse to key on: every click therefore spawns a tab. That was
  the argument for keeping the gesture on a button until 5.2.0, and it lost to use, a whole-row target
  being what everything else in this strip taught the hand to expect. A prunable row is `disabled`, which
  is also the one state that keeps it out of the tab order without hiding it.
- **The life-cycle menu sits BESIDE the row, in a `.worktree-row` wrapper.** The row was a button
  precisely because it had a single gesture and therefore no second control to nest, and a `<button>`
  inside a `<button>` is invalid HTML that browsers silently rearrange. When the second gesture arrived,
  the answer was a **sibling** rather than the `div` a pull request row uses: the row keeps its
  keyboard reachability, and the wrapper's fixed 22px track keeps every row's dots on one vertical line,
  the same job the row's own tracks do for the names. The dots are visible at rest and not on hover,
  unlike `.icon-button--row`, and that is the point of the whole feature: these gestures moved out of
  the terminal because the command for them is easy to forget, and an affordance nobody sees until they
  hover the right line does not fix that.
- **No terminal glyph on the row, and it is not an oversight.** The row carried one until the life-cycle
  menu arrived, on the grounds that it would otherwise be a wide clickable strip with nothing on it
  saying what a click does. Two glyphs at the end of one line is the worse problem: they read as two
  buttons and only one of them is, and the one that is not was labelling a gesture the whole row already
  performs. The row's `title` and `aria-label` still name where the click leads, the hover highlight
  still says the line is one target, and a `prunable` row is told apart by its pill rather than by a
  dimmed drawing. `pull-list` keeps its glyph because there the terminal genuinely is a *second*
  gesture, on a row whose own click opens a browser.
- **`.worktree__menu` sets its own 22px, and that width is load-bearing.** `.icon-button` defaults to
  26px while the wrapper's track is 22px, so an icon button left at its default size overflows by four
  pixels; `.pulls__list` scrolls on one axis, CSS resolves the other from `visible` to `auto` when it
  does, and those four pixels come back as a horizontal scrollbar under the whole tab. It does not take
  the `.icon-button--row` class that would size it, because that class's other half is the hover fade
  this button deliberately refuses. Anything given a fixed grid track here has to be measured, not
  assumed.
- **Read when the tab is shown, then on `RowsChanged`.** No monitor, like the Git tab, and for the same
  reason: it is the widest read of the strip (one `worktree list` per project, then a status per
  worktree), and doing it for a hidden tab is work for nobody. It needed no editing guard for as long as
  it held no field, and its own note said that was a property to remember before giving it state. It has
  state now: `worktreesEditing`, raised while the creation field or a rename field is open, because a
  poll landing mid-typing rebuilds the bar or the row the cursor is in. Skipping a read costs nothing
  here, the next poll being ten seconds away.
- **Projects with no worktree stay in the payload.** The summary says "eight across two of seven", and a
  project silently absent from a list cannot be told from one the tab forgot to look at. An unreadable
  project is counted apart for the same reason, and its error sits **above** the rows rather than
  replacing them: one broken project must not hide the worktrees of the six that answered.
- **The tab spawns the life cycle, it does not implement it.** Until 5.3.0 the rule was that the tab
  creates and removes nothing, and the reason was never "a list must not delete": it was that
  `git worktree add` and `remove` have rules a list would have to **reimplement** to be trustworthy (a
  shared `node_modules` junction to unlink *before* the removal, or it survives as an orphan; a refusal
  on a folder git no longer knows about; a stale registration to prune rather than delete), and getting
  one wrong deletes work. That reason still stands, and it is exactly why the gestures now run a shell
  helper (`wt new` / `mv` / `rm`) in a terminal tab instead: the rules live in one implementation, used
  from the terminal every day, and this app spawns it rather than racing it. Same choice as the Jira
  tab's `dev <TICKET>`, which does not create a branch either. Writing a second copy of those rules in
  TypeScript is the drift `verdictFor` and `isStaged` already record.
- **The helper is called bare, never by path**, and `resolveBashProfile` picks the shell. It is a shell
  **function** (a script's `cd` would die with its subshell), so it exists only in a sourced profile,
  and `bash -ic` is what expands it, exactly as it is what expands `dev`. A machine without it prints
  `wt: command not found` in the tab, which names what is missing where the command was going to run.
- **The renderer sends an intent, never a command line.** `WorktreeCommand` says "remove this label, and
  the branch with it"; `buildWorktreeCommand` in the main process turns that into arguments, and the
  repository comes from the **configured path's basename**, not from the payload and not from the
  project's label, which the user can rename. Labels go through a whitelist rather than an escape, like
  `ISSUE_KEY_PATTERN`: the one quoting bug that matters here removes the wrong folder. `-f` and `-d` are
  read with `=== true`, the string `"false"` being truthy and the flag it would arm being the one that
  throws work away.
- **The pattern is anchored**, `^label$`. The helper matches unanchored across labels, repositories and
  branches, so a bare `PROJ-12` also matches `PROJ-123` and the helper refuses on the ambiguity: safe,
  but it turns a click into a trip to the terminal. If the helper ever stopped treating the argument as
  a regular expression, an anchored pattern would match nothing and it would act on nothing, which is
  the direction worth being wrong in.
- **`--force` is on the menu of a dirty row and nowhere else.** That is the whole argument for these
  gestures being here rather than in the terminal: the list has just read whether the folder holds
  uncommitted work, so it can offer the destructive entry only where there is something to destroy, and
  label it with the count. A plain `Remove` never carries a flag, so git refusing it is a normal, useful
  outcome. `-d` stays a separate entry, and the helper still keeps an unmerged branch and says so.
- **A prunable row keeps its menu while its own button is disabled**, and the menu holds one entry.
  There is nothing to rename and nothing to discard; what is left is a registration git is waiting to be
  told to drop, which is precisely what such a row is for.
- **The tab is focused before the list is re-read, and that read is the only one.** The helper is still
  running at that point, so what it catches is the state before the command finished; the next git poll
  is what settles the row. Inventing a completion signal would mean this app deciding when a command it
  did not run is done. It is also why the tab is brought forward at all: the helper is the only thing
  that will say git refused, and silence after clicking `Remove` reads as success.

## Triage tab

- **A headless Claude Code run, not a terminal tab.** This is the one deliberate exception to "every
  row action ends up in a terminal tab", and the dividing line is the same one the Git tab draws
  between a quick write and a commit: a tab is the right home for a command whose **output** is the
  point, whereas here the output is a payload the tab has to parse and group. It therefore sits with
  the services that call `gh` and Jira from the main process. What the rule protects, that no work
  happens where the app can neither show nor stop it, still holds: the run shows as a state on the
  sprint row and the process is killed on timeout.
- **The prompt goes in on stdin, never as an argument.** Twenty tickets with their descriptions is
  tens of kilobytes, past what a Windows command line accepts, and the failure mode would be a
  truncated prompt rather than an error.
- **The run may read, and only read** (`--allowedTools Read Grep Glob`, `cwd` on `projectsRoot`).
  Reading the code is the difference between "this needs the backend" and a guess from the title;
  an analysis is not a change, so nothing may write or execute.
- **No `--bare`.** That mode requires `ANTHROPIC_API_KEY`, while a normal install is signed in
  through OAuth: the run would fail on authentication for a reason foreign to the tab. Verified.
- **`stream-json`, not `json`.** The plain envelope arrives once, at the end, so a run of several
  minutes would have nothing to show while it worked. The streamed form emits every tool call as it
  happens, which is what the progress line is made of. It needs `--verbose` in print mode, and it is
  line-delimited: the output is split on newlines with the remainder carried over, because a pipe
  cuts wherever its buffer ended and an event routinely arrives in two pieces. Parsing per chunk
  would drop exactly those, silently, and the run would look frozen while it was working.
- **The closing `result` event's `is_error` is checked, not just the exit code.** A refusal or an API
  failure arrives with a successful exit and an error inside the JSON; trusting the code alone would
  show an empty triage as a successful one. A clean exit with no `result` event at all is reported as
  a failure rather than as an empty answer.
- **Sprints come from the Agile API, never from an issue's sprint field.** That field is a
  `customfield_xxxxx` whose number differs per site, which is exactly why story points are not shown
  in the Jira tab either. `/rest/agile/1.0/board/{id}/sprint` answers the same question by name. A
  Kanban board has no sprints and answers 400: that is skipped in silence, not reported.
- **A failed run keeps the previous verdicts and only carries the new error.** The stored result is
  the whole point of the tab, and an analysis costs a minute: wiping a usable answer because of a
  network blip would punish the reader for the weather. The error line sits above the old list,
  saying the list is the old one.
- **The result lives in `triage.json`, not in `settings.json`.** It is a result and not a
  preference, it is rewritten by a long-running job, and a settings save must never be able to drop
  it. Keyed by sprint id, which survives a rename.
- **A ticket the model forgot is added back as `unclear`, never dropped.** A ticket silently missing
  from a triage reads exactly like a sprint that does not contain it, which is the one failure
  nobody would notice. Same reasoning for an unknown verdict: it falls back to `unclear`, the honest
  statement being "this was not classified".
- **A ticket already in progress is never analysed.** The tab answers "what can I start", and a
  ticket somebody is on has had that question answered by the fact of being started: paying a model
  to classify it buys a verdict nobody will act on, and it pushes what matters down a list capped by
  what a strip can show. Read from `statusCategory` and never from the status name, the same rule
  that makes `presentStage` what it is: "In review" and "Développement" are one stage under two
  words, and a filter matching the string "in progress" finds neither. `done` is deliberately **not**
  filtered here: the sprint search already excludes it, and a second authority on the same exclusion
  is how the two would drift.
- **The `mine` scope decides what a run reads, which is why it is not a display filter.** Two
  sub-tabs at the top of the sprint column, `All` and `Mine`, because that column is where the sprint
  is chosen and the run is started; in the bar on the right they would sit among counts describing an
  analysis that already happened, and read as a filter over those. Matched on the **account id**, not
  on a display name or an email: Jira Cloud hides `emailAddress` behind a privacy setting, and a
  scope quietly matching nobody would look exactly like a sprint with no ticket of yours in it. An
  unassigned ticket counts as somebody else's, nobody holding it. Failing to read the account id
  **stops** the run rather than falling back to the whole sprint: forty tickets analysed after four
  were asked for is money spent on a question nobody asked, and nothing in the list would say which
  of the two happened. Session-local and never persisted, the stronger version of the reason the Jira
  tab's assignee filter is not either, and always on screen, which is what makes a narrowing scope
  safe.
- **What was skipped is counted, stored and shown.** `TriageResult` carries its `scope` and a
  `skipped` pair, and the bar states them next to the age. This is the same rule that adds a
  forgotten ticket back as `unclear`: a filtered list and a short sprint are the same picture, so
  "No ticket in this sprint" over nine in-progress tickets is the tab lying about its own filter.
  The two reasons stay apart because they are answered differently, and the scope is named even when
  it skipped nothing, a `mine` run of a sprint that happens to be all yours having still answered a
  narrower question. `describeCoverage` and `describeEmptyResult` are pure and tested, being the only
  places the difference is ever stated.
- **A row can be removed from a result, and that is the one deletion needing no confirmation.**
  Right-click on the ticket, plus a `Remove from the list` button in the overview: the expert gesture
  does not have to be the discoverable one, but one of them has to be, the same pairing as the Git
  tab's `...` button. It edits `triage.json` and touches nothing in Jira, and the next run on that
  sprint brings the row back, which is exactly why no dialog stands in front of it, unlike a stash
  `drop` or a discarded change. It is what a verdict cannot express, "this one is dealt with", and
  the reason that is a gesture rather than a sixth verdict: a verdict is what a run concluded, and
  only another run may replace one. The **empty result is kept** rather than deleted with its last
  ticket: `analysedAt` is what says a sprint was looked at, and dropping the entry would make a
  sprint you cleared look like one nobody ever ran.
- **The summary and assignee shown are Jira's, never the model's.** It is asked to classify, not to
  restate; letting it rewrite a summary would put text on screen that does not match the ticket.
- **One analysis at a time**, and every `Analyse` button is disabled while it runs: they share a
  single process and a single file.
- **`/browse/<KEY>` comes from `boardUrl`, shared with the Jira tab.** Two builders of the same URL
  would drift, and that form is the only one Jira Cloud resolves for every project style.
- **Five verdicts, not three.** The three that were asked for, plus `unclear` and `blocked`: a
  ticket whose description is too thin to act on is a different problem from one waiting on an API,
  and merging them hides the one a single sentence would fix.
- **`Analyse` is a play triangle, and deliberately not `.icon-button--row`.** A magnifier was tried
  first and read as "search", which is what the button is not: it launches a job that takes minutes,
  and play is the one glyph nobody has to be taught. The terminal icons of the pull request and Git
  lists fade until their row is hovered, which is right for a secondary affordance beside a row
  whose main gesture is elsewhere; this one is the tab's primary action, and a button nobody sees
  until they hover the right row is a button nobody finds. Its two paths stay in `triage-panel.ts`
  rather than moving to `icons.ts`, the rule that keeps the sync arrows in `git-panel.ts`.
- **A run is watchable, not just "busy".** A pulsing 14px icon was the first attempt and it is far
  too quiet for an operation of several minutes. The tab now streams the run: an indeterminate bar,
  the line the model is currently on (`Reading schema.graphql`), the step count and the elapsed
  time. That combination is what tells a slow run from a stuck one, which is the only question being
  asked while you wait.
- **The bar is indeterminate, and that is a decision.** Nothing here knows how long a run takes, so
  a bar filling at an invented pace would be a promise the tab cannot keep, and the first slow sprint
  would make every later one untrustworthy. No `aria-valuenow` either: inventing one would tell a
  screen reader a percentage the sighted view is careful not to claim.
- **The bar is striped, not a travelling segment.** The first version slid one 40%-wide chunk from
  `left: -40%` to `left: 100%`, so the chunk sat entirely OUTSIDE the track at both ends of its
  cycle, and `ease-in-out` made it linger there: the track read as empty for a good part of every
  loop, which is exactly what a stopped run looks like. A repeating gradient fills it at every
  instant. `background-size` is one full horizontal period of the stripes (12px across a 45 degree
  gradient is 12 x sqrt(2) on the x axis) and the animation shifts by exactly that: any other value
  leaves a visible jump once per loop. Under `prefers-reduced-motion` the stripes stay and simply
  stop, since a flat fill reads as a finished bar and the elapsed clock beside it keeps counting.
- **`min-width: 0` on the status line.** A flex item refuses to shrink below its content, so without
  it the ellipsis never fires and a long file name pushes the elapsed clock out of the bar. Same
  trap as `.workspace`, which has to be allowed to shrink for the same reason.
- **The elapsed clock ticks in the renderer.** Progress is pushed on events, and those can be twenty
  seconds apart while a file is read: without a timer of its own the line would freeze and look
  exactly like a run that had died. It exists only while something runs.
- **Pressing `Analyse` selects that sprint first.** Otherwise starting a run on a sprint you are not
  looking at leaves the panel on another one, and the progress you asked for is on a screen you
  cannot see.
- **The running bar replaces the verdict counts, it does not sit beside them.** Those counts
  describe the *previous* analysis; next to a live status they would read as the one being produced.
- **One sub-tab per verdict, sharing `.subtab` with the Git and pull request tabs.** The list used
  to stack all five behind headings, which meant scrolling past what you cannot act on to reach what
  you can. The counts sit **on** the tabs for the reason they sit on `Mine` / `All`: a count you
  have to switch view to read makes choosing a tab a guess, and it is also what makes the split
  safe, since nothing is hidden silently. Sitting on `Backend` you can still see that four tickets
  are ready. Empty verdicts keep their tab: "Ready 0" is an answer, and a tab that comes and goes
  between two analyses moves the others under the cursor.
- **Tab labels are short, the full sentence is the tooltip and the `aria-label`.** Five full labels
  with their counts do not fit a strip's bar, and a tab row that scrolls sideways is a row whose
  last tab nobody finds. The accessible name keeps the sentence, since a screen reader gets no
  tooltip and "Backend" alone does not say those tickets are the ones the API cannot serve.
- **A third column: the overview of the selected ticket.** Same grammar as the Git tab, and it grew
  a third column for the same reason: the last one holds prose that cannot be read in the width a
  list leaves over. It carries the verdict spelled out in full, why it landed there, the question,
  what answering it triggers, and the ticket's own text. Without it, checking a verdict means
  opening Jira in a browser, which is the trip this tab exists to save. **No splitter**, unlike Git:
  a diff wants whatever width you can give it, a paragraph wants a readable measure, and the app's
  own notes warn against generalising its resizers into one more.
- **Clicking a ticket row SELECTS it; the browser is a button in the overview.** The opposite of the
  pull request tab, deliberately. Faced with a list of PRs the reflex is to go read the PR, because
  nothing local can show it; here the reason for the verdict is already on this machine, so reading
  it is the everyday gesture and Jira is the deliberate one.
- **The overview shows the text the model was given, not the full description.** It is trimmed once
  and used for both the prompt and the stored ticket. A column showing a whole description beside a
  verdict drawn from an extract would invite blaming the verdict for something the model never read.
- **The estimate sits with the status and the assignee, not in a block of its own.** It is a fact about
  the ticket in the same way those two are, and it has to be on screen **before** the button rather than
  only in its tooltip: `Work on this` writes that number to Jira. "no estimate" is stated rather than
  left blank, an absent line being indistinguishable from a tab that forgot to show one.
- **`next` is asked of the model alongside the question.** "Who does what once this is answered" is
  the half that makes a decision worth taking now rather than postponing, and it is what turns a
  list of questions into a list of moves.
- **The verdict selection is session-local, and reset when the sprint changes.** Unlike `pullScope`,
  reopening the app on `Blocked` because that is where you left it would answer a question nobody
  asked this morning; and a verdict worth reading on one sprint says nothing about the next. With
  nothing chosen it opens on the first verdict that holds tickets (`firstFilledVerdict`, pure and
  tested), so a finished analysis never lands on an empty tab.
- **The active marker is filled, every other glyph in the app is stroked.** That is what tells a
  state from an action at a glance. It is a `span[role="img"]` carrying its own `aria-label`:
  `createIcon` marks the drawing `aria-hidden`, which is correct inside a named button and leaves a
  bare icon mute, so the wrapper has to be the named thing.
- **`.icon-button:hover` is guarded by `:not(:disabled)`**, like `.button` already was. Chromium
  matches `:hover` on a disabled control, so without it a button that cannot be pressed still lights
  up under the cursor and invites the click it is about to swallow.

### Handing a ticket to Claude Code

- **The handoff passes the key and the repository name, nothing else.** `TriageWork` takes issue keys,
  filters them through `ISSUE_KEY_PATTERN` and builds `/ticket <KEY> in the <repo> repository`. The
  verdict, the reason and the question stay in `triage.json`, where the session that picks the ticket
  up reads them itself: a copy pushed through a shell argument would be both fragile to quote and
  stale from the moment it was made, and the whole point of storing the analysis on disk is that any
  session can go and get it. The repository name is the exception, and it is there because the session
  no longer starts inside the repository (see below); it goes through `safeRepoName`, which strips
  anything a shell could read as syntax, since the value lands inside a double-quoted argument where
  bash expands `$` and backticks.
- **The session starts in the workspace, not in the repository, and that is the whole point.** Claude
  Code reads its instructions, skills and memory from the folder it is launched in and from that
  folder's ancestors, so a repository under a workspace starts with strictly **less** than the
  workspace does: it sees its own `CLAUDE.md` and nothing of the conventions, skills and knowledge
  several repositories share one level up. Launching at the workspace root and naming the repository
  in the prompt keeps both halves. The folder is `claudeContextRoot`, a `settings.json`-only key like
  `projectsRoot` and the poll cadences, and an **empty** value means "start in the repository", which
  is what every version before 5.2.0 did. `resolveClaudeContext` falls back to the repository when the
  configured root is not on disk: a pty spawned on a missing directory fails, and the failure would be
  a tab closing on an error about a path nobody typed today. The default is spelled out rather than
  derived with `dirname(projectsRoot)`, deliberately: the parent of a repository folder is only the
  workspace under this layout, and the same arithmetic on `C:\repos` yields the drive root, which is
  not a context but a folder whose ancestors nobody chose.
- **`runProjectCommand` takes an optional `cwd` for exactly that**, and it is the exception rather than
  the rule: a commit has to run where the repository is. The tab stays tied to the project either way,
  which is what keeps its title honest and its reserved `actionId` exempt from `reconcile`.
- **Permission prompts are off** (`--dangerously-skip-permissions`). The session is opened
  deliberately, on a ticket that was read, in a repository chosen from a menu, to do the one thing the
  tab exists for. The flag has **no `--allow-` prefix**, and a wrong spelling is not harmless: `claude`
  rejects an unknown option, so the tab would open, print a usage error and sit at a shell prompt,
  which reads exactly like a session that started and did nothing. Pinned by test for that reason.
- **Two buttons, two different promises.** `Work on this` in the overview starts the ticket you are
  reading, whatever its verdict; `Work N ready` beside the counts starts the `ready` group. Only the
  batch is limited to `ready` (`readyKeys`, pure and tested): a ticket parked on a question is one
  whose answer decides what gets built, so a batch of those would be asking an agent to choose for
  you. Refusing the single-ticket button on a non-`ready` verdict would be the opposite mistake, the
  tab overruling its reader on the strength of a language model reading a Jira description, which
  has no way of knowing the decision was taken in a corridor this morning.
- **Both ends cap at `WORK_BATCH_LIMIT`.** The main process caps because it must, the renderer caps
  so the label says the true number: a button offering `Work 12 ready` while four are silently
  dropped is worse than one saying `Work 8 ready`, and the tooltip says it is a first slice.
- **The repository is asked for, never guessed.** Same second-menu-at-the-cursor gesture as the Jira
  tab's `dev <TICKET>`, sharing `lastBranchProject` through `projectsByLastBranch()`: both gestures
  ask the same question about the same ticket, and two separate memories would each be wrong half
  the time. Jira never says which of the four repositories an issue touches, and a guess would put a
  worktree in the wrong clone.
- **It runs on the default profile, where the branch button needs interactive bash.** `dev` is a
  shell alias, which only exists once `~/.bashrc` has been read; `claude.exe` is a real executable on
  `PATH`, so `resolveDefaultProfile` is enough and the tab starts in whatever shell the user actually
  works in.
- **The batch button is pushed to the far end with `margin-left: auto`.** Not an `order` value: the
  sub-tabs are what the bar is for, and a control that launches a run of agents has no business
  sitting against `Ready` where a mis-aimed click would land on it.
- **The handoff also records itself on the board: sprint, assignee, estimate, in progress.** Four
  writes, in that order, and the order is not cosmetic: a transition can sit behind a screen that
  requires an assignee, and a ticket left "In progress" while unassigned and outside the sprint is
  precisely the state a standup argues about, so the changes that describe the work come before the one
  that announces it. They live in `jira/jira-start.ts`, each step independent, every failure collected
  rather than thrown.
- **The writes live on their own channel, `TriageStartInJira`, called after the tab is focused.** Not
  folded into `TriageWork`, and the reason is measurable: four writes per ticket over the network is
  seconds for a batch of eight, and awaiting them inside the handoff would hold the tab back for
  exactly that long, which the tab's own rule forbids (it holds an agent that asks questions, and one
  waiting behind the current tab is one nobody answers). The renderer therefore opens, focuses, *then*
  records. Folding the two back into one channel is the change to refuse.
- **Nothing in Jira can stop the handoff.** A failed write stamps a message and touches nothing else;
  Jira not being configured is the same case, reported in one sentence, since this app works for
  someone who never entered a token. `ok` on that channel is about whether the bookkeeping ran, never
  about whether the handoff succeeded, and the session is running either way.
- **The estimate comes from the analysis, never from click time.** `TriagedTicket.estimate` is asked of
  the model alongside the verdict, snapped onto `STORY_POINT_SCALE` by `nearestStoryPoints`, and read
  back off disk by the handoff through `TriageStore.findTicket`. That is what lets the channel keep
  carrying nothing but keys while still writing a number somebody will plan against: the value was
  produced by the pass that actually read the description. A missing or unusable value stays `null` and
  the step is **skipped**, because there is no safe default for a number a human plans against, and a
  blank field at least reads as a question nobody answered. The rounding also runs on read, so a
  hand-edited or older `triage.json` cannot put a value off the scale into a ticket.
- **The story point field has to be discovered, and cannot be hardcoded.** There is no fixed id: a
  company-managed project calls it `Story Points`, a team-managed one `Story point estimate`, and the
  `customfield_xxxxx` behind either is allocated per site. That is the same fact that keeps story points
  out of the Jira tab's display. `pickStoryPointField` asks `/rest/api/3/field`, keeps only
  **number-typed** fields (a text field of the same name left by an import would accept a PUT and store
  something the board cannot sum) and prefers the team-managed built-in when a site carries both, since
  only one of them is the field the board adds up. Looked up once per handoff, not once per ticket.
- **The sprint move goes through the Agile API**, `POST /rest/agile/1.0/sprint/{id}/issue`, for the
  reason `listSprints` exists: an issue's sprint is another per-site `customfield_xxxxx`, and the Agile
  endpoint says the same thing by sprint id with nothing to discover. One key per call even though it
  takes a list, so a single rejected ticket cannot fail or hide behind the seven that were fine.
- **"Current sprint" means `state === 'active'`, read and never inferred from position.** `listSprints`
  sorts active first for display, and relying on that would make `pickActiveSprint` silently wrong the
  day the sort changes for a display reason, with a ticket landing in another iteration. A board between
  sprints has none, which is real and reported as skipped rather than falling back to the next future
  sprint: moving a ticket into a sprint nobody has started is not what was asked.
- **The in-progress transition is chosen by category, and the name is only a tiebreak.**
  `IssueTransition` now carries `stage`, from the destination's `statusCategory`, for the reason an
  issue's own stage does: status names are per-project and renamed at will, so matching the string "in
  progress" finds nothing on a board that calls it "Développement". The short word list in
  `pickStartTransition` only ranks the candidates when a workflow offers several in-progress
  destinations at once, and never decides alone. No in-progress move available is a **skip**: the common
  case is a ticket already in progress, which is the state that was asked for.
- **Transitions are read at the moment of the write**, like the tab's own context menu: a workflow
  decides which moves are legal from the current status, and the three writes above may have just
  changed it.
- **The writes are announced before they happen and reported after.** `describeWork` builds both
  buttons' tooltips and names the four writes, because a control that did not say it touches Jira is one
  whose consequences you discover at the next standup; the estimate is quoted when there is one and its
  absence stated when there is not, an unmentioned omission reading as a promise. `describeStart` is the
  account afterwards: failures named and counted, since "some writes failed" is useless when the point
  is knowing which ticket and which step, and skips collapsed to their distinct reasons, eight tickets
  missing the same field being one fact.
- **Each handoff gets its OWN tab**, `workActionId(keys)` and not one shared id. Reuse is right for a
  commit or a branch, where a second click means "do that again"; it is wrong for a tab holding a
  long-lived interactive session. Shared, `runProjectCommand` found the previous handoff still running
  and handed its tab straight back: the new prompt never ran, and the only symptom was a session
  ignoring you. Keyed on the tickets rather than unique per click, because two clicks on the **same**
  ticket must land in the session already working it, not start a second agent on one worktree. The
  reserved prefix survives the suffix, which is what keeps `isUnreachable` from closing it.
- **The tab statuses are re-read on refresh, the verdicts never are.** `status` and `assignee` used to
  be frozen at analysis time with everything else, so a ticket analysed as `Ready` still read `Ready`
  after `Work on this` had moved it, and long after it was done: the one column that has to be current
  was the only one that never changed. `applyLiveFields` refreshes those two and nothing else, because
  a verdict is what a paid run concluded and only another run may replace it. Queried by **key** and
  not by sprint: a stored analysis outlives its sprint, and a query scoped to open sprints would stop
  refreshing exactly the tickets that moved on.
- **Both buttons go through `bindWork`, which stops the click.** They open a menu on a **left** click,
  and they were shipped completely dead: `showContextMenu` dismissed on any `click` reaching
  `document`, so the opening click shut the menu in the same tick, with nothing on screen and nothing
  in the logs, the menu being created and removed before a frame was painted. **This no longer depends
  on the call site** (see the context menu section below): the `stopPropagation` here is kept because
  it also stops the click travelling past the row, not because the menu needs it.

## Servers window: terminals in a second window

- **Ownership is a fact of the LAYOUT, decided in `TerminalManager`.** `setLayout` and `syncLayout`
  filter their live-session list through `layoutLive()`, so a detached session is simply not live as far
  as the dashboard's panes are concerned. `normalizeGroups` therefore drops its tab **and does not
  re-add it as an orphan** on the next sync. Filtering in the renderer instead would have the dashboard
  drop the tab, report the new layout, the manager put it back, once per round, forever. Re-attaching
  needs no code at all for the same reason: the id becomes live again and lands as an orphan, exactly
  like a freshly spawned session.
- **Each window is sent only the sessions it owns**, and that is what made this cheap.
  `TerminalPane.setSessions` already disposes the views of sessions that left the list and re-normalises
  its panes, so a dashboard that stops being told about a server frees its terminal on its own. No
  "hide this tab" flag threaded through the renderer.
- **Output is routed, never broadcast.** `TerminalPane.write` creates a view for whatever id it is
  handed, so a broadcast would build a second hidden xterm per detached server in the dashboard and feed
  it every byte of a `ng serve`. Routing costs one map lookup. `RowsChanged` *is* broadcast, and the
  difference is the point: one small payload on a poll cadence, not a byte stream.
- **`detachedIds` is a set, not a rule re-evaluated on read.** `role === 'server'` seeds it and a newly
  spawned server joins it, but once a session is in or out it stays where it was put. A derived rule
  cannot express "this shell is really a server" or "pull this one back and leave it back", and both are
  needed because the role knows what a `Run` action is and cannot know what somebody typed into a shell.
  Spawn time is the only place the role still decides, because it is the only moment with no prior
  placement to respect.
- **Closing hands the sessions back, from `closed` and not `close`.** `close` can still be cancelled,
  and re-attaching to a window that then stays open would paint the servers in two places. This is the
  app's own invariant applied to a second window: no work runs where nothing can show or stop it.
- **`App.replayed` is cleared for sessions that leave.** It ran once per id, which was safe while an id
  only ever disappeared for good. A detached server keeps its id and comes back, and without this it
  came back to a view whose scrollback was never written: an empty tab for a process running fine.
- **The tiles reuse `presentServer`.** What `serving`, `lint failed` and `crashed` look like is decided
  once for the whole app, so a tile and a projects-table row can never disagree about the same process.
  The tone is put on the tile's border as well as in the pill, because the window exists to be read from
  across a room and four characters of text are not that.
- **One forced `refreshNow` when the window opens.** The phases arrive on the monitor's cadence, so a
  window opened between two pushes would show no phase for up to ten seconds, which is exactly the
  window in which somebody is looking at it to find out whether anything needs them.
- **A grid, not a second `TerminalPane`.** No tab bar, no splitter, no active pane, nothing persisted:
  the arrangement is `ceil(sqrt(n))` columns derived from the session list. That is why `servers.ts` is
  a fraction of the pane's size, and why the layout-per-window problem never had to be solved.
- **`.terminal__view` needed no override in the grid**, only a different padding. That the shared
  container dropped into a grid cell unchanged is the clearest sign `createTerminalView` was cut at the
  right seam.

## Claude Code runs: three of them, three models

- **Three settings and not one, and the reason is not configurability for its own sake.** These are
  three different jobs: classifying a sprint is bulk reading where speed and cost dominate,
  implementing a ticket wants the strongest model there is, and writing a commit message from a diff is
  short and frequent. A single field would be right for one of them and wrong for the other two, and
  the run that suffers most is the sprint analysis, which nobody can intervene in once it starts.
- **Empty means "whatever Claude Code is set to", and it is spelled by the ABSENCE of the flag.** The
  CLI rejects a blank model, so `--model ""` is a run that fails before it starts, not a default. That
  is why `modelArgs` returns `[]` and `modelFlag` returns `''` rather than either producing an empty
  option.
- **One whitelist, in `shared/claude-model.ts`, applied to all three.** Only the `Work on this` handoff
  actually reaches a shell (`bash -ic`), where brackets are glob characters and `$` expands; the two
  headless runs go through `spawn` with an argument array and would have been safe either way. The rule
  is uniform because two rules eventually get applied to the wrong call site. `claude-opus-5[1m]` is a
  legitimate pinned name, hence the brackets in the pattern and the double quotes in `modelFlag`.
- **A well-formed model name is not an existing one, and the CLI does not help.** Verified rather than
  assumed: `claude --model does-not-exist-xyz` starts, and reports that name back in its own `init`
  event; it fails at the API call, or not visibly at all. So the form can mark `sonnet 4` and cannot
  mark `sonnett`, and saying otherwise would be a promise this app cannot keep. The same `init` event
  is where the resolved model could be read back, if it ever becomes worth showing which one ran.
- **The settings form marks an invalid value as you type.** The store normalises anything that is not a
  model name to empty, so without the mark, typing `sonnet 4` would look accepted, save, and come back
  as the default with nothing said. That is the failure `asPatch` already records in its own comment: a
  setting failing in complete silence. `asPatch` itself passes the value on **as typed** and leaves the
  judgement to the store, one question having one answer.
- **`runClaude` is no longer triage's.** Its `model`, `timeoutMs` and `label` options exist because a
  second caller arrived: fifteen minutes is right for a sprint and absurd for a commit message, and
  "the analysis timed out" in front of a commit form describes something nobody asked for. It still
  lives under `triage/` only because moving it would be churn in every importer for a folder name.

## Generate: a commit message from the staged diff

- **The diff goes IN the prompt; the run does not fetch it.** `runClaude` allows `Read`, `Grep` and
  `Glob` and nothing else, because an analysis is not a change. Letting it call `git diff` itself would
  mean granting `Bash`, and a run that can call git can call git for things nobody asked for. Handing
  the diff over also makes the prompt a string a test can hold.
- **The run starts in the repository, and that is the load-bearing part.** Claude Code reads
  `CLAUDE.md` from the folder it starts in and from its ancestors, so it follows **that repository's
  own** commit convention without this app ever having read one. That is the whole reason this beats a
  format string here. It is deliberately the opposite of `Work on this`, which starts one level up:
  that one needs what several repositories share, this one needs one repository's convention and would
  be actively misled by a sibling's. `claudeContextRoot` is therefore not used here.
- **It fills the form and never commits.** The answer is a draft like anything typed in that textarea,
  and the commit stays the separate, deliberate click it already was. A button that generated *and*
  committed would write history from a diff nobody re-read.
- **An amend reads `git diff --cached HEAD~1`, not the index.** An amend describes the last commit
  *plus* whatever is staged on top of it; reading only the index would produce a message about the
  fixup while throwing away the commit it is being folded into. `HEAD~1` does not exist on a root
  commit, so that falls back to the whole of HEAD rather than making the feature unavailable on the one
  commit where there is no convention to read yet. Recent subjects are read with `--skip=1` when
  amending: offering HEAD's own subject as an example of the form invites rewriting it back.
- **An empty diff is caught before the model starts.** A run on nothing takes the same minute as a run
  on something and comes back with an invented message, and "nothing is staged" is a sentence this app
  can write itself.
- **`gitGenerating` is not `gitBusy`.** `busy` means a write is touching the repository and greys the
  whole form; a generation touches nothing and only has to stop a second run from starting. Folded into
  `busy` it would grey out the very textarea the answer is headed for, which is also still worth typing
  in while the run takes its minute.
- **`renderGit` at the end, never `loadGit`.** Nothing about the repository changed, and re-reading it
  would let the poll's refresh carry the fresh message away. `gitEditing` guards that field only while
  it has focus, which it does not during a click on a button.
- **The answer is unwrapped, not cleaned up.** A code fence surrounding the *whole* answer is stripped,
  because it is the one wrapper a model adds even when told not to and it would otherwise become the
  subject line. A preamble is deliberately left in: the rules that catch "Here is the commit message:"
  also catch a legitimate subject ending in a colon, and one stray line at the top of a textarea is
  deleted in a second, whereas a subject eaten by a cleanup rule is not. An empty or essay-length
  answer is reported rather than pasted, the textarea possibly holding something worth keeping.

## Context menu: it forgives its own opening click

- **The dismissal ignores exactly one click, the one that opened the menu.** Without it, a menu opened
  from a **left**-click handler is closed by that same click as it reaches the `document` listener, in
  the same tick, before a frame is painted: nothing on screen, nothing in the console, a button that
  looks dead. Right-click openers were never affected, `contextmenu` firing no `click` at all.
- **It is a mechanism now because the note was not one.** The rule used to be "call `stopPropagation`
  at every left-click opener", written into this file after the Triage tab shipped both its buttons
  dead. It then happened again, to the Worktrees tab's two openers, with the note sitting right there.
  Twice is a design problem, not an attention problem.
- **A flag set by `showContextMenu` itself, not the identity of the opening event.** Recognising the
  event was the first attempt and is subtly wrong: it needs a capture-phase listener on `document`, and
  `bindDismissal` is lazy, so on the very first menu of a session that listener is registered while the
  opening click is already past document's capture phase. The first menu after launch would close on
  its own and every later one would work, which is an intermittent version of the bug being fixed. A
  flag set inside `showContextMenu` has no ordering dependency at all.
- **It is cleared twice over, and both matter.** The dismissal consumes it, so the next click dismisses
  normally; a `setTimeout` also clears it, for a menu opened from something that is not a click, whose
  flag would otherwise sit armed and swallow the first genuine dismissal. A real click always lands in
  a later task than the open, so the timeout can never disarm a flag still in use.
- **Not covered by a test, and that is the whole shape of this bug.** The tests run under
  `environment: 'node'` with no jsdom, on purpose: renderer modules here stay importable without a DOM,
  and this file avoids import-time listeners for exactly that reason. So the menu's *contents* are pure
  and tested while its *opening* is not, and both times this shipped broken it was the opening.

## Mail and Teams: why they are not here

Asked for in V3, dropped after measurement rather than for lack of time:

- **Classic Outlook over COM can be unavailable** while Outlook is installed. When the new client is
  active (`Outlook\Preferences\UseNewOutlook = 1` on the user side), launching `OUTLOOK.EXE` hands over
  to the new Outlook and then exits **without registering its COM class**: activation fails after about
  thirty seconds with `CO_E_SERVER_EXEC_FAILURE`. Reproduced twice.
- **Microsoft Graph requires an app registration**, and therefore a tenant that allows one. Many
  companies refuse it (`defaultUserRolePermissions.allowedToCreateApps = false`, no user consent
  policy), and the trap is the Azure CLI token: its `scp` claim (`Application.ReadWrite.All`, and so on)
  belongs to **the CLI application**, not to the user's own rights, which wrongly suggests one can be
  created from the command line. Check this before writing code.
- **The Teams activity bell has no read API**, even through Graph. The most that can be read is
  `GET /me/chats` plus `viewpoint.lastMessageReadDateTime`, which already excludes channel mentions.

If the app registration ever arrives: public client, `http://localhost` redirect, delegated `Mail.Read`
plus `offline_access` (plus `Chat.Read`), `@azure/msal-node` in device code flow, token encrypted by the
`SecretStore` that already exists, and a monitor modelled on `JiraMonitor`. The space in
`.projects__header-actions` (formerly `.topbar__actions`, gone with the title bar) and the strip's
pattern are left ready.

## Configurable projects

- **Projects are configuration, not code.** `ProjectId` is a free string and the list lives in
  `settings.json`. Do not reintroduce a hardcoded list: `SEED_FOLDERS` is only there for the first
  launch's seeding.
- **`kind` and `expectedPort` stay `null` by default** so they follow the repository's `package.json`.
  Filling them in by force would let the configuration drift from the real project.
- **The id is derived from the folder, the label is editable.** A rename must never change the id, or the
  running terminal becomes an orphan.
- **A project is a folder, not necessarily an npm project.** Only an empty or non-existent path is a
  validation `error`; a missing `package.json`, or a missing script an action points at, is a `warning`.
  Those cases break one button, while git status, the terminal and `commit` all work. As an `error`, a
  single row of that kind blocked the "Save" button for the whole settings dialog.
- **The renderer does not build a project configuration.** `buildProjectConfig` (IPC) builds it in the
  main process, so a project added from the table and a project added from the settings are identical:
  same id derivation, same label, same default actions. It used to be duplicated in both places, and
  already with two diverging label rules.
- **Changing the list rebuilds the monitor** and closes the terminals that have become unreachable
  (`reconcile`). The monitor keys its state by project, so mutating it in place would leave phantom rows.
- **`expectedPort` no longer drives anything** since the probe was removed: it only serves the settings
  display. The port shown by the `serving :4201` badge comes from the process output, not from that setting.
  Still to decide: remove it or make it read-only.

## Verified traps

- **`stripAnsi` must be anchored on `\x1b`.** Without the anchor, the pattern eats `[ERROR]` itself.
- **`gh pr checks --watch` blocks.** Use `gh pr view --json statusCheckRollup`.
- **An empty rollup is not a success.** The `no-checks` verdict is distinct from `passing`.
- **The pty is a prebuilt Node-API binary** (`@lydell/node-pty`), so it loads into Electron without
  recompilation. The machine has no Visual Studio C++ workload: do not introduce a native dependency
  that would require `node-gyp`.
- **Packaging**: `**/*.node` must be in `asarUnpack`. Two targets are produced, NSIS and portable, and
  the portable one needs its own `artifactName`: both emit a `.exe` and would fight over the same file
  name. They deliberately share the `appId`, and therefore the same `userData` and the same
  single-instance lock.
- **The icon is `resources/icon.ico`**, multi-size (16 to 256), generated rather than drawn by hand:
  each size is traced at its own resolution, with a proportionally thicker stroke below 32 px where
  downscaling turns the glyph to mush. `windowIcon()` only passes it to windows **in dev**: a packaged
  exe already carries its icon, and the file is not in the bundle.
- **No `DEFAULT_SETTINGS` constant may come from a module that imports others.** When `settings-store`
  imported `DEFAULT_PROJECTS_ROOT` from `registry`, the constant was `undefined` when `DEFAULT_SETTINGS`
  was evaluated: `projectsRoot` went out empty, the seeding scanned a non-existent path, and the
  dashboard started with an empty table and not a single error. Those values live in
  `projects/project-id.ts`, which imports nothing.

## Typography

- **No hardcoded font size in the CSS.** All 64 `font-size` declarations go through seven tokens
  (`--font-3xs` to `--font-xl`) which are **ratios** of `--ui-font-size`, written on the root element
  from `uiFontSize`. Ratios and not absolute sizes, for a measurable reason: subtracting a fixed pixel
  amount from a variable base flattens the scale as the base grows, and a configurable typographic scale
  then becomes seven sizes that all look alike.
- **The ratios are the historical sizes divided by 12**, the middle step. At the default base nothing
  moves by a fraction of a pixel: this was a refactor, not a redesign. Adding a rule means `--font-md`
  unless there is an explicit reason; the extremes exist because the design already used them (uppercase
  column headers, badges).
- **The terminal is NOT on that scale.** xterm carries its size as an option, fed by `terminalFontSize`:
  two separate settings because they answer two different questions ("can I read the app" versus "how
  much output fits in a pane"). Do not merge them.
- **`applyUiFontSize` is called in BOTH renderers.** The dashboard and the settings window are two pages
  of the same chrome; a setting that resized one and not the other would read as a bug, all the more so
  since the form that changes it is in the window that would not follow. In `settings.ts` it is called
  **before** the guards in `onSettingsChanged`, otherwise the echo of its own save, which is the exact
  case that resizes this form, would be discarded.
- **Changing the interface size refits the terminal.** Larger text makes the tab row and the strip's
  chrome taller, so the box left to the terminal changes size without the window having moved: `resize`
  does not fire.
- **The bounds (`UI_FONT_SIZE`, 11 to 17) are tighter than the terminal's**, and that is deliberate:
  this size draws text inside boxes whose padding is fixed, and beyond that a tab row or a badge presses
  against its own borders. The clamp is duplicated on the renderer side (`clampUiFontSize`) because a
  hot-reloaded renderer can read a bootstrap from an older main process, and because a `NaN` passed to
  `setProperty` produces an invalid declaration: every token then falls back to its default, which
  changes the whole interface with nothing to signal it.

## Commands

```bash
npm run dev        # run the dashboard from source
npm test           # Vitest on the pure units
npm run lint       # ESLint, zero warnings tolerated
npm run typecheck  # tsc on the node, web and test projects
npm run dist       # installer in release/
```

## Conventions

- Strict TypeScript, `noUncheckedIndexedAccess`, no `any`.
- Code, comments, documentation and **displayed text all in English**. The interface was in
  French until 4.3.0 and was translated wholesale: a dashboard whose repository, docs and
  commits are English had no reason to answer in another language. No string is translated at
  runtime, there is no i18n layer, and adding one would be a feature nobody has asked for.
- **Commit messages in English**, present tense and imperative (`Add`, `Fix`, `Refactor`), first
  letter capitalised, no trailing period, no emoji. The history was rewritten on 2026-08-12 to apply
  this rule, so do not take an old commit's style as licence to break it.
- Comments explain the *why* of a non-obvious choice.
- Presentation logic lives in `presenters.ts`, pure and tested, separate from the DOM.
