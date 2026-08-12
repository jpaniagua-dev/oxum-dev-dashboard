import { homedir } from 'node:os';
import { join } from 'node:path';
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

/** Default place to look for repositories. */
export const DEFAULT_PROJECTS_ROOT = join(homedir(), 'oxum', 'projects');

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
 * They reproduce exactly the two buttons that used to be hardcoded, including the shell each ran in:
 * `cmd` for npm, because a pty does not resolve the `.cmd` shims a shell would, and Git Bash for
 * `commit`, which is a bash alias. Seeding with the same shells keeps a first run behaving as before
 * while making both editable.
 */
export function defaultActions(startScript = 'start'): ProjectAction[] {
  return [
    { id: 'run', label: 'Run', command: `npm run ${startScript}`, role: 'server', profileId: 'cmd' },
    { id: 'commit', label: 'Commit', command: 'commit', role: 'task', profileId: 'git-bash' },
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
