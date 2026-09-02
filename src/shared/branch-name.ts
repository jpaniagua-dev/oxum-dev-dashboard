/**
 * The branch name a ticket gets.
 *
 * Pure and in `shared/` because both sides need the same answer: the main process creates the branch,
 * and the Jira tab's menu **names it before creating it**, which is the rule every write in this app
 * follows (a control that did not say what it was about to do is one whose consequences you discover
 * afterwards). Two implementations would let the menu promise a name the checkout does not use.
 *
 * The shape, `TEC-1482-migrate-to-angular-22`, is not invented here: it is the convention the team
 * already writes by hand, and it is what the shell helper this replaces produced. Keeping it means a
 * branch created from the dashboard is indistinguishable from one created in a terminal, which is the
 * only version of "native" worth having.
 */

/**
 * Longest slug kept after the key, in characters.
 *
 * A Jira summary is a sentence, and a branch name is typed, completed and read in a `git log`. Forty
 * characters holds six or seven words, which is enough to tell two branches of one sprint apart; past
 * that the tail is never read and the name stops fitting the Git tab's column.
 */
export const MAX_SLUG_LENGTH = 40;

/**
 * Turns a ticket key and its summary into a branch name.
 *
 * The key is **uppercased** and the slug **lowercased**, which is the convention as written and also
 * the one thing that keeps the name stable: Jira returns the key in whatever case the caller asked
 * with, and a branch differing only by case is a different branch on Linux and the same one on
 * Windows, which is the worst of both.
 *
 * Everything that is not a letter or a digit becomes a single hyphen, and leading and trailing
 * hyphens go. That is deliberately stricter than git's own rules: the point is not to produce a name
 * git accepts (`git check-ref-format` is still the gate, in `createBranch`), it is to produce a name a
 * person can retype. A summary made of nothing but punctuation therefore yields the bare key, which is
 * a usable branch name rather than one ending in a dangling hyphen.
 */
export function branchNameFor(key: string, summary: string): string {
  const prefix = key.trim().toUpperCase();
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    // Sliced before this trim, so a cut landing on a separator does not leave the hyphen behind.
    .replace(/-+$/g, '');

  return slug.length > 0 ? `${prefix}-${slug}` : prefix;
}
