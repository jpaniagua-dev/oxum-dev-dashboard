import type {
  GitChange,
  GitCommit,
  GitMergeMode,
  GitRef,
  GitRemoteTags,
  GitRepoState,
  GitState,
  PrReview,
  PullRequest,
  PullReviewRun,
  PullVerdict,
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
 * Label and tone for what the review concluded.
 *
 * Only `request-changes` wears an error tone, because it is the only one that stops a merge, and the
 * tone has to mean the same thing here as it does two pills to the left. `unclear` is `busy` rather
 * than `error`: nothing is wrong with the pull request, the run simply could not answer, and
 * colouring it red would send the reader looking for a problem in the wrong place.
 */
export function presentPullVerdict(verdict: PullVerdict, current: boolean): Pill {
  const stale = current
    ? ''
    : '\nThe head has moved since: review it again before acting on this.';
  switch (verdict) {
    case 'approve':
      return { label: 'clean', tone: current ? 'ok' : 'neutral', title: `The review found nothing${stale}` };
    case 'comment':
      return {
        label: 'remarks',
        tone: current ? 'info' : 'neutral',
        title: `The review has remarks, none of them blocking${stale}`,
      };
    case 'request-changes':
      return {
        label: 'blocking',
        tone: current ? 'error' : 'neutral',
        title: `The review found something that should not merge as it stands${stale}`,
      };
    case 'unclear':
      return {
        label: 'unclear',
        tone: 'busy',
        title: `The review could not reach a verdict${stale}`,
      };
  }
}

/**
 * What a run over one repository left out, in the fewest words that stay true.
 *
 * Empty when it left nothing out, because a line reading "0 skipped" is a line the eye reads every
 * time to learn nothing. It is the only place the reader is told the list is partial, which is the
 * same job `describeCoverage` does for the Triage tab and the same failure it guards against: a
 * shortened list and a quiet week look identical.
 */
export function describeReviewCoverage(run: PullReviewRun | undefined): string {
  if (run === undefined) {
    return '';
  }
  const parts: string[] = [];
  const add = (count: number, word: string): void => {
    if (count > 0) {
      parts.push(`${count} ${word}`);
    }
  };
  add(run.skipped.alreadyReviewed, 'already reviewed');
  add(run.skipped.draft, 'draft');
  add(run.skipped.bot, 'from a bot');
  add(run.skipped.blocked, 'already blocked');
  add(run.skipped.tooLarge, 'too large');
  add(run.skipped.overLimit, 'over the cap');
  return parts.length === 0 ? '' : `${parts.join(' · ')} skipped`;
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
 * What a branch can be told about its pull request, without asking GitHub again.
 *
 * **Two columns, one function**: the Worktrees tab's `PR checks` and the projects table's `Checks`.
 * The second had its own `presentChecks` until 2026-09-09, fed by exactly the `gh pr view` per
 * project that the paragraph below refuses. The argument had been written for the tab that copied
 * the column and never applied to the column it was copied from; applying it removed eleven `gh`
 * processes a minute on a real configuration. The cost of that is stated at the end of this comment.
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
 *
 * **What the projects table gave up to stop querying.** Its column now trails the pulls poll
 * (`pullsPollSeconds`, 180 s by default) instead of the checks poll (60 s), and a project with
 * `followPulls` off reads `not followed` where it used to carry a verdict. Both are visible and both
 * are named on screen, which is the whole reason the five states below are five and not three: a
 * column that says which question was not asked is worth more than a fresh column that costs a
 * frozen terminal every few seconds.
 */
export function presentBranchChecks(
  branch: string,
  /**
   * Whether the branch has an upstream, or **null when git has not been read yet**.
   *
   * The third state is not decoration. In the Worktrees tab a row cannot exist before its git read,
   * so a boolean was enough; in the projects table the rows arrive from the configuration and their
   * git state lands on the first poll, so there is a moment where the answer is unknown. Collapsing
   * that into `false` makes the column say `not pushed` about a branch nothing has looked at, which
   * is the exact failure the five states below exist to avoid: stating an answer where the honest
   * report is that the question has not been asked.
   */
  hasUpstream: boolean | null,
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
  if (hasUpstream === null) {
    return { label: '…', tone: 'neutral', title: 'The working tree has not been read yet' };
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
  const source = change.from === null ? '' : ` (from ${change.from})`;

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
export function presentTrack(branch: GitRef): string {
  if (branch.upstream === null) {
    return 'local';
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
 * A label hung on a commit of the graph.
 *
 * A local branch and its remote-tracking twin on the **same commit** are one chip, not two: `main`
 * and `origin/main` side by side on every synced commit would double the labels for no information,
 * whereas "this branch is pushed and up to date" is exactly what one chip with a remote mark says.
 * Once they diverge, they sit on different commits and get a chip each.
 */
export interface RefChip {
  /** `main`, `origin/feat` for a remote branch with no local twin here, `v1.2.0`, or `HEAD`. */
  readonly label: string;
  readonly kind: 'branch' | 'tag' | 'head';
  /** The local branch, when there is one on this commit. */
  readonly local: GitRef | null;
  /** The remote-tracking branches of the same name on this commit, or the remote branch itself. */
  readonly remotes: readonly GitRef[];
  readonly tag: GitRef | null;
  /** The branch checked out, which is the one drawn as the anchor of the working tree. */
  readonly current: boolean;
}

/**
 * Groups the repository's refs into chips, per commit sha.
 *
 * Order within a commit: the checked-out branch, the other local branches, the remote-only ones,
 * then tags. A detached HEAD gets a chip of its own, there being no branch to say where it stands.
 */
export function refChipsBySha(
  refs: readonly GitRef[],
  headSha: string | null,
): Map<string, RefChip[]> {
  const bySha = new Map<string, GitRef[]>();
  for (const ref of refs) {
    bySha.set(ref.sha, [...(bySha.get(ref.sha) ?? []), ref]);
  }

  const chips = new Map<string, RefChip[]>();
  for (const [sha, list] of bySha) {
    const locals = list.filter((ref) => ref.kind === 'local');
    const remotes = list.filter((ref) => ref.kind === 'remote');
    const twinned = new Set<GitRef>();
    const branchChips = locals.map((local): RefChip => {
      const twins = remotes.filter((remote) => remoteBranchName(remote) === local.name);
      twins.forEach((twin) => twinned.add(twin));
      return {
        label: local.name,
        kind: 'branch',
        local,
        remotes: twins,
        tag: null,
        current: local.current,
      };
    });
    const remoteChips = remotes
      .filter((remote) => !twinned.has(remote))
      .map(
        (remote): RefChip => ({
          label: remote.name,
          kind: 'branch',
          local: null,
          remotes: [remote],
          tag: null,
          current: false,
        }),
      );
    const tagChips = list
      .filter((ref) => ref.kind === 'tag')
      .map(
        (tag): RefChip => ({
          label: tag.name,
          kind: 'tag',
          local: null,
          remotes: [],
          tag,
          current: false,
        }),
      );
    branchChips.sort((left, right) => Number(right.current) - Number(left.current));
    chips.set(sha, [...branchChips, ...remoteChips, ...tagChips]);
  }

  const detached = headSha !== null && !refs.some((ref) => ref.current);
  if (detached) {
    const head: RefChip = {
      label: 'HEAD',
      kind: 'head',
      local: null,
      remotes: [],
      tag: null,
      current: true,
    };
    chips.set(headSha, [head, ...(chips.get(headSha) ?? [])]);
  }
  return chips;
}

/** `origin/feat/x` without its remote: the name a local branch tracking it would carry. */
export function remoteBranchName(remote: GitRef): string {
  const slash = remote.name.indexOf('/');
  return slash === -1 ? remote.name : remote.name.slice(slash + 1);
}

/** The remote a remote-tracking branch belongs to: `origin` for `origin/feat/x`. */
export function remoteOf(remote: GitRef): string {
  const slash = remote.name.indexOf('/');
  return slash === -1 ? remote.name : remote.name.slice(0, slash);
}

/** What the refs panel lists, section by section. */
export interface RefSections {
  /** Local branches, by name, so a branch is found where the alphabet says rather than by date. */
  readonly local: readonly GitRef[];
  /** Remote-tracking branches, grouped under their remote, each group sorted by name. */
  readonly remotes: readonly { readonly remote: string; readonly refs: readonly GitRef[] }[];
  /** Tags, newest first: the one being looked for is nearly always the last release. */
  readonly tags: readonly GitRef[];
}

export function refSections(refs: readonly GitRef[]): RefSections {
  const byName = (left: GitRef, right: GitRef): number => left.name.localeCompare(right.name);
  const remotes = new Map<string, GitRef[]>();
  for (const ref of refs) {
    if (ref.kind === 'remote') {
      const remote = remoteOf(ref);
      remotes.set(remote, [...(remotes.get(remote) ?? []), ref]);
    }
  }
  return {
    local: refs.filter((ref) => ref.kind === 'local').sort(byName),
    remotes: [...remotes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([remote, list]) => ({ remote, refs: [...list].sort(byName) })),
    tags: refs
      .filter((ref) => ref.kind === 'tag')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  };
}

/**
 * One or two letters standing for an author on a graph row.
 *
 * The first letter of the first and last words: `Sam Doe` is `SD`, `dependabot[bot]` is `D`. Upper
 * case so two rows by the same person always read the same, whatever case their git config uses.
 */
export function initialsOf(author: string): string {
  const words = author
    .replace(/\[bot\]$/i, '')
    .split(/[\s._-]+/)
    .filter((word) => word.length > 0);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase() || '?';
}

/**
 * Whether a commit is reachable from a remote-tracking branch, as far as the graph read shows.
 *
 * That is what "already pushed" means for a commit, whichever branch it was pushed with: a commit
 * other people can fetch is one rewriting would pull from under them. Walked over the parents the
 * graph already holds rather than asked of git, so the toolbar can disable its Undo with a reason
 * without a process; the main process asks git again at click time, this answer being only as fresh
 * as the last read.
 */
export function isPublished(
  sha: string,
  refs: readonly GitRef[],
  commits: readonly GitCommit[],
): boolean {
  return refs.some((ref) => ref.kind === 'remote' && isAncestor(sha, ref.sha, commits));
}

/**
 * Whether `ancestor` is reachable from `descendant` through the parents the graph holds.
 *
 * A commit counts as its own ancestor, which is git's own convention (`merge-base --is-ancestor A A`
 * succeeds). An answer of `false` can also mean "beyond what was read", which is why the merge menu
 * only uses it to offer something and never to refuse it: git decides at click time.
 */
export function isAncestor(
  ancestor: string,
  descendant: string,
  commits: readonly GitCommit[],
): boolean {
  const parents = new Map(commits.map((commit) => [commit.sha, commit.parents]));
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined || seen.has(next)) {
      continue;
    }
    if (next === ancestor) {
      return true;
    }
    seen.add(next);
    queue.push(...(parents.get(next) ?? []));
  }
  return false;
}

/** One entry of the menu a dropped branch opens, before it is bound to an action. */
export interface MergeOption {
  readonly label: string;
  readonly hint: string;
  readonly disabled: boolean;
  /** The merge to run, or null for an entry that only explains why there is nothing to do. */
  readonly mode: GitMergeMode | null;
}

/**
 * What dropping `source` on the current branch can do, worded for the menu.
 *
 * Read off the graph rather than asked of git, so the menu opens at once; the main process checks
 * again before running anything. Three situations:
 * - **already merged** (the source is an ancestor of HEAD): one disabled entry saying so, because a
 *   drop that silently does nothing reads as a gesture that did not work;
 * - **a fast-forward is possible** (HEAD is an ancestor of the source): `Fast-forward` first, the
 *   gesture that adds no commit, and a `--no-ff` merge for a branch whose history should stay visible;
 * - **diverged**: a merge, which will create a commit and may stop on a conflict, said so in the hint.
 */
export function mergeOptionsFor(repo: GitRepoState, source: GitRef): MergeOption[] {
  const target = repo.refs.find((ref) => ref.current);
  if (target === undefined || repo.headSha === null) {
    return [
      {
        label: 'Check out a branch first',
        hint: 'HEAD is detached: a merge commit would belong to no branch.',
        disabled: true,
        mode: null,
      },
    ];
  }
  if (repo.sequencer !== 'none') {
    return [
      {
        label: `Finish or abort the ${repo.sequencer} first`,
        hint: 'git refuses to start a merge while another operation is half-done.',
        disabled: true,
        mode: null,
      },
    ];
  }
  if (isAncestor(source.sha, repo.headSha, repo.commits)) {
    return [
      {
        label: `${source.name} is already in ${target.name}`,
        hint: 'Every commit of that branch is already reachable from HEAD: nothing to merge.',
        disabled: true,
        mode: null,
      },
    ];
  }
  if (isAncestor(repo.headSha, source.sha, repo.commits)) {
    return [
      {
        label: `Fast-forward ${target.name} to ${source.name}`,
        hint: `git merge --ff-only ${source.name}: ${target.name} moves forward, no commit is created.`,
        disabled: false,
        mode: 'ff-only',
      },
      {
        label: `Merge ${source.name} into ${target.name} (merge commit)`,
        hint: `git merge --no-ff ${source.name}: a merge commit even though a fast-forward was possible.`,
        disabled: false,
        mode: 'no-ff',
      },
    ];
  }
  return [
    {
      label: `Merge ${source.name} into ${target.name}`,
      hint: `git merge ${source.name}, in a terminal tab: creates a merge commit, and stops on a conflict if there is one.`,
      disabled: false,
      mode: 'merge',
    },
  ];
}

/**
 * Whether the remote has a tag: `true`, `false`, or `null` when that is not known.
 *
 * Unknown until a Fetch or a tag push has asked the remote, and unknown again when asking failed.
 * Kept apart from `false` on purpose, the rule the repository badges follow: a `local` badge drawn on
 * a tag nobody checked would send it to be pushed a second time.
 */
export function tagOnRemote(name: string, remote: GitRemoteTags | null): boolean | null {
  if (remote === null || remote.remote === null || remote.error !== null) {
    return null;
  }
  return remote.tags.includes(name);
}

/** Whether the Undo button can run, and what its tooltip says either way. */
export interface UndoState {
  readonly enabled: boolean;
  readonly reason: string;
}

/**
 * What undoing the last commit would do here, or why it cannot.
 *
 * Undo is `git reset --soft HEAD~1`: the commit goes, its changes come back staged, nothing on disk
 * moves. It is refused on the four commits where that is either impossible or harmful: the very first
 * one (no parent to go back to), a merge (its first parent is only one of the two histories it
 * joined), anything already pushed (it would rewrite a branch other people have), and any repository
 * where git has an operation half-done.
 */
export function undoStateFor(repo: GitRepoState): UndoState {
  if (repo.headSha === null) {
    return { enabled: false, reason: 'Nothing to undo: there is no commit yet' };
  }
  if (repo.sequencer !== 'none') {
    return { enabled: false, reason: `Finish or abort the ${repo.sequencer} first` };
  }
  const head = repo.commits.find((commit) => commit.sha === repo.headSha);
  if (head === undefined) {
    return { enabled: false, reason: 'HEAD is not in the graph that was read' };
  }
  if (head.parents.length === 0) {
    return { enabled: false, reason: 'The first commit of a repository has nothing to go back to' };
  }
  if (head.parents.length > 1) {
    return { enabled: false, reason: 'A merge cannot be undone here: use a terminal' };
  }
  if (isPublished(head.sha, repo.refs, repo.commits)) {
    return {
      enabled: false,
      reason: `${head.sha.slice(0, 7)} is already pushed: undoing it would rewrite a published branch`,
    };
  }
  return {
    enabled: true,
    reason: `Undo ${head.sha.slice(0, 7)} "${head.subject}": its changes go back to the index, nothing is lost`,
  };
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
