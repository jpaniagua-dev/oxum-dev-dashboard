import { execFile } from 'node:child_process';
import * as pty from '@lydell/node-pty';
import type { IPty } from '@lydell/node-pty';
import { RESERVED_ACTION_PREFIX } from '@shared/contracts.js';
import type {
  ActionRole,
  PaneDirection,
  Project,
  ProjectAction,
  ProjectId,
  ShellProfile,
  TerminalGroup,
  TerminalId,
  TerminalKind,
  TerminalLayout,
  TerminalSession,
  TerminalSize,
} from '@shared/contracts.js';
import { normalizeGroups } from '@shared/terminal-groups.js';
import { parseOutputChunk, type ParsedOutput } from '../projects/output-parser.js';

/**
 * Output retained per session so a tab can be reopened without losing history.
 *
 * Bounded: a dev server left running for hours would otherwise grow this without limit.
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
  readonly session: TerminalSession;
  readonly pty: IPty | null;
  /**
   * Role of the action this tab runs, null for a shell.
   *
   * Kept here rather than on the session: it decides closability and whether output feeds the row's
   * server state, both of which are the main process's business, not the renderer's.
   */
  readonly role: ActionRole | null;
  buffer: string;
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
  private direction: PaneDirection = 'columns';

  constructor(private readonly hooks: TerminalHooks) {}

  layout(): TerminalLayout {
    return { direction: this.direction, groups: this.snapshot() };
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
  setLayout(groups: readonly TerminalGroup[], direction: PaneDirection): void {
    this.direction = direction;
    this.groups = normalizeGroups(groups, [...this.entries.keys()]);
    this.hooks.onLayoutChanged(this.layout());
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
    this.groups = normalizeGroups(this.groups, [...this.entries.keys()]);
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
    }));
  }

  buffer(terminalId: TerminalId): string {
    return this.entries.get(terminalId)?.buffer ?? '';
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
      cwd: options.project.path,
      file: options.file,
      args: [...options.args],
      size: options.size,
      projectKind: null,
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

  write(terminalId: TerminalId, data: string): void {
    this.entries.get(terminalId)?.pty?.write(data);
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
    entry.buffer = '';
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
  }): TerminalId | null {
    this.counter += 1;
    const id = `${options.kind}-${this.counter}`;

    let child: IPty;
    try {
      child = pty.spawn(options.file, options.args, {
        cwd: options.cwd,
        cols: options.size.cols,
        rows: options.size.rows,
        env: { ...process.env, FORCE_COLOR: '1' },
      });
    } catch (error) {
      // A profile pointing at a missing executable must surface in the tab rather than crash the
      // main process, so the failure is recorded as a dead session carrying the message.
      const message = error instanceof Error ? error.message : String(error);
      this.entries.set(id, {
        session: { ...baseSession(id, options), running: false, closable: true },
        pty: null,
        role: options.role,
        // A session that failed to launch still gets a tab and a pane: its buffer carries the reason.
        buffer: `\u001b[31mCould not launch ${options.file}\u001b[39m\r\n${message}\r\n`,
      });
      this.hooks.onSessionsChanged(this.sessions());
      return id;
    }

    const entry: Entry = {
      session: { ...baseSession(id, options), running: true, closable: false },
      pty: child,
      role: options.role,
      buffer: '',
    };
    this.entries.set(id, entry);

    child.onData((data) => {
      entry.buffer = `${entry.buffer}${data}`.slice(-BUFFER_LIMIT);
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
      this.entries.set(id, { ...current, pty: null, session: { ...current.session, running: false } });
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

  private findActionSession(projectId: ProjectId, actionId: string): Entry | undefined {
    return [...this.entries.values()].find(
      (entry) => entry.session.projectId === projectId && entry.session.actionId === actionId,
    );
  }
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
  },
): Omit<TerminalSession, 'running' | 'closable'> {
  return {
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
export function isClosable(session: TerminalSession, role: ActionRole | null): boolean {
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
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {
    // A non-zero exit just means the process was already gone.
  });
}
