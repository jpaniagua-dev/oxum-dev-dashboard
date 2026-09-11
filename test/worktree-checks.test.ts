import { describe, expect, it } from 'vitest';
import type { PullRequest } from '../src/shared/contracts.js';
import { presentBranchChecks } from '../src/renderer/ui/presenters.js';

/**
 * The checks column of the Worktrees tab AND of the projects table, which is a **join** and not a
 * query.
 *
 * Worth its own file because the interesting part is not the green/red mapping (that is
 * `presentPullChecks`, shared with the pull request tab) but the five ways of having no verdict. Each
 * of them is a different sentence and a different next move, and the failure they guard against is the
 * one this app keeps writing down: an absence reported as an answer. "This project does not follow
 * pull requests" flattened into "no PR" would tell somebody there is nothing open on a branch nobody
 * ever asked about.
 */

const pull = (branch: string, over: Partial<PullRequest> = {}): PullRequest => ({
  number: 42,
  title: 'Add the quarterly report export',
  url: 'https://github.com/example-org/web-app/pull/42',
  branch,
  authorLogin: 'dev',
  isDraft: false,
  review: 'none',
  checks: 'passing',
  passed: 7,
  failed: 0,
  pending: 0,
  isAuthor: true,
  isReviewer: false,
  updatedAt: '2026-09-04T08:00:00Z',
  ...over,
});

const repo = (
  pulls: PullRequest[],
  over: { checkedAt?: string | null; error?: string | null } = {},
): { pulls: PullRequest[]; checkedAt: string | null; error: string | null } => ({
  pulls,
  checkedAt: '2026-09-04T08:00:00Z',
  error: null,
  ...over,
});

describe('presentBranchChecks: the five silent states', () => {
  it('says a project is not followed rather than claiming it has no PR', () => {
    // The distinction the whole column rests on: nothing was ever asked about this repository, and it
    // is also the one state the user can fix, so the title has to say how.
    const pill = presentBranchChecks('PROJ-123-documents-list', true, null);
    expect(pill.label).toBe('not followed');
    expect(pill.tone).toBe('neutral');
    expect(pill.title).toMatch(/Follow pull requests/);
  });

  it('surfaces the repository error instead of an absence', () => {
    const pill = presentBranchChecks('any', true, repo([], { error: 'gh: not authenticated' }));
    expect(pill.label).toBe('?');
    expect(pill.title).toBe('gh: not authenticated');
  });

  it('reports a branch with no upstream as not pushed, and does so BEFORE looking', () => {
    // Order matters here. A branch that was never pushed cannot have a pull request, so if the lookup
    // ran first its miss would come back as `no PR`, which reads as an answer rather than as the
    // precondition it is. Same wording as the projects table's own column.
    const pill = presentBranchChecks('wip/dark-mode', false, repo([pull('wip/dark-mode')]));
    expect(pill.label).toBe('not pushed');
  });

  it('separates "not read yet" from "read, and there is nothing"', () => {
    expect(presentBranchChecks('x', true, repo([], { checkedAt: null })).label).toBe('…');
    expect(presentBranchChecks('x', true, repo([])).label).toBe('no PR');
  });

  it('says no PR for a branch that is pushed and has none open', () => {
    const pill = presentBranchChecks('PROJ-456-notes', true, repo([pull('other-branch')]));
    expect(pill.label).toBe('no PR');
    expect(pill.title).toBe('No open PR on this branch');
  });
});

/**
 * The sixth state, and the one the projects table brought with it when its `Checks` column stopped
 * being a `gh pr view` per project.
 *
 * A worktree row cannot exist before its git read, so the Worktrees tab only ever had five. A
 * project row comes from the configuration and its git state lands on the first poll, so there is a
 * moment where the upstream is genuinely unknown. Passing `false` there makes the column say
 * `not pushed` about a branch nothing has looked at, which is an absence reported as an answer: the
 * failure this whole file exists to guard.
 */
describe('presentBranchChecks: git not read yet', () => {
  it('says nothing yet rather than "not pushed"', () => {
    const pill = presentBranchChecks('main', null, {
      pulls: [],
      checkedAt: '2026-09-09T10:00:00.000Z',
      error: null,
    });
    expect(pill.label).toBe('\u2026');
    expect(pill.title).toMatch(/not been read/);
  });

  it('still reports a project that follows no pull requests, which is the earlier question', () => {
    // `not followed` comes first on purpose: it is the one state with a fix, and it is true whether
    // or not git has been read.
    expect(presentBranchChecks('main', null, null).label).toBe('not followed');
  });
});

describe('presentBranchChecks: the join itself', () => {
  it('matches the pull request on the head branch and reports its checks', () => {
    const pill = presentBranchChecks(
      'PROJ-789-fiscal-year',
      true,
      repo([pull('other'), pull('PROJ-789-fiscal-year', { checks: 'failing', failed: 2 })]),
    );
    expect(pill.label).toBe('KO 2');
    expect(pill.tone).toBe('error');
  });

  it('names WHICH pull request answered, several branches of one repo being on screen together', () => {
    const pill = presentBranchChecks(
      'PROJ-789-fiscal-year',
      true,
      repo([pull('PROJ-789-fiscal-year', { number: 128, title: 'Quarterly report export' })]),
    );
    expect(pill.title).toContain('#128 Quarterly report export');
    // The check counts stay in the tooltip too: the number says which PR, the count says what it did.
    expect(pill.title).toContain('check(s) green');
  });

  it('does not match on a prefix, which would hand a row its neighbour verdict', () => {
    // `PROJ-78` and `PROJ-789-fiscal-year` are the kind of pair this workspace actually produces, and
    // a `startsWith` would give the shorter branch the longer one's checks.
    const pill = presentBranchChecks('PROJ-78', true, repo([pull('PROJ-789-fiscal-year')]));
    expect(pill.label).toBe('no PR');
  });

  it('reaches no PR for a detached worktree without a special case', () => {
    // `detached@<sha>` is not a branch name, so it matches nothing and the generic miss is already the
    // right answer. Pinned so nobody adds a branch for it later.
    const pill = presentBranchChecks('detached@a1b2c3d', true, repo([pull('main')]));
    expect(pill.label).toBe('no PR');
  });

  it('keeps no-checks distinct from passing, like every other checks column in this app', () => {
    const pill = presentBranchChecks(
      'b',
      true,
      repo([pull('b', { checks: 'no-checks', passed: 0 })]),
    );
    expect(pill.label).toBe('no checks');
    expect(pill.tone).not.toBe('ok');
  });
});
