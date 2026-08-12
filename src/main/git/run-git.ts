import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Budget for a local read.
 *
 * A `status` or a `log` that takes longer than this is a failure, not a slow answer: it would
 * otherwise hold up the refresh of a strip the user is looking at.
 */
export const GIT_TIMEOUT_MS = 8000;

/**
 * Budget for anything touching the network.
 *
 * Its own constant because a push over the VPN is simply not an eight-second operation, and reusing
 * the read timeout would make a perfectly healthy push report a failure it did not have.
 */
export const GIT_NETWORK_TIMEOUT_MS = 120_000;

/** A diff of a generated file runs to megabytes, and truncating one silently would be worse. */
const DIFF_BUFFER = 16 * 1024 * 1024;

export interface GitRunOptions {
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  /**
   * Variables added on top of the process environment, never replacing it.
   *
   * Exists for `GIT_EDITOR=true`, which is what keeps a `--continue` from opening an editor nobody
   * can see. Merged rather than substituted because git needs the ambient environment to work at all:
   * `PATH` finds its own helpers, and on Windows `HOME` is where the global config lives.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Runs a git command in a repository and returns its stdout.
 *
 * `execFile` with an argument array and **no shell**: branch names, paths and commit messages reach
 * git as single arguments, so nothing a user types can be read as shell syntax. That property is why
 * every git call in this app goes through here rather than through a command string.
 *
 * Throws on a non-zero exit, which is what the read paths want: they turn it into a state carrying
 * the message. Writes use `tryGit` instead.
 */
export async function git(
  repoPath: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], runOptions(options));
  return stdout;
}

/** The `execFile` options every call shares, so the two runners cannot drift on a budget or a variable. */
function runOptions(options: GitRunOptions): {
  timeout: number;
  windowsHide: boolean;
  maxBuffer: number;
  env?: NodeJS.ProcessEnv;
} {
  return {
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
  };
}

/** Same, with the buffer a diff needs. */
export async function gitDiffOutput(
  repoPath: string,
  args: readonly string[],
): Promise<string> {
  return git(repoPath, args, { maxBuffer: DIFF_BUFFER });
}

/**
 * Runs a git command and reports the outcome instead of throwing.
 *
 * What every **write** uses. A failed checkout or a rejected push is a normal answer that has to be
 * shown next to the button that was pressed, not an exception: git's own stderr already says why
 * ("Your local changes would be overwritten", "Updates were rejected"), and no message this app
 * could invent would be more useful than that one.
 */
export async function tryGit(
  repoPath: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<{ ok: boolean; stdout: string; message: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'git',
      ['-C', repoPath, ...args],
      runOptions(options),
    );
    // git says most of what it did on stderr even when it succeeded, and that is the interesting
    // half: "Switched to branch 'x'", "Everything up-to-date".
    return { ok: true, stdout, message: firstLine(stderr) || firstLine(stdout) || 'Fait' };
  } catch (error) {
    return { ok: false, stdout: '', message: describeGitError(error) };
  }
}

/**
 * The first useful line of a git failure.
 *
 * git's stderr is far more informative than `Command failed with exit code 1`, and the first line is
 * almost always the reason; the rest is advice addressed to a terminal user.
 */
export function describeGitError(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: string }).stderr;
    const fromStderr = typeof stderr === 'string' ? firstLine(stderr) : '';
    if (fromStderr.length > 0) {
      return fromStderr;
    }
    const stdout = (error as { stdout?: string }).stdout;
    const fromStdout = typeof stdout === 'string' ? firstLine(stdout) : '';
    return fromStdout.length > 0 ? fromStdout : error.message;
  }
  return String(error);
}

function firstLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  );
}
