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
  /**
   * The last review of each pull request.
   *
   * Its own file for the reasons `triage.json` has one, plus a third: these rows describe things
   * that happened on **GitHub**, so they are the record of what was said publicly and under whose
   * name. A settings save must never be able to drop that.
   */
  pullReviews: (): string => join(app.getPath('userData'), 'pull-reviews.json'),
  /**
   * What the app remembers about each ticket handed to an unattended run.
   *
   * Its own file for the reasons the two above have one, plus the one that makes it load bearing: it
   * holds the phase that stops a feedback pass running twice. Losing it would not lose a preference,
   * it would re-arm an agent on a pull request that has already had its pass.
   */
  autoRuns: (): string => join(app.getPath('userData'), 'auto-runs.json'),
  /**
   * Bodies posted to pull requests, one file per review.
   *
   * Written before the post and **kept after it**, exactly like a commit message and for the same
   * reason plus one: when a post is refused, by a token without the scope or by a pull request that
   * closed in the meantime, this file is the only surviving copy of a run that cost minutes.
   */
  reviewBodies: (): string => join(app.getPath('userData'), 'review-bodies'),
} as const;
