import { BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import {
  IpcChannel,
  type AppSettings,
  type BootstrapState,
  type OpenShellRequest,
  type Project,
  type ProjectCandidate,
  type ProjectConfig,
  type ProjectId,
  type ProjectRow,
  type IssueTransition,
  type JiraConfig,
  type JiraState,
  type NoteContent,
  type NoteId,
  type NotesState,
  type ProjectValidation,
  type RepoPulls,
  type ShellProfile,
  type TerminalId,
  type ThemeMode,
  type ThemeState,
} from '@shared/contracts.js';
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
import type { NotesStore } from './notes/notes-store.js';
import type { ProjectMonitor } from './projects/project-monitor.js';
import { LOCAL_ONLY_KEYS, asPatch } from './store/settings-patch.js';
import type { SettingsStore } from './store/settings-store.js';
import { resolveDefaultProfile } from './terminal/shell-profiles.js';
import type { TerminalManager } from './terminal/terminal-manager.js';
import type { ThemeController } from './theme.js';

export interface IpcDependencies {
  /** Live project list, re-read on every call since settings can change it at any time. */
  readonly projects: () => readonly Project[];
  readonly monitor: () => ProjectMonitor;
  readonly pulls: () => PullMonitor;
  readonly jira: () => JiraMonitor;
  /** Writes the Jira token to the encrypted store. Never reads it back towards the renderer. */
  readonly saveJiraToken: (token: string) => Promise<{ ok: boolean; message: string }>;
  readonly jiraConfig: () => JiraConfig;
  readonly testJira: () => Promise<{ ok: boolean; message: string }>;
  /** Credentials for one Jira write, or null when the connection is incomplete. */
  readonly jiraCredentials: () => Promise<JiraCredentials | null>;
  /** Called after a successful write, to refresh the views without waiting for the poll. */
  readonly afterJiraWrite: () => void;
  readonly notes: () => NotesStore;
  /** Where notes land when `notesFolder` is empty. Shown as the placeholder in the settings window. */
  readonly defaultNotesFolder: () => string;
  /**
   * Asks the user to confirm a deletion.
   *
   * Native and owned by the main process, like the unsaved-settings prompt: an in-page overlay in the
   * notes panel would sit next to a text editor, and a mousedown-inside/mouseup-outside selection
   * fires a `click` on the common ancestor. That is the exact bug that got the settings modal removed.
   */
  readonly confirmNoteDelete: (title: string) => boolean;
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
    notes: deps.notes().state(),
    defaultNotesFolder: deps.defaultNotesFolder(),
  }));

  ipcMain.handle(IpcChannel.RefreshNow, async (): Promise<ProjectRow[]> => deps.monitor().refreshAll());

  ipcMain.handle(IpcChannel.PullsRefresh, async (): Promise<RepoPulls[]> =>
    deps.pulls().refreshNow(),
  );

  ipcMain.handle(IpcChannel.JiraRefresh, async (): Promise<JiraState> => deps.jira().refreshNow());

  /* ---------------------------------------------------------------- notes */

  ipcMain.handle(IpcChannel.NotesRefresh, async (): Promise<NotesState> => deps.notes().refresh());

  ipcMain.handle(IpcChannel.NoteOpen, async (_event, id: unknown): Promise<NoteContent | null> =>
    typeof id === 'string' ? deps.notes().open(id) : null,
  );

  ipcMain.handle(IpcChannel.NoteCreate, async (): Promise<NoteId | null> => deps.notes().create());

  // `send`, not `invoke`: a keystroke must never wait on a round trip. The store debounces.
  ipcMain.on(IpcChannel.NoteUpdate, (_event, id: unknown, text: unknown) => {
    if (typeof id === 'string' && typeof text === 'string') {
      deps.notes().update(id, text);
    }
  });

  ipcMain.handle(IpcChannel.NoteFlush, async (): Promise<void> => deps.notes().flush());

  ipcMain.handle(IpcChannel.NoteDelete, async (_event, id: unknown): Promise<boolean> => {
    if (typeof id !== 'string') {
      return false;
    }
    const note = deps.notes().state().notes.find((entry) => entry.id === id);
    if (note === undefined) {
      return false;
    }
    if (!deps.confirmNoteDelete(note.title)) {
      return false;
    }
    return deps.notes().delete(id);
  });

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
      let message = 'Connexion enregistrée';
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
        return { ok: false, message: 'Connexion Jira incomplète' };
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
        return { ok: false, message: 'Connexion Jira incomplète' };
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

      const terminalId = deps.terminals.runProjectAction(
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
      console.log(`[stop] aucune action serveur en cours pour ${projectId}`);
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

  ipcMain.handle(IpcChannel.TerminalReorder, async (_event, ids: unknown): Promise<void> => {
    if (Array.isArray(ids)) {
      deps.terminals.reorder(ids.filter((id): id is string => typeof id === 'string'));
    }
  });

  ipcMain.handle(
    IpcChannel.TerminalLayoutSet,
    async (_event, panes: unknown, direction: unknown): Promise<void> => {
      deps.terminals.setLayout(
        Array.isArray(panes) ? panes.filter((id): id is string => typeof id === 'string') : [],
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
      if (parsed.notesFolder !== undefined) {
        // Flushes into the *old* folder before switching, which `reopen` guarantees: pending writes
        // carry the path they were typed against, so the last keystrokes must not follow the move.
        await deps.notes().reopen();
      }
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
      typeof title === 'string' ? title : 'Choisir un dossier',
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
