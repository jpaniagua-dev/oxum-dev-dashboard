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
import { PullMonitor } from './github/pull-monitor.js';
import { registerIpcHandlers } from './ipc.js';
import { JiraMonitor } from './jira/jira-monitor.js';
import { buildJql, searchIssues } from './jira/jira-service.js';
import { NotesStore } from './notes/notes-store.js';
import { SecretStore } from './store/secret-store.js';
import { ProjectMonitor } from './projects/project-monitor.js';
import { DEFAULT_PROJECTS_ROOT } from './projects/project-id.js';
import { resolveProjects, seedProjects } from './projects/registry.js';
import { SettingsWindow, SETTINGS_WINDOW_BOUNDS } from './settings-window.js';
import { AppPaths } from './store/paths.js';
import { SettingsStore } from './store/settings-store.js';
import { WindowStateStore } from './store/window-state.js';
import { detectProfiles, mergeProfiles } from './terminal/shell-profiles.js';
import { TerminalManager } from './terminal/terminal-manager.js';
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

  // First launch: seed the project list from the repositories root so the app is immediately useful.
  // Done once and then stored, so deleting a project makes it stay deleted.
  if (settings.projects.length === 0) {
    // Guard against an empty root: a blank value would make the scan silently find nothing and the
    // dashboard would start with an empty table and no error, which is exactly how this failed once.
    const root = settings.projectsRoot.trim().length > 0 ? settings.projectsRoot : DEFAULT_PROJECTS_ROOT;
    const seeded = seedProjects(root);
    console.log(`[projects] seeded from ${root}: ${seeded.length} project(s)`);
    if (seeded.length > 0) {
      await settingsStore.update({ projects: seeded, projectsRoot: root });
    }
  }

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
    },
  );
  themeController.setMode(settings.themeMode);

  const buildMonitor = (): ProjectMonitor =>
    new ProjectMonitor(
      projects,
      () => settingsStore.get(),
      (rows: ProjectRow[]) => dashboardWindow.send(IpcChannel.RowsChanged, rows),
    );

  let projectMonitor = buildMonitor();
  monitor = projectMonitor;

  // Its own loop, on its own cadence: one `gh` call per watched repository is minutes-slow work next to
  // a local git read.
  const buildPullMonitor = (): PullMonitor =>
    new PullMonitor(
      projects,
      () => settingsStore.get(),
      (repos) => dashboardWindow.send(IpcChannel.PullsChanged, repos),
    );

  let pullMonitor = buildPullMonitor();

  // The token lives here, encrypted, and never crosses back to the renderer.
  const secrets = new SecretStore(AppPaths.jiraToken());
  const jiraMonitor = new JiraMonitor(
    () => settingsStore.get(),
    secrets,
    (state) => dashboardWindow.send(IpcChannel.JiraChanged, state),
  );

  /*
   * Notes own their folder, which may be the app's own or one the user picked.
   *
   * `mayCreate` is the difference that matters: the default folder is ours and is created on demand,
   * whereas a folder the user chose and later deleted is left alone. Silently re-creating a directory
   * somewhere else on their disk is not something a dashboard should do.
   */
  const notesStore = new NotesStore(
    () => {
      const configured = settingsStore.get().notesFolder.trim();
      return configured.length > 0
        ? { path: configured, mayCreate: false }
        : { path: AppPaths.notes(), mayCreate: true };
    },
    (state) => dashboardWindow.send(IpcChannel.NotesChanged, state),
  );

  /** The connection as the renderer may see it: everything except the token. */
  const jiraConfig = (): JiraConfig => {
    const { siteUrl, email, projectKeys } = settingsStore.get().jira;
    return { siteUrl, email, projectKeys: [...projectKeys], hasToken: hasJiraToken };
  };

  const terminalManager = new TerminalManager({
    onOutput: (terminalId, data) =>
      dashboardWindow.send(IpcChannel.PtyOutput, { terminalId, data }),
    // Reads `projectMonitor` through the closure rather than capturing it, so output keeps reaching
    // the current monitor after the project list is rebuilt.
    onParsed: (projectId, parsed) => projectMonitor.applyParsed(projectId, parsed),
    onProjectStartExit: (projectId, exitCode, stopped) =>
      projectMonitor.markExited(projectId, exitCode, stopped),
    onSessionsChanged: (sessions: TerminalSession[]) =>
      dashboardWindow.send(IpcChannel.TerminalsChanged, sessions),
    onLayoutChanged: (layout: TerminalLayout) =>
      dashboardWindow.send(IpcChannel.TerminalLayoutChanged, layout),
  });
  terminals = terminalManager;

  /**
   * Rebuilds everything derived from the project list after a settings change.
   *
   * The monitor keys its state by project, so it is replaced rather than mutated: keeping the old one
   * would leave rows for deleted projects and none for new ones. `reconcile` then drops the terminals
   * the new configuration has left unreachable, so no process keeps running without a button able to
   * stop it.
   */
  const reloadProjects = async (): Promise<void> => {
    const next = resolveProjects(settingsStore.get().projects);
    terminalManager.reconcile(next);

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
    // Broadcast: the change usually comes from the settings window, and the dashboard reloads from
    // this event.
    broadcast(IpcChannel.SettingsChanged, settingsStore.get());
  };

  // Recomputed on each read so a settings edit takes effect without a restart.
  const profiles = (): ShellProfile[] =>
    mergeProfiles(detectProfiles(), settingsStore.get().shellProfiles);

  registerIpcHandlers({
    projects: () => projects,
    monitor: () => projectMonitor,
    pulls: () => pullMonitor,
    jira: () => jiraMonitor,
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
    notes: () => notesStore,
    defaultNotesFolder: () => AppPaths.notes(),
    confirmNoteDelete: (title) => {
      const options: Electron.MessageBoxSyncOptions = {
        type: 'warning',
        buttons: ['Delete', 'Cancel'],
        // Cancel is the default: this dialog is one keystroke away from destroying a note.
        defaultId: 1,
        cancelId: 1,
        title: 'Delete note',
        message: `Delete "${title}"?`,
        detail: 'The file is erased from the notes folder. This cannot be undone.',
      };
      // Two distinct overloads, as in `pickFolder`: they cannot be collapsed into one optional argument.
      const parent = dashboardWindow.browserWindow;
      const answer =
        parent === null
          ? dialog.showMessageBoxSync(options)
          : dialog.showMessageBoxSync(parent, options);
      return answer === 0;
    },
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

  /*
   * Read **before** the window exists, and awaited.
   *
   * Read once rather than polled: nothing but this app writes that folder, and an `fs.watch` would fire
   * on our own saves and fight the editor. Awaiting it here is what puts the notes in `BootstrapState`:
   * done after the page loaded, the renderer's bootstrap would race it, come back with an empty list,
   * and a panel reopened on startup would show its notes but select none of them.
   */
  await notesStore.refresh();

  const window = await dashboardWindow.create({
    preloadPath: preloadPath(),
    backgroundColor: themeController.backgroundColor(),
  });
  await loadRendererPage(window, 'index.html');

  projectMonitor.start();
  pullMonitor.start();
  hasJiraToken = (await secrets.read()).length > 0;
  jiraMonitor.start();

  // Leaving the window is a natural save point, and it costs nothing when nothing is pending.
  app.on('browser-window-blur', () => {
    if (notesStore.hasPending()) {
      void notesStore.flush();
    }
  });

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
   * Quit, with one deferral for unsaved notes.
   *
   * `before-quit` is synchronous, so an `await` here would simply not be honoured and the last
   * keystrokes would die with the process. It does however accept `preventDefault`, so the quit is
   * cancelled once, the buffer is written, and `app.quit()` is called again.
   *
   * The early `return` is load-bearing: without it the monitors would stop and every terminal would be
   * killed on a quit that was just cancelled, leaving the app running with nothing alive in it.
   */
  let notesFlushed = false;
  app.on('before-quit', (event) => {
    if (!notesFlushed && notesStore.hasPending()) {
      event.preventDefault();
      void notesStore.flush().finally(() => {
        notesFlushed = true;
        app.quit();
      });
      return;
    }

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
