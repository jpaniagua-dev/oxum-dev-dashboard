import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  GitBranch,
  GitChange,
  GitCommit,
  GitDiff,
  GitDiffTarget,
  GitRepoState,
  GitResult,
  GitSequencer,
  GitSequencerOp,
  GitStash,
  GitStashOp,
  GitSyncOp,
  Project,
} from '@shared/contracts.js';
import { readUpstream } from './git-service.js';
import {
  FIELD_SEPARATOR as SEP,
  parseBranchLines,
  parseLogLines,
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
 * How many commits the history column shows.
 *
 * A window, not the whole log: the column is a few hundred pixels tall and reading ten thousand
 * commits to display forty of them is work nobody asked for. Raising it costs one number.
 */
const LOG_LIMIT = 60;

/* ------------------------------------------------------------------ reads */

/**
 * Everything the Git tab shows for one repository, in a single pass.
 *
 * The four reads run concurrently because none depends on another and they are all local: doing them
 * in sequence would make the tab's refresh four round trips long for no benefit.
 *
 * A failure of the whole thing degrades to a state carrying the message rather than throwing. The
 * folder may simply not be a repository, which is a normal row in this app, not an exception.
 */
export async function readRepoState(project: Project): Promise<GitRepoState> {
  const empty = {
    projectId: project.id,
    label: project.label,
    path: project.path,
    branches: [] as GitBranch[],
    changes: [] as GitChange[],
    commits: [] as GitCommit[],
    stashes: [] as GitStash[],
    headMessage: '',
    sequencer: 'none' as GitSequencer,
  };

  try {
    const [branches, changes, commits, stashes, headMessage, sequencer, upstream] =
      await Promise.all([
        readBranches(project.path),
        readChanges(project.path),
        readCommits(project.path),
        readStashes(project.path),
        readHeadMessage(project.path),
        readSequencer(project.path),
        readUpstream(project.path),
      ]);

    const current = branches.find((branch) => branch.current);
    return {
      ...empty,
      branches,
      changes,
      commits,
      stashes,
      headMessage,
      sequencer,
      // The current branch comes from the branch list when there is one, and from HEAD otherwise:
      // a detached HEAD matches no entry in `refs/heads`, and reporting an empty name there would
      // make the tab look broken rather than detached.
      branch: current?.name ?? (await readHead(project.path)),
      ahead: upstream.ahead,
      behind: upstream.behind,
      hasUpstream: upstream.hasUpstream,
      checkedAt: new Date().toISOString(),
      error: null,
    };
  } catch (error) {
    return {
      ...empty,
      branch: '?',
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      checkedAt: null,
      error: describeGitError(error),
    };
  }
}

/** Local branches, most recently committed first. */
export async function readBranches(repoPath: string): Promise<GitBranch[]> {
  const format = [
    '%(refname:short)',
    '%(HEAD)',
    '%(upstream:short)',
    '%(upstream:track)',
    '%(committerdate:iso-strict)',
  ].join(SEP);
  // Sorted by git rather than by us: `-committerdate` is exactly "the branches I have touched
  // lately", which is the order a branch list is actually searched in.
  const out = await git(repoPath, [
    'for-each-ref',
    '--sort=-committerdate',
    `--format=${format}`,
    'refs/heads',
  ]);
  return parseBranchLines(out);
}

/** Changed files, staged and unstaged alike. */
export async function readChanges(repoPath: string): Promise<GitChange[]> {
  // `-z` for raw paths, `-uall` so a new folder lists its files instead of collapsing to `folder/`:
  // a single untracked entry that cannot be diffed or staged individually is not actionable.
  const out = await git(repoPath, ['status', '--porcelain', '-z', '-uall']);
  return parseStatusZ(out);
}

/** The last commits of the current branch. */
export async function readCommits(repoPath: string): Promise<GitCommit[]> {
  const format = ['%h', '%an', '%aI', '%D', '%s'].join(SEP);
  const out = await git(repoPath, ['log', `-n${LOG_LIMIT}`, `--format=${format}`]);
  return parseLogLines(out);
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
export async function readSequencer(repoPath: string): Promise<GitSequencer> {
  try {
    const markers: readonly (readonly [GitSequencer, string])[] = [
      ['rebase', 'rebase-merge'],
      ['rebase', 'rebase-apply'],
      ['cherry-pick', 'CHERRY_PICK_HEAD'],
      ['revert', 'REVERT_HEAD'],
      ['merge', 'MERGE_HEAD'],
    ];
    const gitDir = (await git(repoPath, ['rev-parse', '--absolute-git-dir'])).trim();
    if (gitDir.length === 0) {
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

    if (target.kind === 'commit') {
      const out = await gitDiffOutput(repoPath, [
        'show',
        '--format=',
        '--no-color',
        target.sha,
      ]);
      return buildDiff(target.sha, out);
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
  const result = await tryGit(repoPath, ['checkout', trimmed]);
  return { ok: result.ok, message: result.ok ? `On branch ${trimmed}` : result.message };
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
  if (!/^[0-9a-f]{4,40}$/i.test(trimmed)) {
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
    case 'stash':
      return target.ref;
    case 'file':
      return target.path;
  }
}
