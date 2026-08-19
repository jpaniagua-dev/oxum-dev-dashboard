import type { Project } from '@shared/contracts.js';
import { runClaude } from '../triage/run-claude.js';
import { buildCommitPrompt, readCommitMessage, RECENT_SUBJECTS } from './commit-prompt.js';
import { describeGitError, git } from './run-git.js';

/**
 * Generates a commit message from what is staged, with a headless Claude Code run.
 *
 * The second use of `runClaude`, and the one that made its options stop being triage's. It reads git,
 * builds the prompt, runs the model and hands back a message. It does **not** commit: the answer goes
 * into the form's textarea and the commit stays a separate, deliberate click. A generator that also
 * committed would be a button that writes history from a diff nobody re-read.
 */

/**
 * Budget for one message.
 *
 * A fraction of the sprint analysis's fifteen minutes, and it has to be: this one is in front of
 * somebody waiting with a staged index, and a button held for a quarter of an hour on a run that is
 * not coming back is worse than a failure. Long enough to read a repository's conventions first.
 */
export const COMMIT_TIMEOUT_MS = 3 * 60_000;

/** Buffer for `git diff --cached`. Diffs of generated files run large, and a truncated one lies. */
const DIFF_BUFFER = 16 * 1024 * 1024;

export interface GeneratedCommit {
  readonly ok: boolean;
  /** The message, ready to be put in the form. Empty when the run failed. */
  readonly message: string;
  /** Why there is no message. Null on success. */
  readonly error: string | null;
}

/**
 * Reads what the message has to describe.
 *
 * Two situations, and they are genuinely different:
 *
 * - **A normal commit** describes the index, so `git diff --cached`.
 * - **An amend** describes the last commit *plus* whatever has been staged on top, which is exactly
 *   `git diff --cached HEAD~1`. Reading only the index would produce a message about the fixup while
 *   throwing away the commit it is being folded into, which is the opposite of what an amend does.
 *
 * `HEAD~1` does not exist on a root commit, so that case falls back to the whole of HEAD. Failing
 * instead would make the feature unavailable on exactly the commit where there is no convention to
 * read yet.
 */
async function readSubjectDiff(repoPath: string, amend: boolean): Promise<string> {
  if (!amend) {
    return git(repoPath, ['diff', '--cached'], { maxBuffer: DIFF_BUFFER });
  }
  try {
    return await git(repoPath, ['diff', '--cached', 'HEAD~1'], { maxBuffer: DIFF_BUFFER });
  } catch {
    return git(repoPath, ['show', '--format=', 'HEAD'], { maxBuffer: DIFF_BUFFER });
  }
}

/**
 * The subjects that show what this repository's messages look like.
 *
 * `--skip=1` on an amend, because HEAD is the commit being replaced: offering its own subject as an
 * example of the form to follow invites the model to rewrite it back.
 */
async function readRecentSubjects(repoPath: string, amend: boolean): Promise<string[]> {
  try {
    const stdout = await git(repoPath, [
      'log',
      `-n${RECENT_SUBJECTS}`,
      `--skip=${amend ? 1 : 0}`,
      '--format=%s',
    ]);
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  } catch {
    // A repository with no commit yet is a normal state here, not a failure: there is simply no
    // observed convention, and the prompt drops that section.
    return [];
  }
}

/**
 * Runs the generation and returns a message or a reason.
 *
 * The empty diff is caught **before** the model is started rather than after: a run on nothing takes
 * the same minute as a run on something and comes back with an invented message, and "nothing is
 * staged" is a sentence this app can write itself.
 *
 * The run starts in the repository, which is the load-bearing part: Claude Code reads `CLAUDE.md` from
 * there and from its ancestors, so it follows that repository's commit convention without this app
 * ever having read one. `claudeContextRoot` is deliberately *not* used, unlike the `Work on this`
 * handoff: the workspace above holds what several repositories share, and here a sibling's convention
 * is not context, it is a wrong answer.
 */
export async function generateCommitMessage(
  project: Project,
  options: { amend: boolean; branch: string; model: string },
): Promise<GeneratedCommit> {
  let diff: string;
  try {
    diff = await readSubjectDiff(project.path, options.amend);
  } catch (error) {
    return { ok: false, message: '', error: describeGitError(error) };
  }

  if (diff.trim().length === 0) {
    return {
      ok: false,
      message: '',
      error: options.amend
        ? 'Nothing to describe: the last commit is empty and nothing is staged'
        : 'Nothing staged: tick at least one file first',
    };
  }

  const prompt = buildCommitPrompt({
    diff,
    recentSubjects: await readRecentSubjects(project.path, options.amend),
    branch: options.branch,
    amend: options.amend,
  });

  const run = await runClaude({
    cwd: project.path,
    prompt,
    model: options.model,
    timeoutMs: COMMIT_TIMEOUT_MS,
    label: 'The commit message',
  });
  if (!run.ok) {
    return { ok: false, message: '', error: run.error ?? 'The commit message could not be generated' };
  }

  const message = readCommitMessage(run.answer);
  if (message === null) {
    // A clean run whose answer is not a message: empty, or long enough to be an essay about the diff.
    // Reported rather than pasted, because the textarea may already hold something worth keeping.
    return { ok: false, message: '', error: 'Claude Code did not answer with a commit message' };
  }
  return { ok: true, message, error: null };
}
