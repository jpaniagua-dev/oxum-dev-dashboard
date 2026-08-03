import { app, dialog, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { IpcChannel, type ClaudeSession, type ProjectRow } from '@shared/contracts.js';
import { readSessions } from './claude/session-service.js';
import { registerIpcHandlers } from './ipc.js';
import { ProjectMonitor } from './projects/project-monitor.js';
import { PtyRunner } from './projects/pty-runner.js';
import { loadExistingProjects } from './projects/registry.js';
import { AppPaths } from './store/paths.js';
import { SettingsStore } from './store/settings-store.js';
import { WindowStateStore } from './store/window-state.js';
import { ThemeController } from './theme.js';
import { DashboardWindow, preloadPath } from './window.js';

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
let dashboard: DashboardWindow | null = null;
let runner: PtyRunner | null = null;
let monitor: ProjectMonitor | null = null;
let sessionsTimer: NodeJS.Timeout | null = null;
/** Set once the user has confirmed a quit, so the second close attempt goes through. */
let quitConfirmed = false;

void bootstrap();

async function bootstrap(): Promise<void> {
  await app.whenReady();

  const settingsStore = new SettingsStore(AppPaths.settings());
  const settings = await settingsStore.load();

  const projects = loadExistingProjects();
  const windowStateStore = new WindowStateStore(AppPaths.windowState());
  const dashboardWindow = new DashboardWindow(windowStateStore);
  dashboard = dashboardWindow;

  const themeController = new ThemeController(
    (state) => dashboardWindow.send(IpcChannel.ThemeChanged, state),
    (color) => dashboardWindow.setBackgroundColor(color),
  );
  themeController.setMode(settings.themeMode);

  const projectMonitor = new ProjectMonitor(
    projects,
    () => settingsStore.get(),
    (rows: ProjectRow[]) => dashboardWindow.send(IpcChannel.RowsChanged, rows),
  );
  monitor = projectMonitor;

  const ptyRunner = new PtyRunner({
    onOutput: (projectId, data) => dashboardWindow.send(IpcChannel.PtyOutput, { projectId, data }),
    onParsed: (projectId, parsed) => projectMonitor.applyParsed(projectId, parsed),
    onExit: (projectId, exitCode, stopped) =>
      projectMonitor.markExited(projectId, exitCode, stopped),
  });
  runner = ptyRunner;

  registerIpcHandlers({
    projects,
    monitor: projectMonitor,
    runner: ptyRunner,
    settings: settingsStore,
    theme: themeController,
    terminalSize: () => terminalSize,
  });

  // The renderer reports its terminal geometry through the same resize channel the pty uses, so
  // a process spawned later starts at the size the pane actually has.
  const { ipcMain } = await import('electron');
  ipcMain.on(IpcChannel.PtyResize, (_event, _projectId: unknown, size: unknown) => {
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
  await loadRenderer(window);

  projectMonitor.start();
  startSessionPolling(dashboardWindow, settingsStore);

  window.on('close', (event) => {
    // Owned dev servers die with the app, so a stray close must not silently kill a build.
    const owned = ptyRunner.runningIds();
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

  app.on('before-quit', () => {
    projectMonitor.stop();
    if (sessionsTimer !== null) {
      clearInterval(sessionsTimer);
      sessionsTimer = null;
    }
    ptyRunner.stopAll();
  });

  app.on('window-all-closed', () => app.quit());
}

/** Asks before killing dev servers the dashboard owns. */
async function confirmQuit(window: BrowserWindow, count: number): Promise<boolean> {
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['Quitter et arrêter', 'Annuler'],
    defaultId: 1,
    cancelId: 1,
    title: 'Quitter le dashboard',
    message:
      count === 1
        ? '1 serveur lancé par le dashboard va être arrêté.'
        : `${count} serveurs lancés par le dashboard vont être arrêtés.`,
    detail: 'Les serveurs lancés depuis un terminal ne sont pas concernés.',
  });
  return response === 0;
}

/** Pushes the Claude Code session list on its own cadence. */
function startSessionPolling(window: DashboardWindow, settings: SettingsStore): void {
  const push = async (): Promise<void> => {
    try {
      const sessions: ClaudeSession[] = await readSessions(settings.get().sessionIdleMinutes);
      window.send(IpcChannel.SessionsChanged, sessions);
    } catch (error) {
      console.error('[sessions] scan failed', error);
    }
  };

  void push();
  sessionsTimer = setInterval(() => void push(), settings.get().sessionsPollSeconds * 1000);
}

/** Loads the renderer from the dev server when available, from disk otherwise. */
async function loadRenderer(window: BrowserWindow): Promise<void> {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl !== undefined && devServerUrl.length > 0) {
    await window.loadURL(devServerUrl);
    return;
  }
  await window.loadFile(join(__dirname, '../renderer/index.html'));
}

export { dashboard, runner, monitor };
