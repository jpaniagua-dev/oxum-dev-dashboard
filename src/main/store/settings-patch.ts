import type { AppSettings } from '@shared/contracts.js';
import { sanitizeTagColors } from '@shared/project-tags.js';

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
  'worktreesHeight',
  'gitListWidth',
  'activeStrip',
  'pullScope',
  'stripCollapsed',
  // Written by the dashboard when the servers window opens or closes. Broadcasting it back would make
  // the dashboard reload settings in the middle of the gesture that produced it.
  'serversDetached',
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
  if (typeof input.worktreesHeight === 'number') patch.worktreesHeight = input.worktreesHeight;
  if (typeof input.gitListWidth === 'number') patch.gitListWidth = input.gitListWidth;
  // Kept in step with `asStrip` in `settings-store.ts`: a tab this list accepts and that one drops is
  // saved as `projects` on its way to disk, which is how the Triage tab spent a version not being
  // remembered. Two gates, one list of tabs.
  if (
    input.activeStrip === 'projects' ||
    input.activeStrip === 'pulls' ||
    input.activeStrip === 'jira' ||
    input.activeStrip === 'git' ||
    input.activeStrip === 'triage' ||
    input.activeStrip === 'worktrees'
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
  if (typeof input.serversDetached === 'boolean') patch.serversDetached = input.serversDetached;
  // The three model names. Accepted as typed and normalised by the store, which is the single place
  // that decides what a model name is: rejecting here as well would mean two answers to that question,
  // and the one that silently dropped the value would be this one.
  if (typeof input.claudeAnalysisModel === 'string') {
    patch.claudeAnalysisModel = input.claudeAnalysisModel;
  }
  if (typeof input.claudeWorkModel === 'string') patch.claudeWorkModel = input.claudeWorkModel;
  if (typeof input.claudeCommitModel === 'string') patch.claudeCommitModel = input.claudeCommitModel;
  /*
   * The tag palette, written by **both** renderers: the settings window on save, and the dashboard on
   * a right click on a chip. Broadcast, and therefore not in `LOCAL_ONLY_KEYS`, since recolouring a
   * tag in one window has to repaint it in the other.
   *
   * Sanitised here as well as in the store, which is the exception to the rule the model names
   * record. Those are passed on as typed because rejecting a typo in two places would mean two
   * answers to what a model name is. A colour map is different: it is a whole object rather than a
   * scalar, so passing it on unchecked would put `undefined` values into a `Partial<AppSettings>`
   * that `update()` spreads over the cache, and the map would be replaced by a malformed one before
   * the store ever looked at it.
   */
  if (typeof input.tagColors === 'object' && input.tagColors !== null) {
    patch.tagColors = sanitizeTagColors(input.tagColors);
  }

  return patch;
}
