import { homedir, release } from 'node:os';
import { basename } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import {
  type AgentOpenResult,
  GIT_COMMIT_ACTION_ID,
  IpcChannel,
  ISSUE_KEY_PATTERN,
  RESERVED_ACTION_PREFIX,
  REPO_SLUG_PATTERN,
  workActionId,
  WORK_BATCH_LIMIT,
  WORKTREE_ACTION_ID,
  type AppSettings,
  type BootstrapState,
  type GitDiff,
  type GitDiffTarget,
  type GitRepoState,
  type GeneratedCommit,
  type GitNotice,
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
  type AutoRunRecord,
  type TriageHandoff,
  type TriageState,
  type ProjectValidation,
  type PullReviewState,
  type PullReviewTarget,
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
  readBranches,
  readDiff,
  readRepoState,
  readSequencer,
  resolveSequencer,
  stagePaths,
  stashPush,
  sync,
} from './git/git-commands.js';
import { sanitizeColumns } from '@shared/terminal-groups.js';
import type { AgentContext } from '@shared/agent-context.js';
import { readAgentContext } from './agent/agent-context-reader.js';
import { generateCommitMessage } from './git/generate-commit.js';
import { branchNameFor } from '@shared/branch-name.js';
import { readGitState, readRemoteSlug } from './git/git-service.js';
import { readRepoWorktrees } from './git/git-worktrees.js';
import { GIT_PTY_FILE } from './git/run-git.js';
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
import { setDraft } from './github/gh-write.js';
import { buildHeadlessCommand, describeCommand, readProfile } from '@shared/agent-profile.js';
import { AGENT_TEST_TIMEOUT_MS, runAgent } from './agent/run-agent.js';
import { findFreePort, withPort } from './projects/free-port.js';
import type { PullReviewService } from './review/review-service.js';
import type { AutoRunRecords } from './autorun/auto-run-store.js';
import type { TriageService } from './triage/triage-service.js';
import { buildInteractiveCommand, buildWorkCommand, resolveWorkspaceRoot } from './triage/work-command.js';
import { LOCAL_ONLY_KEYS, asPatch } from './store/settings-patch.js';
import type { SettingsStore } from './store/settings-store.js';
import { resolveBashProfile, resolveDefaultProfile } from './terminal/shell-profiles.js';
import { resolveShellCommand, type TerminalManager } from './terminal/terminal-manager.js';
import type { ThemeController } from './theme.js';
import { noteFromTicket } from '@shared/session-note.js';
import type { UsageState } from '@shared/contracts.js';
import { readUsage } from './usage/usage-reader.js';
import type { AutomationRule } from '@shared/automation.js';
import type { AutomationState } from '@shared/contracts.js';
import { parseRule } from './automation/automation-store.js';

export interface IpcDependencies {
  /** Live project list, re-read on every call since settings can change it at any time. */
  readonly projects: () => readonly Project[];
  readonly monitor: () => ProjectMonitor;
  readonly pulls: () => PullMonitor;
  readonly jira: () => JiraMonitor;
  readonly triage: () => TriageService;
  readonly automations: () => AutomationState;
  readonly saveAutomationRules: (rules: readonly AutomationRule[]) => Promise<AutomationState>;
  readonly forgetAutomation: (ruleId: string, targetId: string | null) => Promise<AutomationState>;
  readonly clearAutomationLog: () => AutomationState;
  readonly pullReview: () => PullReviewService;
  readonly autoRuns: () => AutoRunRecords;
  /** Starts a feedback pass by hand, through the same gate the watcher uses. */
  readonly runFeedbackPass: (
    ticketKey: string,
  ) => Promise<{ terminalId: TerminalId | null; result: GitResult }>;
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
  /**
   * Tells the dashboard how a write it could not wait for turned out.
   *
   * The dashboard only, like `GitPolled`: the servers window has no Git tab to show it in.
   */
  readonly notifyGit: (notice: GitNotice) => void;
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
    // `app.getVersion()` rather than an import of `package.json`: in a packaged build that file is
    // inside the asar and the renderer is a bundle, so an import would ship the number that was true
    // at build time in a place nothing updates.
    appVersion: app.getVersion(),
    shellProfiles: deps.profiles(),
    terminals: deps.terminals.sessions(),
    layout: deps.terminals.layout(),
    pulls: deps.pulls().rows(),
    pullReview: deps.pullReview().state(),
    jira: deps.jira().state(),
    jiraConfig: deps.jiraConfig(),
    terminalCompat: terminalCompat(process.platform, release()),
  }));

  ipcMain.handle(IpcChannel.RefreshNow, async (): Promise<ProjectRow[]> => deps.monitor().refreshAll());

  ipcMain.handle(IpcChannel.PullsRefresh, async (): Promise<RepoPulls[]> =>
    deps.pulls().refreshNow(),
  );

  /* -------------------------------------------------------- pull request review */

  /*
   * Checks a pull request out and starts its dev server on a free port.
   *
   * The gesture the whole review feature is built around for a reader who guarantees consistency:
   * part of what they check is not in a diff, it is on screen, so a pull request has to be openable
   * the way they would open their own branch.
   *
   * Two steps, chained on the first one's exit code, because they cannot be one:
   *
   * 1. `wt pr <repo> <n>` in a terminal tab. The helper owns the worktree life cycle (it junctions
   *    `node_modules`, which is what makes step 2 take seconds rather than an `npm install`), and
   *    this app deliberately never creates a worktree itself.
   * 2. The project's own `server` action, in that folder, with the port replaced by a free one so it
   *    does not fight the dev server already running in the main checkout.
   *
   * The folder is **read back from git** rather than assumed: `_WT_ROOT` lives in the helper, and
   * guessing a path the helper decides would break the first time somebody moves their worktrees.
   */
  ipcMain.handle(
    IpcChannel.PullReviewWorkspace,
    async (
      _event,
      projectId: unknown,
      number: unknown,
    ): Promise<{ terminalId: TerminalId | null; result: GitResult }> => {
      const project = resolveProject(deps.projects(), projectId);
      const pullNumber = Number(number);
      if (project === undefined || !Number.isInteger(pullNumber) || pullNumber <= 0) {
        return { terminalId: null, result: { ok: false, message: 'Unknown pull request' } };
      }

      const profile = resolveBashProfile(deps.profiles(), deps.settings.get().defaultShellProfileId);
      if (profile === undefined) {
        return {
          terminalId: null,
          result: { ok: false, message: `No bash profile: "${WORKTREE_HELPER}" cannot be launched` },
        };
      }

      const repoFolder = basename(project.path);
      const built = buildWorktreeCommand({ kind: 'pull', number: pullNumber }, repoFolder);
      if (built.command === undefined) {
        return { terminalId: null, result: { ok: false, message: built.error } };
      }

      const folder = `pr-${pullNumber}-${repoFolder}`;
      const resolved = resolveShellCommand(profile, built.command);
      const terminalId = deps.terminals.runProjectCommand({
        project,
        actionId: WORKTREE_ACTION_ID,
        title: `${project.label} · ${WORKTREE_HELPER} pr ${pullNumber}`,
        file: resolved.file,
        args: resolved.args,
        size: deps.terminalSize(),
        profileId: profile.id,
        onExit: (exitCode, stopped) => {
          if (stopped || exitCode !== 0) {
            // The tab already shows why. Saying it again here would be a second voice on one failure.
            return;
          }
          void startWorkspaceServer(deps, project, folder, pullNumber);
        },
      });

      return {
        terminalId,
        result:
          terminalId === null
            ? { ok: false, message: 'Could not open the tab' }
            : { ok: true, message: `${built.command} launched` },
      };
    },
  );


  /*
   * The target is narrowed here rather than trusted, like every other payload that reaches this
   * process. An unrecognised kind becomes `all`, which is the mode that reviews the most and posts
   * under exactly the same rules: the safe default of the three is the one that cannot silently
   * review fewer pull requests than the reader believes.
   */
  ipcMain.handle(
    IpcChannel.PullReviewRun,
    async (_event, target: unknown): Promise<PullReviewState> =>
      deps.pullReview().run(asReviewTarget(target)),
  );

  ipcMain.handle(IpcChannel.PullReviewCancel, async (): Promise<PullReviewState> =>
    deps.pullReview().cancel(),
  );

  /*
   * The three review events, asked for by hand.
   *
   * The event is narrowed to the three GitHub accepts and anything else is refused outright rather
   * than defaulted: there is no safe default among "approve", "block" and "say something", so a
   * payload that does not name one is a bug and is treated as one.
   */
  ipcMain.handle(
    IpcChannel.PullReviewSubmit,
    async (_event, slug: unknown, number: unknown, event: unknown): Promise<PullReviewState> => {
      const id = Number(number);
      const known = event === 'APPROVE' || event === 'REQUEST_CHANGES' || event === 'COMMENT';
      if (typeof slug !== 'string' || !REPO_SLUG_PATTERN.test(slug) || !Number.isInteger(id) || !known) {
        return deps.pullReview().state();
      }
      return deps.pullReview().submitManual(slug, id, event);
    },
  );

  ipcMain.handle(
    IpcChannel.PullReviewRetract,
    async (_event, slug: unknown, number: unknown): Promise<PullReviewState> => {
      const id = Number(number);
      if (typeof slug !== 'string' || !REPO_SLUG_PATTERN.test(slug) || !Number.isInteger(id)) {
        return deps.pullReview().state();
      }
      return deps.pullReview().retract(slug, id);
    },
  );

  /*
   * One real run, which is the only thing that proves a profile.
   *
   * The prompt is deliberately trivial, so what is being measured is the **plumbing**: does the
   * binary exist, does the flag mean "answer and exit", does the prompt get in, does an answer come
   * out in the shape the profile claims. A heavier prompt would measure the model instead, and take
   * minutes doing it.
   *
   * The command line goes back in the message, success or failure. It is the whole point: a headless
   * run has no terminal tab, so without it a wrong flag reads as thirty seconds of nothing.
   */
  ipcMain.handle(
    IpcChannel.AgentTest,
    async (_event, payload: unknown): Promise<{ ok: boolean; message: string }> => {
      const profile = readProfile(payload, deps.settings.get().agentProfile);
      const { file, args } = buildHeadlessCommand(profile, {});
      const command = describeCommand(file, args);
      if (file.length === 0) {
        return { ok: false, message: 'No command configured' };
      }

      const run = await runAgent({
        profile,
        cwd: deps.settings.get().projectsRoot,
        prompt: 'Reply with the single word READY and nothing else.',
        timeoutMs: AGENT_TEST_TIMEOUT_MS,
        label: profile.label,
      });

      if (!run.ok) {
        // `runAgent` already appends the command to its own errors, so it is not repeated here.
        return { ok: false, message: run.error ?? `${profile.label} did not answer` };
      }
      const answer = run.answer.trim().split(/\r?\n/)[0] ?? '';
      return {
        ok: true,
        message: `${profile.label} answered "${answer.slice(0, 60)}"  ·  ${command}`,
      };
    },
  );

  ipcMain.handle(
    IpcChannel.PullReviewBody,
    async (_event, slug: unknown, number: unknown): Promise<string> => {
      const id = Number(number);
      if (typeof slug !== 'string' || !REPO_SLUG_PATTERN.test(slug) || !Number.isInteger(id)) {
        return '';
      }
      return deps.pullReview().bodyOf(slug, id);
    },
  );

  ipcMain.handle(
    IpcChannel.PullReviewDraft,
    async (_event, projectId: unknown, number: unknown, draft: unknown): Promise<GitResult> => {
      const project = resolveProject(deps.projects(), projectId);
      const id = Number(number);
      if (project === undefined || !Number.isInteger(id)) {
        return { ok: false, message: 'Unknown pull request' };
      }
      if (!deps.settings.get().reviewWritesEnabled) {
        // The same master switch as every other write. A state change is smaller than a review and
        // it is still this app speaking on GitHub under its owner's name.
        return { ok: false, message: 'Writing to GitHub is turned off in the settings' };
      }
      // From the poll's rows rather than resolved again: the monitor already caches one slug per
      // project for the whole session, and a second resolver would be a second answer to "which
      // repository is this", which is the drift `verdictFor` and `isStaged` were merged to avoid.
      const slug = deps.pulls().rows().find((row) => row.projectId === project.id)?.slug ?? null;
      if (slug === null) {
        return { ok: false, message: 'This repository has no GitHub remote' };
      }
      const outcome = await setDraft(slug, id, draft === true);
      if (outcome.kind === 'posted') {
        deps.pulls().refreshNow().catch(() => undefined);
        return { ok: true, message: draft === true ? `#${id} is back to draft` : `#${id} is ready for review` };
      }
      return { ok: false, message: outcome.message };
    },
  );

  ipcMain.handle(
    IpcChannel.PullReviewDismiss,
    async (_event, slug: unknown, number: unknown): Promise<PullReviewState> => {
      const id = Number(number);
      if (typeof slug !== 'string' || !REPO_SLUG_PATTERN.test(slug) || !Number.isInteger(id)) {
        return deps.pullReview().state();
      }
      return deps.pullReview().dismiss(slug, id);
    },
  );

  ipcMain.handle(IpcChannel.JiraRefresh, async (): Promise<JiraState> => deps.jira().refreshNow());

  /* --------------------------------------------------------------- triage */

  ipcMain.handle(IpcChannel.TriageRefresh, async (): Promise<TriageState> => deps.triage().refresh());

  /*
   * The sprint id arrives from the renderer and is coerced here rather than trusted: it ends up in a
   * Jira path, and the service also matches it against the sprint list before doing anything.
   *
   * The mode is narrowed the same way, and anything unrecognised becomes `full`. That default is the
   * safe one of the two: a full run re-reads tickets that already had a verdict, which costs minutes,
   * whereas an unintended `new` would silently leave tickets unclassified and look like a sprint that
   * holds fewer than it does.
   */
  ipcMain.handle(
    IpcChannel.TriageAnalyse,
    async (_event, sprintId: unknown, mode: unknown): Promise<TriageState> => {
      const id = Number(sprintId);
      if (!Number.isInteger(id)) {
        return deps.triage().state();
      }
      return deps.triage().analyse(id, mode === 'new' ? 'new' : 'full');
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
        model: deps.settings.get().agentCommitModel,
        profile: deps.settings.get().agentProfile,
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
      push: unknown,
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
        /*
         * The push half, chained on the commit's own exit.
         *
         * Two things make this honest rather than a guess. The exit code is the **commit's**, handed
         * over by the pty this process spawned, so a hook that refused the commit stops the push dead
         * — which is the entire reason the two are one button instead of two clicks. And the outcome
         * travels on `GitNotice`, because by then the invoke has long since answered with the tab.
         *
         * `sync` re-reads the branch and its upstream rather than taking them from the click: minutes
         * pass in that tab, and a first push needs `-u origin <branch>` that a stale read would miss.
         */
        onExit:
          push === true
            ? (exitCode, stopped) => {
                if (stopped) {
                  return;
                }
                if (exitCode !== 0) {
                  deps.notifyGit({
                    projectId: project.id,
                    ok: false,
                    message: 'Commit failed, nothing pushed',
                  });
                  return;
                }
                void (async () => {
                  const state = await readRepoState(project);
                  const result = await sync(project.path, 'push', state.branch, state.hasUpstream);
                  deps.notifyGit({ projectId: project.id, ...result });
                })();
              }
            : undefined,
        project,
        actionId: GIT_COMMIT_ACTION_ID,
        title: `${project.label} · ${amend === true ? 'amend' : 'commit'}`,
        // git straight from PATH, no shell: the app already calls it that way everywhere else.
        // `--cleanup=strip` drops comment lines and trailing blanks the way an editor session would.
        // The amend runs in the same tab for the same reason the commit does: it fires the very same
        // hooks, and rewriting HEAD silently is worse than rewriting it in front of the user.
        //
        // `GIT_PTY_FILE` and not `'git'`: node-pty is the one spawner in this app that does not append
        // `.exe`, so a bare name throws and the tab shows `Could not launch git`. See its own note.
        file: GIT_PTY_FILE,
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
   * Creates a ticket's branch, or switches to it when it is already there.
   *
   * **Native since 5.8.2, and it used to shell out to a `dev <TICKET>` alias.** That alias is a Python
   * script in the author's own profile, so on any other machine this opened a tab reading
   * `command not found`. Replacing it was not merely a portability fix, it is a better shape on three
   * counts: the summary is already on screen, so no second round trip to Jira is needed to build the
   * name; `git check-ref-format` validates it, which is stricter and more honest than the script's
   * own slug; and the outcome is one line in the strip instead of a terminal tab, which is the line
   * the Git tab already draws (a quick write goes through `execFile`, only a commit earns a tab).
   *
   * The renderer still names a ticket and a project, never a command line, and the key is matched
   * against `ISSUE_KEY_PATTERN` before anything happens. The summary is free text and never reaches a
   * shell: `branchNameFor` reduces it to letters, digits and hyphens, and `createBranch` calls git
   * with an argument array.
   *
   * An existing branch is **switched to**, not reported as a failure. That is what the script did and
   * it is the honest reading of the gesture: clicking a ticket twice means "put me on that ticket",
   * not "create it again". A checkout blocked by local changes still fails, with git's own message.
   */
  ipcMain.handle(
    IpcChannel.JiraBranch,
    async (
      _event,
      projectId: unknown,
      issueKey: unknown,
      summary: unknown,
    ): Promise<GitResult> => {
      const project = resolveProject(deps.projects(), projectId);
      if (project === undefined) {
        return { ok: false, message: 'Project not found' };
      }
      const key = typeof issueKey === 'string' ? issueKey.trim().toUpperCase() : '';
      if (!ISSUE_KEY_PATTERN.test(key)) {
        return { ok: false, message: 'Invalid issue key' };
      }

      const name = branchNameFor(key, typeof summary === 'string' ? summary : '');
      const existing = await readBranches(project.path);
      if (existing.some((branch) => branch.name === name)) {
        const switched = await checkoutBranch(project.path, name);
        return switched.ok ? { ok: true, message: `Switched to ${name}` } : switched;
      }
      return createBranch(project.path, name, true);
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
      handoff: unknown,
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

      const cwd = resolveWorkspaceRoot(settings.workspaceRoot, project.path);
      // Anything that is not literally `auto` is the asking handoff. The unattended run is the one that
      // publishes without a human, so it is opted into by an exact word and never by a value that
      // merely failed to be something else.
      const mode: TriageHandoff = handoff === 'auto' ? 'auto' : 'ask';
      const command = buildWorkCommand(
        keys,
        basename(project.path),
        settings.agentWorkModel,
        settings.agentProfile,
        mode,
      );
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
        // Captured from the settings as they stand at the spawn, never re-read later: both the model
        // and the profile can change while this session runs, and reporting the new one would
        // describe the NEXT handoff rather than this one.
        agent: {
          label: settings.agentProfile.label,
          model: settings.agentWorkModel,
          instructionFile: settings.agentProfile.instructionFile,
          startedAt: new Date().toISOString(),
        },
        /*
         * The session is born saying what it was sent to do, and this is what makes notes worth
         * having at all.
         *
         * A note the reader has to type is a note written on the handful of sessions they happened
         * to think about, and it is the other ninety that make a board unreadable. The text comes
         * from `triage.json` rather than from the channel, the same door `estimateFor` uses: the
         * analysis is on disk and any part of the app may go and read the current one.
         *
         * A batch gets no note. `noteFromTicket` describes ONE ticket, and eight of them in a box
         * three lines tall would be a note that says less than the tab title beside it already
         * does.
         */
        note:
          keys.length === 1 && keys[0] !== undefined
            ? noteFromTicket(deps.triage().ticketFor(keys[0]), basename(project.path))
            : null,
      });

      /*
       * An unattended run is remembered, an asking one is not.
       *
       * Only the first opens a pull request nobody will be watching, which is the thing the record
       * exists to follow. The branch and the number are deliberately absent here: the skill invents
       * the branch and GitHub mints the number, so both are learned later from the pull request poll
       * rather than guessed now. An existing record is left alone, a second handoff on one ticket
       * being a retry rather than a new run.
       */
      if (mode === 'auto' && terminalId !== null) {
        const slug = await readRemoteSlug(project.path);
        let added = false;
        for (const key of keys) {
          if (deps.autoRuns().get(key) === undefined) {
            deps.autoRuns().set({
              ticketKey: key,
              projectId: project.id,
              slug: slug ?? '',
              branch: '',
              port: null,
              prNumber: null,
              prMatchedAt: null,
              feedbackPhase: 'watching',
              lastSeenCommentId: 0,
              mergedAt: null,
              feedbackStartedAt: null,
              feedbackFinishedAt: null,
              pendingCount: 0,
              notice: null,
              lastRefusal: null,
            });
            added = true;
          }
        }
        if (added) {
          await deps.autoRuns().write();
        }
      }

      return {
        terminalId,
        result:
          terminalId === null
            ? { ok: false, message: 'Could not open the tab' }
            : {
                ok: true,
                message: `${keys.join(', ')} handed to ${settings.agentProfile.label} in ${
                  project.label
                }${mode === 'auto' ? ', unattended' : ''}`,
              },
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
  /**
   * Starts a feedback pass by hand.
   *
   * Through the same service method the watcher uses, and therefore through the same gate: a pass
   * started by a click must not be able to do what a watched one is refused, or the gate stops being
   * the answer to "may this run" and becomes one of two answers.
   */
  ipcMain.handle(
    IpcChannel.FeedbackPass,
    async (
      _event,
      ticketKey: unknown,
    ): Promise<{ terminalId: TerminalId | null; result: GitResult }> => {
      const key = typeof ticketKey === 'string' ? ticketKey.trim().toUpperCase() : '';
      if (!ISSUE_KEY_PATTERN.test(key)) {
        return { terminalId: null, result: { ok: false, message: 'No valid issue key' } };
      }
      return deps.runFeedbackPass(key);
    },
  );

  ipcMain.handle(IpcChannel.AutoRunsRefresh, (): AutoRunRecord[] => deps.autoRuns().all());

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
    IpcChannel.AgentContextRead,
    async (_event, terminalId: unknown): Promise<AgentContext | null> => {
      if (typeof terminalId !== 'string') {
        return null;
      }
      const session = deps.terminals.sessions().find((entry) => entry.id === terminalId);
      // No agent means nothing to describe. A shell reads no instruction file of its own, and
      // answering with the chain anyway would put a context panel on a bash prompt.
      if (session?.agent == null) {
        return null;
      }
      return readAgentContext(session.cwd, session.agent.instructionFile, homedir());
    },
  );

  ipcMain.handle(IpcChannel.AgentOpen, async (): Promise<AgentOpenResult> => {
    const settings = deps.settings.get();
    const shell = resolveDefaultProfile(deps.profiles(), settings.defaultShellProfileId);
    if (shell === undefined) {
      return { terminalId: null, message: 'No shell profile available to run the agent in' };
    }
    if (settings.agentProfile.interactive.trim().length === 0) {
      return { terminalId: null, message: 'The agent profile has no interactive command' };
    }
    /*
     * The agent's own interactive command line, run through the shell profile.
     *
     * The same two-step every agent tab in this app goes through: the profile says what to run, the
     * shell profile says how to run it on this machine. Skipping the second would spawn the binary
     * directly and lose the environment a login shell sets up, which is where `claude` lives on a
     * normal install.
     */
    const command = buildInteractiveCommand(settings.agentProfile, settings.agentWorkModel);
    const resolved = resolveShellCommand(shell, command);
    const terminalId = deps.terminals.openAgent({
      title: settings.agentProfile.label,
      file: resolved.file,
      args: resolved.args,
      // The workspace root, never a repository: memory and instructions are indexed by working
      // directory, so a session started in a repository begins with neither.
      cwd: resolveWorkspaceRoot(settings.workspaceRoot, settings.projectsRoot),
      size: deps.terminalSize(),
      profileId: shell.id,
      agent: {
        label: settings.agentProfile.label,
        model: settings.agentWorkModel,
        instructionFile: settings.agentProfile.instructionFile,
        startedAt: new Date().toISOString(),
      },
    });
    return {
      terminalId,
      // A null from the manager means the pty could not be spawned, which it records as a dead tab
      // carrying the reason. Saying so here as well is what stops the button looking inert.
      message: terminalId === null ? `${settings.agentProfile.label} could not be started` : '',
    };
  });

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
    IpcChannel.TerminalNote,
    async (_event, terminalId: unknown, text: unknown): Promise<void> => {
      if (typeof terminalId === 'string' && typeof text === 'string') {
        deps.terminals.setNote(terminalId, text);
      }
    },
  );

  /*
   * Pulled when the tab is shown, never polled.
   *
   * Same judgement as the Git and Worktrees tabs: these are two files on disk that change when an
   * agent runs, and reading them for a tab nobody is looking at is work for nobody. The renderer
   * asks when it shows the tab and when the refresh button is pressed, which is exactly when the
   * answer can have changed and somebody is there to read it.
   */
  ipcMain.handle(IpcChannel.UsageRead, async (): Promise<UsageState> => readUsage());

  ipcMain.handle(
    IpcChannel.AutomationsRead,
    async (): Promise<AutomationState> => deps.automations(),
  );

  ipcMain.handle(
    IpcChannel.AutomationsSave,
    async (_event, rules: unknown): Promise<AutomationState> => {
      /*
       * Sanitised in the main process, never trusted as sent.
       *
       * The renderer builds a form; what arrives is whatever reached this channel. These rows decide
       * whether an agent starts on its own, so they go through the same parser a hand-edited file
       * goes through, which is the rule `tagColors` records: a whole object crossing the boundary is
       * checked at the boundary and not only where it is read.
       */
      const parsed = Array.isArray(rules)
        ? rules.map(parseRule).filter((rule): rule is AutomationRule => rule !== null)
        : [];
      return deps.saveAutomationRules(parsed);
    },
  );

  ipcMain.handle(
    IpcChannel.AutomationsClearLog,
    async (): Promise<AutomationState> => deps.clearAutomationLog(),
  );

  ipcMain.handle(
    IpcChannel.AutomationsForget,
    async (_event, ruleId: unknown, targetId: unknown): Promise<AutomationState> => {
      if (typeof ruleId !== 'string') {
        return deps.automations();
      }
      return deps.forgetAutomation(ruleId, typeof targetId === 'string' ? targetId : null);
    },
  );

  ipcMain.handle(
    IpcChannel.TerminalLayoutSet,
    async (_event, groups: unknown, columns: unknown): Promise<void> => {
      // `sanitizeColumns` and not a cast: this is an IPC boundary, and the manager clamps with the
      // same function, so a value refused here and accepted there is not a shape that can exist.
      deps.terminals.setLayout(readGroups(groups), sanitizeColumns(columns));
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

/**
 * Starts the project's dev server inside a freshly created review worktree.
 *
 * Runs after `wt pr` has exited cleanly, so the folder exists; it is found by asking **git** for the
 * worktree list rather than by rebuilding the path, because where worktrees live is the helper's
 * decision and not this app's.
 *
 * The port is probed and **replaced** in the command rather than appended: most of these commands
 * already carry one, and two `--port` flags make the result depend on which the CLI keeps. What ends
 * up on screen is still the port the process announces, since the probe can go stale between the
 * bind and the launch.
 *
 * Everything it has to say arrives on `GitNotice`, the channel built for an outcome that lands after
 * the invoke that started it has already answered.
 */
async function startWorkspaceServer(
  deps: IpcDependencies,
  project: Project,
  folder: string,
  pullNumber: number,
): Promise<void> {
  const entries = await readRepoWorktrees(project);
  const worktree = entries.worktrees.find((entry) => entry.name === folder);
  if (worktree === undefined) {
    deps.notifyGit({
      projectId: project.id,
      ok: false,
      message: `The worktree ${folder} was not created`,
    });
    return;
  }

  const action = project.actions.find((entry) => entry.role === 'server');
  if (action === undefined) {
    // Not a failure: the checkout is there and usable, this project simply has no server to start.
    deps.notifyGit({
      projectId: project.id,
      ok: true,
      message: `#${pullNumber} checked out in ${folder}, no server action to start`,
    });
    return;
  }

  const profile = deps.profiles().find((entry) => entry.id === deps.settings.get().defaultShellProfileId)
    ?? deps.profiles()[0];
  if (profile === undefined) {
    deps.notifyGit({ projectId: project.id, ok: false, message: 'No shell profile to start the server' });
    return;
  }

  const port = await findFreePort();
  const command = port === null ? action.command : withPort(action.command, port);
  const resolved = resolveShellCommand(profile, command);
  const terminalId = deps.terminals.runProjectCommand({
    project,
    // Its own reserved id, so this tab is neither the worktree helper's nor the project's own server:
    // starting the review server must not stop the one running in the main checkout.
    actionId: `${RESERVED_ACTION_PREFIX}review-server:${pullNumber}`,
    title: `${project.label} · #${pullNumber}`,
    file: resolved.file,
    args: resolved.args,
    size: deps.terminalSize(),
    profileId: profile.id,
    cwd: worktree.path,
  });

  deps.notifyGit({
    projectId: project.id,
    ok: terminalId !== null,
    message:
      terminalId === null
        ? `#${pullNumber} is checked out, but its server tab could not open`
        : `#${pullNumber} checked out, server starting${port === null ? '' : ` on :${port}`}`,
  });
}

/**
 * Narrows a review target coming from the renderer.
 *
 * An unrecognised kind becomes `all` over every followed repository, which is the mode that reads
 * the **most**: the three post under identical rules, so the one default that cannot mislead is the
 * one that never silently reviews fewer pull requests than the reader believes it did. A `pull`
 * target missing its project or its number degrades to `all` for the same reason.
 */
function asReviewTarget(value: unknown): PullReviewTarget {
  if (typeof value !== 'object' || value === null) {
    return { kind: 'all', projectId: null };
  }
  const target = value as { kind?: unknown; projectId?: unknown; number?: unknown };
  const projectId = typeof target.projectId === 'string' ? target.projectId : null;
  const number = Number(target.number);
  if (target.kind === 'pull' && projectId !== null && Number.isInteger(number)) {
    return { kind: 'pull', projectId, number };
  }
  if (target.kind === 'new') {
    return { kind: 'new', projectId };
  }
  return { kind: 'all', projectId };
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
