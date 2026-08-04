import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannel,
  type AppSettings,
  type BootstrapState,
  type OpenShellRequest,
  type PaneDirection,
  type ProjectCandidate,
  type ProjectConfig,
  type ProjectId,
  type ProjectRow,
  type ProjectValidation,
  type RendererApi,
  type ShellProfile,
  type TerminalChunk,
  type TerminalId,
  type TerminalLayout,
  type TerminalSession,
  type TerminalSize,
  type ThemeMode,
  type ThemeState,
} from '@shared/contracts.js';

/**
 * The only bridge between the sandboxed renderer and the main process.
 *
 * Nothing generic is exposed: no `ipcRenderer`, no channel-name passthrough, no `require`. Each
 * method is one capability, so the renderer's blast radius is exactly this list.
 */
const api: RendererApi = {
  bootstrap: (): Promise<BootstrapState> => ipcRenderer.invoke(IpcChannel.Bootstrap),

  refreshNow: (): Promise<ProjectRow[]> => ipcRenderer.invoke(IpcChannel.RefreshNow),

  onRowsChanged: (listener: (rows: ProjectRow[]) => void): (() => void) => {
    const handler = (_event: unknown, rows: ProjectRow[]): void => listener(rows);
    ipcRenderer.on(IpcChannel.RowsChanged, handler);
    return () => ipcRenderer.off(IpcChannel.RowsChanged, handler);
  },

  runAction: (projectId: ProjectId, actionId: string): Promise<TerminalId> =>
    ipcRenderer.invoke(IpcChannel.PtyRun, projectId, actionId),

  openShell: (request: OpenShellRequest): Promise<TerminalId> =>
    ipcRenderer.invoke(IpcChannel.TerminalOpenShell, request),

  openProjectShell: (projectId: ProjectId): Promise<TerminalId> =>
    ipcRenderer.invoke(IpcChannel.ProjectShell, projectId),

  stopPty: (terminalId: TerminalId): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.PtyStop, terminalId),

  stopProjectServer: (projectId: ProjectId): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannel.ProjectStop, projectId),

  closeTerminal: (terminalId: TerminalId): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.TerminalClose, terminalId),

  renameTerminal: (terminalId: TerminalId, title: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.TerminalRename, terminalId, title),

  reorderTerminals: (orderedIds: TerminalId[]): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.TerminalReorder, orderedIds),

  setTerminalLayout: (panes: TerminalId[], direction: PaneDirection): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.TerminalLayoutSet, panes, direction),

  onTerminalLayoutChanged: (listener: (layout: TerminalLayout) => void): (() => void) => {
    const handler = (_event: unknown, layout: TerminalLayout): void => listener(layout);
    ipcRenderer.on(IpcChannel.TerminalLayoutChanged, handler);
    return () => ipcRenderer.off(IpcChannel.TerminalLayoutChanged, handler);
  },

  sendPtyInput: (terminalId: TerminalId, data: string): void => {
    ipcRenderer.send(IpcChannel.PtyInput, terminalId, data);
  },

  resizePty: (terminalId: TerminalId, size: TerminalSize): void => {
    ipcRenderer.send(IpcChannel.PtyResize, terminalId, size);
  },

  onPtyOutput: (listener: (chunk: TerminalChunk) => void): (() => void) => {
    const handler = (_event: unknown, chunk: TerminalChunk): void => listener(chunk);
    ipcRenderer.on(IpcChannel.PtyOutput, handler);
    return () => ipcRenderer.off(IpcChannel.PtyOutput, handler);
  },

  readPtyBuffer: (terminalId: TerminalId): Promise<string> =>
    ipcRenderer.invoke(IpcChannel.PtyBuffer, terminalId),

  onTerminalsChanged: (listener: (sessions: TerminalSession[]) => void): (() => void) => {
    const handler = (_event: unknown, sessions: TerminalSession[]): void => listener(sessions);
    ipcRenderer.on(IpcChannel.TerminalsChanged, handler);
    return () => ipcRenderer.off(IpcChannel.TerminalsChanged, handler);
  },

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IpcChannel.OpenExternal, url),

  openFolder: (projectId: ProjectId): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.OpenFolder, projectId),

  setThemeMode: (mode: ThemeMode): Promise<ThemeState> =>
    ipcRenderer.invoke(IpcChannel.ThemeSet, mode),

  onThemeChanged: (listener: (state: ThemeState) => void): (() => void) => {
    const handler = (_event: unknown, state: ThemeState): void => listener(state);
    ipcRenderer.on(IpcChannel.ThemeChanged, handler);
    return () => ipcRenderer.off(IpcChannel.ThemeChanged, handler);
  },

  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IpcChannel.SettingsUpdate, patch),

  saveProjects: (projects: ProjectConfig[]): Promise<AppSettings> =>
    ipcRenderer.invoke(IpcChannel.ProjectsSave, projects),

  detectProjects: (root?: string): Promise<ProjectCandidate[]> =>
    ipcRenderer.invoke(IpcChannel.ProjectsDetect, root),

  buildProjectConfig: (path: string): Promise<ProjectConfig> =>
    ipcRenderer.invoke(IpcChannel.ProjectsBuild, path),

  validateProjects: (projects: ProjectConfig[]): Promise<ProjectValidation[]> =>
    ipcRenderer.invoke(IpcChannel.ProjectsValidate, projects),

  saveProfiles: (profiles: ShellProfile[], defaultProfileId: string): Promise<AppSettings> =>
    ipcRenderer.invoke(IpcChannel.ProfilesSave, profiles, defaultProfileId),

  pickFolder: (title: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannel.PickFolder, title),

  onSettingsChanged: (listener: (settings: AppSettings) => void): (() => void) => {
    const handler = (_event: unknown, settings: AppSettings): void => listener(settings);
    ipcRenderer.on(IpcChannel.SettingsChanged, handler);
    return () => ipcRenderer.off(IpcChannel.SettingsChanged, handler);
  },

  openSettings: (): Promise<void> => ipcRenderer.invoke(IpcChannel.SettingsOpen),

  reportSettingsDirty: (dirty: boolean): void => {
    ipcRenderer.send(IpcChannel.SettingsDirty, dirty);
  },

  closeWindow: (): Promise<void> => ipcRenderer.invoke(IpcChannel.WindowClose),
};

contextBridge.exposeInMainWorld('api', api);
