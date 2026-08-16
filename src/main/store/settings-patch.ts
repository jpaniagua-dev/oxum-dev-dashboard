import type { AppSettings } from '@shared/contracts.js';

/**
 * Settings the dashboard writes about its own geometry.
 *
 * They originate in the window that would receive the echo, so broadcasting them back would rebuild
 * the table and the terminal in the middle of the gesture that produced them.
 */
export const LOCAL_ONLY_KEYS: ReadonlySet<string> = new Set([
  'projectsHeight',
  'pullsHeight',
  'jiraHeight',
  'gitHeight',
  'triageHeight',
  'gitListWidth',
  'activeStrip',
  'pullScope',
  'stripCollapsed',
  'notesWidth',
  'notesOpen',
]);

/**
 * Whitelists what the renderer may patch.
 *
 * Lives in its own module rather than in `ipc.ts` for one reason: `ipc.ts` imports Electron at module
 * scope, so a test importing it would need an Electron runtime. Same rule as `context-menu.ts` in the
 * renderer, which had to drop its import-time listeners for the same reason.
 *
 * The list is load-bearing and it earns its test: `pullsHeight`, `jiraHeight` and `activeStrip` were
 * **missing** here while `renderer/main.ts` sent them on every drag release and every tab change, so
 * the strip heights and the remembered tab were silently discarded from the V2 until now. A key
 * absent from this function fails in complete silence, which is the worst way for a setting to fail.
 */
export function asPatch(value: unknown): Partial<AppSettings> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const input = value as Record<string, unknown>;
  const patch: Partial<AppSettings> = {};

  if (typeof input.projectsHeight === 'number') patch.projectsHeight = input.projectsHeight;
  if (typeof input.pullsHeight === 'number') patch.pullsHeight = input.pullsHeight;
  if (typeof input.jiraHeight === 'number') patch.jiraHeight = input.jiraHeight;
  if (typeof input.gitHeight === 'number') patch.gitHeight = input.gitHeight;
  if (typeof input.triageHeight === 'number') patch.triageHeight = input.triageHeight;
  if (typeof input.gitListWidth === 'number') patch.gitListWidth = input.gitListWidth;
  if (
    input.activeStrip === 'projects' ||
    input.activeStrip === 'pulls' ||
    input.activeStrip === 'jira' ||
    input.activeStrip === 'git' ||
    input.activeStrip === 'triage'
  ) {
    patch.activeStrip = input.activeStrip;
  }
  if (input.pullScope === 'mine' || input.pullScope === 'all') patch.pullScope = input.pullScope;
  if (typeof input.stripCollapsed === 'boolean') patch.stripCollapsed = input.stripCollapsed;
  if (typeof input.terminalFontSize === 'number') patch.terminalFontSize = input.terminalFontSize;
  // Broadcast, and deliberately not in `LOCAL_ONLY_KEYS`: it is written by the settings window and has
  // to reach the dashboard, which is the window whose text it resizes.
  if (typeof input.uiFontSize === 'number') patch.uiFontSize = input.uiFontSize;
  if (typeof input.defaultShellProfileId === 'string') {
    patch.defaultShellProfileId = input.defaultShellProfileId;
  }
  if (typeof input.gitPollSeconds === 'number') patch.gitPollSeconds = input.gitPollSeconds;
  if (typeof input.checksPollSeconds === 'number') patch.checksPollSeconds = input.checksPollSeconds;
  if (typeof input.notesFolder === 'string') patch.notesFolder = input.notesFolder;
  if (typeof input.notesWidth === 'number') patch.notesWidth = input.notesWidth;
  if (typeof input.notesOpen === 'boolean') patch.notesOpen = input.notesOpen;

  return patch;
}
