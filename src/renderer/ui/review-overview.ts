import type { PullRequest, PullReview } from '@shared/contracts.js';
import { isReviewCurrent } from '@shared/pull-review.js';
import { clearChildren, createElement } from './dom.js';
import { presentPullVerdict } from './presenters.js';
import { buildPill } from './project-table.js';

/**
 * Everything the review has to say about one pull request.
 *
 * Its own column for the reason the Triage tab has one: a verdict is worth as much as the reason
 * behind it, and checking that reason used to mean opening the pull request in a browser, which is
 * the trip this tab exists to save. Blocks in a fixed order, so the eye learns where the findings
 * are.
 */

export interface ReviewOverviewActions {
  readonly onOpenPull: (url: string) => void;
  /** Submits one of the three review events by hand. */
  readonly onSubmit: (slug: string, number: number, event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT') => void;
  /** Runs the review again on this one pull request, whatever its stored verdict says. */
  readonly onReview: (projectId: string, number: number) => void;
  /** Drops the row. Local: nothing already posted is unsaid by it. */
  readonly onDismiss: (slug: string, number: number) => void;
  /** Dismisses a posted review on GitHub and replaces its text. There is no delete. */
  readonly onRetract: (slug: string, number: number) => void;
  /** Checks the pull request out in a worktree and starts its dev server. */
  readonly onOpenWorkspace: (projectId: string, number: number) => void;
}

export function renderReviewOverview(
  host: HTMLElement,
  pull: PullRequest | undefined,
  review: PullReview | undefined,
  projectId: string | null,
  body: string,
  actions: ReviewOverviewActions,
): void {
  clearChildren(host);

  if (pull === undefined) {
    host.append(
      createElement('p', {
        className: 'triage__overview-empty',
        text: 'Pick a pull request to see what the review said.',
      }),
    );
    return;
  }

  const head = createElement('div', { className: 'triage__overview-head' });
  head.append(createElement('span', { className: 'triage__overview-key', text: `#${pull.number}` }));
  if (review !== undefined) {
    head.append(buildPill(presentPullVerdict(review.verdict, isReviewCurrent(review, pull))));
  }
  head.append(createElement('span', { className: 'triage__overview-summary', text: pull.title }));
  host.append(head);

  const facts = [
    pull.authorLogin.length > 0 ? pull.authorLogin : 'unknown author',
    `${pull.changedFiles} file(s)`,
    pull.isDraft ? 'draft' : '',
  ].filter((fact) => fact.length > 0);
  host.append(createElement('span', { className: 'triage__meta', text: facts.join(' · ') }));

  if (review === undefined) {
    host.append(
      createElement('p', {
        className: 'pulls__empty',
        text: 'Not reviewed yet. Press Review on the row, or run the whole repository.',
      }),
    );
    host.append(buildActions(pull, undefined, projectId, actions));
    return;
  }

  if (!isReviewCurrent(review, pull)) {
    /*
     * The one line that has to be louder than the verdict above it.
     *
     * A review is about one commit. Once the head has moved, every word in this column describes
     * code that is no longer what would merge, and a reader acting on it would be acting on the
     * wrong diff. Stated rather than implied by a faded pill, because the pill is a colour and this
     * is a fact.
     */
    host.append(
      createElement('p', {
        className: 'pulls__error',
        text: 'The head has moved since this review. Review it again before acting on it.',
      }),
    );
  }

  if (review.error !== null) {
    host.append(createElement('p', { className: 'pulls__error', text: review.error }));
  }

  if (review.summary.length > 0) {
    host.append(createElement('p', { className: 'triage__block-text', text: review.summary }));
  }

  if (review.oversized) {
    host.append(
      createElement('span', {
        className: 'triage__meta',
        text: `${review.changedFiles} files: past what a reviewer reads rather than skims.`,
      }),
    );
  }

  if (review.findings.length === 0) {
    host.append(createElement('p', { className: 'pulls__empty', text: 'No finding.' }));
  } else {
    for (const finding of review.findings) {
      const block = createElement('div', {
        className: `pulls__finding${finding.blocking ? ' pulls__finding--blocking' : ''}`,
      });
      const where =
        finding.path.length === 0
          ? finding.id
          : `${finding.id} · ${finding.path}${finding.line === null ? '' : `:${finding.line}`}`;
      block.append(createElement('span', { className: 'pulls__finding-where', text: where }));
      block.append(createElement('span', { text: finding.body }));
      host.append(block);
    }
  }

  if (review.bot.length > 0) {
    host.append(
      createElement('span', {
        className: 'triage__meta',
        // The badge is reproduced, not ranked: only two of its levels have ever been seen here, and
        // the run weighed the remarks on their merits rather than on their label.
        text: `Automated reviewer: ${review.bot.length} remark(s) weighed${describeBadges(review)}`,
      }),
    );
  }

  if (body.length > 0) {
    host.append(
      createElement('span', {
        className: 'triage__block-label',
        text: review.posted === null ? 'What would be posted' : 'What was posted',
      }),
    );
    host.append(createElement('div', { className: 'pulls__body', text: body }));
  }

  host.append(buildActions(pull, review, projectId, actions));
}

/** The badges the automated reviewer used, verbatim, or nothing when it used none. */
function describeBadges(review: PullReview): string {
  const badges = [...new Set(review.bot.map((finding) => finding.severity).filter((s) => s.length > 0))];
  return badges.length === 0 ? '' : ` (${badges.join(', ')})`;
}

function buildActions(
  pull: PullRequest,
  review: PullReview | undefined,
  projectId: string | null,
  actions: ReviewOverviewActions,
): HTMLElement {
  const row = createElement('div', { className: 'triage__overview-actions' });

  const again = createElement('button', {
    className: 'button button--primary',
    text: review === undefined ? 'Review' : 'Review again',
    title:
      review === undefined
        ? 'Reads the patch and judges it. Minutes, and it posts nothing by itself unless it finds something blocking.'
        : 'Reads it again from scratch, whatever the stored verdict says.',
  });
  again.type = 'button';
  if (projectId !== null) {
    again.addEventListener('click', () => actions.onReview(projectId, pull.number));
  } else {
    again.disabled = true;
  }
  row.append(again);

  /*
   * The gesture the whole feature exists around, for the reader who guarantees consistency: check
   * this pull request out and look at it running. A full word and not an icon, because it creates a
   * folder and starts a server, which is not something to discover by hovering.
   */
  const workspace = createElement('button', {
    className: 'button',
    text: 'Open as a workspace',
    title:
      'Checks this pull request out in its own worktree and starts the dev server on a free port, ' +
      'so it can be looked at rather than only read.',
  });
  workspace.type = 'button';
  if (projectId !== null) {
    workspace.addEventListener('click', () => actions.onOpenWorkspace(projectId, pull.number));
  } else {
    workspace.disabled = true;
  }
  row.append(workspace);

  /*
   * The three writes, and `Approve` is the one with a condition rather than a dialog.
   *
   * No confirmation in front of it: a box answered twenty times a day is a reflex, not a decision,
   * and a reflex is worse than no barrier because it looks like one. The safety is in preconditions
   * a fast click cannot outrun, all of them re-checked in the main process at the moment of the
   * click, and the refusal names both shas when the head has moved.
   *
   * Absent entirely rather than disabled on a review that cannot be acted on: a button whose only
   * possible outcome is a refusal is a trap, the rule the amend already applies to an upstream
   * commit.
   */
  if (review !== undefined && review.postable) {
    const approve = createElement('button', {
      className: 'button button--primary',
      text: 'Approve',
      title:
        'Submits an approval on GitHub, under your name. It is refused if the head has moved since ' +
        'this review.',
    });
    approve.type = 'button';
    approve.addEventListener('click', () => actions.onSubmit(review.slug, review.number, 'APPROVE'));
    row.append(approve);

    const block = createElement('button', {
      className: 'button',
      text: 'Request changes',
      title: 'Posts the body above and blocks the merge until it is dismissed.',
    });
    block.type = 'button';
    block.addEventListener('click', () =>
      actions.onSubmit(review.slug, review.number, 'REQUEST_CHANGES'),
    );
    row.append(block);

    const comment = createElement('button', {
      className: 'button',
      text: 'Comment',
      title: 'Posts the body above without blocking the merge.',
    });
    comment.type = 'button';
    comment.addEventListener('click', () => actions.onSubmit(review.slug, review.number, 'COMMENT'));
    row.append(comment);
  }

  const open = createElement('button', { className: 'button', text: `Open #${pull.number}` });
  open.type = 'button';
  open.addEventListener('click', () => actions.onOpenPull(pull.url));
  row.append(open);

  /*
   * The only recovery that exists, and its label says which one it is.
   *
   * A submitted GitHub review cannot be deleted: the text stays in the timeline and it is already in
   * everybody's inbox. What this does is dismiss it, which unblocks the merge, and replace its body,
   * which is what a reader of the thread sees. "Retract" and not "Delete", because a button that
   * promised a delete would be promising something the API does not do.
   */
  if (review?.posted != null) {
    const retract = createElement('button', { className: 'button', text: 'Retract on GitHub' });
    retract.type = 'button';
    retract.title =
      'Dismisses the review and replaces its text with a line saying it was posted in error. ' +
      'A submitted review cannot be deleted: this is the closest thing there is.';
    retract.addEventListener('click', () => actions.onRetract(review.slug, review.number));
    row.append(retract);
  }

  if (review !== undefined) {
    const dismiss = createElement('button', { className: 'button', text: 'Remove from the list' });
    dismiss.type = 'button';
    dismiss.title =
      'Drops this row. The pull request is untouched, anything already posted stays posted, and ' +
      'reviewing it again brings the row back.';
    dismiss.addEventListener('click', () => actions.onDismiss(review.slug, review.number));
    row.append(dismiss);
  }

  return row;
}
