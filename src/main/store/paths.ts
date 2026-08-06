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
  /** Encrypted Jira token, kept out of `settings.json` on purpose. */
  jiraToken: (): string => join(app.getPath('userData'), 'jira-token.bin'),
  /** Default notes folder, used when `notesFolder` is empty. */
  notes: (): string => join(app.getPath('userData'), 'notes'),
} as const;
