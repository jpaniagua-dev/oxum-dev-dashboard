import type { TriageSkips } from '@shared/contracts.js';
import type { SprintIssue } from '../jira/jira-service.js';

/**
 * Which of a sprint's tickets a run is actually given, and what it leaves behind.
 *
 * Pure and on its own, away from the service, for two reasons. The service cannot be imported by a
 * test (it reaches `triage.json` through Electron's user data path), and this is the one place where
 * a mistake is silent: a filter that drops too much produces a short list, which looks exactly like a
 * short sprint. Hence the count coming back alongside the selection rather than a bare array.
 *
 * One rule is left, and it is subtractive: **in progress is skipped**. Triage answers "what can be
 * started", and a ticket somebody is already on has had that question answered by the fact of being
 * started. Paying a model to classify it produces a verdict nobody will act on, and it pushes the
 * tickets that matter further down a list capped by what a strip can show. Read from the
 * `statusCategory`, never from the status name: "In review" and "Développement" are the same stage
 * under two words.
 *
 * `done` is deliberately **not** skipped here. It is a stage the sprint search already excludes, and
 * a second authority on the same question is how the two would drift.
 *
 * A second rule stood beside it until 5.8.1, a `mine` scope keeping only what was assigned to the
 * token's account. It was removed on request, and the function keeps its shape: the selection is
 * still a value with its own counts, which is what a narrowing rule needs, so putting one back is a
 * branch here rather than a change of contract.
 */
export function selectIssues(
  issues: readonly SprintIssue[],
): { analysed: SprintIssue[]; skipped: TriageSkips } {
  const analysed: SprintIssue[] = [];
  let inProgress = 0;

  for (const issue of issues) {
    if (issue.stage === 'in-progress') {
      inProgress += 1;
      continue;
    }
    analysed.push(issue);
  }

  return { analysed, skipped: { inProgress } };
}
