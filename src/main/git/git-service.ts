import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitState } from '@shared/contracts.js';

const execFileAsync = promisify(execFile);

/** A git call that takes longer than this is treated as a failure rather than blocking a refresh. */
const TIMEOUT_MS = 8000;

/**
 * Reads a repository's state with plain `git` calls.
 *
 * `git` is invoked directly rather than through a library: the four commands below are stable,
 * scriptable and already installed, and a dependency would add a dependency without removing any
 * of the parsing.
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
      error: describeError(error),
    };
  }
}

async function git(repoPath: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    timeout: TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
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

function describeError(error: unknown): string {
  if (error instanceof Error) {
    // execFile puts git's own message on stderr, which is far more useful than "Command failed".
    const stderr = (error as { stderr?: string }).stderr;
    if (typeof stderr === 'string' && stderr.trim().length > 0) {
      return stderr.trim().split(/\r?\n/)[0] ?? error.message;
    }
    return error.message;
  }
  return String(error);
}
