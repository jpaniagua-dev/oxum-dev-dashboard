import type { PullVerdict } from '@shared/contracts.js';

/**
 * The one place a write to GitHub is authorised, and it is pure.
 *
 * Every refusal in this application's review path goes through here, so "when does this post?" has a
 * single answer that a test can enumerate rather than a condition spread over a service, a handler
 * and a button. The refusals carry a **sentence**, not a boolean: each one has a different fix, and a
 * row that says nothing more than "not posted" sends the reader to the code.
 */

export type ReviewEvent = 'REQUEST_CHANGES' | 'COMMENT' | 'APPROVE';

export type ReviewAction =
  | { readonly kind: 'none'; readonly reason: string }
  | { readonly kind: 'post'; readonly event: ReviewEvent };

export interface GateInput {
  /** The master switch. Off by default, so an update cannot write before it has been turned on. */
  readonly writesEnabled: boolean;
  /** Empty when `gh` is not signed in, which disables everything: see the note in `postable`. */
  readonly viewerLogin: string;
  /** A run that computes and shows but never writes. */
  readonly dryRun: boolean;
  /** False on your own pull request. GitHub refuses two of the three events there. */
  readonly postable: boolean;
  /** `OPEN`, or whatever `gh` last answered. Anything else and there is nothing to review. */
  readonly state: string;
  /** Re-read immediately before the write, never taken from the poll. */
  readonly isDraft: boolean;
  /** True when the head moved between the start of the review and now. */
  readonly headMoved: boolean;
  /** True when a review carrying our marker for this exact head is already on the pull request. */
  readonly alreadyPostedAtHead: boolean;
  /**
   * True when the signed-in account has a `CHANGES_REQUESTED` review with no marker of ours.
   *
   * Which means the user reviewed this pull request by hand. The agent never stacks on top of that:
   * a second, machine-written block under a human one the author is already answering is noise at
   * best and a contradiction at worst.
   */
  readonly humanBlockPresent: boolean;
  readonly aborted: boolean;
}

/**
 * What a finished review does about the pull request it just read.
 *
 * The order is the contract, and it runs from "this feature is off" through "this pull request is
 * not ours to write on" to "this verdict does not write". Reordering it changes nothing about which
 * pull requests post, and everything about which sentence the row shows, which is the part a reader
 * acts on.
 */
export function decideAction(verdict: PullVerdict, input: GateInput): ReviewAction {
  const blocked = refusal(input);
  if (blocked !== null) {
    return { kind: 'none', reason: blocked };
  }

  switch (verdict) {
    case 'request-changes':
      return { kind: 'post', event: 'REQUEST_CHANGES' };
    case 'approve':
      // Never automatic, and this is the asymmetry the whole feature is built on: the write that
      // unblocks a merge stays a human click, the write that stops one is what the run is for.
      return { kind: 'none', reason: 'Approving is a click, never a run' };
    case 'comment':
      return { kind: 'none', reason: 'Nothing blocking: post the remarks yourself if they are worth it' };
    case 'unclear':
      // The fallback of an answer that could not be read. It must never reach a write: that is what
      // keeps a parse failure from putting text on a colleague's pull request.
      return { kind: 'none', reason: 'The review could not be read' };
  }
}

/**
 * What a button does, when the user asks for one of the three events by hand.
 *
 * The same preconditions as a run, minus the verdict: the user has decided, so the only questions
 * left are whether this application may write at all and whether the pull request is still the one
 * that was read. `APPROVE` carries one more, since approving is what unblocks a merge.
 */
export function decideManual(event: ReviewEvent, input: GateInput & { readonly reviewIsCurrent: boolean }): ReviewAction {
  const blocked = refusal(input);
  if (blocked !== null) {
    return { kind: 'none', reason: blocked };
  }
  if (event === 'APPROVE' && !input.reviewIsCurrent) {
    return {
      kind: 'none',
      reason: 'The review on screen is about another commit: run it again before approving',
    };
  }
  return { kind: 'post', event };
}

/** Every reason nothing may be written, in a fixed order, or `null` when writing is allowed. */
function refusal(input: GateInput): string | null {
  if (!input.writesEnabled) {
    return 'Writing to GitHub is turned off in the settings';
  }
  if (input.viewerLogin.length === 0) {
    // Not a detail: an empty login makes every `isAuthor` comparison false, so every pull request
    // would look like somebody else's and everything would look postable.
    return 'gh is not signed in';
  }
  if (input.dryRun) {
    return 'Dry run: nothing was posted';
  }
  if (input.aborted) {
    return 'The run was stopped before this one was posted';
  }
  if (!input.postable) {
    return 'Your own pull request: GitHub does not allow reviewing it';
  }
  if (input.state !== 'OPEN') {
    return `The pull request is ${input.state.toLowerCase()}`;
  }
  if (input.isDraft) {
    return 'The pull request went back to draft while it was being reviewed';
  }
  if (input.headMoved) {
    return 'The head moved while it was being reviewed';
  }
  if (input.humanBlockPresent) {
    return 'You already requested changes on this one by hand';
  }
  if (input.alreadyPostedAtHead) {
    return 'Already reviewed at this commit';
  }
  return null;
}
