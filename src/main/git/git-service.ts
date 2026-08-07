import type { GitState } from '@shared/contracts.js';
import { describeGitError, git } from './run-git.js';

/**
 * Reads a repository's state with plain `git` calls.
 *
 * `git` is invoked directly rather than through a library: the four commands below are stable,
 * scriptable and already installed, and a dependency would add a dependency without removing any
 * of the parsing.
 *
 * The runner itself lives in `run-git.ts`, shared with the Git tab's commands: one place decides
 * that git is called with an argument array and never through a shell, which is what keeps a branch
 * name from ever being read as shell syntax.
 */
export async function readGitState(repoPath: string): Promise<GitState> {
  try {
    const [branch, status, upstream, stashes] = await Promise.all([
      readBranch(repoPath),
      readStatus(repoPath),
      readUpstream(repoPath),
      readStashCount(repoPath),
    ]);

    return {
      branch,
      modified: status.modified,
      staged: status.staged,
      untracked: status.untracked,
      behind: upstream.behind,
      ahead: upstream.ahead,
      hasUpstream: upstream.hasUpstream,
      stashes,
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
      stashes: 0,
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

async function readBranch(repoPath: string): Promise<string> {
  const out = (await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  // A detached HEAD reports literally "HEAD"; show the short sha instead, which is actionable.
  if (out === 'HEAD') {
    const sha = (await git(repoPath, ['rev-parse', '--short', 'HEAD'])).trim();
    return `detached@${sha}`;
  }
  return out;
}

/**
 * Counts working-tree changes from porcelain output.
 *
 * Exported for testing: the two-column status format is easy to misread, and conflating staged
 * with unstaged changes would make the "files to commit" column meaningless.
 */
export function parsePorcelain(stdout: string): {
  modified: number;
  staged: number;
  untracked: number;
} {
  let modified = 0;
  let staged = 0;
  let untracked = 0;

  for (const line of stdout.split(/\r?\n/)) {
    if (line.length < 2) {
      continue;
    }
    const index = line[0] ?? ' ';
    const worktree = line[1] ?? ' ';

    if (index === '?' && worktree === '?') {
      untracked += 1;
      continue;
    }
    // Column 1 is the index (staged), column 2 the working tree. A file can be both, and then it
    // legitimately counts once on each side.
    if (index !== ' ' && index !== '?') {
      staged += 1;
    }
    if (worktree !== ' ' && worktree !== '?') {
      modified += 1;
    }
  }

  return { modified, staged, untracked };
}

async function readStatus(repoPath: string): Promise<ReturnType<typeof parsePorcelain>> {
  return parsePorcelain(await git(repoPath, ['status', '--porcelain']));
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

/** `git rev-list --left-right --count` prints "<behind>\t<ahead>". */
export function parseAheadBehind(stdout: string): { behind: number; ahead: number } {
  const [behind, ahead] = stdout.trim().split(/\s+/);
  return { behind: toCount(behind), ahead: toCount(ahead) };
}

async function readStashCount(repoPath: string): Promise<number> {
  try {
    const out = await git(repoPath, ['stash', 'list']);
    return out.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

function toCount(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
