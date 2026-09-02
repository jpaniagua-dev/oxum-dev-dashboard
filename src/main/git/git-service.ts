import type { GitState } from '@shared/contracts.js';
import { describeGitError, git } from './run-git.js';

/**
 * Reads a repository's state with **one** `git` call.
 *
 * `git` is invoked directly rather than through a library: the command is stable, scriptable and
 * already installed, and a dependency would add a dependency without removing any of the parsing.
 * The runner lives in `run-git.ts`, shared with the Git tab's commands: one place decides that git is
 * called with an argument array and never through a shell, which is what keeps a branch name from
 * ever being read as shell syntax.
 *
 * **One call, and the count is the point.** This function used to make four (`rev-parse` for the
 * branch, `status` for the files, `rev-list` for the upstream gap, `stash list` for a count), which
 * was harmless on the assumption that starting a process is cheap. It is not, on a machine with
 * corporate endpoint protection: measured on 2026-09-02, a process that does nothing at all costs
 * 31 ms there, so the four calls cost 170 ms per project of which only about 22 ms was git actually
 * working. Ten projects on a ten-second poll is 40 spawns, and because `uv_spawn` creates processes
 * synchronously on the event loop thread, that blocked the main process for 489 ms every ten seconds.
 * See `main/concurrency.ts` for the measurements.
 *
 * `--porcelain=v2 --branch` answers all of it at once: the branch name, the upstream and its gap in
 * the `# branch.*` header, then one record per changed file. The stash count went with the change and
 * was not replaced, because **nothing displayed it** (see `GitState`).
 *
 * `readUpstream` below is kept even though this no longer calls it: the Git tab reads a single
 * repository on demand, where one focused call is the right shape.
 */
export async function readGitState(repoPath: string): Promise<GitState> {
  try {
    return {
      ...parsePorcelainV2(await git(repoPath, ['status', '--porcelain=v2', '--branch'])),
      error: null,
    };
  } catch (error) {
    return {
      branch: '?',
      modified: 0,
      staged: 0,
      untracked: 0,
      behind: 0,
      ahead: 0,
      hasUpstream: false,
      error: describeGitError(error),
    };
  }
}

/**
 * The `owner/repo` a repository points at on GitHub, or null when it points elsewhere.
 *
 * Null rather than an error for anything unexpected: a project with no remote, or one hosted somewhere
 * that is not GitHub, is a perfectly normal row that simply has no pull requests to show.
 */
export async function readRemoteSlug(repoPath: string): Promise<string | null> {
  try {
    const url = (await git(repoPath, ['remote', 'get-url', 'origin'])).trim();
    return parseRemoteSlug(url);
  } catch {
    return null;
  }
}

/**
 * Extracts `owner/repo` from a remote URL.
 *
 * Exported for testing, and both forms are handled because both are in the wild: these clones use
 * `https://github.com/example-org/<repo>.git` while an SSH clone reads
 * `git@github.com:owner/repo.git`. The `.git` suffix is optional in both.
 */
export function parseRemoteSlug(url: string): string | null {
  const cleaned = url.trim().replace(/\.git$/i, '');
  const https = /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+)$/i.exec(cleaned);
  if (https !== null) {
    return `${https[1]}/${https[2]}`;
  }
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+)$/i.exec(cleaned);
  if (ssh !== null) {
    return `${ssh[1]}/${ssh[2]}`;
  }
  return null;
}

/**
 * Reads everything a row needs out of `git status --porcelain=v2 --branch`.
 *
 * Exported and pure because it is the one place four separate answers are now read from a single
 * output, and each of them has a shape that is easy to misread. Verified against real git output on
 * Windows, including the two cases that would otherwise fail in silence.
 *
 * The header is a handful of `# key value` lines:
 *
 * ```
 * # branch.oid <sha>
 * # branch.head main            <- the branch, or literally "(detached)"
 * # branch.upstream origin/main <- ABSENT when the branch has no upstream
 * # branch.ab +2 -1             <- ahead first, behind second, ABSENT with no upstream
 * ```
 *
 * Two traps, both of them met for real rather than guessed:
 *
 * - **`branch.upstream` and `branch.ab` are simply missing** on a branch that was never pushed, which
 *   is what `hasUpstream: false` is read from. There is no line saying "no upstream", so anything
 *   defaulting a missing `branch.ab` to zero while claiming an upstream would report every unpushed
 *   branch as level with a remote it does not have, and the checks column would then look one up.
 * - **`branch.ab` puts ahead first and behind second** (`+ahead -behind`), which is the opposite order
 *   from `rev-list --left-right --count`, whose output the old code read as behind-then-ahead. Getting
 *   this backwards swaps the two badges and is invisible until you are both ahead and behind.
 *
 * Then one line per entry: `1 <XY> ...` for an ordinary change, `2 <XY> ...` for a rename or copy,
 * `u <XY> ...` for an unmerged path, `? <path>` for an untracked one and `! <path>` for an ignored
 * one. `X` is the index and `Y` the working tree, exactly as in the v1 format, so a file that is
 * staged **and** modified again counts once on each side, which is the whole reason those two columns
 * are never merged. An unmerged path counts as modified: it is work in the tree, and `u` carries no
 * meaningful `X`/`Y` pair to split.
 */
export function parsePorcelainV2(stdout: string): Omit<GitState, 'error'> {
  let head = '';
  let oid = '';
  let ahead = 0;
  let behind = 0;
  let hasUpstream = false;
  let modified = 0;
  let staged = 0;
  let untracked = 0;

  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) {
      head = line.slice('# branch.head '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.oid ')) {
      oid = line.slice('# branch.oid '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      hasUpstream = true;
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const [first, second] = line.slice('# branch.ab '.length).trim().split(/\s+/);
      ahead = toCount(first?.replace(/^\+/, ''));
      behind = toCount(second?.replace(/^-/, ''));
      continue;
    }
    if (line.startsWith('? ')) {
      untracked += 1;
      continue;
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const index = line[2] ?? ' ';
      const worktree = line[3] ?? ' ';
      if (index !== '.' && index !== ' ') {
        staged += 1;
      }
      if (worktree !== '.' && worktree !== ' ') {
        modified += 1;
      }
      continue;
    }
    if (line.startsWith('u ')) {
      // A conflict is work in the tree. `u` reports both sides of the merge rather than an index and a
      // worktree state, so there is nothing to split between the two counts.
      modified += 1;
    }
  }

  return { branch: describeHead(head, oid), modified, staged, untracked, behind, ahead, hasUpstream };
}

/**
 * The branch as a row should read it.
 *
 * Resolved after the whole output has been walked rather than while walking it, and that is not a
 * style choice: git prints `# branch.oid` **before** `# branch.head`, so deciding the branch on the
 * `head` line and then reaching for the oid finds nothing. A test caught it. Reading both fields first
 * removes the dependency on git's line order entirely.
 *
 * A detached HEAD reads `(detached)`, which names a state rather than a place; the short sha is what
 * somebody can act on, and it is in the same output, so it costs no second call.
 */
function describeHead(head: string, oid: string): string {
  if (head.length === 0) {
    return '?';
  }
  if (head !== '(detached)') {
    return head;
  }
  return oid.length > 0 ? `detached@${oid.slice(0, 7)}` : 'detached';
}

/**
 * Reads how far the branch is from its upstream.
 *
 * A branch with no upstream is a normal state, not an error: it simply has not been pushed, which
 * also means no pull request can exist for it. `rev-list` exits non-zero in that case, so the
 * failure is caught and reported as `hasUpstream: false`.
 */
export async function readUpstream(
  repoPath: string,
): Promise<{ behind: number; ahead: number; hasUpstream: boolean }> {
  try {
    const out = await git(repoPath, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
    return { ...parseAheadBehind(out), hasUpstream: true };
  } catch {
    return { behind: 0, ahead: 0, hasUpstream: false };
  }
}

/**
 * `git rev-list --left-right --count` prints "<behind>\t<ahead>".
 *
 * Behind first, and worth stating next to `parsePorcelainV2`, which reads the same two numbers from
 * `# branch.ab` in the **opposite** order. Two readers of one fact with two orders is exactly the kind
 * of pair that gets copied wrongly.
 */
export function parseAheadBehind(stdout: string): { behind: number; ahead: number } {
  const [behind, ahead] = stdout.trim().split(/\s+/);
  return { behind: toCount(behind), ahead: toCount(ahead) };
}

function toCount(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
