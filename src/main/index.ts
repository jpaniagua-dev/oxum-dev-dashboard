import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import {
  IpcChannel,
  type AppSettings,
  type JiraConfig,
  type ProjectRow,
  type ShellProfile,
  type TerminalLayout,
  type TerminalSession,
} from '@shared/contracts.js';
import { writeCommitMessage } from './git/commit-message.js';
import {
  patchPaths,
  readBotFindings,
  readPatch,
  readPullDetail,
  readReviewComments,
  readReviews,
} from './github/gh-review-read.js';
import { AutoRunStore } from './autorun/auto-run-store.js';
import { FeedbackWatcher, type FeedbackPorts } from './feedback/feedback-watcher.js';
import { buildFeedbackCommand } from './feedback/feedback-command.js';
import { feedbackActionId } from '@shared/contracts.js';
import { resolveWorkspaceRoot } from './triage/work-command.js';
import { PullMonitor } from './github/pull-monitor.js';
import { dismissReview, submitReview, writeReviewBody } from './github/gh-write.js';
import { readViewerLogin } from './github/viewer.js';
import { PullReviewService } from './review/review-service.js';
import { runAgent } from './agent/run-agent.js';
import { registerIpcHandlers } from './ipc.js';
import { JiraMonitor } from './jira/jira-monitor.js';
import { TriageService } from './triage/triage-service.js';
import { buildJql, searchIssues } from './jira/jira-service.js';
import { SecretStore } from './store/secret-store.js';
import { sameProjectSet } from '@shared/project-order.js';
import { ProjectMonitor } from './projects/project-monitor.js';
import { resolveProjects } from './projects/registry.js';
import { ServersWindow, SERVERS_WINDOW_BOUNDS } from './servers-window.js';
import { SettingsWindow, SETTINGS_WINDOW_BOUNDS } from './settings-window.js';
import { AppPaths } from './store/paths.js';
import { SettingsStore } from './store/settings-store.js';
import { WindowStateStore } from './store/window-state.js';
import { basename } from 'node:path';
import { detectProfiles, mergeProfiles, resolveDefaultProfile } from './terminal/shell-profiles.js';
import { TerminalManager, resolveShellCommand } from './terminal/terminal-manager.js';
import { ThemeController } from './theme.js';
import { DashboardWindow, loadRendererPage, preloadPath } from './window.js';

/**
 * Development runs get their own data directory.
 *
 * Sharing `userData` with an installed build would mean sharing settings, window state and the
 * single-instance lock, so running from source would fight the installed app.
 */
if (!app.isPackaged) {
  app.setPath('userData', `${app.getPath('userData')}-dev`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/** Terminal geometry reported by the renderer, used when spawning a process. */
let terminalSize = { cols: 120, rows: 24 };
/**
 * Whether a Jira token is stored.
 *
 * Kept as a flag rather than re-read on every call: the settings form only needs to know that one exists,
 * and the token itself has no business travelling back towards the renderer.
 */
let hasJiraToken = false;
let dashboard: DashboardWindow | null = null;
let terminals: TerminalManager | null = null;
let monitor: ProjectMonitor | null = null;
/** Set once the user has confirmed a quit, so the second close attempt goes through. */
let quitConfirmed = false;

void bootstrap();

async function bootstrap(): Promise<void> {
  await app.whenReady();

  const settingsStore = new SettingsStore(AppPaths.settings());
  const settings = await settingsStore.load();

  /*
   * A first launch adds nothing, and that is a decision rather than a gap.
   *
   * There used to be a seeding pass over three hardcoded folder names (`web-app`, `admin-front`,
   * `design-system`). Those names are placeholders this repository is public with, so the pass matched
   * **nothing on any machine**, the author's included: the empty table was already every user's first
   * launch, under a message that told them to "check the paths in the registry".
   *
   * Detecting repositories automatically instead was the obvious replacement and is refused on a
   * measured ground: every project costs a `git` process on every poll, and creating a process is
   * expensive here (see the performance section of `CLAUDE.md`). A first launch that silently adopted
   * twenty-five repositories would hand the user a freeze nobody chose. `Detect repositories` offers
   * exactly that list, on demand, and then the choice belongs to whoever will live with it.
   *
   * What carries the first launch is therefore the empty state of the table, which names the two ways
   * in and is reachable without reading anything.
   */

  let projects = resolveProjects(settingsStore.get().projects);
  const windowStateStore = new WindowStateStore(AppPaths.windowState());
  const dashboardWindow = new DashboardWindow(windowStateStore);
  dashboard = dashboardWindow;

  const settingsWindow = new SettingsWindow(
    new WindowStateStore(AppPaths.settingsWindowState(), SETTINGS_WINDOW_BOUNDS),
    {
      preloadPath: preloadPath(),
      // Read at open time, not captured: the theme may have changed since startup, and the
      // background colour is what gets painted before the page renders.
      backgroundColor: () => themeController.backgroundColor(),
    },
  );

  /*
   * The servers window, and the ownership rule that comes with it.
   *
   * `onClosed` hands the sessions back unconditionally, however the window went: closed by its own
   * button, by the title bar, or with the app shutting down. A running dev server owned by a window that
   * no longer exists would be work with nothing able to show or stop it, which this app does not allow.
   */
  const serversWindow: ServersWindow = new ServersWindow(
    new WindowStateStore(AppPaths.serversWindowState(), SERVERS_WINDOW_BOUNDS),
    {
      preloadPath: preloadPath(),
      backgroundColor: () => themeController.backgroundColor(),
      onClosed: () => {
        terminals?.setServersDetached(false);
        dashboardWindow.send(IpcChannel.ServersDetachedChanged, false);
      },
    },
  );

  /** Sends to every live window. Used for state no window owns: the theme and the settings. */
  const broadcast = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload);
      }
    }
  };

  const themeController = new ThemeController(
    (state) => broadcast(IpcChannel.ThemeChanged, state),
    (color) => {
      dashboardWindow.setBackgroundColor(color);
      settingsWindow.setBackgroundColor(color);
      serversWindow.setBackgroundColor(color);
    },
  );
  themeController.setMode(settings.themeMode);

  const buildMonitor = (): ProjectMonitor =>
    new ProjectMonitor(
      projects,
      () => settingsStore.get(),
      (rows: ProjectRow[]) => {
        dashboardWindow.send(IpcChannel.RowsChanged, rows);
        // The servers window paints a phase per tile, and the phase lives on the row. Broadcast rather
        // than routed, unlike the pty output: this is one small payload on the poll's cadence, not a
        // byte stream, and there is nothing per-window to decide about it.
        serversWindow.send(IpcChannel.RowsChanged, rows);
      },
      // The dashboard only: the servers window has no tab that reads git on demand.
      () => dashboardWindow.send(IpcChannel.GitPolled),
    );

  let projectMonitor = buildMonitor();
  monitor = projectMonitor;

  // Its own loop, on its own cadence: one `gh` call per watched repository is minutes-slow work next to
  // a local git read.
  /*
   * What the app remembers about each unattended run, and the watcher that rides the pull request poll.
   *
   * On that poll and with no timer of its own, deliberately: the payload is the authority on whether a
   * pull request is still open, so a second cadence would be free to disagree with the state it depends
   * on.
   */
  const autoRuns = new AutoRunStore();
  await autoRuns.load();

  /**
   * Opens the tab a feedback pass runs in.
   *
   * Assigned once the terminal manager exists, because it is the one thing here that cannot be built
   * before it. Null until then, and the watcher simply launches nothing, which is the correct state
   * during start-up: there is no window to bring a session forward into yet.
   */
  let spawnFeedbackTab: FeedbackPorts['spawn'] = () => null;

  const feedbackWatcher = new FeedbackWatcher(
    autoRuns,
    () => settingsStore.get(),
    () => projects,
    {
      readComments: readReviewComments,
      viewerLogin: readViewerLogin,
      isActionRunning: (projectId, actionId) => terminals?.isActionRunning(projectId, actionId) === true,
      spawn: (input) => spawnFeedbackTab(input),
      now: () => new Date(),
    },
  );

  const buildPullMonitor = (): PullMonitor =>
    new PullMonitor(
      projects,
      () => settingsStore.get(),
      (repos) => {
        dashboardWindow.send(IpcChannel.PullsChanged, repos);
        // After the broadcast, never before: the list must fill in whatever the watcher then decides,
        // and the records follow on their own channel once the tick has had its say.
        void feedbackWatcher
          .tick(pullMonitor.rows().flatMap((repo) => repo.pulls))
          .then(() => dashboardWindow.send(IpcChannel.AutoRunsChanged, autoRuns.all()));
      },
    );

  let pullMonitor = buildPullMonitor();

  // The token lives here, encrypted, and never crosses back to the renderer.
  const secrets = new SecretStore(AppPaths.jiraToken());
  const jiraMonitor = new JiraMonitor(
    () => settingsStore.get(),
    secrets,
    (state) => dashboardWindow.send(IpcChannel.JiraChanged, state),
  );

  // Triage shares the Jira credentials and nothing else: it is pulled, never polled.
  const triageService = new TriageService(
    () => settingsStore.get(),
    secrets,
    (state) => dashboardWindow.send(IpcChannel.TriageChanged, state),
  );
  await triageService.load();

  /*
   * The review agent, with its ports handed in rather than imported.
   *
   * It is the one service in this app that can write to GitHub, so the modules that reach the
   * network are passed as arguments: "did this run post anything" has to be a question a test can
   * ask without a network, and an imported `gh` cannot be asked.
   */
  const pullReviewService = new PullReviewService(
    () => settingsStore.get(),
    () => pullMonitor.rows(),
    (projectId) => projects.find((project) => project.id === projectId)?.path ?? null,
    {
      readDetail: readPullDetail,
      readPatch,
      readBotFindings,
      readReviews,
      patchPaths,
      runAgent,
      viewerLogin: readViewerLogin,
      writeBody: writeReviewBody,
      submitReview,
      retract: dismissReview,
    },
    (state) => dashboardWindow.send(IpcChannel.PullReviewChanged, state),
  );
  await pullReviewService.load();

  /** The connection as the renderer may see it: everything except the token. */
  const jiraConfig = (): JiraConfig => {
    const { siteUrl, email, projectKeys } = settingsStore.get().jira;
    return { siteUrl, email, projectKeys: [...projectKeys], hasToken: hasJiraToken };
  };

  const terminalManager = new TerminalManager({
    /*
     * Output goes to the one window that owns the session, never to both.
     *
     * Not a broadcast, and the reason is measured rather than stylistic: `TerminalPane.write` creates a
     * view for whatever id it is handed, so a broadcast would build a second, hidden xterm per detached
     * server in the dashboard and feed it every byte of a `ng serve`. Routing costs one map lookup.
     */
    onOutput: (terminalId, data) => {
      const target = terminalManager.isDetached(terminalId) ? serversWindow : dashboardWindow;
      target.send(IpcChannel.PtyOutput, { terminalId, data });
    },
    // Reads `projectMonitor` through the closure rather than capturing it, so output keeps reaching
    // the current monitor after the project list is rebuilt.
    onParsed: (projectId, parsed) => projectMonitor.applyParsed(projectId, parsed),
    onProjectStartExit: (projectId, exitCode, stopped) =>
      projectMonitor.markExited(projectId, exitCode, stopped),
    /*
     * Each window is told about its own sessions and no others.
     *
     * This is what makes detaching work with no change to `TerminalPane`: its `setSessions` already
     * disposes the views of sessions that have left the list and re-normalises its panes, so a dashboard
     * that stops being told about a server drops its tab and frees its terminal on its own. The servers
     * window does the same in reverse. One rule, applied twice, instead of a "hide this tab" flag
     * threaded through the renderer.
     */
    onSessionsChanged: (sessions: TerminalSession[]) => {
      dashboardWindow.send(
        IpcChannel.TerminalsChanged,
        sessions.filter((session) => !terminalManager.isDetached(session.id)),
      );
      serversWindow.send(
        IpcChannel.TerminalsChanged,
        sessions.filter((session) => terminalManager.isDetached(session.id)),
      );
    },
    onLayoutChanged: (layout: TerminalLayout) =>
      dashboardWindow.send(IpcChannel.TerminalLayoutChanged, layout),
  });
  terminals = terminalManager;

  spawnFeedbackTab = (input) => {
    const profile = resolveDefaultProfile(
      mergeProfiles(detectProfiles(), settingsStore.get().shellProfiles),
      settingsStore.get().defaultShellProfileId,
    );
    if (profile === undefined) {
      return null;
    }
    const resolved = resolveShellCommand(profile, input.command);
    return terminalManager.runProjectCommand({
      project: input.project,
      actionId: input.actionId,
      title: input.title,
      file: resolved.file,
      args: resolved.args,
      size: terminalSize,
      profileId: profile.id,
      cwd: input.cwd,
      onExit: () => input.onExit(),
    });
  };

  /**
   * Rebuilds everything derived from the project list after a settings change.
   *
   * The monitor keys its state by project, so it is replaced rather than mutated: keeping the old one
   * would leave rows for deleted projects and none for new ones. `reconcile` then drops the terminals
   * the new configuration has left unreachable, so no process keeps running without a button able to
   * stop it.
   *
   * **Unless the set of projects has not changed**, which is what reordering the table does, and what
   * renaming one does too. Then the monitors adopt the new order and keep everything they hold: the
   * server states, the git and checks reads, the pull requests and the resolved remotes. Rebuilding
   * there was not merely wasteful, it was wrong. `servers` is only ever filled by pty output, so a
   * running dev server with nothing new to say would have read `stopped` until restarted, and the Pull
   * requests tab would have gone empty for up to `pullsPollSeconds`.
   */
  const reloadProjects = async (): Promise<void> => {
    const next = resolveProjects(settingsStore.get().projects);
    terminalManager.reconcile(next);

    if (sameProjectSet(projects, next)) {
      projects = next;
      projectMonitor.reorder(next);
      pullMonitor.reorder(next);
      broadcast(IpcChannel.SettingsChanged, settingsStore.get());
      return;
    }

    projectMonitor.stop();
    pullMonitor.stop();
    projects = next;
    projectMonitor = buildMonitor();
    monitor = projectMonitor;
    projectMonitor.start();
    // Rebuilt for the same reason as the project monitor: it keys its state, and its resolved remotes,
    // by project.
    pullMonitor = buildPullMonitor();
    pullMonitor.start();
    dashboardWindow.send(IpcChannel.RowsChanged, projectMonitor.rows());
    serversWindow.send(IpcChannel.RowsChanged, projectMonitor.rows());
    // Broadcast: the change usually comes from the settings window, and the dashboard reloads from
    // this event.
    broadcast(IpcChannel.SettingsChanged, settingsStore.get());
  };

  // Recomputed on each read so a settings edit takes effect without a restart.
  const profiles = (): ShellProfile[] =>
    mergeProfiles(detectProfiles(), settingsStore.get().shellProfiles);

  registerIpcHandlers({
    projects: () => projects,
    // The dashboard only, like `GitPolled`: the servers window has no Git tab to put a notice in.
    notifyGit: (notice) => dashboardWindow.send(IpcChannel.GitNotice, notice),
    monitor: () => projectMonitor,
    pulls: () => pullMonitor,
    jira: () => jiraMonitor,
    triage: () => triageService,
    pullReview: () => pullReviewService,
    autoRuns: () => autoRuns,
    /**
     * The manual entry point, going through the watcher's own gate.
     *
     * It resolves the pull request from the record rather than from the poll, so it still works on a
     * repository whose poll has not come round yet, and it clears a spent phase: a pass that died with
     * its tab would otherwise burn the pull request for good, and the first failure would be
     * indistinguishable from a feature that does not work. The phase is what stops the loop, so only a
     * gesture may clear it, never a rule.
     */
    runFeedbackPass: async (ticketKey) => {
      const record = autoRuns.get(ticketKey);
      if (record === undefined || record.prNumber === null) {
        return { terminalId: null, result: { ok: false, message: 'No pull request known for that ticket' } };
      }
      const project = projects.find((entry) => entry.id === record.projectId);
      if (project === undefined) {
        return { terminalId: null, result: { ok: false, message: 'That run\'s repository is no longer configured' } };
      }
      const settings = settingsStore.get();
      const command = buildFeedbackCommand(
        record.prNumber,
        basename(project.path),
        settings.agentWorkModel,
        settings.agentProfile,
      );
      if (command.length === 0) {
        return { terminalId: null, result: { ok: false, message: 'That pull request number is not one' } };
      }
      autoRuns.set({ ...record, feedbackPhase: 'passing', feedbackStartedAt: new Date().toISOString() });
      await autoRuns.write();
      const terminalId = spawnFeedbackTab({
        project,
        actionId: feedbackActionId(record.slug, record.prNumber),
        title: `${project.label} · PR #${record.prNumber} feedback`,
        command,
        cwd: resolveWorkspaceRoot(settings.workspaceRoot, project.path),
        onExit: () => {
          const latest = autoRuns.get(ticketKey);
          if (latest !== undefined && latest.feedbackPhase === 'passing') {
            autoRuns.set({
              ...latest,
              feedbackPhase: 'done',
              feedbackFinishedAt: new Date().toISOString(),
              notice: 'Feedback pass finished',
            });
            void autoRuns.write();
          }
        },
      });
      dashboardWindow.send(IpcChannel.AutoRunsChanged, autoRuns.all());
      return {
        terminalId,
        result:
          terminalId === null
            ? { ok: false, message: 'Could not open the tab' }
            : { ok: true, message: `Treating the feedback on #${record.prNumber}` },
      };
    },
    jiraConfig,
    saveJiraToken: async (token) => {
      const result = await secrets.write(token);
      if (result.ok) {
        hasJiraToken = token.trim().length > 0;
        // Applied at once rather than at the next tick of a five-minute loop: the user just pressed save
        // and expects the tab to fill in.
        void jiraMonitor.refreshNow();
      }
      return result;
    },
    /**
     * Credentials for one Jira write, or null when the connection is incomplete.
     *
     * Read at each call rather than held: the token can be replaced from the settings window at any
     * moment, and a stale copy would keep failing with a message about the wrong thing.
     */
    jiraCredentials: async () => {
      const { siteUrl, email } = settingsStore.get().jira;
      const token = await secrets.read();
      return siteUrl.length > 0 && email.length > 0 && token.length > 0
        ? { siteUrl, email, token }
        : null;
    },
    afterJiraWrite: () => {
      // Re-read at once: the row the user just changed has to show its new state without waiting for the
      // five-minute loop.
      void jiraMonitor.refreshNow();
    },
    testJira: async () => {
      const { siteUrl, email, projectKeys } = settingsStore.get().jira;
      const token = await secrets.read();
      if (siteUrl.length === 0 || email.length === 0 || token.length === 0) {
        return { ok: false, message: 'Site, email and token are all required' };
      }
      // One real query rather than a ping: only an actual search proves the credentials and the project
      // keys together, which is what fails in practice.
      const { issues, error } = await searchIssues(
        { siteUrl, email, token },
        buildJql(projectKeys).mine,
        email,
      );
      return error === null
        ? { ok: true, message: `Connection succeeded, ${issues.length} issue(s) assigned to you` }
        : { ok: false, message: error };
    },
    writeCommitMessage: (projectId, message) =>
      writeCommitMessage(AppPaths.commitMessages(), projectId, message),
    terminals: terminalManager,
    settings: settingsStore,
    theme: themeController,
    profiles,
    terminalSize: () => terminalSize,
    reloadProjects,
    pickFolder: async (title, parent) => {
      const window = parent ?? dashboardWindow.browserWindow;
      const options: Electron.OpenDialogOptions = { title, properties: ['openDirectory'] };
      // The overload without a parent window is a different signature, so the two calls cannot be
      // collapsed into one with an optional argument.
      const result =
        window === null
          ? await dialog.showOpenDialog(options)
          : await dialog.showOpenDialog(window, options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    openSettings: () => settingsWindow.open(),
    openServers: () => serversWindow.open(),
    closeServers: () => serversWindow.close(),
    // Broadcast rather than sent to the dashboard alone: the servers window's own `Back` button reads
    // the same state, and a window told nothing would keep showing a control for a state it has left.
    broadcastServersDetached: (detached) =>
      broadcast(IpcChannel.ServersDetachedChanged, detached),
    setSettingsDirty: (dirty) => settingsWindow.setDirty(dirty),
    broadcastSettings: (next: AppSettings) => broadcast(IpcChannel.SettingsChanged, next),
  });

  // The renderer reports its geometry through the same resize channel the pty uses, so a process
  // spawned later starts at the size the pane actually has.
  ipcMain.on(IpcChannel.PtyResize, (_event, _terminalId: unknown, size: unknown) => {
    if (typeof size === 'object' && size !== null) {
      const record = size as Record<string, unknown>;
      terminalSize = {
        cols: typeof record.cols === 'number' ? record.cols : terminalSize.cols,
        rows: typeof record.rows === 'number' ? record.rows : terminalSize.rows,
      };
    }
  });

  const window = await dashboardWindow.create({
    preloadPath: preloadPath(),
    backgroundColor: themeController.backgroundColor(),
  });
  await loadRendererPage(window, 'index.html');

  projectMonitor.start();
  pullMonitor.start();
  hasJiraToken = (await secrets.read()).length > 0;
  jiraMonitor.start();

  /*
   * Reopens the servers window if that is how the app was left.
   *
   * After the dashboard's page has loaded, and that ordering is the whole subtlety: detaching pushes a
   * session list to both windows, and a dashboard still loading would never receive the one telling it
   * which tabs it has lost. There are no sessions yet at this point either, so nothing actually moves;
   * what this restores is the **window**, ready for the first `Run`, which then joins it on spawn.
   */
  if (settingsStore.get().serversDetached) {
    await serversWindow.open();
    terminalManager.setServersDetached(true);
    broadcast(IpcChannel.ServersDetachedChanged, true);
  }

  window.on('close', (event) => {
    // Only dev servers matter here. A shell tab dying with the app is expected; a build being killed
    // silently is not.
    const owned = terminalManager.runningProjectStarts();
    if (owned.length === 0 || quitConfirmed) {
      return;
    }
    event.preventDefault();
    void confirmQuit(window, owned.length).then((confirmed) => {
      if (confirmed) {
        quitConfirmed = true;
        window.close();
      }
    });
  });

  app.on('second-instance', () => {
    const existing = dashboardWindow.browserWindow;
    if (existing !== null) {
      existing.show();
      existing.focus();
    }
  });

  /*
   * Quit: stop the monitors and every terminal.
   *
   * This used to defer the quit once to flush unsaved notes, which is why it takes the event at all.
   * Nothing asynchronous is left to save, so it now runs straight through.
   */
  app.on('before-quit', () => {
    projectMonitor.stop();
    pullMonitor.stop();
    jiraMonitor.stop();
    terminalManager.stopAll();
  });

  // Closing the dashboard ends the session, so the settings window must not keep the app alive.
  window.on('closed', () => {
    const settings = settingsWindow.browserWindow;
    if (settings !== null && !settings.isDestroyed()) {
      settings.destroy();
    }
  });

  app.on('window-all-closed', () => app.quit());
}

/** Asks before killing dev servers the dashboard owns. */
async function confirmQuit(window: BrowserWindow, count: number): Promise<boolean> {
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['Quit and stop', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Quit the dashboard',
    message:
      count === 1
        ? '1 server started by the dashboard will be stopped.'
        : `${count} servers started by the dashboard will be stopped.`,
    detail: 'Servers started from an external terminal are not affected.',
  });
  return response === 0;
}

export { dashboard, terminals, monitor };
