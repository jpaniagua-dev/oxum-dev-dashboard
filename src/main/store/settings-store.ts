import { readFile } from 'node:fs/promises';
import {
  TERMINAL_FONT_SIZE,
  type ActionRole,
  type AppSettings,
  type ProjectAction,
  type ProjectConfig,
  type ShellProfile,
  type StripTab,
  type ThemeMode,
  type WindowBounds,
} from '@shared/contracts.js';
import {
  DEFAULT_PROJECTS_ROOT,
  defaultActions,
  makeActionId,
  makeId,
} from '../projects/project-id.js';
import { sanitizeProfile } from '../terminal/shell-profiles.js';
import { atomicWriteFile, fileExists } from './atomic-write.js';

/**
 * Defaults chosen so a fresh install is useful with no configuration.
 *
 * The poll intervals differ by cost: git is local and cheap, GitHub is a network round trip, and
 * scanning Claude transcripts touches many files. Using one interval for all three would either
 * make git feel stale or hammer the GitHub API.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  themeMode: 'system',
  gitPollSeconds: 10,
  checksPollSeconds: 60,
  // One `gh` call per watched repository, so the slowest of the three loops by design.
  pullsPollSeconds: 180,
  activeStrip: 'projects',
  // Taller than the project table: a master-detail list needs the room.
  pullsHeight: 360,
  jiraHeight: 360,
  // Two network searches per pass, so the slowest loop of the three.
  jiraPollSeconds: 300,
  jira: { siteUrl: '', email: '', projectKeys: [] },
  // The terminal is the centre of the window, so the projects pane is the one with a stored height.
  // 250 shows the three seeded projects without a scrollbar, which is the point of a status strip.
  projectsHeight: 250,
  defaultShellProfileId: 'git-bash',
  terminalFontSize: TERMINAL_FONT_SIZE.default,
  // Empty means the default folder. Resolved in the main process, never here: this module must not
  // import `AppPaths`, which imports Electron. See the `DEFAULT_PROJECTS_ROOT` trap in CLAUDE.md.
  notesFolder: '',
  notesWidth: 340,
  notesOpen: false,
  shellProfiles: [],
  projectsRoot: DEFAULT_PROJECTS_ROOT,
  // Empty on purpose: an empty list triggers the one-time seeding in `index.ts`, whereas a hardcoded
  // default here would come back every time the user deleted a project.
  projects: [],
};

export const DEFAULT_BOUNDS: WindowBounds = { x: -1, y: -1, width: 1180, height: 760 };

/**
 * Reads and writes `settings.json`.
 *
 * Unknown keys are dropped and missing ones fall back to defaults, so a hand-edited or outdated
 * file degrades instead of breaking startup.
 */
export class SettingsStore {
  private cache: AppSettings = { ...DEFAULT_SETTINGS };

  constructor(private readonly filePath: string) {}

  async load(): Promise<AppSettings> {
    if (!fileExists(this.filePath)) {
      return this.cache;
    }
    try {
      const raw: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.cache = sanitizeSettings(raw);
    } catch (error) {
      console.error('[settings] unreadable file, using defaults', error);
    }
    return this.cache;
  }

  get(): AppSettings {
    return this.cache;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.cache = sanitizeSettings({ ...this.cache, ...patch });
    await atomicWriteFile(this.filePath, `${JSON.stringify(this.cache, null, 2)}\n`);
    return this.cache;
  }
}

/**
 * Coerces arbitrary JSON into valid settings.
 *
 * Exported for testing: this is the boundary protecting the app from a corrupted configuration.
 * The clamps also stop a hand-edited interval of `0` from turning a poll into a busy loop.
 */
export function sanitizeSettings(raw: unknown): AppSettings {
  if (typeof raw !== 'object' || raw === null) {
    return { ...DEFAULT_SETTINGS };
  }
  const input = raw as Record<string, unknown>;

  return {
    themeMode: asThemeMode(input.themeMode),
    gitPollSeconds: clamp(asNumber(input.gitPollSeconds, DEFAULT_SETTINGS.gitPollSeconds), 2, 600),
    checksPollSeconds: clamp(
      asNumber(input.checksPollSeconds, DEFAULT_SETTINGS.checksPollSeconds),
      15,
      3600,
    ),
    pullsPollSeconds: clamp(
      asNumber(input.pullsPollSeconds, DEFAULT_SETTINGS.pullsPollSeconds),
      30,
      3600,
    ),
    jiraPollSeconds: clamp(asNumber(input.jiraPollSeconds, DEFAULT_SETTINGS.jiraPollSeconds), 60, 3600),
    jira: asJira(input.jira),
    activeStrip: asStrip(input.activeStrip),
    // Clamped so a hand-edited value cannot hide the strip or swallow the terminal.
    projectsHeight: clamp(asNumber(input.projectsHeight, DEFAULT_SETTINGS.projectsHeight), 90, 1200),
    pullsHeight: clamp(asNumber(input.pullsHeight, DEFAULT_SETTINGS.pullsHeight), 90, 1200),
    jiraHeight: clamp(asNumber(input.jiraHeight, DEFAULT_SETTINGS.jiraHeight), 90, 1200),
    defaultShellProfileId: asString(
      input.defaultShellProfileId,
      DEFAULT_SETTINGS.defaultShellProfileId,
    ),
    // Clamped rather than trusted: a hand-edited `2` would make the terminal unreadable with no way to
    // fix it from the app, since the settings window would be the thing you can no longer read.
    terminalFontSize: clamp(
      Math.round(asNumber(input.terminalFontSize, TERMINAL_FONT_SIZE.default)),
      TERMINAL_FONT_SIZE.min,
      TERMINAL_FONT_SIZE.max,
    ),
    // Trimmed but an empty string is preserved: it is the meaningful "use the default folder" value,
    // so `asString`'s fallback-on-empty behaviour would be wrong here.
    notesFolder: typeof input.notesFolder === 'string' ? input.notesFolder.trim() : '',
    // Clamped for the same reason as the strip heights: a hand-edited width must not be able to hide
    // the terminal behind the panel.
    notesWidth: clamp(asNumber(input.notesWidth, DEFAULT_SETTINGS.notesWidth), 240, 900),
    notesOpen: typeof input.notesOpen === 'boolean' ? input.notesOpen : false,
    shellProfiles: asProfiles(input.shellProfiles),
    projectsRoot: asString(input.projectsRoot, DEFAULT_SETTINGS.projectsRoot),
    projects: asProjects(input.projects),
  };
}

/**
 * Validates the project list.
 *
 * A missing label falls back to the folder name and a missing action list to the defaults, so an
 * entry hand-written with the bare minimum still works. Entries without an id or a path are dropped:
 * there is nothing sensible to infer for either.
 */
function asProjects(value: unknown): ProjectConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: ProjectConfig[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const input = entry as Record<string, unknown>;
    if (typeof input.path !== 'string' || input.path.length === 0) {
      continue;
    }
    const folder = input.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'projet';
    const id = typeof input.id === 'string' && input.id.length > 0 ? input.id : makeId(folder);

    result.push({
      id,
      label: typeof input.label === 'string' && input.label.length > 0 ? input.label : folder,
      path: input.path,
      // `startScript` is the pre-actions shape of this file. Reading it here is what makes an existing
      // configuration migrate silently instead of losing a customised start script.
      actions: asActions(
        input.actions,
        typeof input.startScript === 'string' && input.startScript.length > 0
          ? input.startScript
          : 'start',
      ),
      kind: input.kind === 'server' || input.kind === 'watch' ? input.kind : null,
      expectedPort:
        typeof input.expectedPort === 'number' && Number.isFinite(input.expectedPort)
          ? input.expectedPort
          : null,
      enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
      // Followed unless said otherwise, so an existing configuration gains the pull request tab without
      // being edited first.
      followPulls: typeof input.followPulls === 'boolean' ? input.followPulls : true,
    });
  }
  return result;
}

/**
 * Validates a project's action list.
 *
 * Exported for testing, and the place where two invariants are enforced rather than hoped for: ids
 * are unique, and **at most one action is a `server`**. A row holds a single server state, so a second
 * server action would have two processes writing the same phase and the last one to print would win.
 * Extras are demoted rather than dropped, so the command the user wrote is never lost silently.
 */
export function asActions(value: unknown, startScript = 'start'): ProjectAction[] {
  if (!Array.isArray(value)) {
    return defaultActions(startScript);
  }

  const result: ProjectAction[] = [];
  let serverTaken = false;

  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const input = entry as Record<string, unknown>;
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (command.length === 0) {
      // An action with no command has no reason to exist, and its button would do nothing.
      continue;
    }
    const label =
      typeof input.label === 'string' && input.label.trim().length > 0
        ? input.label.trim()
        : command.slice(0, 20);
    const requested: ActionRole = input.role === 'server' ? 'server' : 'task';
    const role: ActionRole = requested === 'server' && !serverTaken ? 'server' : 'task';
    if (role === 'server') {
      serverTaken = true;
    }

    result.push({
      id:
        typeof input.id === 'string' && input.id.length > 0 && !result.some((a) => a.id === input.id)
          ? input.id
          : makeActionId(label, result.map((action) => action.id)),
      label,
      command,
      role,
      profileId: typeof input.profileId === 'string' && input.profileId.length > 0 ? input.profileId : null,
    });
  }

  // An empty list would leave a row with no buttons at all, which reads as a broken dashboard rather
  // than a deliberate choice.
  return result.length > 0 ? result : defaultActions(startScript);
}

/**
 * Validates the Jira connection.
 *
 * The token is **not** part of this shape and never will be: it lives encrypted in its own file. Project
 * keys are trimmed and uppercased because JQL is case-sensitive on them and a stray `proj` returns nothing
 * with no error at all.
 */
function asJira(value: unknown): AppSettings['jira'] {
  const input = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const keys = Array.isArray(input.projectKeys) ? input.projectKeys : [];
  return {
    siteUrl: typeof input.siteUrl === 'string' ? input.siteUrl.trim().replace(/\/+$/, '') : '',
    email: typeof input.email === 'string' ? input.email.trim() : '',
    projectKeys: keys
      .filter((key): key is string => typeof key === 'string')
      .map((key) => key.trim().toUpperCase())
      .filter((key) => key.length > 0),
  };
}

function asStrip(value: unknown): StripTab {
  return value === 'pulls' || value === 'jira' ? value : 'projects';
}

/** Drops malformed profiles instead of letting one reach `pty.spawn`. */
function asProfiles(value: unknown): ShellProfile[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => sanitizeProfile(entry))
    .filter((profile): profile is ShellProfile => profile !== null);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function asThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system'
    ? value
    : DEFAULT_SETTINGS.themeMode;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
