import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannel,
  type AppSettings,
  type BootstrapState,
  type IssueTransition,
  type JiraConfig,
  type JiraState,
  type NoteContent,
  type NoteId,
  type NotesState,
  type OpenShellRequest,
  type PaneDirection,
  type ProjectCandidate,
  type ProjectConfig,
  type ProjectId,
  type ProjectRow,
  type ProjectValidation,
  type RendererApi,
  type RepoPulls,
  type ShellProfile,
  type TerminalChunk,
  type TerminalGroup,
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

  refreshPulls: (): Promise<RepoPulls[]> => ipcRenderer.invoke(IpcChannel.PullsRefresh),

  onPullsChanged: (listener: (repos: RepoPulls[]) => void): (() => void) => {
    const handler = (_event: unknown, repos: RepoPulls[]): void => listener(repos);
    ipcRenderer.on(IpcChannel.PullsChanged, handler);
    return () => ipcRenderer.off(IpcChannel.PullsChanged, handler);
  },

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IpcChannel.OpenExternal, url),

  writeClipboard: (text: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.ClipboardWrite, text),

  readClipboard: (): Promise<string> => ipcRenderer.invoke(IpcChannel.ClipboardRead),

  refreshNotes: (): Promise<NotesState> => ipcRenderer.invoke(IpcChannel.NotesRefresh),

  onNotesChanged: (listener: (state: NotesState) => void): (() => void) => {
    const handler = (_event: unknown, state: NotesState): void => listener(state);
    ipcRenderer.on(IpcChannel.NotesChanged, handler);
    return () => ipcRenderer.off(IpcChannel.NotesChanged, handler);
  },

  openNote: (id: NoteId): Promise<NoteContent | null> =>
    ipcRenderer.invoke(IpcChannel.NoteOpen, id),

  createNote: (): Promise<NoteId | null> => ipcRenderer.invoke(IpcChannel.NoteCreate),

  // `send`, like `sendPtyInput`: a keystroke must not wait on a round trip.
  updateNote: (id: NoteId, text: string): void => {
    ipcRenderer.send(IpcChannel.NoteUpdate, id, text);
  },

  flushNotes: (): Promise<void> => ipcRenderer.invoke(IpcChannel.NoteFlush),

  deleteNote: (id: NoteId): Promise<boolean> => ipcRenderer.invoke(IpcChannel.NoteDelete, id),

  refreshJira: (): Promise<JiraState> => ipcRenderer.invoke(IpcChannel.JiraRefresh),

  onJiraChanged: (listener: (state: JiraState) => void): (() => void) => {
    const handler = (_event: unknown, state: JiraState): void => listener(state);
    ipcRenderer.on(IpcChannel.JiraChanged, handler);
    return () => ipcRenderer.off(IpcChannel.JiraChanged, handler);
  },

  saveJira: (
    config: { siteUrl: string; email: string; projectKeys: string[] },
    token?: string,
  ): Promise<{ config: JiraConfig; message: string }> =>
    ipcRenderer.invoke(IpcChannel.JiraSave, config, token),

  testJira: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke(IpcChannel.JiraTest),

  jiraTransitions: (key: string): Promise<IssueTransition[]> =>
    ipcRenderer.invoke(IpcChannel.JiraTransitions, key),

  transitionJira: (key: string, transitionId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IpcChannel.JiraTransition, key, transitionId),

  assignJiraToMe: (key: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke(IpcChannel.JiraAssignMe, key),

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

  setTerminalLayout: (groups: readonly TerminalGroup[], direction: PaneDirection): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.TerminalLayoutSet, groups, direction),

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

  clearPty: (terminalId: TerminalId): void => {
    ipcRenderer.send(IpcChannel.PtyClear, terminalId);
  },

  onTerminalsChanged: (listener: (sessions: TerminalSession[]) => void): (() => void) => {
    const handler = (_event: unknown, sessions: TerminalSession[]): void => listener(sessions);
    ipcRenderer.on(IpcChannel.TerminalsChanged, handler);
    return () => ipcRenderer.off(IpcChannel.TerminalsChanged, handler);
  },

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
