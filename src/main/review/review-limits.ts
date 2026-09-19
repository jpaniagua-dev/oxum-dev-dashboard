/**
 * Every bound a review run answers to, one constant each.
 *
 * Together in one module rather than spread across the service, because a cap nobody can find is a
 * cap nobody tunes, and because `planRun` below has to be pure to be tested: a run that quietly
 * reviewed twenty pull requests, or quietly skipped three, is a run whose behaviour is discovered
 * from a GitHub notification.
 */

/** Pull requests one run may read. A run whose result cannot be read in one sitting is too big. */
export const MAX_PRS_PER_RUN = 10;

/** Pull requests one repository may contribute to a run, so a busy one cannot consume it all. */
export const MAX_PRS_PER_REPO = 5;

/**
 * Bytes of patch a run will read.
 *
 * Over it, the pull request is **skipped and said to be skipped**, never truncated. Truncating a
 * diff and reviewing it produces a confident, specific, wrong comment about code the run never saw,
 * signed with the user's name. "Too large to review (1.2 MB, 140 files)" is strictly better than a
 * verdict drawn from the first third of a change.
 */
export const MAX_PATCH_BYTES = 400_000;

/** Files a run will read. Same rule as the byte cap, from the other direction. */
export const MAX_CHANGED_FILES = 60;

/** One pull request's own budget. Reading a diff and a codebase is minutes, not seconds. */
export const PER_PR_TIMEOUT_MS = 6 * 60_000;

/**
 * The whole run's budget.
 *
 * It stops the run from **starting** another pull request; the one in flight finishes on its own
 * timeout. Killing mid-review would leave a run that spent the money and stored nothing.
 */
export const RUN_TIMEOUT_MS = 25 * 60_000;

/** Logins whose pull requests nobody is waiting for a human opinion on. */
export const BOT_AUTHORS: readonly string[] = [
  'dependabot',
  'dependabot[bot]',
  'renovate',
  'renovate[bot]',
  'github-actions',
  'github-actions[bot]',
];
