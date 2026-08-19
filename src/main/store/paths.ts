import { app } from 'electron';
import { join } from 'node:path';

/**
 * Everything the app writes, resolved from Electron's per-user data directory.
 *
 * The dev build gets a suffixed directory (see `src/main/index.ts`), so running from source never
 * shares settings or window state with an installed build.
 */
export const AppPaths = {
  userData: (): string => app.getPath('userData'),
  settings: (): string => join(app.getPath('userData'), 'settings.json'),
  windowState: (): string => join(app.getPath('userData'), 'window-state.json'),
  settingsWindowState: (): string =>
    join(app.getPath('userData'), 'settings-window-state.json'),
  /** Its own file, so the position it was left in on a second monitor is where it comes back. */
  serversWindowState: (): string =>
    join(app.getPath('userData'), 'servers-window-state.json'),
  /** Encrypted Jira token, kept out of `settings.json` on purpose. */
  jiraToken: (): string => join(app.getPath('userData'), 'jira-token.bin'),
  /** Default notes folder, used when `notesFolder` is empty. */
  notes: (): string => join(app.getPath('userData'), 'notes'),
  /**
   * Where the Git tab writes commit messages before handing them to `git commit -F`.
   *
   * Under `userData` rather than the system temp folder: a hook can reject a commit, and the message
   * that was typed is then worth keeping somewhere a cleanup job will not sweep it away.
   */
  commitMessages: (): string => join(app.getPath('userData'), 'commit-messages'),
  /**
   * Last triage per sprint.
   *
   * Its own file rather than a key in `settings.json`: this is a result, not a preference, it is
   * rewritten by a long-running analysis, and a settings save must never be able to drop it.
   */
  triage: (): string => join(app.getPath('userData'), 'triage.json'),
} as const;
