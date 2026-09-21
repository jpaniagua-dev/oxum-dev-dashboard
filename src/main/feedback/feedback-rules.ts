import type { AutoRunRecord, PullRequest } from '@shared/contracts.js';
import { sameLogin } from '../github/bot-findings.js';
import type { ReviewComment } from '../github/review-comments.js';
import { nextWatermark } from '../github/review-comments.js';
import type { FeedbackGateInput } from './feedback-gate.js';
import { feedbackRefusal } from './feedback-gate.js';

/**
 * The arithmetic of the feedback watcher, with nothing that touches the network.
 *
 * All of it pure and all of it exported, for the reason `selectIssues` sits in its own file: the
 * watcher cannot be imported into a test without Electron behind it, and every mistake available here
 * is silent. A comment wrongly counted as new starts an agent nobody asked for; one wrongly counted as
 * old is feedback that is never mentioned again.
 */

/**
 * The pull request an unattended run produced, found in the poll payload rather than asked for.
 *
 * Nothing in this app observes the agent running `gh pr create`, so the number has to be recovered,
 * and `gh pr list` already returns the branch and the author for every open pull request of every
 * followed repository. That makes the match arithmetic on a payload the poll just produced, which is
 * the same trick the Worktrees tab's `PR checks` column is built on: no call, no channel, no cost.
 *
 * ⚠️ It is also the weakest link in the chain, knowingly. The branch is named by the skill and not by
 * this app, so the match rests on a convention rather than on a fact, and a renamed branch breaks it in
 * silence. That is why `prMatchedAt` is a stored state and why the row carries a way to pin the number
 * by hand.
 *
 * Matched on the **ticket key plus its separator**, and on the author being us. It cannot be an exact
 * branch comparison: the app never learns the branch, the skill invents the kebab half of it, so the
 * key is the only part of the name this side knows. The trailing dash is what makes the prefix safe,
 * `TEC-12-` not being a prefix of `TEC-123-`; without it one ticket's watcher would attach itself to
 * another ticket's pull request. The branch is then **learned** from the match and stored, which is
 * what the merge watcher needs later.
 */
export function matchRunPull(
  record: AutoRunRecord,
  pulls: readonly PullRequest[],
  viewerLogin: string,
): PullRequest | null {
  const prefix = `${record.ticketKey.trim().toUpperCase()}-`;
  if (prefix.length < 2 || viewerLogin.length === 0) {
    return null;
  }
  const found = pulls.find(
    (pull) =>
      pull.branch.toUpperCase().startsWith(prefix) && sameLogin(pull.authorLogin, viewerLogin),
  );
  return found ?? null;
}

/**
 * The comments that arrived since the watermark and were not written by us.
 *
 * The second half is the whole of the loop protection at this level. The `gh` token is the user's, so
 * every reply the pass posts comes back authored by the viewer: one comparison excludes them, with no
 * marker, no HTML comment and no convention to keep in step with the agent.
 *
 * An **empty viewer login yields nothing**, belt to the gate's braces. With an empty login the
 * comparison is false for every row, so the pass would read its own replies as feedback and relaunch;
 * refusing here as well means a future caller that forgets the gate still cannot start that loop.
 *
 * Accepted corollary, stated rather than discovered: a comment the **user** types on their own pull
 * request is indistinguishable from one the agent posted through `gh`, and therefore starts nothing.
 * That is the honest price of a single-identity token, and the manual entry is the way round it.
 */
export function newFeedback(
  comments: readonly ReviewComment[],
  watermark: number,
  viewerLogin: string,
): ReviewComment[] {
  if (viewerLogin.length === 0) {
    return [];
  }
  return comments.filter(
    (comment) => comment.id > watermark && !sameLogin(comment.authorLogin, viewerLogin),
  );
}

/** What a tick concluded about one record, so the caller can act and report with the same value. */
export interface RunAdvance {
  readonly record: AutoRunRecord;
  /** Set when the pass may start. The caller spawns, and only then. */
  readonly start: boolean;
}

/**
 * One record, advanced by one poll, or `null` when nothing moved.
 *
 * `null` rather than an equal record, reusing the rule `applyLiveToTickets` set: a quiet poll must not
 * rewrite `auto-runs.json` every three minutes, and "nothing moved" is a fact the caller acts on rather
 * than a value it has to compare.
 *
 * The watermark advances on every tick that saw comments, **except** while a pass is running: a pass in
 * flight has not accounted for anything yet, and moving the mark under it would lose the very comments
 * it was started for.
 */
export function advanceRun(
  record: AutoRunRecord,
  comments: readonly ReviewComment[],
  viewerLogin: string,
  gate: Omit<FeedbackGateInput, 'newCount'>,
  now: Date,
): RunAdvance | null {
  const fresh = newFeedback(comments, record.lastSeenCommentId, viewerLogin);
  const refusal = feedbackRefusal({ ...gate, newCount: fresh.length });

  if (refusal === 'A feedback pass is already running on this pull request') {
    // Nothing is recorded under a running pass, not even the refusal: the row already says `passing`,
    // and advancing the mark here would hide what the pass was started to read.
    return null;
  }

  if (refusal === null) {
    return {
      start: true,
      record: {
        ...record,
        feedbackPhase: 'passing',
        lastSeenCommentId: nextWatermark(comments, record.lastSeenCommentId),
        feedbackStartedAt: now.toISOString(),
        feedbackFinishedAt: null,
        pendingCount: 0,
        notice: `Treating ${fresh.length} new ${fresh.length === 1 ? 'comment' : 'comments'}`,
        lastRefusal: null,
      },
    };
  }

  const pendingCount = record.pendingCount + fresh.length;
  const advanced: AutoRunRecord = {
    ...record,
    lastSeenCommentId: nextWatermark(comments, record.lastSeenCommentId),
    pendingCount,
    // The sentence is about what is waiting, not about the rule, whenever something is actually
    // waiting: "3 comments nobody has looked at" is what a reader needs, and the rule is one hover away.
    notice:
      pendingCount > 0
        ? `${pendingCount} ${pendingCount === 1 ? 'comment' : 'comments'} waiting on you`
        : record.notice,
    lastRefusal: refusal,
  };

  return changed(record, advanced) ? { record: advanced, start: false } : null;
}

function changed(before: AutoRunRecord, after: AutoRunRecord): boolean {
  return (
    before.lastSeenCommentId !== after.lastSeenCommentId ||
    before.pendingCount !== after.pendingCount ||
    before.notice !== after.notice ||
    before.lastRefusal !== after.lastRefusal
  );
}
