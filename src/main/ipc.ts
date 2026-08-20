import { release } from 'node:os';
import { basename } from 'node:path';
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import {
  GIT_COMMIT_ACTION_ID,
  IpcChannel,
  ISSUE_KEY_PATTERN,
  TICKET_BRANCH_ACTION_ID,
  workActionId,
  WORK_BATCH_LIMIT,
  WORKTREE_ACTION_ID,
  type AppSettings,
  type BootstrapState,
  type GitDiff,
  type GitDiffTarget,
  type GitRepoState,
  type GeneratedCommit,
  type GitResult,
  type GitSequencerOp,
  type GitStashOp,
  type OpenShellRequest,
  type Project,
  type ProjectCandidate,
  type ProjectConfig,
  type ProjectId,
  type ProjectRow,
  type IssueTransition,
  type JiraConfig,
  type JiraState,
  type TriageScope,
  type TriageState,
  type ProjectValidation,
  type RepoPulls,
  type RepoWorktrees,
  type ShellProfile,
  type TerminalGroup,
  type TerminalId,
  type ThemeMode,
  type ThemeState,
} from '@shared/contracts.js';
import {
  applyStash,
  checkoutBranch,
  cherryPick,
  createBranch,
  discardPaths,
  readDiff,
  readRepoState,
  readSequencer,
  resolveSequencer,
  stagePaths,
  stashPush,
  sync,
} from './git/git-commands.js';
import { generateCommitMessage } from './git/generate-commit.js';
import { readGitState } from './git/git-service.js';
import { readAllWorktrees } from './git/git-worktrees.js';
import {
  buildWorktreeCommand,
  parseWorktreeCommand,
  WORKTREE_HELPER,
} from './git/worktree-command.js';
import {
  configFromPath,
  detectCandidates,
  findProject,
  validateProjects,
} from './projects/registry.js';
import type { PullMonitor } from './github/pull-monitor.js';
import type { JiraMonitor } from './jira/jira-monitor.js';
import {
  applyTransition,
  assignIssue,
  readMyAccountId,
  readTransitions,
  type JiraCredentials,
} from './jira/jira-service.js';
import {
  describeStart,
  readStartContext,
  startIssue,
  type StartReport,
} from './jira/jira-start.js';
import { terminalCompat } from './terminal/windows-pty.js';
import type { ProjectMonitor } from './projects/project-monitor.js';
import type { TriageService } from './triage/triage-service.js';
import { buildWorkCommand, resolveClaudeContext } from './triage/work-command.js';
import { LOCAL_ONLY_KEYS, asPatch } from './store/settings-patch.js';
import type { SettingsStore } from './store/settings-store.js';
import { resolveBashProfile, resolveDefaultProfile } from './terminal/shell-profiles.js';
import { resolveShellCommand, type TerminalManager } from './terminal/terminal-manager.js';
import type { ThemeController } from './theme.js';

export interface IpcDependencies {
  /** Live project list, re-read on every call since settings can change it at any time. */
  readonly projects: () => readonly Project[];
  readonly monitor: () => ProjectMonitor;
  readonly pulls: () => PullMonitor;
  readonly jira: () => JiraMonitor;
  readonly triage: () => TriageService;
  /** Writes the Jira token to the encrypted store. Never reads it back towards the renderer. */
  readonly saveJiraToken: (token: string) => Promise<{ ok: boolean; message: string }>;
  readonly jiraConfig: () => JiraConfig;
  readonly testJira: () => Promise<{ ok: boolean; message: string }>;
  /** Credentials for one Jira write, or null when the connection is incomplete. */
  readonly jiraCredentials: () => Promise<JiraCredentials | null>;
  /** Called after a successful write, to refresh the views without waiting for the poll. */
  readonly afterJiraWrite: () => void;
  /**
   * Persists a commit message and hands back the file `git commit -F` will read.
   *
   * Injected rather than called directly: resolving the folder means asking Electron where
   * `userData` lives, and this module is already the one place that must stay testable without an
   * Electron runtime around it.
   */
  readonly writeCommitMessage: (projectId: ProjectId, message: string) => Promise<string>;
  readonly terminals: TerminalManager;
  readonly settings: SettingsStore;
  readonly theme: ThemeController;
  /** Profiles available for new tabs, recomputed when settings change. */
  readonly profiles: () => ShellProfile[];
  /** Current terminal geometry, so a spawned process starts at the right size. */
  readonly terminalSize: () => { cols: number; rows: number };
  /** Rebuilds everything that depends on the project list. */
  readonly reloadProjects: () => Promise<void>;
  /**
   * Opens the native folder picker.
   *
   * The calling window is passed through so the dialog is parented to whichever window asked: a
   * picker anchored to the dashboard while the user is in the settings window looks like a freeze.
   */
  readonly pickFolder: (title: string, parent: BrowserWindow | null) => Promise<string | null>;
  /** Opens or focuses the settings window. */
  readonly openSettings: () => Promise<void>;
  /** Opens or focuses the servers window. */
  readonly openServers: () => Promise<void>;
  /** Closes the servers window, if it is open. Its `closed` hook hands any sessions back. */
  readonly closeServers: () => void;
  /** Tells every window whether the servers are detached, so the dashboard's button reads right. */
  readonly broadcastServersDetached: (detached: boolean) => void;
  /** Records unsaved edits in the settings window, so closing it can ask first. */
  readonly setSettingsDirty: (dirty: boolean) => void;
  /** Pushes settings to every window, after a change that alters more than the caller's own state. */
  readonly broadcastSettings: (settings: AppSettings) => void;
}

/**
 * Registers every IPC handler.
 *
 * This module is the complete list of what the renderer may ask the main process to do; it holds no
 * privileged capability of its own.
 */
export function registerIpcHandlers(deps: IpcDependencies): void {
  ipcMain.handle(IpcChannel.Bootstrap, async (): Promise<BootstrapState> => ({
    projects: [...deps.projects()],
    settings: deps.settings.get(),
    theme: deps.theme.state(),
    shellProfiles: deps.profiles(),
    terminals: deps.terminals.sessions(),
    layout: deps.terminals.layout(),
    pulls: deps.pulls().rows(),
    jira: deps.jira().state(),
    jiraConfig: deps.jiraConfig(),
    terminalCompat: terminalCompat(process.platform, release()),
  }));

  ipcMain.handle(IpcChannel.RefreshNow, async (): Promise<ProjectRow[]> => deps.monitor().refreshAll());

  ipcMain.handle(IpcChannel.PullsRefresh, async (): Promise<RepoPulls[]> =>
    deps.pulls().refreshNow(),
  );

  ipcMain.handle(IpcChannel.JiraRefresh, async (): Promise<JiraState> => deps.jira().refreshNow());

  /* --------------------------------------------------------------- triage */

  ipcMain.handle(IpcChannel.TriageRefresh, async (): Promise<TriageState> => deps.triage().refresh());

  /*
   * The sprint id arrives from the renderer and is coerced here rather than trusted: it ends up in a
   * Jira path, and the service also matches it against the sprint list before doing anything.
   */
  ipcMain.handle(
    IpcChannel.TriageAnalyse,
    async (_event, sprintId: unknown, scope: unknown): Promise<TriageState> => {
      const id = Number(sprintId);
      if (!Number.isInteger(id)) {
        return deps.triage().state();
      }
      // `all` is the default of an unreadable value on purpose: it is the scope that hides nothing,
      // and a run that quietly narrowed itself is the failure this whole feature has to avoid.
      const wanted: TriageScope = scope === 'mine' ? 'mine' : 'all';
      return deps.triage().analyse(id, wanted);
    },
  );

  /*
   * Drops one row from a stored analysis.
   *
   * The key is validated like every other one that reaches this process, even though it never leaves
   * it: this one is only ever compared against what is on disk, and the pattern costs nothing next to
   * being the single place a key is not checked.
   */
  ipcMain.handle(
    IpcChannel.TriageDismiss,
    async (_event, sprintId: unknown, issueKey: unknown): Promise<TriageState> => {
      const id = Number(sprintId);
      const key = typeof issueKey === 'string' ? issueKey.trim().toUpperCase() : '';
      if (!Number.isInteger(id) || !ISSUE_KEY_PATTERN.test(key)) {
        return deps.triage().state();
      }
      return deps.triage().dismiss(id, key);
    },
  );

  /* ------------------------------------------------------------------ git */

  /*
   * The Git tab's channels are all **pull**, with no monitor behind them.
   *
   * Only one repository is ever on screen, and branches, history and status for every project would
   * be several times the work of the strip's own git poll for something nobody is looking at. The
   * renderer asks when it shows the tab, when the selection changes and after every write, which is
   * exactly when the answer can have changed.
   */

  // Reads the whole workspace's worktrees in one pass. `deps.projects()` rather than a stored list,
  // like every other handler here: a project added a second ago must appear in the next read.
  ipcMain.handle(
    IpcChannel.WorktreesRead,
    async (): Promise<RepoWorktrees[]> => readAllWorktrees(deps.projects()),
  );

  /*
   * Creates, renames or removes a worktree, by running the shell helper in a terminal tab.
   *
   * The one gesture in the strip that deletes something, and the reason it goes through a tab rather
   * than an `execFile` is the same reason the commit does: the helper reports which junction it
   * unlinked, whether git refused on uncommitted work and which branch it kept because it is not
   * merged. Swallowing that would replace it with a one-line verdict this app writes about a command it
   * did not run.
   *
   * The repository folder comes from the **configured path**, never from the payload: the renderer says
   * which project, and the only thing it can name freely is a label the builder puts through a
   * whitelist. `resolveBashProfile` for the shell, because the helper is a bash **function** and the
   * quoting the builder emits is POSIX.
   */
  ipcMain.handle(
    IpcChannel.WorktreeRun,
    async (
      _event,
      projectId: unknown,
      payload: unknown,
    ): Promise<{ terminalId: TerminalId | null; result: GitResult }> => {
      const project = resolveProject(deps.projects(), projectId);
      if (project === undefined) {
        return { terminalId: null, result: { ok: false, message: 'Project not found' } };
      }
      const command = parseWorktreeCommand(payload);
      if (command === null) {
        return { terminalId: null, result: { ok: false, message: 'Invalid worktree command' } };
      }

      const profile = resolveBashProfile(
        deps.profiles(),
        deps.settings.get().defaultShellProfileId,
      );
      if (profile === undefined) {
        return {
          terminalId: null,
          result: {
            ok: false,
            message: `No bash profile: "${WORKTREE_HELPER}" cannot be launched`,
          },
        };
      }

      const built = buildWorktreeCommand(command, basename(project.path));
      if (built.command === undefined) {
        return { terminalId: null, result: { ok: false, message: built.error } };
      }

      const resolved = resolveShellCommand(profile, built.command);
      const terminalId = deps.terminals.runProjectCommand({
        project,
        actionId: WORKTREE_ACTION_ID,
        title: `${project.label} · ${WORKTREE_HELPER}`,
        file: resolved.file,
        args: resolved.args,
        size: deps.terminalSize(),
        profileId: profile.id,
      });

      return {
        terminalId,
        result:
          terminalId === null
            ? { ok: false, message: 'Could not open the tab' }
            : { ok: true, message: `${built.command} launched in ${project.label}` },
      };
    },
  );

  /*
   * Detaches the `server` tabs into their own window, or brings them back.
   *
   * The order is load-bearing in both directions. **Detaching** opens the window first and moves the
   * sessions second, so the payload that follows lands in a renderer that exists. **Re-attaching** moves
   * the sessions back first and closes the window second, so the dashboard has adopted them before the
   * window that was painting them goes away; and the window's own `closed` hook then re-runs the
   * hand-back, which is a no-op because the manager returns early on an unchanged value.
   */
  ipcMain.handle(IpcChannel.ServersDetach, async (_event, detached: unknown): Promise<void> => {
    const wanted = detached === true;
    if (wanted) {
      await deps.openServers();
      deps.terminals.setServersDetached(true);
    } else {
      deps.terminals.setServersDetached(false);
      deps.closeServers();
    }
    deps.broadcastServersDetached(wanted);
    // Remembered, so a window parked on a second monitor is still populated at the next launch.
    await deps.settings.update({ serversDetached: wanted });
  });

  /*
   * Moves one tab between the two windows.
   *
   * Nothing is validated here beyond the types: the manager refuses an unknown id, a move that changes
   * nothing, and any move at all while the servers window is closed, which is the one case that could
   * otherwise take a tab off the dashboard and hand it to nobody.
   */
  ipcMain.handle(
    IpcChannel.ServersMove,
    async (_event, terminalId: unknown, toServers: unknown): Promise<void> => {
      if (typeof terminalId !== 'string') {
        return;
      }
      deps.terminals.moveTerminal(terminalId, toServers === true);
    },
  );

  ipcMain.handle(
    IpcChannel.GitState,
    async (_event, projectId: unknown): Promise<GitRepoState | null> => {
      const project = resolveProject(deps.projects(), projectId);
      return project === undefined ? null : readRepoState(project);
    },
  );

  ipcMain.handle(
    IpcChannel.GitDiff,
    async (_event, projectId: unknown, target: unknown): Promise<GitDiff> => {
      const project = resolveProject(deps.projects(), projectId);
      const parsed = asDiffTarget(target);
      if (project === undefined || parsed === null) {
        return { title: '', lines: [], note: 'Project or file not found.' };
      }
      return readDiff(project.path, parsed);
    },
  );

  /*
   * Writes a commit message from the staged diff, with a headless Claude Code run.
   *
   * The branch is read here rather than taken from the renderer: it goes into the prompt as the place
   * a ticket key lives, and a value the renderer could get wrong would put the wrong key in a subject
   * line. `amend` does come from the renderer, because it is a draft nothing has saved yet.
   */
  ipcMain.handle(
    IpcChannel.GitGenerateMessage,
    async (_event, projectId: unknown, amend: unknown): Promise<GeneratedCommit> => {
      const project = resolveProject(deps.projects(), projectId);
      if (project === undefined) {
        return { ok: false, message: '', error: 'Project not found' };
      }
      const state = await readGitState(project.path);
      return generateCommitMessage(project, {
        amend: amend === true,
        branch: state.branch,
        model: deps.settings.get().claudeCommitModel,
      });
    },
  );

  ipcMain.handle(
    IpcChannel.GitBranchCreate,
    async (_event, projectId: unknown, name: unknown, checkout: unknown): Promise<GitResult> => {
      const project = resolveProject(deps.projects(), projectId);
      if (project === undefined || typeof name !== 'string') {
        return { ok: false, message: 'Project not found' };
      }
      return createBranch(project.path, name, checkout === true);
    },
  );

  ipcMain.handle(
    IpcChannel.GitCheckout,
    async (_event, projectId: unknown, name: unknown): Promise<GitResult> => {
      const project = resolveProject(deps.projects(), projectId);
      if (project === undefined || typeof name !== 'string') {
        return { ok: false, message: 'Project not found' };
      }
      return checkoutBranch(project.path, name);
    },
  );

  ipcMain.handle(
    IpcChannel.GitStage,
    async (_event, projectId: unknown, paths: unknown, staged: unknown): Promise<GitResult> => {
      const project = resolveProject(deps.projects(), projectId);
      if (project === undefined) {
        return { ok: false, message: 'Project not found' };
      }
      const list = Array.isArray(paths)
        ? paths.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : [];
      return stagePaths(project.path, list, staged === true);
    },
  );

  /*
   * Throws away what was done to a set of files, behind a confirmation.
   *
   * The confirmation lives **here** and not in the renderer, for the reason every other question the
   * app asks does: a page under this CSP has no dialog worth the name, and the two it could use
   * (`window.confirm`, a modal of our own) are respectively unstyleable and the exact pattern the
   * settings modal was removed for. A `showMessageBox` on the parent window is also the only form
   * that cannot be dismissed by clicking somewhere else, which is what a question about losing work
   * has to be.
   *
   * Asked **before** anything is touched, and `ok: false` is what a cancel looks like from the
   * renderer: it never learns whether the dialog was answered or the command refused, both being
   * "nothing happened", and neither is worth a different line in the status bar.
   *
   * The count comes from the paths asked for rather than from git, because the question has to be on
   * screen before the repository is read; `discardPaths` re-reads the list itself and is the authority
   * on what is actually destroyed.
   */
  ipcMain.handle(
    IpcChannel.GitDiscard,
    async (event, projectId: unknown, paths: unknown): Promise<GitResult> => {
      const project = resolveProject(deps.projects(), projectId);
      if (project === undefined) {
        return { ok: false, message: 'Project not found' };
      }
      const list = Array.isArray(paths)
        ? paths.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : [];
      if (list.length === 0) {
        return { ok: false, message: 'No file selected' };
      }
      if (!(await confirmDiscard(event, project.label, list))) {
        return { ok: false, message: 'Nothing discarded' };
      }
      return discardPaths(project.path, list);
    },
  );

  /**
   * Commits what is staged, in a terminal tab.
   *
   * The one write that does **not** go through `execFile`, and the reason is the pre-commit hooks:
   * `husky` and `lint-staged` can run for half a minute and print everything worth reading about why
   * a commit was refused. Run silently, all of that would be reduced to a one-line failure; run in a
   * tab, it is watched exactly as it would be from a shell — which is also what the whole app's
   * "every action ends in a terminal tab" rule asks for.
   */
  ipcMain.handle(
    IpcChannel.GitCommit,
    async (
      _event,
      projectId: unknown,
      message: unknown,
      amend: unknown,
    ): Promise<{ terminalId: TerminalId | null; result: GitResult }> => {
      const project = resolveProject(deps.projects(), projectId);
      if (project === undefined) {
        return { terminalId: null, result: { ok: false, message: 'Project not found' } };
      }
      if (typeof message !== 'string' || message.trim().length === 0) {
        return { terminalId: null, result: { ok: false, message: 'Empty commit message' } };
      }

      const file = await deps.writeCommitMessage(project.id, message);
      const terminalId = deps.terminals.runProjectCommand({
        project,
        actionId: GIT_COMMIT_ACTION_ID,
        title: `${project.label} · ${amend === true ? 'amend' : 'commit'}`,
        // `git` straight from PATH, no shell: the app already calls it that way everywhere else.
        // `--cleanup=strip` drops comment lines and trailing blanks the way an editor session would.
        // The amend runs in the same tab for the same reason the commit does: it fires the very same
        // hooks, and rewriting HEAD silently is worse than rewriting it in front of the user.
        file: 'git',
        args:
          amend === true
            ? ['commit', '--amend', '--cleanup=strip', '-F', file]
            : ['commit', '--cleanup=strip', '-F', file],
        size: deps.terminalSize(),
      });

      return {
        terminalId,
        result:
          terminalId === null
            ? { ok: false, message: 'Could not open the commit tab' }
            : { ok: true, message: 'Commit launched in a tab' },
      };
    },
  );

  ipcMain.handle(
    IpcChannel.GitSync,
    async (_event, projectId: unknown, op: unknown): Promise<GitResult> => {
      const project = resolveProject(deps.projects(), projectId);
      const operation = op === 'fetch' || op === 'pull' || op === 'push' ? op : null;
      if (project === undefined || operation === null) {
        return { ok: false, message: 'Unknown operation' };
      }
      // Re-read rather than trusting what the renderer last saw: `push` needs to know whether the
      // branch has an upstream, and a stale answer is what turns a first push into a puzzling refusal.
      const state = await readRepoState(project);
      return sync(project.path, operation, state.branch, state.hasUpstream);
    },
  );

  ipcMain.handle(
    IpcChannel.GitCherryPick,
    async (_event, projectId: unknown, sha: unknown, noCommit: unknown): Promise<GitResult> => {
      const project = resolveProject(deps.projects(), projectId);
      if (project === undefined || typeof sha !== 'string') {
        return { ok: false, message: 'Project not found' };
      }
      return cherryPick(project.path, sha, noCommit === true);
    },
  );

  /**
   * Finishes or abandons a half-done operation.
   *
   * The state is **re-read here** rather than taken from the renderer, and that is the same reasoning
   * as `push` re-reading its upstream: the panel's copy is up to a poll old, and `git merge --abort`
   * fired at a repository that is actually mid-rebase fails with a message about the wrong operation.
   */
  ipcMain.handle(
    IpcChannel.GitSequencer,
    async (_event, projectId: unknown, op: unknown): Promise<GitResult> => {
      const project = resolveProject(deps.projects(), projectId);
      const operation: GitSequencerOp | null =
        op === 'continue' || op === 'abort' ? op : null;
      if (project === undefined || operation === null) {
        return { ok: false, message: 'Unknown operation' };
      }
      return resolveSequencer(project.path, await readSequencer(project.path), operation);
    },
  );

  ipcMain.handle(
    IpcChannel.GitStashPush,
    async (
      _event,
      projectId: unknown,
      message: unknown,
      includeUntracked: unknown,
    ): Promise<GitResult> => {
      const project = resolveProject(deps.projects(), projectId);
      if (project === undefined) {
        return { ok: false, message: 'Project not found' };
      }
      return stashPush(
        project.path,
        typeof message === 'string' ? message : '',
        includeUntracked === true,
      );
    },
  );

  ipcMain.handle(
    IpcChannel.GitStashApply,
    async (_event, projectId: unknown, sha: unknown, op: unknown): Promise<GitResult> => {
      const project = resolveProject(deps.projects(), projectId);
      const operation: GitStashOp | null =
        op === 'apply' || op === 'pop' || op === 'drop' ? op : null;
      if (project === undefined || operation === null || typeof sha !== 'string') {
        return { ok: false, message: 'Unknown operation' };
      }
      return applyStash(project.path, sha, operation);
    },
  );

  /**
   * Starts a ticket's branch by running the `dev <TICKET>` alias in a terminal tab.
   *
   * Three decisions worth keeping. The command is **assembled here**, from a key matched against
   * `ISSUE_KEY_PATTERN`: the renderer names a ticket and a project, never a command line, so this
   * channel cannot become a general "run anything" hole in an otherwise sandboxed renderer. It needs
   * an **interactive bash** because `dev` is an alias, and no bash means no command rather than a
   * `command not found` in a tab that looks like it worked. And it lands in a tab, like the commit,
   * because the alias talks: it prints what it created and sometimes asks something.
   */
  ipcMain.handle(
    IpcChannel.JiraBranch,
    async (
      _event,
      projectId: unknown,
      issueKey: unknown,
    ): Promise<{ terminalId: TerminalId | null; result: GitResult }> => {
      const project = resolveProject(deps.projects(), projectId);
      if (project === undefined) {
        return { terminalId: null, result: { ok: false, message: 'Project not found' } };
      }
      const key = typeof issueKey === 'string' ? issueKey.trim().toUpperCase() : '';
      if (!ISSUE_KEY_PATTERN.test(key)) {
        return { terminalId: null, result: { ok: false, message: 'Invalid issue key' } };
      }

      const profile = resolveBashProfile(
        deps.profiles(),
        deps.settings.get().defaultShellProfileId,
      );
      if (profile === undefined) {
        return {
          terminalId: null,
          result: { ok: false, message: 'No bash profile: the "dev" alias cannot be launched' },
        };
      }

      const resolved = resolveShellCommand(profile, `dev ${key}`);
      const terminalId = deps.terminals.runProjectCommand({
        project,
        actionId: TICKET_BRANCH_ACTION_ID,
        title: `${project.label} · ${key}`,
        file: resolved.file,
        args: resolved.args,
        size: deps.terminalSize(),
        profileId: profile.id,
      });

      return {
        terminalId,
        result:
          terminalId === null
            ? { ok: false, message: 'Could not open the tab' }
            : { ok: true, message: `dev ${key} launched in ${project.label}` },
      };
    },
  );

  /*
   * Hands one or more triaged tickets to an interactive Claude Code session, in a terminal tab.
   *
   * A tab and not a headless run, unlike the analysis: triage only reads, whereas working a ticket
   * writes files, runs tests and opens a pull request. A long writer with no visible output is
   * exactly what the "every action ends in a tab" rule exists to prevent, and in a tab it can be
   * watched, answered and killed.
   *
   * Only the keys and the repository name travel. The verdict, the reason and the question stay in
   * `triage.json`, where the session goes and reads them itself: a copy pushed through a shell
   * argument would be fragile to quote and stale from the moment it was made.
   *
   * The default shell profile is enough here, where the branch channel insists on an interactive
   * bash: `dev` is a `.bashrc` alias and needs one, `claude.exe` is a real executable that any pty
   * resolves.
   */
  ipcMain.handle(
    IpcChannel.TriageWork,
    async (
      _event,
      projectId: unknown,
      issueKeys: unknown,
    ): Promise<{ terminalId: TerminalId | null; result: GitResult }> => {
      const project = resolveProject(deps.projects(), projectId);
      if (project === undefined) {
        return { terminalId: null, result: { ok: false, message: 'Project not found' } };
      }

      const keys = (Array.isArray(issueKeys) ? issueKeys : [])
        .map((key) => (typeof key === 'string' ? key.trim().toUpperCase() : ''))
        .filter((key) => ISSUE_KEY_PATTERN.test(key))
        .slice(0, WORK_BATCH_LIMIT);
      if (keys.length === 0) {
        return { terminalId: null, result: { ok: false, message: 'No valid issue key' } };
      }

      const settings = deps.settings.get();
      const profile = resolveDefaultProfile(deps.profiles(), settings.defaultShellProfileId);
      if (profile === undefined) {
        return { terminalId: null, result: { ok: false, message: 'No shell profile available' } };
      }

      const cwd = resolveClaudeContext(settings.claudeContextRoot, project.path);
      const command = buildWorkCommand(keys, basename(project.path), settings.claudeWorkModel);
      const resolved = resolveShellCommand(profile, command);

      const terminalId = deps.terminals.runProjectCommand({
        project,
        // One tab per set of tickets: a handoff already running must never swallow a new one.
        actionId: workActionId(keys),
        title: `${project.label} · ${keys.length === 1 ? keys[0] : `${keys.length} tickets`}`,
        file: resolved.file,
        args: resolved.args,
        size: deps.terminalSize(),
        profileId: profile.id,
        cwd,
      });
      return {
        terminalId,
        result:
          terminalId === null
            ? { ok: false, message: 'Could not open the tab' }
            : { ok: true, message: `${keys.join(', ')} handed to Claude Code in ${project.label}` },
      };
    },
  );

  /*
   * Records a handoff on the board: active sprint, assigned to you, estimated, in progress.
   *
   * Its own channel, called by the renderer **after** the tab is open and focused. Four writes per
   * ticket over the network is seconds for a batch of eight, and folded into `TriageWork` they would
   * delay the moment the tab comes forward, which the tab's own note forbids: it holds an agent that
   * asks questions, and one waiting behind the current tab is one nobody answers.
   *
   * Jira not being configured is reported in a sentence rather than as an error. The session is the
   * deliverable and this app works for someone who never entered a token, so `ok` is about whether the
   * bookkeeping ran, never about whether the handoff succeeded.
   *
   * The estimate is looked up in `triage.json` per key rather than travelling on the channel, which is
   * what keeps this carrying nothing but issue keys while still writing a number somebody will plan
   * against: the value was produced by the pass that read the description, not invented at click time.
   */
  ipcMain.handle(
    IpcChannel.TriageStartInJira,
    async (_event, issueKeys: unknown): Promise<GitResult> => {
      const keys = (Array.isArray(issueKeys) ? issueKeys : [])
        .map((key) => (typeof key === 'string' ? key.trim().toUpperCase() : ''))
        .filter((key) => ISSUE_KEY_PATTERN.test(key))
        .slice(0, WORK_BATCH_LIMIT);
      if (keys.length === 0) {
        return { ok: false, message: 'No valid issue key' };
      }

      const credentials = await deps.jiraCredentials();
      if (credentials === null) {
        return { ok: false, message: 'Jira not updated: no credentials configured' };
      }
      const { accountId, error } = await readMyAccountId(credentials);
      if (error !== null) {
        return { ok: false, message: `Jira not updated: ${error}` };
      }

      const triage = deps.triage();
      const context = await readStartContext(credentials, accountId, await triage.sprintList());
      const reports: StartReport[] = [];
      for (const key of keys) {
        reports.push(await startIssue(context, key, triage.estimateFor(key)));
      }
      deps.afterJiraWrite();
      return {
        ok: reports.every((report) => report.failed.length === 0),
        message: describeStart(reports),
      };
    },
  );

  ipcMain.handle(IpcChannel.JiraTest, async (): Promise<{ ok: boolean; message: string }> =>
    deps.testJira(),
  );

  ipcMain.handle(
    IpcChannel.JiraSave,
    async (_event, config: unknown, token: unknown): Promise<{ config: JiraConfig; message: string }> => {
      const input = typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {};
      await deps.settings.update({
        jira: {
          siteUrl: typeof input.siteUrl === 'string' ? input.siteUrl : '',
          email: typeof input.email === 'string' ? input.email : '',
          projectKeys: Array.isArray(input.projectKeys)
            ? input.projectKeys.filter((key): key is string => typeof key === 'string')
            : [],
        },
      });

      // An absent token leaves the stored one alone: the form never receives it, so it cannot send it
      // back, and an empty string would otherwise wipe a working credential on every save.
      let message = 'Connection saved';
      if (typeof token === 'string' && token.length > 0) {
        const result = await deps.saveJiraToken(token);
        message = result.message;
      }
      return { config: deps.jiraConfig(), message };
    },
  );

  ipcMain.handle(
    IpcChannel.JiraTransitions,
    async (_event, key: unknown): Promise<IssueTransition[]> => {
      const credentials = await deps.jiraCredentials();
      if (credentials === null || typeof key !== 'string') {
        return [];
      }
      const { transitions } = await readTransitions(credentials, key);
      return transitions;
    },
  );

  ipcMain.handle(
    IpcChannel.JiraTransition,
    async (_event, key: unknown, transitionId: unknown): Promise<{ ok: boolean; message: string }> => {
      const credentials = await deps.jiraCredentials();
      if (credentials === null || typeof key !== 'string' || typeof transitionId !== 'string') {
        return { ok: false, message: 'Incomplete Jira connection' };
      }
      const result = await applyTransition(credentials, key, transitionId);
      if (result.ok) {
        deps.afterJiraWrite();
      }
      return result;
    },
  );

  ipcMain.handle(
    IpcChannel.JiraAssignMe,
    async (_event, key: unknown): Promise<{ ok: boolean; message: string }> => {
      const credentials = await deps.jiraCredentials();
      if (credentials === null || typeof key !== 'string') {
        return { ok: false, message: 'Incomplete Jira connection' };
      }
      // The account id comes from the token's own account, so "assign to me" cannot target anyone else.
      const { accountId, error } = await readMyAccountId(credentials);
      if (error !== null) {
        return { ok: false, message: error };
      }
      const result = await assignIssue(credentials, key, accountId);
      if (result.ok) {
        deps.afterJiraWrite();
      }
      return result;
    },
  );

  ipcMain.handle(IpcChannel.OpenExternal, async (_event, url: unknown): Promise<void> => {
    // Only http(s) is followed: an arbitrary string here could otherwise launch a local handler.
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle(
    IpcChannel.PtyRun,
    async (_event, projectId: unknown, actionId: unknown): Promise<TerminalId | null> => {
      const project = resolveProject(deps.projects(), projectId);
      const action = project?.actions.find((entry) => entry.id === actionId);
      if (project === undefined || action === undefined) {
        return null;
      }
      // The action's own profile when it names one, the default profile otherwise. Resolution goes
      // through the same helper as a shell tab, so an action pointing at a profile that no longer
      // exists degrades to the default instead of failing to launch.
      const profile = resolveDefaultProfile(
        deps.profiles(),
        action.profileId ?? deps.settings.get().defaultShellProfileId,
      );
      if (profile === undefined) {
        return null;
      }

      // Awaited: for a `server` action this call now stops a process still running and waits for it to
      // be gone before relaunching, so `markStarting` below must land after that stop, never before.
      const terminalId = await deps.terminals.runProjectAction(
        project,
        action,
        profile,
        deps.terminalSize(),
      );
      // Only a `server` action owns the row's server state; a task is one-shot and must not make the
      // row claim a server is booting.
      if (action.role === 'server' && terminalId !== null) {
        deps.monitor().markStarting(project.id, null);
      }
      return terminalId;
    },
  );

  ipcMain.handle(
    IpcChannel.TerminalOpenShell,
    async (_event, request: unknown): Promise<TerminalId | null> => {
      const parsed = asShellRequest(request);
      const profile = resolveDefaultProfile(deps.profiles(), parsed.profileId);
      if (profile === undefined) {
        return null;
      }
      return deps.terminals.openShell(profile, deps.terminalSize(), {
        ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
        ...(parsed.title === undefined ? {} : { title: parsed.title }),
      });
    },
  );

  ipcMain.handle(
    IpcChannel.ProjectShell,
    async (_event, projectId: unknown): Promise<TerminalId | null> => {
      const project = resolveProject(deps.projects(), projectId);
      if (project === undefined) {
        return null;
      }
      const profile = resolveDefaultProfile(
        deps.profiles(),
        deps.settings.get().defaultShellProfileId,
      );
      if (profile === undefined) {
        return null;
      }
      return deps.terminals.openProjectShell(project, profile, deps.terminalSize());
    },
  );

  ipcMain.handle(IpcChannel.PtyStop, async (_event, terminalId: unknown): Promise<void> => {
    if (typeof terminalId === 'string') {
      deps.terminals.stop(terminalId);
    }
  });

  ipcMain.handle(IpcChannel.ProjectStop, async (_event, projectId: unknown): Promise<boolean> => {
    if (typeof projectId !== 'string') {
      return false;
    }
    const stopped = deps.terminals.stopProjectServer(projectId);
    if (!stopped) {
      // Logged rather than swallowed: a `Stop` that finds nothing to stop means the row and the
      // session list disagree, and that must be findable instead of looking like a dead button.
      console.log(`[stop] no running server action for ${projectId}`);
    }
    return stopped;
  });

  ipcMain.handle(IpcChannel.TerminalClose, async (_event, terminalId: unknown): Promise<void> => {
    if (typeof terminalId === 'string') {
      deps.terminals.close(terminalId);
    }
  });

  ipcMain.handle(
    IpcChannel.TerminalRename,
    async (_event, terminalId: unknown, title: unknown): Promise<void> => {
      if (typeof terminalId === 'string' && typeof title === 'string') {
        deps.terminals.rename(terminalId, title);
      }
    },
  );

  ipcMain.handle(
    IpcChannel.TerminalLayoutSet,
    async (_event, groups: unknown, direction: unknown): Promise<void> => {
      deps.terminals.setLayout(
        readGroups(groups),
        direction === 'rows' ? 'rows' : 'columns',
      );
    },
  );

  // Fire-and-forget: keystrokes must never wait on a round trip.
  ipcMain.on(IpcChannel.PtyInput, (_event, terminalId: unknown, data: unknown) => {
    if (typeof terminalId === 'string' && typeof data === 'string') {
      deps.terminals.write(terminalId, data);
    }
  });

  ipcMain.on(IpcChannel.PtyResize, (_event, terminalId: unknown, size: unknown) => {
    if (typeof terminalId !== 'string' || typeof size !== 'object' || size === null) {
      return;
    }
    const record = size as Record<string, unknown>;
    deps.terminals.resize(terminalId, {
      cols: typeof record.cols === 'number' ? record.cols : 80,
      rows: typeof record.rows === 'number' ? record.rows : 24,
    });
  });

  ipcMain.handle(IpcChannel.PtyBuffer, async (_event, terminalId: unknown): Promise<string> =>
    typeof terminalId === 'string' ? deps.terminals.buffer(terminalId) : '',
  );

  ipcMain.on(IpcChannel.PtyClear, (_event, terminalId: unknown) => {
    if (typeof terminalId === 'string') {
      deps.terminals.clear(terminalId);
    }
  });

  ipcMain.handle(IpcChannel.ClipboardWrite, async (_event, text: unknown): Promise<void> => {
    if (typeof text === 'string' && text.length > 0) {
      clipboard.writeText(text);
    }
  });

  ipcMain.handle(IpcChannel.ClipboardRead, async (): Promise<string> => clipboard.readText());

  ipcMain.handle(IpcChannel.OpenFolder, async (_event, projectId: unknown): Promise<void> => {
    const project = resolveProject(deps.projects(), projectId);
    if (project !== undefined) {
      await shell.openPath(project.path);
    }
  });

  ipcMain.handle(IpcChannel.ThemeSet, async (_event, mode: unknown): Promise<ThemeState> => {
    const parsed = asThemeMode(mode);
    const state = deps.theme.setMode(parsed);
    await deps.settings.update({ themeMode: parsed });
    return state;
  });

  ipcMain.handle(
    IpcChannel.SettingsUpdate,
    async (_event, patch: unknown): Promise<AppSettings> => {
      const parsed = asPatch(patch);
      const saved = await deps.settings.update(parsed);
      /*
       * Broadcast everything except the keys the dashboard writes about its own geometry. Those are
       * written on every drag release and every tab change, so echoing them back would rebuild the
       * table and the terminal mid-gesture. Anything else can come from the settings window and must
       * reach the dashboard.
       */
      if (Object.keys(parsed).some((key) => !LOCAL_ONLY_KEYS.has(key))) {
        deps.broadcastSettings(saved);
      }
      return saved;
    },
  );

  ipcMain.handle(IpcChannel.ProjectsSave, async (_event, projects: unknown): Promise<AppSettings> => {
    // The store sanitises the list, so a malformed entry from the dialog cannot reach the monitor.
    const saved = await deps.settings.update({ projects: asRawProjects(projects) });
    // Everything downstream is rebuilt: the monitor keys its state by project, so keeping the old one
    // would leave rows for deleted projects and no rows for new ones.
    await deps.reloadProjects();
    return saved;
  });

  ipcMain.handle(
    IpcChannel.ProjectsDetect,
    async (_event, root: unknown): Promise<ProjectCandidate[]> => {
      const settings = deps.settings.get();
      const target = typeof root === 'string' && root.length > 0 ? root : settings.projectsRoot;
      return detectCandidates(target, settings.projects);
    },
  );

  ipcMain.handle(
    IpcChannel.ProjectsBuild,
    async (_event, path: unknown): Promise<ProjectConfig> =>
      configFromPath(typeof path === 'string' ? path : ''),
  );

  ipcMain.handle(
    IpcChannel.ProjectsValidate,
    async (_event, projects: unknown): Promise<ProjectValidation[]> =>
      validateProjects(asRawProjects(projects)),
  );

  ipcMain.handle(
    IpcChannel.ProfilesSave,
    async (_event, profiles: unknown, defaultId: unknown): Promise<AppSettings> => {
      const saved = await deps.settings.update({
        shellProfiles: Array.isArray(profiles) ? (profiles as ShellProfile[]) : [],
        ...(typeof defaultId === 'string' && defaultId.length > 0
          ? { defaultShellProfileId: defaultId }
          : {}),
      });
      // The dashboard builds its new-tab menu from these, and the change comes from another window,
      // so it has no other way to hear about it.
      deps.broadcastSettings(saved);
      return saved;
    },
  );

  ipcMain.handle(IpcChannel.PickFolder, async (event, title: unknown): Promise<string | null> =>
    deps.pickFolder(
      typeof title === 'string' ? title : 'Choose a folder',
      BrowserWindow.fromWebContents(event.sender),
    ),
  );

  ipcMain.handle(IpcChannel.SettingsOpen, async (): Promise<void> => deps.openSettings());

  ipcMain.on(IpcChannel.SettingsDirty, (_event, dirty: unknown) => {
    deps.setSettingsDirty(dirty === true);
  });

  // Lets a renderer close its own window without knowing anything about the others.
  ipcMain.handle(IpcChannel.WindowClose, async (event): Promise<void> => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

/**
 * Passes the dialog's project list through untouched, typed only as an array.
 *
 * Validation deliberately happens in the settings store rather than here: that keeps one sanitising
 * boundary for both a hand-edited file and the dialog, instead of two that can drift apart.
 */
function asRawProjects(value: unknown): ProjectConfig[] {
  return Array.isArray(value) ? (value as ProjectConfig[]) : [];
}

function resolveProject(projects: readonly Project[], id: unknown): Project | undefined {
  return typeof id === 'string' ? findProject(projects, id as ProjectId) : undefined;
}

/**
 * Asks before throwing work away.
 *
 * The one question in the Git tab that is worth a modal. Everything else it does is either reversible
 * (a checkout that fails, a stage, a stash) or leaves an object behind that git can find again (a
 * dropped stash is still in the reflog for a while); a discarded change is gone, and a deleted
 * untracked file was never in the database at all.
 *
 * The files are **named**, up to a handful: "3 files" is not enough to catch a selection that was one
 * row off, which is the mistake this dialog exists to catch. `defaultId` is Cancel, so a stray Enter
 * on a focused dialog does nothing.
 *
 * Anchored on the window the call came from rather than on the main window: this is invoked from the
 * dashboard, but a modal parented to another window would appear behind the one being used.
 */
async function confirmDiscard(
  event: Electron.IpcMainInvokeEvent,
  label: string,
  paths: readonly string[],
): Promise<boolean> {
  const named = paths.slice(0, 8).join('\n');
  const rest = paths.length > 8 ? `\n...and ${paths.length - 8} more` : '';
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['Discard', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Discard changes',
    message:
      paths.length === 1
        ? `Discard the changes to 1 file in ${label}?`
        : `Discard the changes to ${paths.length} files in ${label}?`,
    detail:
      `${named}${rest}\n\n` +
      'Tracked files go back to HEAD, including what is staged. New files are deleted. ' +
      'Nothing here can bring either of them back.',
  };
  const window = BrowserWindow.fromWebContents(event.sender);
  const { response } =
    window === null
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(window, options);
  return response === 0;
}

/**
 * Reads a pane layout off the wire.
 *
 * Shape only: whether the groups make *sense* is `normalizeGroups`' job in the manager, and doing
 * half of it here would be a second opinion on the same question. All this guarantees is that what
 * reaches it is arrays of strings, so a malformed message cannot crash the main process.
 */
function readGroups(value: unknown): TerminalGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const groups: TerminalGroup[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const input = raw as Record<string, unknown>;
    const tabs = Array.isArray(input.tabs)
      ? input.tabs.filter((id): id is string => typeof id === 'string')
      : [];
    const first = tabs[0];
    if (first === undefined) {
      continue;
    }
    groups.push({ tabs, active: typeof input.active === 'string' ? input.active : first });
  }
  return groups;
}

/**
 * Reads a diff target off the wire.
 *
 * Returns null rather than a default on anything unexpected: the two shapes name different git
 * commands, and guessing one would show the wrong thing instead of saying nothing.
 */
function asDiffTarget(value: unknown): GitDiffTarget | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const input = value as Record<string, unknown>;
  if (input.kind === 'commit' && typeof input.sha === 'string' && input.sha.length > 0) {
    return { kind: 'commit', sha: input.sha };
  }
  if (input.kind === 'file' && typeof input.path === 'string' && input.path.length > 0) {
    return { kind: 'file', path: input.path, staged: input.staged === true };
  }
  if (
    input.kind === 'stash' &&
    typeof input.sha === 'string' &&
    input.sha.length > 0 &&
    typeof input.ref === 'string'
  ) {
    return { kind: 'stash', sha: input.sha, ref: input.ref };
  }
  return null;
}

function asThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

function asShellRequest(value: unknown): OpenShellRequest {
  if (typeof value !== 'object' || value === null) {
    return { profileId: '' };
  }
  const input = value as Record<string, unknown>;
  return {
    profileId: typeof input.profileId === 'string' ? input.profileId : '',
    ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
    ...(typeof input.title === 'string' ? { title: input.title } : {}),
  };
}

/** Keeps only the keys the renderer is allowed to change. */
