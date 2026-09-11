import type { ChecksVerdict } from '@shared/contracts.js';

/**
 * What "green" means, in one place.
 *
 * A pure module, and it did not start as one: it used to run `gh pr view` per project on every checks
 * poll to answer the projects table's `Checks` column. That call is gone. `gh pr list`, which the
 * pull requests tab already runs once per repository, returns `headRefName` and `statusCheckRollup`
 * for every open pull request, so the column is a **join** against a payload the renderer already
 * holds rather than a query of its own. That was already the design of the Worktrees tab's
 * `PR checks` column; the projects table is where the reasoning was copied from and had never been
 * applied. It removed eleven `gh` processes a minute on a real configuration, and `gh` is the most
 * expensive process this app starts. See `renderer/ui/presenters.ts` for the join and
 * `main/concurrency.ts` for why a process count is a latency budget here.
 *
 * What is left is the classification, which both readers of a rollup need and neither may re-invent:
 * two places deciding what "green" means would eventually disagree.
 */

/**
 * Turns check counts into a verdict.
 *
 * Exported so the pull request list reaches the same conclusion from the same numbers: two places
 * deciding what "green" means would eventually disagree.
 */
export function verdictFor(
  total: number,
  passed: number,
  failed: number,
  pending: number,
): ChecksVerdict {
  if (total === 0) {
    return 'no-checks';
  }
  if (failed > 0) {
    return 'failing';
  }
  if (pending > 0) {
    return 'pending';
  }
  return passed > 0 ? 'passing' : 'no-checks';
}

/**
 * Classifies one rollup entry.
 *
 * The rollup mixes two shapes: check runs carry `status` plus `conclusion`, while commit statuses
 * carry only `state`. Reading a single field would silently drop half the entries.
 */
export function classifyCheck(entry: unknown): 'passed' | 'failed' | 'pending' | 'ignored' {
  if (typeof entry !== 'object' || entry === null) {
    return 'ignored';
  }
  const record = entry as Record<string, unknown>;
  const raw = (
    (typeof record.conclusion === 'string' && record.conclusion.length > 0
      ? record.conclusion
      : undefined) ??
    (typeof record.state === 'string' ? record.state : undefined) ??
    (typeof record.status === 'string' ? record.status : '')
  ).toUpperCase();

  if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(raw)) {
    return 'passed';
  }
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(raw)) {
    return 'failed';
  }
  if (['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED'].includes(raw)) {
    return 'pending';
  }
  return 'ignored';
}
