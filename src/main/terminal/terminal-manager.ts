import * as pty from '@lydell/node-pty';
import type { IPty } from '@lydell/node-pty';
import { PANE_COLUMNS_AUTO, RESERVED_ACTION_PREFIX } from '@shared/contracts.js';
import type {
  ActionRole,
  Project,
  ProjectAction,
  ProjectId,
  SessionAgent,
  SessionNote,
  ShellProfile,
  TerminalGroup,
  TerminalId,
  TerminalKind,
  TerminalLayout,
  TerminalSession,
  TerminalSize,
} from '@shared/contracts.js';
import { trimNote } from '@shared/session-note.js';
import { normalizeGroups, sanitizeColumns } from '@shared/terminal-groups.js';
import { spawnOffThread } from '../spawn/spawn-pool.js';
import { Scrollback } from './scrollback.js';
import { parseOutputChunk, type ParsedOutput } from '../projects/output-parser.js';

/**
 * Characters of output retained per session, so a tab can be reopened without losing history.
 *
 * Bounded: a dev server left running for hours would otherwise grow this without limit. How the
 * bound is enforced is {@link Scrollback}'s business, and it is not a detail: the obvious enforcement
 * recopies all 200 000 characters on every chunk a pty emits, which is what this used to do.
 */
const BUFFER_LIMIT = 200_000;

/**
 * How long a restart waits for the previous process to be gone.
 *
 * `taskkill /T /F` on a dev server tree is done in well under a second, so this is a ceiling for the
 * pathological case and not an expected delay: the wait ends as soon as the exit event fires.
 */
const RESTART_EXIT_TIMEOUT_MS = 8_000;

/**
 * What a second click on an action's button should do.
 *
 * Pure and exported so the rule is pinned by a test rather than read off three branches inside a
 * method, exactly like `isClosable` and `isUnreachable` below. The interesting case is the middle one:
 * a **server** that is still running gets restarted, because "Run" that decides on its own to do
 * nothing is indistinguishable from a broken button, while a **task** that is still running is left
 * alone, because `Commit` runs hooks that take half a minute and a second click must not kill a commit
 * in flight.
 *
 * A dead session is replaced rather than revived either way: its tab and its scrollback are worth
 * keeping right up to the moment the same action runs again.
 */
export type RerunDecision = 'spawn' | 'reuse' | 'restart';

/** A session minus what `sessions()` derives: see `Entry.session`. */
type StoredSession = Omit<TerminalSession, 'role'>;

export function decideRerun(
  existing: { readonly running: boolean } | undefined,
  role: ActionRole,
): RerunDecision {
  if (existing === undefined || !existing.running) {
    return 'spawn';
  }
  return role === 'server' ? 'restart' : 'reuse';
}

interface Entry {
  /**
   * The session as stored, without the two fields that are **derived** on the way out.
   *
   * `closable` depends on live state and `role` lives on the entry beside it, so both are added in
   * `sessions()`. Storing either here would be a second copy able to disagree with the first.
   */
  readonly session: StoredSession;
  readonly pty: IPty | null;
  /**
   * Role of the action this tab runs, null for a shell.
   *
   * Kept here rather than on the session: it decides closability and whether output feeds the row's
   * server state, both of which are the main process's business, not the renderer's.
   */
  readonly role: ActionRole | null;
  readonly scrollback: Scrollback;
}

export interface TerminalHooks {
  onOutput: (terminalId: TerminalId, data: string) => void;
  /** The set of visible panes changed and the surface must be laid out again. */
  onLayoutChanged: (layout: TerminalLayout) => void;
  /** Phase changes derived from a `server` action's output. */
  onParsed: (projectId: ProjectId, parsed: ParsedOutput) => void;
  /** A `server` action ended, so its row must stop claiming a server. */
  onProjectStartExit: (projectId: ProjectId, exitCode: number, stopped: boolean) => void;
  /** The session list changed and the tab strip must be rebuilt. */
  onSessionsChanged: (sessions: TerminalSession[]) => void;
}

/**
 * Owns every pseudo-terminal: project commands and free-form shells alike.
 *
 * Sessions are keyed by their own id rather than by project. A terminal is no longer a property of a
 * project: a shell tab belongs to nothing, and keying by project made it impossible to have a shell
 * open while a dev server ran, which is the normal way of working.
 */
export class TerminalManager {
  private readonly entries = new Map<TerminalId, Entry>();
  /** Sessions stopped on purpose, so a normal exit is not reported as a crash. */
  private readonly stopping = new Set<TerminalId>();
  private counter = 0;
  /**
   * The panes and what each holds. Also **the** tab order: a group owns its tabs.
   *
   * There is no second ordering next to it any more. The strip used to be drawn from the insertion
   * order of `entries` while `panes` said which of those were on screen, so a tab had two homes and
   * they could disagree; now a tab is wherever its group says it is.
   */
  private groups: TerminalGroup[] = [];
  /**
   * Panes per row, or `PANE_COLUMNS_AUTO` for one row however many there are.
   *
   * Held here with the groups rather than read from the settings on every call: this class is the
   * authority on the layout, and a second reader of the stored preference would be a second answer
   * to what the surface currently looks like. The settings seed it once, at construction.
   */
  private columns: number = PANE_COLUMNS_AUTO;
  /**
   * Whether the servers window is currently open.
   *
   * Held here and nowhere else because this class is the only holder of a session's `role`, and because
   * the layout is its business: a detached session must leave the dashboard's panes, and putting that
   * anywhere else would mean a second answer to "which tabs exist".
   */
  private serversDetached = false;
  /**
   * Exactly which sessions the servers window owns.
   *
   * A **set** and not a rule re-evaluated on every read, and the difference is the whole reason a tab
   * can be moved by hand. `role === 'server'` is what seeds it and what a newly spawned server joins,
   * but once a session is in or out, it stays where it was put: pulling a server back to the dashboard
   * has to survive the next spawn, and sending a shell over has to survive at all, neither of which a
   * derived rule can express.
   *
   * Only meaningful while `serversDetached`; emptied when the window closes, so there is no stale
   * membership to reconcile the next time it opens.
   */
  private readonly detachedIds = new Set<TerminalId>();

  constructor(
    private readonly hooks: TerminalHooks,
    /**
     * The stored column preference, seeded once.
     *
     * A constructor argument and not a setter, so there is never a frame where the manager holds a
     * default the renderer is about to contradict: the bootstrap carries the layout, and a layout
     * reporting the wrong shape at boot is a grid that visibly snaps into place a moment later.
     */
    initialColumns: number = PANE_COLUMNS_AUTO,
    /** Ephemeral capabilities added according to the project that owns a new process. */
    private readonly environmentFor: (projectId: ProjectId | null) => NodeJS.ProcessEnv = () => ({}),
  ) {
    this.columns = sanitizeColumns(initialColumns);
  }

  layout(): TerminalLayout {
    return { columns: this.columns, groups: this.snapshot() };
  }

  /** A copy, so a caller mutating what it received cannot reach into the manager's state. */
  private snapshot(): TerminalGroup[] {
    return this.groups.map((group) => ({ tabs: [...group.tabs], active: group.active }));
  }

  /**
   * Replaces the layout with what the renderer computed.
   *
   * Validated rather than trusted: a layout is easy to make nonsensical, and the consequences are
   * invisible until they bite. `normalizeGroups` is the whole gate, and it is the same function the
   * renderer applies, so the two sides cannot drift on what a sane layout is.
   */
  setLayout(groups: readonly TerminalGroup[], columns: number): void {
    this.columns = sanitizeColumns(columns);
    this.groups = normalizeGroups(groups, this.layoutLive());
    this.hooks.onLayoutChanged(this.layout());
  }

  /**
   * The sessions the dashboard's panes are allowed to hold.
   *
   * Everything except what is currently detached. Filtering here, in the one place both `setLayout` and
   * `syncLayout` read, is what makes detaching a **layout** fact rather than a rendering trick: a
   * detached session is simply not live as far as the panes are concerned, so `normalizeGroups` drops
   * its tab and, crucially, does not re-add it as an orphan on the next sync. Filtering in the renderer
   * instead would have the dashboard drop the tab, report the new layout, and the manager put it back,
   * once per round, forever.
   *
   * Re-attaching needs no code at all for the same reason: the id becomes live again and
   * `normalizeGroups` places it as an orphan, which is exactly how a freshly spawned session lands.
   */
  private layoutLive(): TerminalId[] {
    return [...this.entries.keys()].filter((id) => !this.isDetached(id));
  }

  /** True when this session belongs to the servers window rather than to the dashboard. */
  isDetached(id: TerminalId): boolean {
    return this.serversDetached && this.detachedIds.has(id);
  }

  /**
   * Moves one session between the two windows.
   *
   * The escape hatch for what the role cannot know: a `npm run start` typed by hand into a shell is a
   * dev server in every way that matters and a `shell` session as far as this app can tell, so the only
   * honest answer is to let it be said. It works in both directions, which also makes it the correction
   * for a `server` action that is not really a server.
   *
   * A no-op when the servers window is closed: there would be nowhere for the session to go, and moving
   * it anyway would take a tab off the dashboard and give it to nobody.
   */
  moveTerminal(id: TerminalId, toServers: boolean): void {
    if (!this.serversDetached || !this.entries.has(id) || this.isDetached(id) === toServers) {
      return;
    }
    if (toServers) {
      this.detachedIds.add(id);
    } else {
      this.detachedIds.delete(id);
    }
    this.syncLayout();
    this.hooks.onSessionsChanged(this.sessions());
  }

  /**
   * Moves the `server` sessions to their own window, or brings them back.
   *
   * Both hooks fire, and both are needed: the layout because the dashboard's panes gain or lose tabs,
   * and the session list because each window is sent only the sessions it owns. No pty is touched, which
   * is the point of doing this at the layout level: a detached server keeps running, keeps its
   * scrollback in `entry.buffer`, and only changes which window paints it.
   */
  setServersDetached(detached: boolean): void {
    if (this.serversDetached === detached) {
      return;
    }
    this.serversDetached = detached;
    this.detachedIds.clear();
    if (detached) {
      // Seeded from the role, once. From here on membership is explicit: see `detachedIds`.
      for (const [id, entry] of this.entries) {
        if (entry.role === 'server') {
          this.detachedIds.add(id);
        }
      }
    }
    this.syncLayout();
    this.hooks.onSessionsChanged(this.sessions());
  }

  /**
   * Keeps the layout coherent after sessions appear or disappear.
   *
   * A closed session must leave its strip, and a pane emptied that way must go with it. A newly
   * spawned one has to land in a group immediately: a session in no group has no tab anywhere, so it
   * would be running with nothing able to show or stop it. `normalizeGroups` does both, which is why
   * the renderer only has to say where it *would like* a new tab, never make sure it exists.
   */
  private syncLayout(): void {
    const before = JSON.stringify(this.groups);
    this.groups = normalizeGroups(this.groups, this.layoutLive());
    if (JSON.stringify(this.groups) !== before) {
      this.hooks.onLayoutChanged(this.layout());
    }
  }

  sessions(): TerminalSession[] {
    // `closable` is computed here rather than stored, because it depends on live state: a tab becomes
    // closable the moment its process ends, and the strip re-renders on every session change.
    return [...this.entries.values()].map((entry) => ({
      ...entry.session,
      closable: isClosable(entry.session, entry.role),
      // Exposed so a renderer can tell a dev server from a shell without asking. `closable` is already
      // derived from it here; the servers window needs the same fact to know which sessions are its own
      // in the one payload that is not filtered per window, `bootstrap`.
      role: entry.role,
    }));
  }

  buffer(terminalId: TerminalId): string {
    return this.entries.get(terminalId)?.scrollback.text() ?? '';
  }

  /** Projects with a running `server` action, used by the quit guard. */
  runningProjectStarts(): ProjectId[] {
    return [...this.entries.values()]
      .filter(
        (entry) =>
          entry.session.running && entry.role === 'server' && entry.session.projectId !== null,
      )
      .map((entry) => entry.session.projectId as ProjectId);
  }

  /**
   * Runs one of a project's actions, reusing the tab already dedicated to that action.
   *
   * Reuse rather than a new tab each time: clicking Run twice should not litter the strip, and the
   * previous output of the same action is exactly the history the user wants to keep.
   *
   * **For a `server` action, clicking Run means "restart"**: a process still alive is stopped, its exit
   * awaited, and the action relaunched. The rule it replaces ("already running, hand back the tab and
   * start nothing") looked harmless and was the opposite: it made Run a button that silently did
   * nothing in every state where the row disagreed with the sessions, and the user has no way to tell
   * "nothing to do" from "this is broken". A restart always does something observable, and it is also
   * the repair for such a disagreement rather than its victim.
   *
   * Asynchronous because of that wait, and the wait is the point: relaunching a dev server before the
   * old one has released its port would fail with `address in use` for a reason that has nothing to do
   * with the user's code. Bounded all the same — see `stopAndAwaitExit`.
   *
   * A `task` keeps the old behaviour, deliberately: `Commit` runs hooks that can take half a minute,
   * and a second click on it must not kill a commit in flight. See `decideRerun`.
   */
  async runProjectAction(
    project: Project,
    action: ProjectAction,
    profile: ShellProfile,
    size: TerminalSize,
  ): Promise<TerminalId | null> {
    const existing = this.findActionSession(project.id, action.id);
    if (existing !== undefined) {
      const decision = decideRerun(existing.session, action.role);
      if (decision === 'reuse') {
        // Hand the caller the tab so it can be focused, but start nothing.
        return existing.session.id;
      }
      if (decision === 'restart') {
        await this.stopAndAwaitExit(existing.session.id);
      }
      this.entries.delete(existing.session.id);
    }

    const resolved = resolveActionCommand(action, profile);
    return this.spawn({
      // A rerun keeps a name the user set: re-deriving it would silently undo the rename every time
      // the action is launched again.
      title:
        existing?.session.renamed === true
          ? existing.session.title
          : actionTitle(project, action),
      renamed: existing?.session.renamed === true,
      kind: 'project',
      projectId: project.id,
      actionId: action.id,
      role: action.role,
      profileId: profile.id,
      cwd: project.path,
      file: resolved.file,
      args: resolved.args,
      size,
      projectKind: project.kind,
    });
  }

  /**
   * Runs a one-shot command in a project's folder, in a tab of its own.
   *
   * The path the Git tab's commit takes. It is deliberately **not** a `ProjectAction`: an action is
   * user configuration living in `settings.json`, whereas this command is built by the app from what
   * the user typed in a form, and inventing a fake action to carry it would put a phantom button in
   * the settings window.
   *
   * Whatever the caller names is spawned as given, with **no shell inserted here**. That is the
   * difference from `runProjectAction`, and it is the point for the commit: a commit message is
   * arbitrary text, so passing it through `bash -ic` would mean quoting it correctly against a shell,
   * forever. There is no shell to quote against, and the message travels through a file anyway. A
   * caller that genuinely needs a shell (the Jira tab's `dev <TICKET>`, an alias) resolves one with
   * `resolveShellCommand` and hands the result in, which keeps that decision at the call site instead
   * of making this method guess.
   *
   * Reuse follows the same rule as an action: one tab per `actionId`, replaced once its process has
   * ended, so committing twice does not litter the strip.
   */
  runProjectCommand(options: {
    project: Project;
    /** Reserved id, `git:`-prefixed, which is what exempts the tab from `reconcile`. */
    actionId: string;
    title: string;
    file: string;
    args: readonly string[];
    size: TerminalSize;
    /** Profile the command was resolved against, recorded so a split inherits the same shell. */
    profileId?: string | null;
    /**
     * The coding agent this command runs, when it runs one.
     *
     * Passed in rather than inferred, and the caller is the only one who can know: it is the one that
     * built the command line from a profile and a model, and by the time the string reaches here it
     * is just a program and some arguments.
     */
    agent?: SessionAgent | null;
    /** What this session is for, when the caller knows. Seeded by the ticket handoff. */
    note?: string | null;
    /**
     * Folder to start in, when it is not the project's own.
     *
     * The exception, not the rule: a commit has to run where the repository is. It exists for the
     * triage handoff, which starts a Claude Code session in the workspace *above* the repositories so
     * the session inherits the instructions and skills kept there, and names the repository in its
     * prompt instead. The tab stays tied to the project either way, which is what keeps its title
     * honest and its `actionId` exempt from `reconcile`.
     */
    cwd?: string;
    /**
     * Called once the command's process is gone, with its exit code and whether it was killed by us.
     *
     * The one way a caller can chain anything onto a command that runs in a tab. It is a real signal
     * and not an inferred one: this manager spawned the process and is handed its exit by node-pty,
     * which is exactly the difference with the worktree helper, where the app refuses to decide when a
     * command it did not run is done.
     *
     * `stopped` is true when the session was killed on purpose (a close, a restart), and a caller must
     * treat that as "did not finish" however the exit code reads: a killed process can still exit 0.
     */
    onExit?: ((exitCode: number, stopped: boolean) => void) | undefined;
  }): TerminalId | null {
    const existing = this.findActionSession(options.project.id, options.actionId);
    if (existing !== undefined) {
      if (existing.session.running) {
        return existing.session.id;
      }
      this.entries.delete(existing.session.id);
    }

    return this.spawn({
      title: existing?.session.renamed === true ? existing.session.title : options.title,
      renamed: existing?.session.renamed === true,
      kind: 'project',
      projectId: options.project.id,
      actionId: options.actionId,
      // `task`, so the tab is closable at any moment and its output is never parsed as build markers.
      role: 'task',
      profileId: options.profileId ?? null,
      cwd: options.cwd ?? options.project.path,
      file: options.file,
      args: [...options.args],
      size: options.size,
      projectKind: null,
      agent: options.agent ?? null,
      note: options.note ?? null,
      onExit: options.onExit ?? null,
    });
  }

  /**
   * Opens a shell in a project's repository, reusing the one already there.
   *
   * Reuse is the whole point: clicking a row opens this, and a gesture that easy must not stack a tab
   * per click. A shell that has exited (the user typed `exit`) is replaced rather than revived, exactly
   * as a rerun of an action does.
   */
  openProjectShell(
    project: Project,
    profile: ShellProfile,
    size: TerminalSize,
  ): TerminalId | null {
    const existing = [...this.entries.values()].find(
      (entry) => entry.session.kind === 'shell' && entry.session.projectId === project.id,
    );
    if (existing !== undefined) {
      if (existing.session.running) {
        return existing.session.id;
      }
      this.entries.delete(existing.session.id);
    }

    return this.spawn({
      title: existing?.session.renamed === true ? existing.session.title : project.label,
      renamed: existing?.session.renamed === true,
      kind: 'shell',
      projectId: project.id,
      actionId: null,
      role: null,
      profileId: profile.id,
      cwd: project.path,
      file: profile.file,
      args: [...profile.args],
      size,
      projectKind: null,
    });
  }

  /** Opens a free-form shell tab from a profile. */
  openShell(
    profile: ShellProfile,
    size: TerminalSize,
    overrides: { cwd?: string; title?: string } = {},
  ): TerminalId | null {
    return this.spawn({
      title: overrides.title ?? profile.label,
      kind: 'shell',
      projectId: null,
      actionId: null,
      role: null,
      profileId: profile.id,
      cwd: overrides.cwd ?? profile.cwd,
      file: profile.file,
      args: [...profile.args],
      size,
      projectKind: null,
      renamed: false,
    });
  }

  /**
   * Opens a coding agent in a tab of its own, tied to no project.
   *
   * A `shell` and not a `project` command, because it belongs to nothing: there is no action behind
   * it, no row whose state it feeds, and it is closable from the first second. What separates it from
   * an ordinary shell is the `agent` record, which is what the Agents tab lists.
   *
   * The caller resolves the command and the folder. This class knows how to spawn things; which
   * binary an agent is and where a session ought to start are decisions made where the settings are.
   */
  openAgent(options: {
    title: string;
    file: string;
    args: readonly string[];
    cwd: string;
    size: TerminalSize;
    profileId: string | null;
    agent: SessionAgent;
  }): TerminalId | null {
    return this.spawn({
      title: options.title,
      kind: 'shell',
      projectId: null,
      actionId: null,
      role: null,
      profileId: options.profileId,
      cwd: options.cwd,
      file: options.file,
      args: [...options.args],
      size: options.size,
      projectKind: null,
      renamed: false,
      agent: options.agent,
    });
  }

  /**
   * Types bytes into a session's stdin, and says whether anything took them.
   *
   * The boolean was added for the vault and it is not a nicety. This was a silent no-op for an
   * unknown id and for an exited pty, which is right for a keystroke (the tab is gone, so is the
   * key) and wrong for a secret: somebody who believes a key went into a prompt and it did not will
   * paste it somewhere else, probably somewhere worse. The one side that knows whether a pty is
   * alive is this one, so it is the side that answers; re-deriving it from `sessions()` in `ipc.ts`
   * would be the second authority `stopProjectServer` already records as a mistake.
   */
  write(terminalId: TerminalId, data: string): boolean {
    const pty = this.entries.get(terminalId)?.pty;
    if (pty === undefined || pty === null) {
      return false;
    }
    pty.write(data);
    return true;
  }

  resize(terminalId: TerminalId, size: TerminalSize): void {
    const entry = this.entries.get(terminalId);
    if (entry?.pty == null) {
      return;
    }
    try {
      entry.pty.resize(Math.max(2, size.cols), Math.max(2, size.rows));
    } catch {
      // The process can exit between the resize event and this call; harmless.
    }
  }

  /**
   * Tells a pty its screen was cleared, and forgets the output it had accumulated.
   *
   * `pty.clear()` is a no-op everywhere except ConPTY, and on ConPTY it is the whole point: ConPTY
   * holds its own copy of the console buffer and reprints it at the next thing that makes it repaint
   * (a resize, a full-screen program redrawing). Clearing xterm alone therefore erases the screen
   * until ConPTY puts the very same text back — a full-screen TUI makes that happen within seconds.
   *
   * The retained buffer goes with it, or a renderer restart would replay exactly what was cleared.
   */
  clear(terminalId: TerminalId): void {
    const entry = this.entries.get(terminalId);
    if (entry === undefined) {
      return;
    }
    entry.scrollback.clear();
    try {
      entry.pty?.clear();
    } catch {
      // The process can exit between the click and this call; harmless.
    }
  }

  /**
   * Drops the tabs a configuration change has left unreachable.
   *
   * Three cases, one rule: a running process must always have a button able to stop it.
   * - its project no longer exists;
   * - its action no longer exists;
   * - it was spawned as the `server` action and no longer is, because the row then shows neither
   *   `Run` nor `Stop` for it and the port would stay held with nothing left to press.
   *
   * The reconciliation lives here because the spawned role does, and it is what the third case turns
   * on. A caller comparing sessions to configuration from outside cannot see it.
   */
  reconcile(projects: readonly Project[]): void {
    const byId = new Map(projects.map((project) => [project.id, project]));

    for (const entry of [...this.entries.values()]) {
      if (isUnreachable(entry.session, entry.role, byId.get(entry.session.projectId ?? ''))) {
        this.close(entry.session.id);
      }
    }
  }

  /**
   * Stops a project's running `server` action.
   *
   * The lookup lives here rather than in the renderer. It used to be the renderer's job: find the
   * project's server action, then find the session whose `actionId` matches it. Two hops through
   * shapes it does not own, each of which silently yields nothing when they drift, which is exactly
   * how `Stop` became a button that did nothing at all. The main process already knows which session
   * carries the `server` role, so it is the only place the answer cannot be wrong.
   *
   * @returns true when something was actually stopped.
   */
  stopProjectServer(projectId: ProjectId): boolean {
    const entry = [...this.entries.values()].find(
      (candidate) =>
        candidate.session.projectId === projectId &&
        candidate.role === 'server' &&
        candidate.session.running,
    );
    if (entry === undefined) {
      return false;
    }
    this.stop(entry.session.id);
    return true;
  }

  /**
   * Stops a session and waits for its process to actually be gone.
   *
   * `stop` only asks: `taskkill /T /F` is a request to Windows that returns long before the tree is
   * down. A restart that spawned immediately after it would race the dying server for its own port, so
   * this is what makes "stop then run" mean what it says.
   *
   * Bounded, and the bound is not a formality: a process that refuses to die must not freeze the
   * button. Past the deadline the relaunch happens anyway and the truth ends up where it belongs, in
   * the tab's own output — which is the same trade-off this app already accepts for a port held from
   * outside. The stale exit that then arrives is dropped by the guard in `onExit`.
   */
  private async stopAndAwaitExit(terminalId: TerminalId): Promise<void> {
    const entry = this.entries.get(terminalId);
    const child = entry?.pty ?? null;
    if (entry === undefined || child === null || !entry.session.running) {
      return;
    }

    // Subscribed before the kill, or a process that dies instantly would exit between the two lines
    // and the wait would then run to its full timeout for nothing.
    const exited = new Promise<void>((resolve) => {
      const subscription = child.onExit(() => {
        subscription.dispose();
        resolve();
      });
    });

    this.stop(terminalId);
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, RESTART_EXIT_TIMEOUT_MS)),
    ]);
  }

  /** Stops a session's process and everything it spawned, keeping the tab and its output. */
  stop(terminalId: TerminalId): void {
    const entry = this.entries.get(terminalId);
    if (entry?.pty == null || !entry.session.running) {
      return;
    }
    this.stopping.add(terminalId);
    killTree(entry.pty);
  }

  /**
   * Renames a tab.
   *
   * An empty name is refused rather than accepted: a nameless tab is unclickable in practice, and
   * silently keeping the old one is what the user expects from clearing the field and pressing Enter.
   */
  rename(terminalId: TerminalId, title: string): void {
    const entry = this.entries.get(terminalId);
    const trimmed = title.trim();
    if (entry === undefined || trimmed.length === 0 || trimmed === entry.session.title) {
      return;
    }
    this.entries.set(terminalId, {
      ...entry,
      session: { ...entry.session, title: trimmed, renamed: true },
    });
    this.hooks.onSessionsChanged(this.sessions());
  }

  /**
   * Writes what a session is for, or clears it.
   *
   * An empty text removes the note rather than storing a blank one, which is why there is no second
   * channel for deleting: two ways to say "no note" would be two states to keep in step. The stamp
   * is refreshed on every write, because the card shows the note's age and an edit is what makes an
   * old sentence current again.
   */
  setNote(terminalId: TerminalId, text: string): void {
    const entry = this.entries.get(terminalId);
    if (entry === undefined) {
      return;
    }
    const trimmed = trimNote(text);
    // Nothing changed, so nothing is broadcast: a session list pushed for an identical note rebuilds
    // every tab strip in both windows for no visible difference.
    if (trimmed === (entry.session.note?.text ?? null)) {
      return;
    }
    this.entries.set(terminalId, {
      ...entry,
      session: {
        ...entry.session,
        note: trimmed === null ? null : { text: trimmed, writtenAt: new Date().toISOString() },
      },
    });
    this.hooks.onSessionsChanged(this.sessions());
  }

  /** Stops if needed, then forgets the tab entirely. */
  close(terminalId: TerminalId): void {
    const entry = this.entries.get(terminalId);
    if (entry === undefined) {
      return;
    }
    if (entry.session.running) {
      this.stop(terminalId);
    }
    this.entries.delete(terminalId);
    this.hooks.onSessionsChanged(this.sessions());
    // A closed session must leave the surface too, or its pane would be a hole in the layout.
    this.syncLayout();
  }

  /** Stops every running session, for application shutdown. */
  stopAll(): void {
    for (const [id, entry] of this.entries) {
      if (entry.session.running) {
        this.stop(id);
      }
    }
  }

  /* ------------------------------------------------------------------ inner */

  private spawn(options: {
    title: string;
    kind: TerminalKind;
    projectId: ProjectId | null;
    actionId: string | null;
    role: ActionRole | null;
    profileId: string | null;
    cwd: string;
    file: string;
    args: string[];
    size: TerminalSize;
    projectKind: Project['kind'] | null;
    renamed: boolean;
    /** The coding agent this command runs, when it runs one. See `runProjectCommand`. */
    agent?: SessionAgent | null;
    /** See `runProjectCommand`. */
    note?: string | null;
    /** See `runProjectCommand`. Null for every spawn that chains nothing. */
    onExit?: ((exitCode: number, stopped: boolean) => void) | null;
  }): TerminalId | null {
    this.counter += 1;
    const id = `${options.kind}-${this.counter}`;

    let child: IPty;
    try {
      child = pty.spawn(options.file, options.args, {
        cwd: options.cwd,
        cols: options.size.cols,
        rows: options.size.rows,
        env: { ...process.env, ...this.environmentFor(options.projectId), FORCE_COLOR: '1' },
      });
    } catch (error) {
      // A profile pointing at a missing executable must surface in the tab rather than crash the
      // main process, so the failure is recorded as a dead session carrying the message.
      const message = error instanceof Error ? error.message : String(error);
      this.entries.set(id, {
        session: {
          ...baseSession(id, options),
          running: false,
          closable: true,
          // The pty could not be spawned at all, which is a failure and not a clean end. `-1` is the
          // code the `onExit` callback is handed on this path, so the two agree.
          exitCode: -1,
        },
        pty: null,
        role: options.role,
        // A session that failed to launch still gets a tab and a pane: its scrollback carries the
        // reason.
        scrollback: failedScrollback(options.file, message),
      });
      this.hooks.onSessionsChanged(this.sessions());
      // A command that never launched has to reach a chained caller too, or `Commit and push` would
      // simply never say anything when git could not be spawned at all.
      options.onExit?.(-1, false);
      return id;
    }

    const entry: Entry = {
      session: { ...baseSession(id, options), running: true, closable: false },
      pty: child,
      role: options.role,
      scrollback: new Scrollback(BUFFER_LIMIT),
    };
    this.entries.set(id, entry);
    /*
     * A server launched while the servers window is open goes straight there.
     *
     * This is the only place the role still decides membership, and it has to be here rather than in
     * `isDetached`: clicking `Run` on a second monitor's worth of servers must not require moving each
     * one by hand, while a session already placed by hand must not be re-grabbed. Spawn time is exactly
     * the moment where there is no prior placement to respect.
     */
    if (this.serversDetached && options.role === 'server') {
      this.detachedIds.add(id);
    }

    child.onData((data) => {
      entry.scrollback.push(data);
      this.hooks.onOutput(id, data);
      // Only a `server` action's output describes a server. A commit TUI or an interactive shell could
      // otherwise print something that looks like a build marker and rewrite a row's state.
      if (
        options.role === 'server' &&
        options.projectId !== null &&
        options.projectKind !== null
      ) {
        this.hooks.onParsed(options.projectId, parseOutputChunk(data, options.projectKind));
      }
    });

    child.onExit(({ exitCode }) => {
      const stopped = this.stopping.delete(id);
      /*
       * The chained caller is told first, and whatever state the tab is in.
       *
       * Before the `current === undefined` guard on purpose: that guard is about not repainting a row
       * from a process the manager no longer accounts for, which says nothing about whether the
       * command ran. A commit whose tab was closed while its hooks were working still committed, and
       * `stopped` is what separates that from a tab the user killed.
       */
      options.onExit?.(exitCode, stopped);
      const current = this.entries.get(id);
      if (current === undefined) {
        /*
         * The session was replaced or closed before its pty got round to exiting, so this exit
         * describes a process the manager no longer accounts for. Reporting it would be a statement
         * about the **previous** process applied to the row of the current one: `markExited` is keyed
         * by project, so the row would flip to `crashed` while a freshly started server is booting
         * behind it. And that state is a trap rather than a cosmetic glitch — the row then shows `Run`
         * (nothing looks owned) while a session is very much running, so the click resolved to "reuse
         * the tab, start nothing" and the button did nothing at all, forever.
         *
         * The window is real, not theoretical: `close()` deletes the entry immediately after asking
         * `taskkill` to bring the tree down, and a restart deletes it on purpose, so every kill has a
         * few hundred milliseconds during which this callback can still fire.
         */
        this.hooks.onSessionsChanged(this.sessions());
        return;
      }
      // The tab survives its process: the output is often the reason the user opened it.
      this.entries.set(id, {
        ...current,
        pty: null,
        session: { ...current.session, running: false, exitCode, stoppedOnPurpose: stopped },
      });
      if (options.role === 'server' && options.projectId !== null) {
        this.hooks.onProjectStartExit(options.projectId, exitCode, stopped);
      }
      this.hooks.onSessionsChanged(this.sessions());
    });

    this.hooks.onSessionsChanged(this.sessions());
    // After the sessions, never before: the layout it announces refers to a session the renderer must
    // already know about.
    this.syncLayout();
    return id;
  }

  /**
   * Whether a tab of this action is open **and its process is still alive**.
   *
   * Public where `findActionSession` is private, because the answer and not the session is what a
   * caller outside this class can act on. The feedback gate asks it about the ticket handoff's own tab:
   * that tab holds the worktree, and a second agent on one worktree is the outcome `workActionId`
   * already calls worse than being blocked.
   *
   * `running` and not merely "a tab exists": a finished handoff leaves its scrollback on screen, and
   * refusing on a tab nobody is using any more would be refusing for ever.
   */
  isActionRunning(projectId: ProjectId, actionId: string): boolean {
    return this.findActionSession(projectId, actionId)?.session.running === true;
  }

  private findActionSession(projectId: ProjectId, actionId: string): Entry | undefined {
    return [...this.entries.values()].find(
      (entry) => entry.session.projectId === projectId && entry.session.actionId === actionId,
    );
  }
}

/** The scrollback a session that never launched is born with: one red line saying why. */
function failedScrollback(file: string, message: string): Scrollback {
  const scrollback = new Scrollback(BUFFER_LIMIT);
  scrollback.push(`\u001b[31mCould not launch ${file}\u001b[39m\r\n${message}\r\n`);
  return scrollback;
}

/** A seeded note, stamped now, or nothing at all when the caller had nothing to say. */
function buildNote(text: string | null): SessionNote | null {
  const trimmed = text === null ? null : trimNote(text);
  return trimmed === null ? null : { text: trimmed, writtenAt: new Date().toISOString() };
}

function baseSession(
  id: TerminalId,
  options: {
    title: string;
    kind: TerminalKind;
    projectId: ProjectId | null;
    actionId: string | null;
    profileId: string | null;
    cwd: string;
    renamed: boolean;
    agent?: SessionAgent | null;
    note?: string | null;
  },
): Omit<StoredSession, 'running' | 'closable'> {
  return {
    // Null and false until the pty says otherwise: a session that has not ended has no verdict, and
    // zero would read as "finished cleanly" on a process that is still working.
    exitCode: null,
    stoppedOnPurpose: false,
    // Set by the caller that spawned an agent, never guessed from the command line: an action can run
    // anything, and matching on the word `claude` would call `git log --grep claude` a coding agent.
    agent: options.agent ?? null,
    /*
     * Seeded by the caller that knows what the session is for, exactly like `agent`.
     *
     * Only the ticket handoff passes one today, and that is the whole reason this field is worth
     * having at the scale the board is built for: a note the reader has to type is a note written
     * on the five sessions they happened to think about, and it is the other ninety-five that are
     * the problem.
     */
    note: buildNote(options.note ?? null),
    id,
    title: options.title,
    kind: options.kind,
    projectId: options.projectId,
    actionId: options.actionId,
    profileId: options.profileId,
    cwd: options.cwd,
    renamed: options.renamed,
  };
}

/**
 * Tab title for an action: the project, then the action that opened the tab.
 *
 * Uniform across roles. The server action used to get the bare project name, on the theory that it was
 * *the* tab of that project; with several actions per project that reads as a riddle, since nothing
 * says whether a bare project name is the dev server, a build or a test run. A renamed tab keeps its name, so this
 * only ever decides the first title.
 */
function actionTitle(project: Project, action: ProjectAction): string {
  return `${project.label} · ${action.label.toLowerCase()}`;
}

/**
 * Whether a configuration change has left a tab with no button able to act on it.
 *
 * Pure and exported so the rule is tested rather than trusted, since three of its five cases are easy
 * to get wrong in opposite directions:
 * - a **free shell** (no project) belongs to nobody and is never unreachable;
 * - a **repository shell** has a project but no action, so looking one up would find nothing and close
 *   a perfectly good shell on every settings save;
 * - a **reserved** tab (`git:`) has a project *and* an action id, but that id names no configured
 *   action: it belongs to the Git tab, which owns its own buttons. Looking it up in the project's
 *   actions finds nothing, so without this case every settings save would kill a commit mid-hook;
 * - an action that no longer exists leaves its tab orphaned;
 * - an action **demoted** from `server` leaves a running process whose row shows neither `Run` nor
 *   `Stop`, so the port would stay held with nothing left to press.
 */
export function isUnreachable(
  session: Pick<TerminalSession, 'projectId' | 'actionId'>,
  role: ActionRole | null,
  project: Project | undefined,
): boolean {
  if (session.projectId === null) {
    return false;
  }
  if (project === undefined) {
    return true;
  }
  if (session.actionId === null || session.actionId.startsWith(RESERVED_ACTION_PREFIX)) {
    return false;
  }
  const action = project.actions.find((candidate) => candidate.id === session.actionId);
  return action === undefined || (role === 'server' && action.role !== 'server');
}

/**
 * Decides whether a tab can be closed.
 *
 * The rule is about whether the tab is still doing something, not about who owns it. Making every
 * project tab permanent, as the first version did, left a `commit` tab stuck in the strip forever
 * once the TUI had finished: a one-shot task with nothing left to say and no way to dismiss it.
 *
 * A running `server` action is the one case kept closed: `Stop` is the deliberate way to end it, and
 * a close button next to it would make killing a build a single stray click. Once it has stopped, the
 * tab is just a log and can go.
 *
 * Exported for testing.
 */
export function isClosable(
  session: Pick<TerminalSession, 'kind' | 'running'>,
  role: ActionRole | null,
): boolean {
  if (session.kind === 'shell' || role === 'task') {
    return true;
  }
  return !session.running;
}

/**
 * Turns an action into an executable plus arguments, run through its shell profile.
 *
 * The command line is passed as a **single argument** to the shell's own "run this" flag rather than
 * split on spaces: `pty.spawn` takes an argv array with no shell in between, so splitting would break
 * the first quoted path or `&&` the user writes.
 *
 * Which flag depends on the shell, and the two that matter here are not interchangeable:
 * - bash gets `-ic`. Interactive, because `commit` is an **alias**: bash refuses to expand aliases in
 *   a non-interactive shell at all, and `-lc` reads `.bash_profile` rather than the `.bashrc` that
 *   defines it. Both verified on this machine.
 * - cmd gets `/c`, which is also why the default `Run` action ships pointed at cmd: a pty does not
 *   resolve the `.cmd` shims that make a bare `npm` work.
 *
 * An unrecognised executable falls back to cmd's convention rather than guessing, and the profile's
 * own arguments are dropped in that case: they configure an interactive session, not a one-shot
 * command, and passing `-NoLogo` to something expecting a script would fail in an unreadable way.
 */
export function resolveActionCommand(
  action: ProjectAction,
  profile: ShellProfile,
): { file: string; args: string[] } {
  return resolveShellCommand(profile, action.command);
}

/**
 * Same resolution, for a command line the app built rather than one the user configured.
 *
 * Split out for the Jira tab's `dev <TICKET>`, which is an alias and therefore needs the very same
 * `-ic` reasoning an action's `commit` needs. A second copy of this table would be a second answer to
 * "how does a command line reach a shell here", and the two would drift on the detail that matters:
 * bash refuses to expand aliases without `-i`.
 */
export function resolveShellCommand(
  profile: ShellProfile,
  command: string,
): { file: string; args: string[] } {
  const exe = profile.file.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';

  if (/^(bash|sh|zsh)\.exe$/.test(exe) || /^(bash|sh|zsh)$/.test(exe)) {
    return { file: profile.file, args: ['-ic', command] };
  }
  if (exe === 'powershell.exe' || exe === 'pwsh.exe') {
    return { file: profile.file, args: ['-NoLogo', '-Command', command] };
  }
  if (exe === 'wsl.exe') {
    return { file: profile.file, args: ['-e', 'bash', '-ic', command] };
  }
  return { file: exe === 'cmd.exe' ? profile.file : 'cmd.exe', args: ['/c', command] };
}

/**
 * Kills a pty's process and its descendants.
 *
 * `pty.kill()` signals only the process at the head of the pty, which for `npm run start` is a
 * `cmd.exe` wrapper; the `ng serve` underneath would survive and keep holding the port.
 */
function killTree(child: IPty): void {
  const pid = child.pid;
  if (typeof pid !== 'number') {
    return;
  }
  if (process.platform !== 'win32') {
    child.kill();
    return;
  }
  // Off the main thread like every other spawn in the app, and this one is worth stating: `Stop` is a
  // click, so nobody is typing at that instant, but a spawn holds the thread for over 100 ms about
  // one time in thirteen here, and a button that freezes the window for half a second is the same bug
  // wearing a different hat. The outcome is ignored on purpose: a non-zero exit just means the process
  // was already gone.
  void spawnOffThread({
    file: 'taskkill',
    args: ['/PID', String(pid), '/T', '/F'],
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  }).catch(() => undefined);
}
