import type {
  ChecksState,
  GitBranch,
  GitChange,
  GitState,
  PrReview,
  PullRequest,
  ServerState,
  WorkflowsState,
} from '@shared/contracts.js';
import { hasWorktreeChange, isStaged } from '@shared/git-changes.js';

/**
 * Turns domain state into what the table shows.
 *
 * Kept as pure functions, separate from the DOM, because the interesting decisions live here: which
 * states deserve to look alarming, and which distinctions must not be flattened. They are unit
 * tested for that reason.
 */

export type PillTone = 'neutral' | 'ok' | 'busy' | 'error' | 'info';

export interface Pill {
  readonly label: string;
  readonly tone: PillTone;
  readonly title: string;
}

/** Label and tone for a project's dev process. */
export function presentServer(server: ServerState): Pill {
  switch (server.phase) {
    case 'stopped':
      return { label: 'stopped', tone: 'neutral', title: 'No process' };
    case 'starting':
      return { label: 'starting', tone: 'busy', title: 'Process launched, waiting for output' };
    case 'linting':
      // Visible on purpose: the `start` scripts lint before serving, so this window is normal and
      // must not look like a failure.
      return { label: 'lint', tone: 'busy', title: 'Lint step, before the build' };
    case 'building':
      return { label: 'build', tone: 'busy', title: 'Compiling' };
    case 'serving':
      return {
        label: server.port === null ? 'serving' : `serving :${server.port}`,
        tone: 'ok',
        title: 'Dev server up',
      };
    case 'watching':
      return {
        label: 'watch',
        tone: 'ok',
        // No port to show, and saying "serving" would promise something observable that does not exist.
        title: 'Watch build, no HTTP server',
      };
    case 'lint-error':
      return { label: 'lint failed', tone: 'error', title: server.errorSummary ?? 'Lint error' };
    case 'build-error':
      return {
        label: server.errorCount > 1 ? `build failed (${server.errorCount})` : 'build failed',
        tone: 'error',
        title: server.errorSummary ?? 'Build error',
      };
    case 'crashed':
      return { label: 'crashed', tone: 'error', title: 'The process exited on its own' };
  }
}

/**
 * True when the dashboard is allowed to stop this process.
 *
 * Unchanged, and deliberately so: while a process of ours is alive the button is `Stop`, so a server
 * can be ended at any moment. It is also the only condition in the row, since its counterpart
 * disappeared — there used to be a `canStart` deciding whether `Run` was allowed to fire, back when
 * the dashboard probed ports to spot servers started elsewhere. That probe is gone, `Run` is a restart
 * (the main process stops what is running first), and a button that refuses to run has no case left.
 */
export function canStop(server: ServerState): boolean {
  return server.owned && server.phase !== 'stopped' && server.phase !== 'crashed';
}

/**
 * Label and tone for a pull request's review state.
 *
 * `none` gets a neutral pill rather than a green one: `gh` reports an empty `reviewDecision` when the
 * repository requires no review at all, and showing that as approved would claim something nobody said.
 */
export function presentReview(review: PrReview): Pill {
  switch (review) {
    case 'approved':
      return { label: 'approved', tone: 'ok', title: 'At least one approval, nothing to change' };
    case 'changes-requested':
      return {
        label: 'changes requested',
        tone: 'error',
        title: 'A reviewer requested changes',
      };
    case 'review-required':
      return { label: 'review requested', tone: 'busy', title: 'Waiting for review' };
    case 'none':
      return { label: 'no review', tone: 'neutral', title: 'No review required' };
  }
}

/**
 * Label and tone for a pull request's checks.
 *
 * Same vocabulary as the project rows, on purpose: `OK n` / `KO n` / `en cours n`, and `aucun check`
 * kept distinct from green.
 */
export function presentPullChecks(pull: PullRequest): Pill {
  switch (pull.checks) {
    case 'passing':
      return { label: `OK ${pull.passed}`, tone: 'ok', title: `${pull.passed} check(s) green` };
    case 'failing':
      return { label: `KO ${pull.failed}`, tone: 'error', title: `${pull.failed} check(s) failing` };
    case 'pending':
      return {
        label: `running ${pull.pending}`,
        tone: 'busy',
        title: `${pull.pending} check(s) running`,
      };
    case 'no-checks':
      return { label: 'no checks', tone: 'info', title: 'No check reported' };
    case 'no-pr':
    case 'unknown':
      return { label: '?', tone: 'neutral', title: 'Unknown check state' };
  }
}

/**
 * Why a pull request concerns the user, or nothing when it does not.
 *
 * Author and reviewer are separate flags in the payload, so the badge can say which it is instead of a
 * flat "mine" that hides whether the ball is in your court.
 */
export function presentInvolvement(pull: PullRequest): Pill | null {
  if (pull.isAuthor && pull.isReviewer) {
    return { label: 'mine', tone: 'info', title: 'You are the author and a requested reviewer' };
  }
  if (pull.isAuthor) {
    return { label: 'auteur', tone: 'neutral', title: 'You are the author' };
  }
  if (pull.isReviewer) {
    return { label: 'review requested', tone: 'busy', title: 'Your review is requested' };
  }
  return null;
}

/**
 * What a worktree can be told about its branch's pull request, without asking GitHub again.
 *
 * The Worktrees tab wanted the projects table's `Checks` column, and the obvious way to build it was
 * `readChecksState(worktree.path, ...)`: that function runs `gh pr view` in a folder and reads the
 * pull request of whatever branch is checked out there, which is exactly the question, and a worktree
 * is exactly a folder with its own branch. It is refused on cost. `gh --version` alone measures 79 ms
 * on this machine (see the performance section of `CLAUDE.md`), a `gh pr view` is that plus a network
 * round trip, and this would be one per worktree on every poll. Meanwhile `gh pr list` already runs
 * once per followed repository and already returns `headRefName` and `statusCheckRollup` for every
 * open pull request, so the answer is in a payload the app has in hand. The join costs a `find`.
 *
 * Which is why this takes a **branch** and a repository's pulls rather than a worktree: what it does
 * is match a branch name against a list, and giving it the whole row would hide that.
 *
 * The five silent states are all distinct, and flattening any of them would be a lie of the kind
 * `no-checks` already exists to avoid:
 *
 * - **`repo === null`**: this project does not follow pull requests, so nothing was ever asked. NOT
 *   `no PR`, which claims a question was answered. This is the one state with a fix, and the title
 *   names it.
 * - **`repo.error`**: `gh` failed or is unauthenticated. Shown as unknown with the reason, never as an
 *   absence.
 * - **`repo.checkedAt === null`**: followed, not read yet. The first paint after opening the app.
 * - **`hasUpstream === false`**: never pushed, so no pull request can exist. Same wording and same
 *   reasoning as `presentChecks`, and cheaper than any lookup.
 * - **no match**: pushed, read, and no open pull request on this branch. The only one that is
 *   genuinely `no PR`.
 *
 * A **detached** worktree is `no PR` by the same route as any other miss: `detached@<sha>` is not a
 * branch name, so it matches nothing, and no special case is needed to reach the right answer.
 *
 * Only OPEN pull requests are listed, so a merged branch whose worktree is still around reads `no PR`.
 * That is the correct answer to "is anything waiting on this branch" and it is worth knowing that it
 * is not the same sentence as "this was never reviewed".
 */
export function presentWorktreeChecks(
  branch: string,
  hasUpstream: boolean,
  repo: {
    readonly pulls: readonly PullRequest[];
    readonly checkedAt: string | null;
    readonly error: string | null;
  } | null,
): Pill {
  if (repo === null) {
    return {
      label: 'not followed',
      tone: 'neutral',
      title:
        'This project does not follow pull requests. Tick "Follow pull requests" on it in the settings.',
    };
  }
  if (repo.error !== null) {
    return { label: '?', tone: 'neutral', title: repo.error };
  }
  if (!hasUpstream) {
    // Before the lookup rather than after: a branch with no upstream cannot have a pull request, so a
    // miss here would be reported as `no PR` and read as an answer instead of a precondition.
    return { label: 'not pushed', tone: 'neutral', title: 'The branch has no upstream' };
  }
  if (repo.checkedAt === null) {
    return { label: '…', tone: 'neutral', title: 'Not queried yet' };
  }

  const pull = repo.pulls.find((candidate) => candidate.branch === branch);
  if (pull === undefined) {
    return { label: 'no PR', tone: 'neutral', title: 'No open PR on this branch' };
  }
  return {
    ...presentPullChecks(pull),
    // The pill's own title says how many checks are in which state; the number and the heading are
    // what tell you WHICH pull request answered, on a tab where several branches of one repository
    // are on screen together.
    title: `#${pull.number} ${pull.title}
${presentPullChecks(pull).title}`,
  };
}

/** Label and tone for the checks column. */
export function presentChecks(checks: ChecksState | null, git: GitState | null): Pill {
  if (git !== null && !git.hasUpstream) {
    // Not an error: the branch was never pushed, so no pull request can exist.
    return { label: 'not pushed', tone: 'neutral', title: 'The branch has no upstream' };
  }
  if (checks === null) {
    return { label: '…', tone: 'neutral', title: 'Not queried yet' };
  }

  switch (checks.verdict) {
    case 'no-pr':
      return { label: 'no PR', tone: 'neutral', title: 'No PR for this branch' };
    case 'no-checks':
      // Deliberately distinct from `passing`: two real open PRs returned an empty rollup, and
      // painting that green would be a lie.
      return {
        label: 'no checks',
        tone: 'info',
        title: 'PR open, but no check reported',
      };
    case 'pending':
      return {
        label: `running ${checks.pending}`,
        tone: 'busy',
        title: `${checks.pending} check(s) running`,
      };
    case 'passing':
      return {
        label: `OK ${checks.passed}`,
        tone: 'ok',
        title: `${checks.passed} check(s) green`,
      };
    case 'failing':
      return {
        label: `KO ${checks.failed}`,
        tone: 'error',
        title: `${checks.failed} check(s) failing`,
      };
    case 'unknown':
      return { label: '?', tone: 'neutral', title: checks.error ?? 'Unknown state' };
  }
}

/**
 * Label and tone for the workflows column.
 *
 * It says *that* something runs, never *what*: the column exists to be read from across the table
 * while working in the terminal below, and a workflow name would need room the strip does not have.
 * Whoever wants the name has the repository one click away. The counts go in the tooltip, which is
 * where a number has room to be explained.
 *
 * Running and queued are shown as one figure, because they are one answer — CI is busy on this
 * project — and split again in the tooltip, because "3 queued, none started" is a different morning
 * from "3 running" for anyone waiting on the result.
 */
export function presentWorkflows(workflows: WorkflowsState | null): Pill {
  if (workflows === null) {
    return { label: '…', tone: 'neutral', title: 'Not queried yet' };
  }

  switch (workflows.verdict) {
    case 'running':
      return {
        label: `running ${workflows.running + workflows.queued}`,
        tone: 'busy',
        title: `${workflows.running} run(s) in progress, ${workflows.queued} queued`,
      };
    case 'idle':
      return { label: 'idle', tone: 'neutral', title: 'No workflow run in flight' };
    case 'no-runs':
      // Distinct from `idle` on purpose: this repository has never run a workflow, so there is no
      // pipeline to be idle. Same reason `no-checks` is not `passing`.
      return { label: 'no runs', tone: 'neutral', title: 'No workflow run in this repository' };
    case 'no-repo':
      return { label: 'no remote', tone: 'neutral', title: 'No GitHub remote to query' };
    case 'unknown':
      return { label: '?', tone: 'neutral', title: workflows.error ?? 'Unknown state' };
  }
}

export interface GitSummary {
  readonly parts: { label: string; kind: 'dirty' | 'clean' | 'plain' }[];
  /** Short warning shown next to the branch, when the branch needs attention. */
  readonly warning: string | null;
}

/**
 * Summarises the working tree and the branch position.
 *
 * `ahead`/`behind` earn a place next to the file counts: a repository can be perfectly clean and
 * still be twelve commits behind, which a "files" column alone would report as nothing to do.
 */
export function presentGit(git: GitState | null): GitSummary {
  if (git === null) {
    return { parts: [{ label: '…', kind: 'plain' }], warning: null };
  }
  if (git.error !== null) {
    return { parts: [{ label: 'git error', kind: 'dirty' }], warning: null };
  }

  const parts: GitSummary['parts'] = [];
  if (git.staged > 0) {
    parts.push({ label: `${git.staged} staged`, kind: 'dirty' });
  }
  if (git.modified > 0) {
    parts.push({ label: `${git.modified} modified`, kind: 'dirty' });
  }
  if (git.untracked > 0) {
    parts.push({ label: `${git.untracked} untracked`, kind: 'dirty' });
  }
  if (parts.length === 0) {
    parts.push({ label: 'clean', kind: 'clean' });
  }

  const flags: string[] = [];
  if (git.ahead > 0) {
    flags.push(`↑${git.ahead}`);
  }
  if (git.behind > 0) {
    flags.push(`↓${git.behind}`);
  }

  return { parts, warning: flags.length > 0 ? flags.join(' ') : null };
}

/* ------------------------------------------------------------------ *
 * Git tab
 * ------------------------------------------------------------------ */

/**
 * Turns a file's two status columns into a label and a tone.
 *
 * The letters are shown **as git prints them** rather than translated into French words. They are two
 * characters wide whatever the state, so the list stays aligned, and anyone who has run `git status`
 * already reads them; the long form goes in the tooltip, which is where a word has room to be a word.
 *
 * The tone deliberately follows the *worktree* column when the two disagree. `MM` means staged, then
 * edited again: painting it as "staged" would suggest the commit will contain what is on disk, which
 * is exactly the thing that is not true.
 */
export function presentChange(change: GitChange): Pill {
  const label = `${normalizeColumn(change.index)}${normalizeColumn(change.worktree)}`;

  if (change.untracked) {
    return { label: '??', tone: 'info', title: 'New file, not tracked by git yet' };
  }
  if (change.index === 'U' || change.worktree === 'U' || label === 'AA' || label === 'DD') {
    // Conflicts are the one state this tab cannot resolve, so they are painted as an error rather
    // than hidden among the modifications.
    return { label, tone: 'error', title: 'Conflict to resolve, in a terminal' };
  }

  const staged = isStaged(change);
  const dirty = hasWorktreeChange(change);
  const source = change.from === null ? '' : ` (depuis ${change.from})`;

  if (staged && dirty) {
    return {
      label,
      tone: 'busy',
      title: `Staged then modified again: the commit will only take the staged version${source}`,
    };
  }
  if (staged) {
    return { label, tone: 'ok', title: `Ready to commit${source}` };
  }
  return { label, tone: 'neutral', title: `Modified, not staged yet${source}` };
}

/**
 * How far a branch stands from its upstream, in the shortest readable form.
 *
 * Empty when there is nothing to say, so the caller can skip the element entirely: a badge reading
 * "up to date" on every line of a list is noise that hides the two lines that are not.
 */
export function presentTrack(branch: GitBranch): string {
  if (branch.upstream === null) {
    return 'locale';
  }
  if (branch.gone) {
    return 'upstream gone';
  }
  const marks: string[] = [];
  if (branch.ahead > 0) {
    marks.push(`↑${branch.ahead}`);
  }
  if (branch.behind > 0) {
    marks.push(`↓${branch.behind}`);
  }
  return marks.join(' ');
}

/**
 * A space for git's own space.
 *
 * git prints a space for "nothing here", which is invisible in HTML and collapses the two-character
 * column to one. A middle dot keeps the width without pretending a letter is there.
 */
function normalizeColumn(column: string): string {
  return column === ' ' || column.length === 0 ? '·' : column;
}
