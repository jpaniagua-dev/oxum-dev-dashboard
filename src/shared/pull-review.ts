import type { PullRequest, PullReview } from './contracts.js';

/**
 * Files a pull request should not exceed, by team convention.
 *
 * Soft: nothing enforces it, and a lockfile or a mechanical rename can legitimately push a pull
 * request over. What it forbids is a large one **by default**, when a split was available and was
 * simply not considered. Shown as a pill and given to the review run, from here, because a number
 * the badge and the prompt disagreed about would make the verdict argue with the row next to it.
 */
export const PR_FILE_SOFT_LIMIT = 20;

/**
 * Whether a stored review still describes the pull request as it stands.
 *
 * Shared between the renderer, which decides whether to draw the `Approve` button at all, and the
 * main process, which decides whether a click may write. Two implementations of "is this review
 * current" is exactly how the button and the handler would end up disagreeing, the lesson already
 * paid for by `verdictFor` and `isStaged`.
 *
 * **An empty sha on either side is not current.** The poll leaves `headSha` empty when the payload
 * did not carry it, and a review read off an older file has none either: not knowing which commit a
 * verdict is about is an answer, and the direction to be wrong in is the one that asks for another
 * review rather than the one that approves a commit nobody read.
 */
export function isReviewCurrent(review: PullReview, pull: PullRequest): boolean {
  if (review.headSha.length === 0 || pull.headSha.length === 0) {
    return false;
  }
  return review.headSha === pull.headSha;
}

/** The key a review is stored under. `owner/repo#12` is the pull request's identity. */
export function reviewKey(slug: string, number: number): string {
  return `${slug}#${number}`;
}
