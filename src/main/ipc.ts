import { ipcMain, shell } from 'electron';
import {
  IpcChannel,
  type AppSettings,
  type BootstrapState,
  type Project,
  type ProjectId,
  type ProjectRow,
  type PtyCommand,
  type ThemeMode,
  type ThemeState,
} from '@shared/contracts.js';
import { findProject } from './projects/registry.js';
import type { ProjectMonitor } from './projects/project-monitor.js';
import type { PtyRunner } from './projects/pty-runner.js';
import type { SettingsStore } from './store/settings-store.js';
import type { ThemeController } from './theme.js';

export interface IpcDependencies {
  readonly projects: readonly Project[];
  readonly monitor: ProjectMonitor;
  readonly runner: PtyRunner;
  readonly settings: SettingsStore;
  readonly theme: ThemeController;
  /** Current terminal geometry, so a spawned process starts with the right size. */
  readonly terminalSize: () => { cols: number; rows: number };
}

/**
 * Registers every IPC handler.
 *
 * This module is the complete list of what the renderer may ask the main process to do; it holds no
 * privileged capability of its own.
 */
export function registerIpcHandlers(deps: IpcDependencies): void {
  ipcMain.handle(IpcChannel.Bootstrap, async (): Promise<BootstrapState> => ({
    projects: [...deps.projects],
    settings: deps.settings.get(),
    theme: deps.theme.state(),
  }));

  ipcMain.handle(IpcChannel.RefreshNow, async (): Promise<ProjectRow[]> => deps.monitor.refreshAll());

  ipcMain.handle(
    IpcChannel.PtyRun,
    async (_event, projectId: unknown, command: unknown): Promise<void> => {
      const project = resolveProject(deps.projects, projectId);
      if (project === undefined) {
        return;
      }
      const ptyCommand = asPtyCommand(command);
      deps.runner.run(project, ptyCommand, deps.terminalSize());
      // Only a long-running `start` owns the row's server state; `commit` is a one-shot task and
      // must not make the row claim a server is booting.
      if (ptyCommand === 'start') {
        deps.monitor.markStarting(project.id, null);
      }
    },
  );

  ipcMain.handle(IpcChannel.PtyStop, async (_event, projectId: unknown): Promise<void> => {
    const project = resolveProject(deps.projects, projectId);
    if (project !== undefined) {
      deps.runner.stop(project.id);
    }
  });

  // Fire-and-forget: keystrokes must never wait on a round trip.
  ipcMain.on(IpcChannel.PtyInput, (_event, projectId: unknown, data: unknown) => {
    const project = resolveProject(deps.projects, projectId);
    if (project !== undefined && typeof data === 'string') {
      deps.runner.write(project.id, data);
    }
  });

  ipcMain.on(IpcChannel.PtyResize, (_event, projectId: unknown, size: unknown) => {
    const project = resolveProject(deps.projects, projectId);
    if (project === undefined || typeof size !== 'object' || size === null) {
      return;
    }
    const record = size as Record<string, unknown>;
    const cols = typeof record.cols === 'number' ? record.cols : 80;
    const rows = typeof record.rows === 'number' ? record.rows : 24;
    deps.runner.resize(project.id, { cols, rows });
  });

  ipcMain.handle(IpcChannel.PtyBuffer, async (_event, projectId: unknown): Promise<string> => {
    const project = resolveProject(deps.projects, projectId);
    return project === undefined ? '' : deps.runner.buffer(project.id);
  });

  ipcMain.handle(IpcChannel.OpenExternal, async (_event, url: unknown): Promise<void> => {
    // Only http(s) is followed: an arbitrary string here could otherwise launch a local handler.
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle(IpcChannel.OpenFolder, async (_event, projectId: unknown): Promise<void> => {
    const project = resolveProject(deps.projects, projectId);
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
    async (_event, patch: unknown): Promise<AppSettings> => deps.settings.update(asPatch(patch)),
  );
}

function resolveProject(projects: readonly Project[], id: unknown): Project | undefined {
  return typeof id === 'string' ? findProject(projects, id as ProjectId) : undefined;
}

function asPtyCommand(value: unknown): PtyCommand {
  return value === 'commit' ? 'commit' : 'start';
}

function asThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

/** Keeps only the keys the renderer is allowed to change. */
function asPatch(value: unknown): Partial<AppSettings> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const input = value as Record<string, unknown>;
  const patch: Partial<AppSettings> = {};

  if (typeof input.showTerminal === 'boolean') patch.showTerminal = input.showTerminal;
  if (typeof input.gitPollSeconds === 'number') patch.gitPollSeconds = input.gitPollSeconds;
  if (typeof input.checksPollSeconds === 'number') patch.checksPollSeconds = input.checksPollSeconds;
  if (typeof input.sessionsPollSeconds === 'number') {
    patch.sessionsPollSeconds = input.sessionsPollSeconds;
  }
  if (typeof input.sessionIdleMinutes === 'number') {
    patch.sessionIdleMinutes = input.sessionIdleMinutes;
  }

  return patch;
}
