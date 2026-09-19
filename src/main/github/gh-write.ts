import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnOffThread } from '../spawn/spawn-pool.js';
import { AppPaths } from '../store/paths.js';
import type { ReviewEvent } from '../review/review-gate.js';

/**
 * The only place in this application that writes to GitHub.
 *
 * One door, for the reason `run-git.ts` is the one door to git. Every other `gh` call in the app is
 * a read, and that was true of the whole app until the pull request review shipped; keeping the
 * write behind a single import is what makes "does this touch somebody else's repository?" a
 * question answerable by grep rather than by reading function bodies.
 */

const TIMEOUT_MS = 30_000;

/** See `gh-review-read.ts`: a `gh` that prompts hangs, and a hung write is the worst outcome here. */
const GH_ENV = {
  ...process.env,
  GH_PROMPT_DISABLED: '1',
  GH_PAGER: 'cat',
  NO_COLOR: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
};

/**
 * What happened, and the fourth case is the one that matters.
 *
 * `failed` means `gh` answered and said no, so nothing was written. `unknown` means the call timed
 * out or its worker died, so the request **may** have reached GitHub. They are separate because the
 * only safe reaction to the second is to do nothing: retrying a timed-out review is how the same
 * blocking comment gets posted twice on a colleague's pull request.
 */
export type WriteOutcome =
  | { readonly kind: 'posted'; readonly reviewId: number; readonly url: string }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string };

/**
 * Writes a review body to disk and hands back its path.
 *
 * The body never travels as an argument. It is arbitrary model text, multi-line by construction and
 * free to contain backticks, quotes and anything else; as bytes in a file, none of it can be read as
 * an option or as shell syntax, which is the same reasoning that puts a commit message through
 * `git commit -F`.
 *
 * **Kept after the post**, like a commit message, and for one reason more: when a post is refused,
 * by a token without the scope or by a pull request that closed in the meantime, this file is the
 * only surviving copy of a run that cost minutes.
 */
export async function writeReviewBody(
  slug: string,
  number: number,
  headSha: string,
  body: string,
): Promise<string> {
  const folder = AppPaths.reviewBodies();
  await mkdir(folder, { recursive: true });
  const name = `${slug.replace('/', '-')}-${number}-${headSha.slice(0, 12)}-${Date.now()}.md`;
  const path = join(folder, name);
  await writeFile(path, body, 'utf8');
  return path;
}

/**
 * Submits a review to GitHub.
 *
 * `gh api` and not `gh pr review`, for four reasons that all matter:
 *
 * - **The comment and the review state are one call.** `gh pr comment` followed by `gh pr review`
 *   is the version that can half-fail, leaving the text posted and the merge unblocked. Here that
 *   state does not exist.
 * - **`commit_id` pins the review to the sha that was actually read.** `gh pr review` has no such
 *   option, so a review landing a second after a push would be silently attributed to a commit
 *   nobody reviewed. With it, GitHub itself shows which commit the review is about.
 * - **The review id comes back**, and it is the only thing that makes a review dismissable or
 *   retractable afterwards. A submitted review cannot be deleted; without its id, not even the
 *   recovery that does exist is reachable.
 * - **The body goes in with `-F body=@file`**, so `gh` reads the bytes and does the JSON encoding.
 *
 * Never retried. See `WriteOutcome`.
 */
export async function submitReview(input: {
  readonly slug: string;
  readonly number: number;
  readonly headSha: string;
  readonly event: ReviewEvent;
  readonly bodyPath: string;
}): Promise<WriteOutcome> {
  const args = [
    'api',
    '--method',
    'POST',
    `repos/${input.slug}/pulls/${input.number}/reviews`,
    '-f',
    `commit_id=${input.headSha}`,
    '-f',
    `event=${input.event}`,
    '-F',
    `body=@${input.bodyPath}`,
    '--jq',
    '{id: .id, url: .html_url}',
  ];

  try {
    const { stdout } = await spawnOffThread({
      file: 'gh',
      args,
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: GH_ENV,
    });
    const parsed: unknown = JSON.parse(stdout);
    const answer = (parsed ?? {}) as { id?: unknown; url?: unknown };
    if (typeof answer.id !== 'number') {
      // Posted, probably, but with nothing to point at afterwards. Reported as unknown rather than
      // as a success: a row claiming a review it cannot dismiss is worse than one claiming nothing.
      return { kind: 'unknown', message: 'GitHub answered without a review id' };
    }
    return {
      kind: 'posted',
      reviewId: answer.id,
      url: typeof answer.url === 'string' ? answer.url : '',
    };
  } catch (error) {
    return classify(error);
  }
}

/**
 * The argv a submission would use, without running anything.
 *
 * Exported for one test, and that test is the reason this feature can claim the body is never
 * quoted: an assertion that the body's text appears nowhere in the argument list is checkable,
 * whereas a comment saying so is a promise.
 */
export function reviewArgs(input: {
  readonly slug: string;
  readonly number: number;
  readonly headSha: string;
  readonly event: ReviewEvent;
  readonly bodyPath: string;
}): string[] {
  return [
    'api',
    '--method',
    'POST',
    `repos/${input.slug}/pulls/${input.number}/reviews`,
    '-f',
    `commit_id=${input.headSha}`,
    '-f',
    `event=${input.event}`,
    '-F',
    `body=@${input.bodyPath}`,
    '--jq',
    '{id: .id, url: .html_url}',
  ];
}

/**
 * Moves a pull request between draft and ready.
 *
 * `gh pr ready --undo` converts back to draft, verified against the installed CLI. A plain state
 * change with no body, so it takes no file.
 */
export async function setDraft(slug: string, number: number, draft: boolean): Promise<WriteOutcome> {
  const args = ['pr', 'ready', String(number), '--repo', slug];
  if (draft) {
    args.push('--undo');
  }
  try {
    await spawnOffThread({ file: 'gh', args, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, env: GH_ENV });
    return { kind: 'posted', reviewId: 0, url: '' };
  } catch (error) {
    return classify(error);
  }
}

/**
 * Dismisses a review, and optionally replaces its text.
 *
 * The closest thing to an undo that exists. **A submitted GitHub review cannot be deleted**: there
 * is no API for it, the text stays in the timeline and it is already in everyone's inbox. Dismissing
 * removes the blocking state; replacing the body is what turns "this was wrong" into something a
 * reader of the thread can see. The two are useless separately, which is why one function does both.
 */
export async function dismissReview(input: {
  readonly slug: string;
  readonly number: number;
  readonly reviewId: number;
  readonly reason: string;
  readonly replacementPath: string | null;
}): Promise<WriteOutcome> {
  try {
    await spawnOffThread({
      file: 'gh',
      args: [
        'api',
        '--method',
        'PUT',
        `repos/${input.slug}/pulls/${input.number}/reviews/${input.reviewId}/dismissals`,
        '-f',
        'event=DISMISS',
        '-f',
        `message=${input.reason}`,
      ],
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: GH_ENV,
    });
  } catch (error) {
    return classify(error);
  }

  if (input.replacementPath !== null) {
    try {
      await spawnOffThread({
        file: 'gh',
        args: [
          'api',
          '--method',
          'PUT',
          `repos/${input.slug}/pulls/${input.number}/reviews/${input.reviewId}`,
          '-F',
          `body=@${input.replacementPath}`,
        ],
        timeout: TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: GH_ENV,
      });
    } catch (error) {
      // The dismissal landed, which is the half that unblocks the merge. Reported as a failure all
      // the same, because the text a reader sees is still the wrong one.
      return classify(error);
    }
  }
  return { kind: 'posted', reviewId: input.reviewId, url: '' };
}

/**
 * Tells "GitHub said no" from "we do not know".
 *
 * A killed process or a dead worker means the request may have been sent, so the outcome is
 * `unknown` and the caller does nothing about it. Everything else is a refusal `gh` reported, which
 * means nothing was written.
 */
function classify(error: unknown): WriteOutcome {
  if (typeof error === 'object' && error !== null) {
    const failure = error as {
      killed?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    if (failure.killed === true) {
      return { kind: 'unknown', message: 'The call timed out: it may have reached GitHub' };
    }
    if (typeof failure.stdout === 'string' && failure.stdout.includes('"message"')) {
      try {
        const parsed: unknown = JSON.parse(failure.stdout);
        const message = (parsed as { message?: unknown }).message;
        if (typeof message === 'string' && message.length > 0) {
          return { kind: 'failed', message };
        }
      } catch {
        // Not JSON after all; fall through.
      }
    }
    if (typeof failure.stderr === 'string' && failure.stderr.trim().length > 0) {
      const first = failure.stderr.trim().split('\n')[0] ?? '';
      // A lane that died says so rather than naming a GitHub error, and the request is then in the
      // same unknown state as a timeout.
      if (first.includes('command runner')) {
        return { kind: 'unknown', message: first };
      }
      return { kind: 'failed', message: first };
    }
    if (typeof failure.message === 'string' && failure.message.length > 0) {
      return { kind: 'failed', message: failure.message };
    }
  }
  return { kind: 'failed', message: String(error) };
}
