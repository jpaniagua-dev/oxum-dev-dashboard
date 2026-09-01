import { readFile } from 'node:fs/promises';
import { normalizeModel } from '@shared/claude-model.js';
import {
  sanitizeTagColors,
  sanitizeTags,
  withAssignedTagColors,
} from '@shared/project-tags.js';
import {
  TERMINAL_FONT_SIZE,
  UI_FONT_SIZE,
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
  DEFAULT_CLAUDE_CONTEXT_ROOT,
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
  stripCollapsed: false,
  // Taller than the project table: a master-detail list needs the room.
  pullsHeight: 360,
  jiraHeight: 360,
  // "Mine" is the question the tab was built for; "all" is one click away when it is not the question.
  pullScope: 'mine',
  // Taller still, and on purpose: three columns ending in a diff is the one tab of this strip where
  // the user stops glancing and starts working. 250 pixels would show four lines of a diff.
  gitHeight: 460,
  triageHeight: 460,
  // Between the status table and the Git tab: one line per worktree, and this workspace holds eight
  // of them across two repositories, which is more than a 250px strip can show without scrolling.
  worktreesHeight: 360,
  // Wide enough for a real path (`src/renderer/ui/git-panel.ts`) without truncation, which the first
  // 340 was not. The diff keeps the rest, and the separator is there to change the balance.
  gitListWidth: 460,
  // Two network searches per pass, so the slowest loop of the three.
  jiraPollSeconds: 300,
  jira: { siteUrl: '', email: '', projectKeys: [] },
  // The terminal is the centre of the window, so the projects pane is the one with a stored height.
  // 250 shows the three seeded projects without a scrollbar, which is the point of a status strip.
  projectsHeight: 250,
  defaultShellProfileId: 'git-bash',
  terminalFontSize: TERMINAL_FONT_SIZE.default,
  uiFontSize: UI_FONT_SIZE.default,
  // Empty means the default folder. Resolved in the main process, never here: this module must not
  // import `AppPaths`, which imports Electron. See the `DEFAULT_PROJECTS_ROOT` trap in CLAUDE.md.
  shellProfiles: [],
  projectsRoot: DEFAULT_PROJECTS_ROOT,
  // The workspace above the repositories, so a `Work on this` session starts with the conventions and
  // skills that live there. Empty would mean "start in the repository", which is what it used to do.
  claudeContextRoot: DEFAULT_CLAUDE_CONTEXT_ROOT,
  // Empty means "whatever Claude Code itself is set to", for all three. A default named here would be
  // this app deciding which model a user's own CLI runs on, which is not its call to make.
  // Closed on a fresh install: a window nobody asked for, opening on first launch, is the wrong
  // first impression of a feature that is opt-in by nature.
  serversDetached: false,
  claudeAnalysisModel: '',
  claudeWorkModel: '',
  claudeCommitModel: '',
  // Empty on purpose: an empty list triggers the one-time seeding in `index.ts`, whereas a hardcoded
  // default here would come back every time the user deleted a project.
  projects: [],
  // Filled by `sanitizeSettings` from the tags actually in use, so this is only the shape and never a
  // set of colours somebody would have to undo.
  tagColors: {},
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
  // Read before the object literal because two of its fields need it: the list itself, and the colour
  // map, which is completed from the tags that list actually carries.
  const projects = asProjects(input.projects);

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
    pullScope: input.pullScope === 'all' ? 'all' : 'mine',
    stripCollapsed: input.stripCollapsed === true,
    // Clamped so a hand-edited value cannot hide the strip or swallow the terminal.
    projectsHeight: clamp(asNumber(input.projectsHeight, DEFAULT_SETTINGS.projectsHeight), 90, 1200),
    pullsHeight: clamp(asNumber(input.pullsHeight, DEFAULT_SETTINGS.pullsHeight), 90, 1200),
    jiraHeight: clamp(asNumber(input.jiraHeight, DEFAULT_SETTINGS.jiraHeight), 90, 1200),
    gitHeight: clamp(asNumber(input.gitHeight, DEFAULT_SETTINGS.gitHeight), 90, 1200),
    triageHeight: clamp(asNumber(input.triageHeight, DEFAULT_SETTINGS.triageHeight), 90, 1200),
    worktreesHeight: clamp(
      asNumber(input.worktreesHeight, DEFAULT_SETTINGS.worktreesHeight),
      90,
      1200,
    ),
    gitListWidth: clamp(asNumber(input.gitListWidth, DEFAULT_SETTINGS.gitListWidth), 240, 1400),
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
    // Clamped for exactly the reason above, only more so: this one sizes the settings window's own
    // text, so a hand-edited `4` would have to be fixed in a form that is no longer readable.
    uiFontSize: clamp(
      Math.round(asNumber(input.uiFontSize, UI_FONT_SIZE.default)),
      UI_FONT_SIZE.min,
      UI_FONT_SIZE.max,
    ),
    // Trimmed but an empty string is preserved: it is the meaningful "use the default folder" value,
    // so `asString`'s fallback-on-empty behaviour would be wrong here.
    // Clamped for the same reason as the strip heights: a hand-edited width must not be able to hide
    // the terminal behind the panel.
    shellProfiles: asProfiles(input.shellProfiles),
    projectsRoot: asString(input.projectsRoot, DEFAULT_SETTINGS.projectsRoot),
    // Not `asString`, which falls back on an empty value: an empty string is a real answer here, and it
    // means "start the session in the repository itself".
    claudeContextRoot:
      typeof input.claudeContextRoot === 'string'
        ? input.claudeContextRoot.trim()
        : DEFAULT_SETTINGS.claudeContextRoot,
    // Normalised and not merely trimmed: one of these three ends up on a shell command line, and a
    // value that is not a model name is stored as empty (the default) rather than passed on. The
    // settings form is where a typo is shown; this is the guard that holds when the file is edited by
    // hand.
    serversDetached: typeof input.serversDetached === 'boolean' ? input.serversDetached : false,
    claudeAnalysisModel: asModel(input.claudeAnalysisModel),
    claudeWorkModel: asModel(input.claudeWorkModel),
    claudeCommitModel: asModel(input.claudeCommitModel),
    projects: projects,
    /*
     * Completed here rather than at each call site, and this is the choke point every write passes
     * through: the settings form, the table's context menu, and a file edited by hand. So a tag typed
     * anywhere comes back with a colour, and no renderer ever has to invent one.
     *
     * The assignment reads the **sanitised** project list, not the raw input, or a tag the guards
     * above dropped would still be given a colour.
     */
    tagColors: withAssignedTagColors(sanitizeTagColors(input.tagColors), projects),
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
      // Absent from every configuration written before tags existed, and an empty list is the right
      // answer there: an untagged project is visible under every filter, so a migration that invented
      // a tag would be a migration that hid rows.
      tags: sanitizeTags(input.tags),
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

/**
 * The tab to reopen on, falling back to the projects table.
 *
 * This list is the **second** gate `activeStrip` has to pass, `asPatch` being the first, and a tab
 * missing from either one is discarded in total silence. `triage` was missing here while `asPatch`
 * accepted it, so `update()` sanitised the value away on its way to disk: the Triage tab was written,
 * saved as `projects`, and the app reopened on the wrong tab with nothing to explain it. Exactly the
 * failure mode `settings-patch.ts` documents, one function further down. Both lists are pinned by
 * `test/settings-store.test.ts` and `test/settings-patch.test.ts` for that reason.
 */
function asStrip(value: unknown): StripTab {
  return value === 'pulls' ||
    value === 'jira' ||
    value === 'git' ||
    value === 'triage' ||
    value === 'worktrees'
    ? value
    : 'projects';
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

/**
 * Reads a model name, or the default.
 *
 * No `fallback` parameter, unlike `asString`: the fallback is always empty, empty being what "let
 * Claude Code decide" is spelled as, and a stored value that is not a model name is exactly as
 * unusable as no value at all.
 */
function asModel(value: unknown): string {
  return typeof value === 'string' ? normalizeModel(value) : '';
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
