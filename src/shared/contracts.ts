/**
 * Single source of truth for everything crossing the main <-> renderer boundary.
 *
 * The renderer is sandboxed: no `fs`, no `child_process`, no `ipcRenderer`. Every capability it
 * needs is declared here, implemented in the main process, and exposed through the narrow bridge
 * in `src/preload/index.ts`.
 */

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

/**
 * Stable identifier for a watched project.
 *
 * A free-form string rather than a closed union: projects are declared by the user in settings, so
 * the set cannot be known at compile time. Ids are generated from the folder name and never change
 * when a project is renamed, which is what keeps a rename from orphaning its running terminal.
 */
export type ProjectId = string;

/**
 * What an action does to the row it belongs to.
 *
 * `server` is the long-running dev process: it owns the row's server state, its output is parsed for
 * build markers, and it is the one replaced by `Stop` while it runs. `task` is anything one-shot
 * (`commit`, a test run, a generator): it says nothing about the server and its tab is closable at
 * any time. A project has at most one `server` action, because a row has one server state.
 */
export type ActionRole = 'server' | 'task';

/**
 * A command the user can launch on a project, straight into a terminal tab.
 *
 * Actions are configuration, not code. They used to be two hardcoded buttons (`npm run start` and
 * `commit`); since every one of them is just a command line run in a shell, there is no reason the
 * list should be fixed.
 */
export interface ProjectAction {
  /**
   * Stable identifier, derived from the label when the action is created and never changed after.
   *
   * It keys the terminal tab, so renaming an action must not change it: the id is what keeps a
   * running process attached to the button that started it.
   */
  readonly id: string;
  /** Button text in the table. */
  readonly label: string;
  /** Command line, run through the chosen shell exactly as typed. */
  readonly command: string;
  readonly role: ActionRole;
  /** Shell profile to run it in. Null follows the default profile. */
  readonly profileId: string | null;
}

/**
 * A project as the user declared it.
 *
 * `kind` and `expectedPort` are optional because both are inferred from the repository's own
 * `package.json`; they are only stored when the user overrides the inference.
 */
export interface ProjectConfig {
  readonly id: ProjectId;
  readonly label: string;
  readonly path: string;
  /** Commands offered on this project's row. */
  readonly actions: readonly ProjectAction[];
  readonly kind: ProjectKind | null;
  readonly expectedPort: number | null;
  /** Excluded from the table without deleting the entry. */
  readonly enabled: boolean;
}

/** A repository found by scanning the projects root, offered when adding a project. */
export interface ProjectCandidate {
  readonly label: string;
  readonly path: string;
  readonly kind: ProjectKind;
  readonly expectedPort: number | null;
  /** True when a project already points at this path. */
  readonly alreadyAdded: boolean;
}

/** What is wrong with a project's configuration, surfaced next to the field. */
export interface ProjectValidation {
  readonly id: ProjectId;
  readonly issues: { level: 'error' | 'warning'; message: string }[];
  /** Inferred command line of the server action, shown so the deduction is auditable. */
  readonly serverCommand: string;
  /** Scripts the repository actually declares, to help pick a valid one. */
  readonly scripts: string[];
  readonly inferredKind: ProjectKind | null;
  readonly inferredPort: number | null;
}

/**
 * How a project's dev process behaves, which decides what can be observed about it.
 *
 * `server` projects run `ng serve` and open a port, so a port probe can confirm they really
 * serve. `watch` projects run `ng build --watch`: no HTTP server, no port, so their state can
 * only come from the process output. That difference is why the dashboard owns the processes.
 */
export type ProjectKind = 'server' | 'watch';

export interface Project {
  readonly id: ProjectId;
  /** Short label for the table. */
  readonly label: string;
  /** Absolute path to the repository. */
  readonly path: string;
  readonly actions: readonly ProjectAction[];
  readonly kind: ProjectKind;
  /** Port the dev server is expected to listen on. Null for `watch` projects. */
  readonly expectedPort: number | null;
}

/* ------------------------------------------------------------------ *
 * Dev server / watch state
 * ------------------------------------------------------------------ */

/**
 * Lifecycle of a project's dev process.
 *
 * Deliberately not a boolean. The `start` scripts run `npm run lint` before serving, so there is
 * a genuine window where the process is healthy but nothing is listening yet; a two-state model
 * would report that as "down".
 *
 * Every phase describes a process the dashboard **owns**. There used to be an `external` phase for a
 * server started elsewhere, dropped once every launch went through the embedded terminal: a state
 * nobody could act on, for a situation that had stopped happening.
 */
export type ServerPhase =
  | 'stopped'
  | 'starting'
  | 'linting'
  | 'building'
  | 'serving'
  | 'watching'
  | 'lint-error'
  | 'build-error'
  | 'crashed';

export interface ServerState {
  readonly phase: ServerPhase;
  /** Process id, or null when nothing runs. */
  readonly pid: number | null;
  /** Port the process announced it is serving on. */
  readonly port: number | null;
  /** First error line reported by the toolchain, shown in the table. */
  readonly errorSummary: string | null;
  /** Number of errors in the last failed build, when the toolchain reports it. */
  readonly errorCount: number;
  /** ISO timestamp of the last successful build. */
  readonly lastSuccessAt: string | null;
  /** True when the dashboard spawned this process and can therefore stop it. */
  readonly owned: boolean;
}

/* ------------------------------------------------------------------ *
 * Git
 * ------------------------------------------------------------------ */

export interface GitState {
  readonly branch: string;
  /** Working-tree counts, kept separate because they mean different things. */
  readonly modified: number;
  readonly staged: number;
  readonly untracked: number;
  /** Commits the branch is behind / ahead of its upstream. */
  readonly behind: number;
  readonly ahead: number;
  /**
   * False when the branch has no upstream at all.
   *
   * Worth its own flag: a branch that was never pushed cannot have a pull request, so the checks
   * column has nothing to look up and the dashboard should say so rather than show an error.
   */
  readonly hasUpstream: boolean;
  readonly stashes: number;
  /** Set when git itself failed, e.g. the path is not a repository. */
  readonly error: string | null;
}

/* ------------------------------------------------------------------ *
 * GitHub checks
 * ------------------------------------------------------------------ */

/**
 * Outcome of a pull request's checks.
 *
 * `no-checks` is distinct from `passing` on purpose: two open pull requests on the real
 * repository returned an empty rollup, and showing that as green would be a lie.
 */
export type ChecksVerdict =
  | 'no-pr'
  | 'no-checks'
  | 'pending'
  | 'passing'
  | 'failing'
  | 'unknown';

export interface ChecksState {
  readonly verdict: ChecksVerdict;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly prTitle: string | null;
  readonly isDraft: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
  /** ISO timestamp of the last successful lookup. */
  readonly checkedAt: string | null;
  readonly error: string | null;
}

/* ------------------------------------------------------------------ *
 * Aggregated row
 * ------------------------------------------------------------------ */

/** Everything the table needs for one project. */
export interface ProjectRow {
  readonly project: Project;
  readonly server: ServerState;
  readonly git: GitState | null;
  readonly checks: ChecksState | null;
}

/* ------------------------------------------------------------------ *
 * Terminal
 * ------------------------------------------------------------------ */

/** A named shell launcher, in the spirit of Windows Terminal profiles. */
export interface ShellProfile {
  readonly id: string;
  readonly label: string;
  /** Absolute path to the executable. */
  readonly file: string;
  readonly args: readonly string[];
  /** Starting directory. */
  readonly cwd: string;
  /** True when found on this machine rather than declared by the user. */
  readonly detected: boolean;
}

/**
 * Identifier of one live terminal.
 *
 * Sessions are keyed by their own id rather than by project, because a terminal is no longer tied
 * to a project: a shell tab belongs to nothing, and a project can have output from a `start` and a
 * `commit` at different times.
 */
export type TerminalId = string;

/** What a terminal session is for, which decides how its exit is interpreted. */
export type TerminalKind = 'project' | 'shell';

export interface TerminalSession {
  readonly id: TerminalId;
  readonly title: string;
  readonly kind: TerminalKind;
  /**
   * Project this tab belongs to, so server state updates reach the right row.
   *
   * Also set on a **shell** opened in a repository, which is what lets that shell be found again
   * instead of a new one being stacked on every click. A shell therefore has a `projectId` and no
   * `actionId`: anything walking these two fields must treat that pair as valid.
   */
  readonly projectId: ProjectId | null;
  /** Action that opened this tab. Null for a shell, including a repository shell. */
  readonly actionId: string | null;
  /** Set for `shell` sessions. */
  readonly profileId: string | null;
  readonly cwd: string;
  /** False once the process has exited; the tab stays so its output can still be read. */
  readonly running: boolean;
  /**
   * Whether the tab can be closed.
   *
   * Derived from live state rather than stored: a one-shot task is always closable, a shell always
   * is, and a `server` action only once it has stopped, so `Stop` stays the deliberate way to end a
   * build.
   */
  readonly closable: boolean;
  /** True once the user renamed the tab, which stops the title being re-derived on a rerun. */
  readonly renamed: boolean;
}

/**
 * How the visible panes share the terminal surface.
 *
 * `columns` puts them side by side, `rows` stacks them. One direction for the whole surface, not a
 * nestable tree: three terminals side by side or three stacked, never a mix. That is the deliberate
 * limit of this layout, and what keeps a pane's position predictable from its index alone.
 */
export type PaneDirection = 'columns' | 'rows';

/**
 * The set of sessions currently on screen.
 *
 * Held by the main process next to the sessions themselves, for the same reason their order is: the
 * renderer restarts on every hot reload, and a layout kept there would be lost several times a minute
 * in development. It is never empty while a session exists.
 */
export interface TerminalLayout {
  readonly direction: PaneDirection;
  /** Visible sessions, in display order. */
  readonly panes: readonly TerminalId[];
}

/** Chunk of terminal output. */
export interface TerminalChunk {
  readonly terminalId: TerminalId;
  readonly data: string;
}

/** Terminal geometry, pushed when the pane is resized. */
export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}


/** Request to open a shell tab. */
export interface OpenShellRequest {
  readonly profileId: string;
  /** Overrides the profile's starting directory, used by the per-repository action. */
  readonly cwd?: string;
  /** Title override, so a repo-scoped shell can say which repo it is in. */
  readonly title?: string;
}

/* ------------------------------------------------------------------ *
 * Theme
 * ------------------------------------------------------------------ */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeState {
  readonly mode: ThemeMode;
  readonly resolved: ResolvedTheme;
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

/**
 * Terminal font size, in CSS pixels.
 *
 * Lives here so the store's clamp, the settings field and the pane's own fallback all read the same
 * three numbers. The bounds are what stays legible: below the minimum xterm's cell grid stops being
 * readable, above the maximum a single tab fits almost nothing.
 */
export const TERMINAL_FONT_SIZE = { default: 14, min: 9, max: 28 } as const;

export interface AppSettings {
  themeMode: ThemeMode;
  /** Seconds between git refreshes. */
  gitPollSeconds: number;
  /** Seconds between GitHub checks refreshes. Kept well above the git interval: it hits the network. */
  checksPollSeconds: number;
  /** Height of the projects pane in pixels, remembered across restarts. The terminal takes the rest. */
  projectsHeight: number;
  /** Profile the bare "new tab" click uses. */
  defaultShellProfileId: string;
  /** Font size of every terminal, in pixels. */
  terminalFontSize: number;
  /** User-declared shell profiles, merged over the detected ones by id. */
  shellProfiles: ShellProfile[];
  /** Where to look for repositories when detecting candidates. */
  projectsRoot: string;
  /**
   * Watched projects.
   *
   * Empty on a fresh install, which triggers a one-time seeding from `projectsRoot` so the app is
   * useful immediately without asking the user to configure anything first.
   */
  projects: ProjectConfig[];
}

/** Window bounds remembered across sessions. */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

export interface BootstrapState {
  readonly projects: Project[];
  readonly settings: AppSettings;
  readonly theme: ThemeState;
  /** Detected profiles merged with the user's, ready for the new-tab menu. */
  readonly shellProfiles: ShellProfile[];
  /**
   * Terminals already alive in the main process.
   *
   * Sent because the renderer can restart without the main process doing so, on every hot reload in
   * development. Without this the tab strip came up empty until the next change event, and the
   * startup shell was opened again each time, stacking up identical "Git Bash" tabs.
   */
  readonly terminals: TerminalSession[];
  /** Which of those sessions are on screen, and how they share it. */
  readonly layout: TerminalLayout;
}

/* ------------------------------------------------------------------ *
 * IPC channels
 * ------------------------------------------------------------------ */

export const IpcChannel = {
  /** invoke: () => BootstrapState */
  Bootstrap: 'app:bootstrap',
  /** on: (rows: ProjectRow[]) => void, pushed whenever any project's state changes */
  RowsChanged: 'projects:rows-changed',
  /** invoke: () => ProjectRow[], forces a full refresh */
  RefreshNow: 'projects:refresh',
  /** invoke: (projectId, actionId) => TerminalId, runs one of a project's actions in its own tab */
  PtyRun: 'pty:run',
  /** invoke: (request: OpenShellRequest) => TerminalId */
  TerminalOpenShell: 'terminal:open-shell',
  /** invoke: (projectId) => TerminalId, opens the project's shell or brings the existing one back */
  ProjectShell: 'project:shell',
  /** invoke: (terminalId) => void, stops the process and its whole tree */
  PtyStop: 'pty:stop',
  /** invoke: (projectId) => boolean, stops the project's running `server` action, whichever it is */
  ProjectStop: 'project:stop',
  /** invoke: (terminalId) => void, stops it if needed and forgets the tab */
  TerminalClose: 'terminal:close',
  /** invoke: (terminalId, title) => void, renames a tab */
  TerminalRename: 'terminal:rename',
  /** invoke: (orderedIds: TerminalId[]) => void, sets the tab order after a drag */
  TerminalReorder: 'terminal:reorder',
  /** send: (terminalId, data) => void, keystrokes from xterm to the pty */
  PtyInput: 'pty:input',
  /** send: (terminalId, size) => void */
  PtyResize: 'pty:resize',
  /** on: (chunk: TerminalChunk) => void */
  PtyOutput: 'pty:output',
  /** invoke: (terminalId) => string, replays buffered output when a tab is first shown */
  PtyBuffer: 'pty:buffer',
  /** on: (sessions: TerminalSession[]) => void, the tab strip is rebuilt from this */
  TerminalsChanged: 'terminal:sessions-changed',
  /** invoke: (panes: TerminalId[], direction) => void, replaces the whole visible layout */
  TerminalLayoutSet: 'terminal:layout-set',
  /** on: (layout: TerminalLayout) => void, pushed whenever the visible panes change */
  TerminalLayoutChanged: 'terminal:layout-changed',
  /** invoke: (url: string) => void, opens in the real browser */
  OpenExternal: 'shell:open-external',
  /** invoke: (projectId) => void, reveals the repository in the file explorer */
  OpenFolder: 'shell:open-folder',
  /** invoke: (mode: ThemeMode) => ThemeState */
  ThemeSet: 'theme:set',
  /** on: (state: ThemeState) => void */
  ThemeChanged: 'theme:changed',
  /** invoke: (patch) => AppSettings */
  SettingsUpdate: 'settings:update',
  /** invoke: (projects: ProjectConfig[]) => AppSettings, replaces the whole list */
  ProjectsSave: 'projects:save',
  /** invoke: (root?: string) => ProjectCandidate[] */
  ProjectsDetect: 'projects:detect',
  /** invoke: (path: string) => ProjectConfig, a candidate entry for a folder, not saved */
  ProjectsBuild: 'projects:build',
  /** invoke: (projects: ProjectConfig[]) => ProjectValidation[], checked as the user types */
  ProjectsValidate: 'projects:validate',
  /** invoke: (profiles: ShellProfile[], defaultId) => AppSettings */
  ProfilesSave: 'profiles:save',
  /** invoke: (title) => string | null, native folder picker */
  PickFolder: 'dialog:pick-folder',
  /** on: (settings: AppSettings) => void, pushed when settings change from anywhere */
  SettingsChanged: 'settings:changed',
  /** invoke: () => void, opens (or focuses) the settings window */
  SettingsOpen: 'settings:open',
  /** send: (dirty: boolean) => void, lets the main process warn before closing on unsaved edits */
  SettingsDirty: 'settings:dirty',
  /** invoke: () => void, closes the window the call came from */
  WindowClose: 'window:close',
} as const;

/**
 * The API exposed on `window.api`.
 *
 * Deliberately small: each member is one capability, so the renderer's blast radius is exactly
 * this list.
 */
export interface RendererApi {
  bootstrap(): Promise<BootstrapState>;
  refreshNow(): Promise<ProjectRow[]>;
  onRowsChanged(listener: (rows: ProjectRow[]) => void): () => void;

  runAction(projectId: ProjectId, actionId: string): Promise<TerminalId>;
  openShell(request: OpenShellRequest): Promise<TerminalId>;
  /**
   * Opens a shell sitting in the project's repository, or brings back the one already open there.
   *
   * Reuse rather than a new tab, because this is what a click on a row does: a gesture that easy to
   * trigger must not be able to pile up terminals. The lookup is the main process's, since it owns the
   * sessions.
   */
  openProjectShell(projectId: ProjectId): Promise<TerminalId>;
  stopPty(terminalId: TerminalId): Promise<void>;
  /**
   * Stops a project's server action.
   *
   * Takes a project rather than a terminal on purpose: which session that is depends on the action
   * roles, and the main process is the only side that holds both. Resolves to false when there was
   * nothing running, so a dead button reports itself instead of looking like a no-op.
   */
  stopProjectServer(projectId: ProjectId): Promise<boolean>;
  closeTerminal(terminalId: TerminalId): Promise<void>;
  renameTerminal(terminalId: TerminalId, title: string): Promise<void>;
  /**
   * Sets the tab order.
   *
   * The order lives in the main process, with the sessions themselves: the renderer restarts on every
   * hot reload, so an order kept there would be lost several times a minute in development.
   */
  reorderTerminals(orderedIds: TerminalId[]): Promise<void>;
  /**
   * Replaces the visible layout.
   *
   * The whole list at once rather than one operation per gesture: splitting, hiding a pane and showing
   * a session in place of another are all just a different list, the arithmetic is pure and testable in
   * the renderer, and the main process only has to validate what it is handed.
   */
  setTerminalLayout(panes: TerminalId[], direction: PaneDirection): Promise<void>;
  onTerminalLayoutChanged(listener: (layout: TerminalLayout) => void): () => void;
  sendPtyInput(terminalId: TerminalId, data: string): void;
  resizePty(terminalId: TerminalId, size: TerminalSize): void;
  onPtyOutput(listener: (chunk: TerminalChunk) => void): () => void;
  readPtyBuffer(terminalId: TerminalId): Promise<string>;
  onTerminalsChanged(listener: (sessions: TerminalSession[]) => void): () => void;

  openExternal(url: string): Promise<void>;
  openFolder(projectId: ProjectId): Promise<void>;

  setThemeMode(mode: ThemeMode): Promise<ThemeState>;
  onThemeChanged(listener: (state: ThemeState) => void): () => void;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;

  saveProjects(projects: ProjectConfig[]): Promise<AppSettings>;
  detectProjects(root?: string): Promise<ProjectCandidate[]>;
  /**
   * Builds the configuration for a folder without saving it.
   *
   * The id, the label and the default actions are derived in the main process so there is exactly one
   * definition of what a new project looks like, whether it is added from the table or from the
   * settings window.
   */
  buildProjectConfig(path: string): Promise<ProjectConfig>;
  validateProjects(projects: ProjectConfig[]): Promise<ProjectValidation[]>;
  saveProfiles(profiles: ShellProfile[], defaultProfileId: string): Promise<AppSettings>;
  pickFolder(title: string): Promise<string | null>;
  onSettingsChanged(listener: (settings: AppSettings) => void): () => void;

  /** Opens the settings window, or focuses it when it is already up. */
  openSettings(): Promise<void>;
  /** Reports unsaved edits so closing the settings window can ask for confirmation. */
  reportSettingsDirty(dirty: boolean): void;
  /** Closes the window the renderer runs in. */
  closeWindow(): Promise<void>;
}
