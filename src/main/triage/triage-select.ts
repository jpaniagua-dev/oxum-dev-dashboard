import type { TriageSkips } from '@shared/contracts.js';
import type { SprintIssue } from '../jira/jira-service.js';

/**
 * Which of a sprint's tickets a run is actually given, and what it leaves behind.
 *
 * Pure and on its own, away from the service, for two reasons. The service cannot be imported by a
 * test (it reaches `triage.json` through Electron's user data path), and this is the one place where
 * a mistake is silent: a filter that drops too much produces a short list, which looks exactly like a
 * short sprint. Hence the counts coming back alongside the selection rather than a bare array.
 *
 * Two subtractive rules, and the order between them is the contract:
 *
 * 1. **In progress is skipped**, always, in both modes. Triage answers "what can be started", and a
 *    ticket somebody is already on has had that question answered by the fact of being started.
 *    Read from the `statusCategory`, never from the status name: "In review" and "Développement" are
 *    the same stage under two words.
 * 2. **Already analysed is skipped**, and only when the caller passes keys. A ticket matching both is
 *    counted under the first, which is what keeps the two modes' `inProgress` counts comparable.
 *
 * `done` is deliberately **not** skipped here. It is a stage the sprint search already excludes, and
 * a second authority on the same question is how the two would drift.
 *
 * Two stacked subtractive rules is exactly the shape that killed the `mine` scope in 5.8.1: the
 * selection came back empty for a reason that read like a bug. The counts are the answer, and they
 * are why every caller gets them whether it wants them or not.
 *
 * @param issues Everything the sprint holds.
 * @param alreadyAnalysed Upper-cased keys a stored verdict already covers. Empty for a full run,
 *   which is a real value and not a missing one: a full run is given everything rule 1 leaves.
 */
export function selectIssues(
  issues: readonly SprintIssue[],
  alreadyAnalysed: ReadonlySet<string> = new Set(),
): { analysed: SprintIssue[]; skipped: TriageSkips } {
  const analysed: SprintIssue[] = [];
  let inProgress = 0;
  let known = 0;

  for (const issue of issues) {
    if (issue.stage === 'in-progress') {
      inProgress += 1;
      continue;
    }
    if (alreadyAnalysed.has(issue.key.toUpperCase())) {
      known += 1;
      continue;
    }
    analysed.push(issue);
  }

  return { analysed, skipped: { inProgress, alreadyAnalysed: known } };
}
