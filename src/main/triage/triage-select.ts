import type { TriageScope, TriageSkips } from '@shared/contracts.js';
import type { SprintIssue } from '../jira/jira-service.js';

/**
 * Which of a sprint's tickets a run is actually given, and what it leaves behind.
 *
 * Pure and on its own, away from the service, for two reasons. The service cannot be imported by a
 * test (it reaches `triage.json` through Electron's user data path), and this is the one place where
 * a mistake is silent: a filter that drops too much produces a short list, which looks exactly like a
 * short sprint. Hence the counts coming back alongside the selection rather than a bare array.
 *
 * Two rules, both of them subtractive:
 *
 * - **In progress is skipped, always.** Triage answers "what can be started", and a ticket somebody
 *   is already on has had that question answered by the fact of being started. Paying a model to
 *   classify it produces a verdict nobody will act on, and it pushes the tickets that matter further
 *   down a list capped by what a strip can show. Read from the `statusCategory`, never from the
 *   status name: "In review" and "Développement" are the same stage under two words.
 * - **`mine` keeps what is assigned to the token's account.** Unassigned tickets go too, which is
 *   deliberate: "mine" is a statement about who holds the ticket, and nobody holds an unassigned one.
 *   Matched on the account id rather than on a display name or an email, the only identity Jira does
 *   not hide behind a privacy setting.
 *
 * `done` is deliberately **not** skipped here. It is a stage the sprint search already excludes, and
 * a second authority on the same question is how the two would drift.
 */
export function selectIssues(
  issues: readonly SprintIssue[],
  scope: TriageScope,
  myAccountId: string,
): { analysed: SprintIssue[]; skipped: TriageSkips } {
  const analysed: SprintIssue[] = [];
  let inProgress = 0;
  let notMine = 0;

  for (const issue of issues) {
    if (issue.stage === 'in-progress') {
      inProgress += 1;
      continue;
    }
    if (scope === 'mine' && (myAccountId.length === 0 || issue.accountId !== myAccountId)) {
      notMine += 1;
      continue;
    }
    analysed.push(issue);
  }

  return { analysed, skipped: { inProgress, notMine } };
}
