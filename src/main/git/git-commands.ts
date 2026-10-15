import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { VIEW_CONCURRENCY, allWithLimit } from '../concurrency.js';
import {
  GIT_GRAPH_LIMIT,
  type GitChange,
  type GitCommit,
  type GitCommitDetail,
  type GitDiff,
  type GitDiffTarget,
  type GitMergeMode,
  type GitRef,
  type GitRepoState,
  type GitResult,
  type GitSequencer,
  type GitSequencerOp,
  type GitStash,
  type GitStashOp,
  type GitSyncOp,
  type Project,
} from '@shared/contracts.js';
import {
  FIELD_SEPARATOR as SEP,
  parseCommitFilesZ,
  parseGraphLines,
  parseRefLines,
  parseStashLines,
  parseStatusZ,
  parseUnifiedDiff,
} from './git-parse.js';
import {
  GIT_NETWORK_TIMEOUT_MS,
  describeGitError,
  git,
  gitDiffOutput,
  tryGit,
} from './run-git.js';

/**
 * A hexadecimal sha and nothing else, abbreviated or full.
 *
 * The guard for every command that takes a revision rather than a path: those have no `--` to hide
 * a value starting with `-` behind, so the value itself has to be checked.
 */
const SHA_PATTERN = /^[0-9a-f]{4,40}$/i;

/* ------------------------------------------------------------------ reads */

/**
 * Everything the Git tab shows for one repository, in a single pass.
 *
 * **Five child processes, on worker threads, six allowed in flight.** It was seven fired at once on
 * the main thread, which blocked that thread for 486 ms: `uv_spawn` calls `CreateProcessW` on the
 * event loop thread of whoever calls it, and a stalled main process is a terminal that stops echoing
 * what is typed into it. It now measures 173 ms of wall time and 14 ms of worst main-loop lag.
 * Measured on 2026-09-09; see `main/concurrency.ts` and `main/spawn/spawn-pool.ts`.
 *
 * A concurrency limit alone would not have been enough, because it spreads the stalls out without
 * removing them. Two things had to happen: the spawns left the main thread, and two of the seven
 * calls turned out to be **redundant** and went rather than being spread out.
 *
 * - **`readUpstream`** asked `rev-list --left-right --count @{upstream}...HEAD` for the gap to the
 *   remote. `readBranches` already requests `%(upstream:track)`, which is git's own
 *   `[ahead 2, behind 1]` for **every** branch, so the answer for the current one was already in a
 *   payload this function held. A `gone` upstream is the one case where the two disagreed and it is
 *   handled explicitly below: `rev-list` fails on a deleted remote branch, so the old code reported
 *   no upstream, and `Push` has to keep offering `-u` there.
 * - **`readSequencer`'s `rev-parse`** became a `readFileSync` of `.git`. See {@link resolveGitDir}.
 *
 * A third call, **`readHead`**, was already lazy and stays so: it is only reached on a detached HEAD,
 * which `for-each-ref refs/heads` cannot name, so it is not part of the five.
 *
 * A failure of the whole thing degrades to a state carrying the message rather than throwing. The
 * folder may simply not be a repository, which is a normal row in this app, not an exception.
 */
export async function readRepoState(project: Project): Promise<GitRepoState> {
  const empty = {
    projectId: project.id,
    label: project.label,
    path: project.path,
    refs: [] as GitRef[],
    changes: [] as GitChange[],
    commits: [] as GitCommit[],
    stashes: [] as GitStash[],
    headMessage: '',
    sequencer: 'none' as GitSequencer,
  };

  try {
    const [refs, changes, commits, stashes, headMessage] = await allWithLimit(
      // `VIEW_CONCURRENCY` and not the poll's limit: this read answers a click as well as the poll,
      // and at four its five calls needed two waves, which measured 1068 ms against 173 ms. See the
      // table on that constant.
      VIEW_CONCURRENCY,
      () => readRefs(project.path),
      () => readChanges(project.path),
      () => readCommits(project.path),
      () => readStashes(project.path),
      () => readHeadMessage(project.path),
    );
    // No process of its own any more, so it is not in the pool: two stats and, in a worktree, a
    // sixty-byte read.
    const sequencer = readSequencer(project.path);

    const current = refs.find((ref) => ref.current);
    return {
      ...empty,
      headSha: current?.sha ?? findHeadSha(commits),
      refs,
      changes,
      commits,
      stashes,
      headMessage,
      sequencer,
      // The current branch comes from the branch list when there is one, and from HEAD otherwise:
      // a detached HEAD matches no entry in `refs/heads`, and reporting an empty name there would
      // make the tab look broken rather than detached.
      branch: current?.name ?? (await readHead(project.path)),
      ahead: current?.ahead ?? 0,
      behind: current?.behind ?? 0,
      // A `gone` upstream is configured but no longer exists on the remote, so pushing still needs
      // `-u`: reporting it as an upstream would offer a bare `git push` for a branch that has to be
      // republished. This is the one disagreement with the `rev-list` call that used to answer here,
      // and it is preserved deliberately rather than inherited.
      hasUpstream: current !== undefined && current.upstream !== null && !current.gone,
      checkedAt: new Date().toISOString(),
      error: null,
    };
  } catch (error) {
    return {
      ...empty,
      branch: '?',
      headSha: null,
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      checkedAt: null,
      error: describeGitError(error),
    };
  }
}

/**
 * Local branches, remote-tracking branches and tags, most recently touched first.
 *
 * One `for-each-ref` for the three namespaces rather than one per kind: the graph needs all of them
 * to hang labels on its commits, and `readRepoState` is at five processes in a pool of six.
 */
export async function readRefs(repoPath: string): Promise<GitRef[]> {
  const format = [
    '%(refname)',
    '%(HEAD)',
    '%(upstream:short)',
    '%(upstream:track)',
    '%(creatordate:iso-strict)',
    '%(objectname)',
    '%(*objectname)',
  ].join(SEP);
  // Sorted by git rather than by us: most recent first is exactly "the branches I have touched
  // lately", which is the order a branch list is actually searched in. `creatordate` and not
  // `committerdate`: an annotated tag is a tag object with no committer, and sorts by its tagging.
  const out = await git(repoPath, [
    'for-each-ref',
    '--sort=-creatordate',
    `--format=${format}`,
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ]);
  return parseRefLines(out);
}

/** Local branches only, for the callers that create or switch to one by name. */
export async function readBranches(repoPath: string): Promise<GitRef[]> {
  return (await readRefs(repoPath)).filter((ref) => ref.kind === 'local');
}

/** Changed files, staged and unstaged alike. */
export async function readChanges(repoPath: string): Promise<GitChange[]> {
  // `-z` for raw paths, `-uall` so a new folder lists its files instead of collapsing to `folder/`:
  // a single untracked entry that cannot be diffed or staged individually is not actionable.
  const out = await git(repoPath, ['status', '--porcelain', '-z', '-uall']);
  return parseStatusZ(out);
}

/**
 * The commit graph: every local branch, remote-tracking branch and tag, plus HEAD.
 *
 * - **`--topo-order`**, not the default date order: it guarantees every child comes before its
 *   parents and keeps a branch's commits together, which is what lets a lane run straight down
 *   instead of zig-zagging between two branches committed on the same afternoon.
 * - **`HEAD` is named explicitly** besides the namespaces: a detached HEAD belongs to none of them,
 *   and the commit being worked on is the last one that may go missing from the graph.
 * - **`%H` and `%P`, full shas**: the layout matches each parent against a sha it has seen, and an
 *   abbreviation is only unique as of the moment git printed it.
 *
 * A repository with no commit yet makes `git log` fail; that is a normal row here, read as an empty
 * graph rather than as an error.
 */
export async function readCommits(repoPath: string): Promise<GitCommit[]> {
  const format = ['%H', '%P', '%an', '%aI', '%D', '%s'].join(SEP);
  try {
    const out = await git(repoPath, [
      'log',
      '--topo-order',
      `-n${GIT_GRAPH_LIMIT}`,
      `--format=${format}`,
      '--branches',
      '--remotes',
      '--tags',
      'HEAD',
    ]);
    return parseGraphLines(out);
  } catch (error) {
    if (await hasNoCommit(repoPath)) {
      return [];
    }
    throw error;
  }
}

/** True in a freshly initialised repository, where HEAD names a branch with no commit yet. */
async function hasNoCommit(repoPath: string): Promise<boolean> {
  return !(await tryGit(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD'])).ok;
}

/**
 * The sha of HEAD, found among the commits already read.
 *
 * Only reached on a detached HEAD, which no branch names: `%D` then starts with a bare `HEAD`, and
 * with `HEAD -> ` on a branch. Exported for testing.
 */
export function findHeadSha(commits: readonly GitCommit[]): string | null {
  const head = commits.find((commit) =>
    commit.refs.split(', ').some((ref) => ref === 'HEAD' || ref.startsWith('HEAD -> ')),
  );
  return head?.sha ?? null;
}

/**
 * The full message and the files of one commit, for the detail panel.
 *
 * - **Files against the first parent** (`--diff-merges=first-parent`). By default `git show` prints
 *   no file at all for a merge, which reads as "this merge changed nothing"; `diff-tree -m` lists
 *   one diff per parent, and `diff-tree` **ignores** `--first-parent`, a revision-walk option: the
 *   merge then lists the files of both sides, verified on a real repository. The first parent is the
 *   branch the merge landed on, so its diff is what the merge brought in.
 * - **`git show` and not `diff-tree`** also covers the root commit, listed against the empty tree
 *   where `diff-tree` needs `--root` to say anything.
 * - The sha comes from our own graph and is validated anyway: there is no `--` to hide a value
 *   starting with `-` behind, the same reason `cherryPick` checks it.
 */
export async function readCommitDetail(repoPath: string, sha: string): Promise<GitCommitDetail> {
  if (!SHA_PATTERN.test(sha)) {
    return { sha, message: '', files: [], error: 'Not a commit' };
  }
  try {
    const [message, files] = await allWithLimit(
      VIEW_CONCURRENCY,
      () => git(repoPath, ['show', '-s', '--format=%B', sha]),
      () =>
        git(repoPath, [
          'show',
          '--format=',
          '-z',
          '--name-status',
          '--diff-merges=first-parent',
          sha,
        ]),
    );
    return { sha, message: message.trim(), files: parseCommitFilesZ(files), error: null };
  } catch (error) {
    return { sha, message: '', files: [], error: describeGitError(error) };
  }
}

/**
 * The stash entries.
 *
 * `%H` is asked for next to `%gd` because the ref is a **position**: `stash@{0}` names whatever is on
 * top right now, so every write resolves the sha back to a fresh ref instead of trusting the one this
 * read produced. Failure degrades to an empty list rather than throwing — a repository with no stash
 * ref at all (a fresh clone) is the normal case, not an error.
 */
export async function readStashes(repoPath: string): Promise<GitStash[]> {
  try {
    const format = ['%gd', '%H', '%cI', '%gs'].join(SEP);
    return parseStashLines(await git(repoPath, ['stash', 'list', `--format=${format}`]));
  } catch {
    return [];
  }
}

/**
 * The full message of the HEAD commit, for the amend form to pre-fill.
 *
 * `%B` is the raw body, subject and blank line and paragraphs included: an amend replaces the whole
 * message, so offering only the subject would silently drop the body of the commit being amended.
 * Failure degrades to an empty string, a repository with no commit yet being a normal row here.
 */
export async function readHeadMessage(repoPath: string): Promise<string> {
  try {
    return (await git(repoPath, ['log', '-1', '--format=%B'])).trim();
  } catch {
    return '';
  }
}

/**
 * Whether git has left an operation half-finished here.
 *
 * Read off the files git itself uses as its markers, in the real git directory rather than a guessed
 * `.git`: a worktree's `.git` is a *file* pointing elsewhere, so joining `.git/CHERRY_PICK_HEAD` onto
 * the repository path would answer "nothing in progress" for every worktree. `--git-path` asks git
 * where each marker would be, which is the only answer that is right in both layouts.
 *
 * Rebase is two directories because there are two rebase implementations (`--merge` and the
 * `format-patch` one) and they do not share a marker. Order matters when several exist: a rebase that
 * stopped on a conflicted cherry-pick has both, and naming the rebase is what leads to the command
 * that actually finishes it.
 */
export function readSequencer(repoPath: string): GitSequencer {
  try {
    const markers: readonly (readonly [GitSequencer, string])[] = [
      ['rebase', 'rebase-merge'],
      ['rebase', 'rebase-apply'],
      ['cherry-pick', 'CHERRY_PICK_HEAD'],
      ['revert', 'REVERT_HEAD'],
      ['merge', 'MERGE_HEAD'],
    ];
    const gitDir = resolveGitDir(repoPath);
    if (gitDir === null) {
      return 'none';
    }
    for (const [state, marker] of markers) {
      if (existsSync(join(gitDir, marker))) {
        return state;
      }
    }
    return 'none';
  } catch {
    return 'none';
  }
}

/**
 * Where this checkout's git directory is, read off the disk instead of asked of git.
 *
 * This used to be `git rev-parse --absolute-git-dir`, and the answer was right; what was wrong was
 * paying a child process for it. On this machine a spawn costs about 40 ms and roughly one in
 * thirteen blocks the main process for over 100 ms, against a `readFileSync` of sixty bytes here.
 * The read is synchronous like the marker probes just above it, and stays that way for the same
 * reason: a stat is microseconds, so moving these to promises would buy nothing and split one
 * question across two styles.
 *
 * Two layouts, and the second is the whole reason the git directory has to be resolved at all: in a
 * main checkout `.git` is the directory, while in a **linked worktree** it is a file holding
 * `gitdir: <path>` that points into the main repository's `worktrees/<name>`. That is where a
 * worktree's own sequencer markers live, so joining `.git/CHERRY_PICK_HEAD` onto the folder would
 * answer "nothing in progress" for every worktree.
 */
export function resolveGitDir(repoPath: string): string | null {
  const dotGit = join(repoPath, '.git');
  if (!existsSync(dotGit)) {
    return null;
  }
  if (statSync(dotGit).isDirectory()) {
    return dotGit;
  }
  return parseGitDirFile(readFileSync(dotGit, 'utf8'), repoPath);
}

/**
 * Reads the `gitdir: <path>` pointer a linked worktree's `.git` file carries.
 *
 * Pure and exported for testing. The path git writes there is absolute in practice, but the format
 * allows a relative one, so it is resolved against the checkout rather than trusted flat: a relative
 * pointer taken literally would be joined onto the process's working directory, which is somewhere
 * else entirely and would silently report `none` forever.
 */
export function parseGitDirFile(content: string, repoPath: string): string | null {
  const match = /^gitdir:\s*(.+)$/m.exec(content);
  const target = match?.[1]?.trim() ?? '';
  if (target.length === 0) {
    return null;
  }
  return isAbsolute(target) ? target : resolve(repoPath, target);
}

/**
 * Reads the diff the tab is asking for.
 *
 * The three cases are genuinely different commands, which is why the target is a union rather than
 * a set of optional flags:
 * - a **staged** file is `--cached`, the index against HEAD;
 * - an **untracked** file has no diff at all, so it is compared against `/dev/null` with
 *   `--no-index`, which is the only way to see the contents of a file git does not know yet;
 * - a **commit** is `git show`, its own message stripped so the column shows changes and not prose;
 * - a **stash** is `git stash show -p`, and it has to be: a stash entry is a merge commit, and
 *   `git show` prints *nothing at all* for a merge unless asked for a combined diff. Reusing the
 *   commit branch here would show an empty diff for every stash, which reads as "nothing stashed".
 */
export async function readDiff(repoPath: string, target: GitDiffTarget): Promise<GitDiff> {
  try {
    if (target.kind === 'stash') {
      const out = await gitDiffOutput(repoPath, ['stash', 'show', '-p', '--no-color', target.sha]);
      return buildDiff(target.ref, out);
    }

    // Both commit shapes compare against the first parent, for the reason `readCommitDetail` does:
    // `git show` prints nothing for a merge unless told which parent to diff against.
    if (target.kind === 'commit') {
      const out = await gitDiffOutput(repoPath, [
        'show',
        '--format=',
        '--no-color',
        '--diff-merges=first-parent',
        target.sha,
      ]);
      return buildDiff(target.sha, out);
    }

    if (target.kind === 'commit-file') {
      const out = await gitDiffOutput(repoPath, [
        'show',
        '--format=',
        '--no-color',
        '--diff-merges=first-parent',
        target.sha,
        '--',
        target.path,
      ]);
      return buildDiff(target.path, out);
    }

    if (target.staged) {
      const out = await gitDiffOutput(repoPath, [
        'diff',
        '--cached',
        '--no-color',
        '--',
        target.path,
      ]);
      return buildDiff(target.path, out);
    }

    const out = await gitDiffOutput(repoPath, ['diff', '--no-color', '--', target.path]);
    if (out.trim().length > 0) {
      return buildDiff(target.path, out);
    }
    // Empty means one of two things: nothing changed, or git has never heard of this file. Only the
    // second is worth another call, and `--no-index` is what makes an untracked file readable.
    return buildDiff(target.path, await readUntrackedDiff(repoPath, target.path));
  } catch (error) {
    return { title: describeTarget(target), lines: [], note: describeGitError(error) };
  }
}

/**
 * Diffs an untracked file against nothing.
 *
 * `git diff --no-index` **exits 1 whenever it finds a difference**, which is its documented
 * behaviour and not a failure: it is meant to be used as a test. Letting the thrown error through
 * would report every untracked file as an error, so the output is taken off the rejection instead.
 */
async function readUntrackedDiff(repoPath: string, path: string): Promise<string> {
  try {
    return await gitDiffOutput(repoPath, [
      'diff',
      '--no-index',
      '--no-color',
      '--',
      '/dev/null',
      path,
    ]);
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    return typeof stdout === 'string' ? stdout : '';
  }
}

/* ----------------------------------------------------------------- writes */

/**
 * Creates a branch, and switches to it unless told otherwise.
 *
 * The name is validated by `git check-ref-format` rather than by a pattern of ours. git's rules are
 * more subtle than they look (no `..`, no trailing `.lock`, no `@{`, no leading dash) and a regex
 * that approximates them either rejects a legal name or lets git fail later with a message about
 * something else.
 */
export async function createBranch(
  repoPath: string,
  name: string,
  checkout: boolean,
): Promise<GitResult> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'Empty branch name' };
  }

  const valid = await tryGit(repoPath, ['check-ref-format', '--branch', trimmed]);
  if (!valid.ok) {
    return { ok: false, message: `Invalid branch name: ${trimmed}` };
  }

  const result = checkout
    ? await tryGit(repoPath, ['checkout', '-b', trimmed])
    : await tryGit(repoPath, ['branch', trimmed]);
  return {
    ok: result.ok,
    message: result.ok ? `Branch ${trimmed} created` : result.message,
  };
}

/**
 * Switches branch.
 *
 * Nothing is stashed and nothing is forced. A checkout that would overwrite local changes fails, and
 * git's own message says which files are in the way — which is the honest outcome for a tab that has
 * no conflict resolution to offer. The alternative, an automatic stash, moves work somewhere the
 * user did not ask for and did not watch.
 */
export async function checkoutBranch(repoPath: string, name: string): Promise<GitResult> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'No branch given' };
  }
  // A branch name cannot start with a dash, so one that does is an option in disguise. The trailing
  // `--` is the other half: without it, a name that is also a file in the working tree makes git
  // hesitate between switching branch and restoring that file, and a double-click in a list must
  // only ever mean the first.
  if (trimmed.startsWith('-')) {
    return { ok: false, message: `Not a branch: ${trimmed}` };
  }
  const result = await tryGit(repoPath, ['checkout', trimmed, '--']);
  return { ok: result.ok, message: result.ok ? `On branch ${trimmed}` : result.message };
}

/**
 * Checks out a remote-tracking branch, as the local branch that follows it.
 *
 * Switching to `origin/feat` itself would detach HEAD, and a commit made there belongs to no branch:
 * what a double-click on a remote branch means is "let me work on this", which is a local branch with
 * that branch as its upstream. When that local branch already exists it is simply checked out, and
 * left where it is: fast-forwarding it is what `Pull` is for, and doing it silently here would be a
 * second write behind one gesture.
 *
 * The ref is re-read rather than trusted: the list it was double-clicked in can be a poll old, and a
 * `fetch --prune` in between removes branches.
 */
export async function checkoutRemoteBranch(repoPath: string, remoteRef: string): Promise<GitResult> {
  const refs = await readRefs(repoPath);
  const remote = refs.find((ref) => ref.kind === 'remote' && ref.ref === remoteRef);
  if (remote === undefined) {
    return { ok: false, message: 'That remote branch no longer exists: fetch, then try again' };
  }
  const slash = remote.name.indexOf('/');
  const local = slash === -1 ? remote.name : remote.name.slice(slash + 1);
  if (refs.some((ref) => ref.kind === 'local' && ref.name === local)) {
    return checkoutBranch(repoPath, local);
  }
  const valid = await tryGit(repoPath, ['check-ref-format', '--branch', local]);
  if (!valid.ok) {
    return { ok: false, message: `Invalid branch name: ${local}` };
  }
  const result = await tryGit(repoPath, ['checkout', '-b', local, '--track', remote.ref]);
  return {
    ok: result.ok,
    message: result.ok ? `On branch ${local}, following ${remote.name}` : result.message,
  };
}

/**
 * Undoes the last commit and keeps its changes staged.
 *
 * `reset --soft HEAD~1`: the branch moves back one commit, the index and the files on disk do not
 * move at all, so everything the commit contained is staged again and nothing is lost. Committing
 * again is one click away, the panel having put the message back in the form.
 *
 * Every condition is read again here rather than taken from the panel, which only disabled its button
 * on the state of its last read:
 * - **no half-done operation**: a reset in the middle of a cherry-pick or a merge leaves git's own
 *   markers pointing at a history that has just moved;
 * - **not the first commit**, which has no `HEAD~1` to go back to;
 * - **not a merge**: its first parent is only one of the two histories it joined, and the changes it
 *   would stage are the whole other branch;
 * - **not on any remote-tracking branch**: a commit someone can fetch is one rewriting would pull from
 *   under them, whichever branch it was pushed with. `--contains` answers that for every remote at
 *   once, which `@{upstream}` would only answer for one.
 */
export async function undoLastCommit(repoPath: string): Promise<GitResult> {
  const sequencer = readSequencer(repoPath);
  if (sequencer !== 'none') {
    return { ok: false, message: `Finish or abort the ${sequencer} first` };
  }
  const parents = await tryGit(repoPath, ['rev-list', '--parents', '-n1', 'HEAD']);
  if (!parents.ok) {
    return { ok: false, message: 'Nothing to undo: there is no commit yet' };
  }
  const [head = '', ...parentShas] = parents.stdout.trim().split(' ');
  if (parentShas.length === 0) {
    return { ok: false, message: 'The first commit of a repository has nothing to go back to' };
  }
  if (parentShas.length > 1) {
    return { ok: false, message: 'A merge cannot be undone here: use a terminal' };
  }
  const published = await tryGit(repoPath, [
    'for-each-ref',
    '--contains',
    'HEAD',
    '--format=%(refname:short)',
    'refs/remotes',
  ]);
  const remotes = published.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!published.ok || remotes.length > 0) {
    return {
      ok: false,
      message: published.ok
        ? `Already pushed to ${remotes[0] ?? 'a remote'}: undoing it would rewrite a published branch`
        : published.message,
    };
  }
  const result = await tryGit(repoPath, ['reset', '--soft', 'HEAD~1']);
  return {
    ok: result.ok,
    message: result.ok ? `Undid ${head.slice(0, 7)}: its changes are staged` : result.message,
  };
}

/**
 * Checks a merge request against the repository as it is now, and gives the arguments to run.
 *
 * Separate from running it because the merge runs in a terminal tab, which this module does not
 * own: it decides, the IPC layer launches. Refused, with a sentence, when:
 * - git has an operation half-done, which a merge would pile onto;
 * - HEAD is detached, where a merge commit would belong to no branch;
 * - the source is not a branch of this repository as of this read, or is the current branch itself.
 *
 * The source travels as its **short** name, because git writes the merge message from whatever it is
 * given: the full `refs/heads/feat` produced `Merge branch 'refs/heads/feat'`, verified on a real
 * repository. A short name is safe on two conditions, both checked: it does not start with a dash, so
 * it cannot be read as an option, and no other ref shares it, since git resolves a tag before a branch
 * of the same name and would merge the tag.
 */
export async function planMerge(
  repoPath: string,
  sourceRef: string,
  mode: GitMergeMode,
): Promise<{ ok: true; args: string[]; source: string; target: string } | GitResult> {
  const sequencer = readSequencer(repoPath);
  if (sequencer !== 'none') {
    return { ok: false, message: `Finish or abort the ${sequencer} first` };
  }
  const refs = await readRefs(repoPath);
  const current = refs.find((ref) => ref.current);
  if (current === undefined) {
    return { ok: false, message: 'HEAD is detached: check out a branch to merge into first' };
  }
  const source = refs.find(
    (ref) => ref.ref === sourceRef && (ref.kind === 'local' || ref.kind === 'remote'),
  );
  if (source === undefined) {
    return { ok: false, message: 'That branch no longer exists: fetch, then try again' };
  }
  if (source.ref === current.ref) {
    return { ok: false, message: `${source.name} is the branch checked out` };
  }
  if (source.name.startsWith('-')) {
    return { ok: false, message: `Not a branch: ${source.name}` };
  }
  if (refs.some((ref) => ref.name === source.name && ref.ref !== source.ref)) {
    return {
      ok: false,
      message: `${source.name} is ambiguous: another ref has the same name. Merge it from a terminal`,
    };
  }
  return {
    ok: true,
    source: source.name,
    target: current.name,
    // `--no-edit`: the merge runs in a pty, where git would otherwise open `core.editor` on the
    // message and wait for an editor nobody asked for.
    args: [
      'merge',
      ...(mode === 'ff-only' ? ['--ff-only'] : mode === 'no-ff' ? ['--no-ff', '--no-edit'] : ['--no-edit']),
      source.name,
    ],
  };
}

/**
 * Stages or unstages paths.
 *
 * `--` before the paths is not decoration: without it a file literally named `-f`, or a path that
 * happens to match a branch name, is read by git as an option or a revision. The separator is what
 * makes a path always a path.
 */
export async function stagePaths(
  repoPath: string,
  paths: readonly string[],
  staged: boolean,
): Promise<GitResult> {
  if (paths.length === 0) {
    return { ok: false, message: 'No file selected' };
  }

  const result = staged
    ? await tryGit(repoPath, ['add', '--', ...paths])
    : await tryGit(repoPath, ['restore', '--staged', '--', ...paths]);

  const count = paths.length;
  return {
    ok: result.ok,
    message: result.ok
      ? `${count} file${count > 1 ? 's' : ''} ${staged ? 'staged' : 'unstaged'}`
      : result.message,
  };
}

/**
 * Throws away what was done to those paths.
 *
 * The only write in this tab that destroys work with nothing able to bring it back. A stash `drop`
 * comes close, but a dropped stash is a commit the reflog holds for a while; a discarded working-tree
 * change was never an object at all, and a deleted untracked file was never even in the database.
 * Everything below follows from that.
 *
 * **The list is re-read here**, exactly like `applyStash` re-reads the stash list. The renderer's
 * snapshot is up to a poll old, and in that window a file can have been staged, committed or created:
 * acting on a stale classification would delete a file git now tracks, or restore a path the reader
 * believed was still modified. A path that no longer has changes is dropped from the operation rather
 * than passed to git anyway, and a call left with nothing to do says so instead of reporting success.
 *
 * **Two commands, because git has two answers.** A tracked path goes back to HEAD with
 * `restore --staged --worktree`, which covers the `MM` case a single column would flatten: what is
 * staged is part of what was done to that file, and leaving the index behind would put the change
 * straight back into the next commit. An untracked path has no HEAD version to go back to, so the
 * only way to discard it is `clean -f`, which deletes it. The two are counted apart in the message
 * for the same reason they are two commands: one is reversible in principle, the other is not.
 *
 * `--` before the paths, like `stagePaths`: without it a file named `-f`, or one whose name matches a
 * branch, is read as an option or a revision.
 */
export async function discardPaths(repoPath: string, paths: readonly string[]): Promise<GitResult> {
  if (paths.length === 0) {
    return { ok: false, message: 'No file selected' };
  }

  const wanted = new Set(paths);
  const changes = (await readChanges(repoPath)).filter((change) => wanted.has(change.path));
  if (changes.length === 0) {
    return { ok: false, message: 'Those files have no change left: refresh the list' };
  }

  /*
   * A rename is two paths, and forgetting the second one is the trap this line exists for.
   *
   * `git status` reports it as a single record carrying the new path, with the old one in `from`.
   * Restoring only the new path leaves the old file deleted, which is a half-undone rename: the
   * reader asked for the change to go away and would be left with the worse half of it.
   */
  const tracked = changes
    .filter((change) => !change.untracked)
    .flatMap((change) => (change.from === null ? [change.path] : [change.path, change.from]));
  const untracked = changes.filter((change) => change.untracked).map((change) => change.path);

  if (tracked.length > 0) {
    const result = await tryGit(repoPath, ['restore', '--staged', '--worktree', '--', ...tracked]);
    if (!result.ok) {
      return result;
    }
  }
  if (untracked.length > 0) {
    const result = await tryGit(repoPath, ['clean', '-f', '--', ...untracked]);
    if (!result.ok) {
      return result;
    }
  }

  // Counted on the changes, not on the paths: a rename contributes two paths and is one file.
  return {
    ok: true,
    message: describeDiscard(changes.length - untracked.length, untracked.length),
  };
}

/** What was actually thrown away, counted per kind: one was restored, the other was deleted. */
function describeDiscard(tracked: number, untracked: number): string {
  const parts: string[] = [];
  if (tracked > 0) {
    parts.push(`${tracked} file${tracked > 1 ? 's' : ''} back to HEAD`);
  }
  if (untracked > 0) {
    parts.push(`${untracked} new file${untracked > 1 ? 's' : ''} deleted`);
  }
  return parts.join(', ');
}

/**
 * Replays a commit onto the current branch.
 *
 * The one write of this tab that can leave the repository in a state git calls "in progress": on a
 * conflict, `cherry-pick` stops with `CHERRY_PICK_HEAD` on disk, every later button fails for reasons
 * that have nothing to do with what was clicked, and there is no way out but a command. That is
 * exactly why `readSequencer` exists and why `resolveSequencer` below is its counterpart — offering
 * the operation without offering the way out of it would be the worse half of the feature.
 *
 * `-n` stages the changes without committing them, which is what "take that commit, let me adjust it"
 * means; it is also the only form that does not open an editor, the other being handled by git's own
 * default of reusing the original message.
 */
export async function cherryPick(
  repoPath: string,
  sha: string,
  noCommit: boolean,
): Promise<GitResult> {
  const trimmed = sha.trim();
  /*
   * A hexadecimal sha and nothing else.
   *
   * `cherry-pick` has no `--` separator to hide behind — it takes revisions, not paths — so the
   * guard has to be the value itself. It costs nothing: this sha is one the app printed from its own
   * `git log`, so anything that fails this test did not come from the history column.
   */
  if (!SHA_PATTERN.test(trimmed)) {
    return { ok: false, message: 'Invalid commit sha' };
  }

  const result = await tryGit(
    repoPath,
    noCommit ? ['cherry-pick', '-n', trimmed] : ['cherry-pick', trimmed],
  );
  if (result.ok) {
    return {
      ok: true,
      message: noCommit
        ? `${trimmed} applied to the index, not committed yet`
        : `${trimmed} replayed on the current branch`,
    };
  }
  /*
   * A failed cherry-pick is two different situations and the message has to tell them apart. Refused
   * outright (dirty working tree, unknown commit), nothing moved. Stopped on a conflict, the
   * repository is now mid-cherry-pick and the next thing the user needs is the way out, not a
   * restatement of the failure — so the state is re-read rather than assumed from the exit code.
   */
  const sequencer = await readSequencer(repoPath);
  return {
    ok: false,
    message:
      sequencer === 'cherry-pick'
        ? `Conflict: ${result.message}. Resolve it then "Continue", or "Abort".`
        : result.message,
  };
}

/**
 * Finishes or abandons whatever git left half-done.
 *
 * `--continue` runs with `GIT_EDITOR=true`, and that is load-bearing rather than tidy: left to itself
 * git opens the editor from `core.editor` to confirm the message, and an editor opened by a *silent*
 * `execFile` is a command that never returns — the call would sit there until the timeout, with the
 * repository still mid-operation and nothing on screen to say why. `true` is the standard way to
 * answer "accept the message as it stands"; the flag spelling differs per operation (`--no-edit`
 * exists for some and not others), the environment variable works for all of them.
 *
 * `none` is answered rather than run: a `--continue` with nothing in progress fails with a message
 * about something else entirely.
 */
export async function resolveSequencer(
  repoPath: string,
  state: GitSequencer,
  op: GitSequencerOp,
): Promise<GitResult> {
  if (state === 'none') {
    return { ok: false, message: 'No operation in progress' };
  }

  const result = await tryGit(repoPath, [state, `--${op}`], {
    // A `--continue` runs the rest of the operation, which on a long rebase is not an eight-second job.
    timeoutMs: GIT_NETWORK_TIMEOUT_MS,
    ...(op === 'continue' ? { env: { GIT_EDITOR: 'true' } } : {}),
  });
  return {
    ok: result.ok,
    message: result.ok
      ? op === 'abort'
        ? `${state} aborted`
        : `${state} finished`
      : result.message,
  };
}

/**
 * Stashes the working tree.
 *
 * `--include-untracked` is offered rather than always on: a stash that quietly swept away new files
 * is how work disappears, and it is also the only half of a stash that a `git checkout` did not
 * already refuse to overwrite. The message goes through `-m` as a **single argument**, which
 * `execFile` guarantees — unlike a commit message this one is a short label, so the file dance
 * `writeCommitMessage` exists for would buy nothing here.
 */
export async function stashPush(
  repoPath: string,
  message: string,
  includeUntracked: boolean,
): Promise<GitResult> {
  const trimmed = message.trim();
  const args = ['stash', 'push'];
  if (includeUntracked) {
    args.push('--include-untracked');
  }
  if (trimmed.length > 0) {
    args.push('-m', trimmed);
  }

  const result = await tryGit(repoPath, args);
  if (!result.ok) {
    return result;
  }
  // git says "No local changes to save" on stdout and still exits 0, so success is not the same thing
  // as something having been stashed. Repeating git's own sentence is more honest than "Stash created".
  return { ok: true, message: result.message };
}

/**
 * Applies, pops or drops a stash, named by its **sha**.
 *
 * The resolution is the whole point of this function. `stash@{1}` is a position in a list that
 * renumbers itself on every drop and every pop, so a ref the renderer read thirty seconds ago can
 * name a different entry by the time the button is pressed — and `drop` on the wrong entry is work
 * lost with nothing to undo it. The list is therefore re-read here and the sha looked up in it; an
 * entry that has since disappeared is refused rather than approximated.
 */
export async function applyStash(
  repoPath: string,
  sha: string,
  op: GitStashOp,
): Promise<GitResult> {
  const stashes = await readStashes(repoPath);
  const entry = stashes.find((candidate) => candidate.sha === sha);
  if (entry === undefined) {
    return { ok: false, message: 'That stash is gone: refresh the list' };
  }

  const result = await tryGit(repoPath, ['stash', op, entry.ref]);
  if (!result.ok) {
    return result;
  }
  switch (op) {
    case 'apply':
      return { ok: true, message: `${entry.ref} applied, and kept in the list` };
    case 'pop':
      return { ok: true, message: `${entry.ref} applied and removed from the list` };
    case 'drop':
      return { ok: true, message: `${entry.ref} dropped` };
  }
}

/**
 * Runs one of the three network operations.
 *
 * They share a handler because they share everything that matters: a long timeout, an outcome that
 * is only knowable from git's own message, and no state of ours to update beyond re-reading.
 *
 * `pull` is deliberately `--ff-only`. A merge or a rebase can stop halfway on a conflict, and this
 * tab has nothing to offer someone standing in a half-finished rebase; refusing to start one is the
 * only outcome it can honestly explain. Diverged branches are a terminal's business.
 *
 * `push` gains `-u origin <branch>` when the branch has no upstream, which is the first push of any
 * new branch and the one case where a bare `push` fails with advice instead of doing the obvious.
 */
export async function sync(
  repoPath: string,
  op: GitSyncOp,
  branch: string,
  hasUpstream: boolean,
): Promise<GitResult> {
  const options = { timeoutMs: GIT_NETWORK_TIMEOUT_MS };

  if (op === 'fetch') {
    const result = await tryGit(repoPath, ['fetch', '--prune'], options);
    return { ok: result.ok, message: result.ok ? 'Fetch done' : result.message };
  }

  if (op === 'pull') {
    const result = await tryGit(repoPath, ['pull', '--ff-only'], options);
    return { ok: result.ok, message: result.message };
  }

  const args = hasUpstream ? ['push'] : ['push', '-u', 'origin', branch];
  const result = await tryGit(repoPath, args, options);
  return { ok: result.ok, message: result.message };
}

/* ------------------------------------------------------------------ inner */

/** The branch HEAD points at, or a short sha when it points at no branch. */
async function readHead(repoPath: string): Promise<string> {
  const out = (await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (out !== 'HEAD') {
    return out;
  }
  return `detached@${(await git(repoPath, ['rev-parse', '--short', 'HEAD'])).trim()}`;
}

function buildDiff(title: string, out: string): GitDiff {
  const lines = parseUnifiedDiff(out);
  const content = lines.some((line) => line.kind === 'add' || line.kind === 'del');

  if (out.includes('Binary files ')) {
    return { title, lines: [], note: 'Binary file, no diff to show.' };
  }
  if (!content && lines.length === 0) {
    return { title, lines: [], note: 'No change to show.' };
  }
  return { title, lines, note: null };
}

function describeTarget(target: GitDiffTarget): string {
  switch (target.kind) {
    case 'commit':
      return target.sha;
    case 'commit-file':
      return target.path;
    case 'stash':
      return target.ref;
    case 'file':
      return target.path;
  }
}
