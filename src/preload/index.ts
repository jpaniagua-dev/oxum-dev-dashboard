import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannel,
  type AppSettings,
  type BootstrapState,
  type ClaudeSession,
  type ProjectId,
  type ProjectRow,
  type PtyCommand,
  type RendererApi,
  type TerminalChunk,
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

  runPty: (projectId: ProjectId, command: PtyCommand): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.PtyRun, projectId, command),

  stopPty: (projectId: ProjectId): Promise<void> =>
    ipcRenderer.invoke(IpcChannel.PtyStop, projectId),

  sendPtyInput: (projectId: ProjectId, data: string): void => {
    ipcRenderer.send(IpcChannel.PtyInput, projectId, data);
  },

  resizePty: (projectId: ProjectId, size: TerminalSize): void => {
    ipcRenderer.send(IpcChannel.PtyResize, projectId, size);
  },

  onPtyOutput: (listener: (chunk: TerminalChunk) => void): (() => void) => {
    const handler = (_event: unknown, chunk: TerminalChunk): void => listener(chunk);
    ipcRenderer.on(IpcChannel.PtyOutput, handler);
    return () => ipcRenderer.off(IpcChannel.PtyOutput, handler);
  },

  readPtyBuffer: (projectId: ProjectId): Promise<string> =>
    ipcRenderer.invoke(IpcChannel.PtyBuffer, projectId),

  onSessionsChanged: (listener: (sessions: ClaudeSession[]) => void): (() => void) => {
    const handler = (_event: unknown, sessions: ClaudeSession[]): void => listener(sessions);
    ipcRenderer.on(IpcChannel.SessionsChanged, handler);
    return () => ipcRenderer.off(IpcChannel.SessionsChanged, handler);
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
};

contextBridge.exposeInMainWorld('api', api);
