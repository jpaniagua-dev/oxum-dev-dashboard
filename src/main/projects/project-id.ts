import type { ProjectAction, ProjectId } from '@shared/contracts.js';

/**
 * Values shared by the settings store and the project registry.
 *
 * They live in their own dependency-free module on purpose. When `settings-store` imported them from
 * `registry`, `DEFAULT_SETTINGS` was evaluated before `registry` had initialised, so
 * `projectsRoot` came out `undefined`, was written to `settings.json` as missing, and the first-run
 * seeding then scanned an empty path and found nothing. The dashboard came up with an empty table and
 * no error anywhere. Keeping these constants free of imports removes the ordering question entirely.
 */

/**
 * Default place to look for repositories: none.
 *
 * It was `~/oxum/projects`, the author's own layout, which exists on no other machine: detection
 * scanned a missing folder and every headless run was spawned in it. Empty now, and set in the
 * settings; a stored value is kept, so an install that had the old default explicitly keeps it.
 */
export const DEFAULT_PROJECTS_ROOT = '';

/**
 * Default folder a `Work on this` session starts in: the workspace holding the repositories.
 *
 * Spelled out rather than derived with `dirname(DEFAULT_PROJECTS_ROOT)`, and that is deliberate. The
 * parent of a repository folder is only the workspace under this layout; point `projectsRoot` at
 * `C:\repos` and the same arithmetic yields the drive root, which is not a context, it is a folder
 * whose ancestors nobody chose. A default is allowed to assume the layout it ships with; a computation
 * would silently claim to work for every other one.
 */
export const DEFAULT_CLAUDE_CONTEXT_ROOT = '';

/** Stable id derived from a folder name, kept distinct from the editable label. */
export function makeId(folder: string): ProjectId {
  return folder
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Actions given to a project that declares none.
 *
 * **One action, and it used to be two.** A `Commit` button ran a command literally called `commit`,
 * which is a bash alias in the author's own profile: on any other machine that button opened a tab
 * saying `command not found`, and this file's own rules name that as the mistake not to repeat. It was
 * dropped in 5.8.2 rather than repointed, because the app grew a better answer in the meantime: the
 * Git tab commits with a real form, a message file, an amend, and `Generate` writing the message from
 * the staged diff through a headless Claude Code run. A row button that shells out to a script is a
 * second implementation of that, and the worse one.
 *
 * Existing configurations are **untouched**: stored actions are read as they were saved, so a project
 * that already carries a `Commit` button keeps it. Only a project added from now on starts with `Run`
 * alone.
 *
 * No profile override: a freshly added project follows the configured default shell, exactly like
 * the terminal opened by clicking its row. `runProjectAction` executes the command through that
 * shell, so Git Bash, PowerShell, cmd and WSL each receive the syntax they understand.
 */
export function defaultActions(startScript = 'start'): ProjectAction[] {
  return [
    { id: 'run', label: 'Run', command: `npm run ${startScript}`, role: 'server', profileId: null },
  ];
}

/** Whether a project's pull requests are followed by default. Kept here with the other seed values. */
export const FOLLOW_PULLS_DEFAULT = true;

/**
 * Stable id for an action, unique within its project.
 *
 * Derived from the label at creation and never recomputed: an action's id keys its terminal tab, so
 * re-deriving it on a rename would orphan a running process.
 */
export function makeActionId(label: string, taken: readonly string[]): string {
  const base = makeId(label) || 'action';
  if (!taken.includes(base)) {
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.includes(candidate)) {
      return candidate;
    }
  }
}

/**
 * Default label for a freshly added project: its folder name, unchanged.
 *
 * There used to be a shortening rule here, stripping the prefix shared by one particular set of
 * repositories. It only ever made sense for that naming scheme: applied elsewhere, guessing which
 * part of a folder name is noise removes the very word that told the projects apart. The label is
 * editable in the settings dialog and by double-clicking the name in the table, which is the right
 * place for a judgement no rule can make.
 */
export function defaultLabel(folder: string): string {
  return folder;
}
