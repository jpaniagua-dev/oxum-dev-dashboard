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

/** Stable identifier for a watched project. */
export type ProjectId = 'web-app' | 'admin-front' | 'design-system';

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
  /** npm script to run, always `start` today but kept explicit. */
  readonly startScript: string;
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
 * would report that as "down". `external` covers a server started outside the dashboard, which
 * must be visible but cannot be controlled.
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
  | 'crashed'
  | 'external';

export interface ServerState {
  readonly phase: ServerPhase;
  /** Owned process id, or null when stopped or external. */
  readonly pid: number | null;
  /** Port confirmed listening, whoever owns it. */
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
 * Claude Code sessions
 * ------------------------------------------------------------------ */

/**
 * What a Claude Code session is doing.
 *
 * `idle` matters: sessions stay open for days, so without it a dashboard would permanently
 * report several "active" sessions that nobody is using.
 */
export type SessionStatus = 'working' | 'waiting' | 'idle' | 'ended';

export interface ClaudeSession {
  /** Session uuid, also the transcript file name. */
  readonly id: string;
  /** Short form for display. */
  readonly shortId: string;
  /** Working directory the session runs in, from the transcript. */
  readonly cwd: string | null;
  /** Last known git branch, from the transcript. */
  readonly gitBranch: string | null;
  /** Project folder name derived from the transcript directory. */
  readonly project: string;
  readonly status: SessionStatus;
  /** ISO timestamp of the last transcript write. */
  readonly lastActivityAt: string;
  /** Minutes since the last transcript write. */
  readonly idleMinutes: number;
  /** Number of transcript entries, a rough measure of session size. */
  readonly entries: number;
}

/* ------------------------------------------------------------------ *
 * Terminal
 * ------------------------------------------------------------------ */

/** Chunk of terminal output for a project's pty. */
export interface TerminalChunk {
  readonly projectId: ProjectId;
  readonly data: string;
}

/** Terminal geometry, pushed when the pane is resized. */
export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

/** A command the user can launch in a project's pty. */
export type PtyCommand = 'start' | 'commit';

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

export interface AppSettings {
  themeMode: ThemeMode;
  /** Seconds between git refreshes. */
  gitPollSeconds: number;
  /** Seconds between GitHub checks refreshes. Kept well above the git interval: it hits the network. */
  checksPollSeconds: number;
  /** Seconds between Claude session scans. */
  sessionsPollSeconds: number;
  /** A session with no transcript activity for this long counts as idle rather than active. */
  sessionIdleMinutes: number;
  /** Show the embedded terminal pane. */
  showTerminal: boolean;
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
  /** invoke: (projectId, command) => void */
  PtyRun: 'pty:run',
  /** invoke: (projectId) => void, stops an owned process and its whole tree */
  PtyStop: 'pty:stop',
  /** send: (projectId, data) => void, keystrokes from xterm to the pty */
  PtyInput: 'pty:input',
  /** send: (projectId, size) => void */
  PtyResize: 'pty:resize',
  /** on: (chunk: TerminalChunk) => void */
  PtyOutput: 'pty:output',
  /** invoke: (projectId) => string, replays buffered output when the pane opens */
  PtyBuffer: 'pty:buffer',
  /** on: (sessions: ClaudeSession[]) => void */
  SessionsChanged: 'sessions:changed',
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

  runPty(projectId: ProjectId, command: PtyCommand): Promise<void>;
  stopPty(projectId: ProjectId): Promise<void>;
  sendPtyInput(projectId: ProjectId, data: string): void;
  resizePty(projectId: ProjectId, size: TerminalSize): void;
  onPtyOutput(listener: (chunk: TerminalChunk) => void): () => void;
  readPtyBuffer(projectId: ProjectId): Promise<string>;

  onSessionsChanged(listener: (sessions: ClaudeSession[]) => void): () => void;

  openExternal(url: string): Promise<void>;
  openFolder(projectId: ProjectId): Promise<void>;

  setThemeMode(mode: ThemeMode): Promise<ThemeState>;
  onThemeChanged(listener: (state: ThemeState) => void): () => void;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
}
