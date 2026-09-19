import type {
  ProjectId,
  PullRequest,
  PullReviewSkips,
  PullReviewTarget,
  RepoPulls,
} from '@shared/contracts.js';
import { reviewKey } from '@shared/pull-review.js';
import { BOT_AUTHORS, MAX_CHANGED_FILES, MAX_PRS_PER_REPO, MAX_PRS_PER_RUN } from './review-limits.js';

/** One pull request a run will read, with the repository it belongs to. */
export interface PullTarget {
  readonly projectId: ProjectId;
  readonly slug: string;
  readonly pull: PullRequest;
  /**
   * Whether anything may be posted about it.
   *
   * False on your own pull request, and that is the **only** thing that turns it off here: GitHub
   * refuses to approve or request changes on your own, so a run that posted would fail with an API
   * error after spending minutes. The review still happens and is still shown, which on your own
   * work is the useful half.
   */
  readonly postable: boolean;
}

export interface Selection {
  readonly selected: PullTarget[];
  readonly skipped: PullReviewSkips;
  /** `owner/repo#12` of what the cap deferred, so the run can name it rather than truncate silently. */
  readonly deferred: string[];
}

const NOTHING_SKIPPED: PullReviewSkips = {
  draft: 0,
  bot: 0,
  blocked: 0,
  alreadyReviewed: 0,
  tooLarge: 0,
  overLimit: 0,
};

/**
 * Which pull requests a run is given, and what it leaves behind.
 *
 * Pure and on its own, away from the service, for the reason `selectIssues` is: this is where a
 * mistake is silent. A filter that drops too much produces a short list, and a short list is
 * indistinguishable from a quiet week. Hence the counts coming back beside the selection rather than
 * a bare array, and hence the rules being **ordered**, so a pull request matching two of them is
 * counted once and always under the same one.
 *
 * The order, and it is the contract:
 *
 * 1. **not in the target** (another repository, another number): not a skip, it was never asked for
 * 2. **opened by a bot**: nobody is waiting on a human opinion about a lockfile bump
 * 3. **already blocked** by somebody's `changes-requested`: a second block says nothing new
 * 4. **draft**: it is not asking for review yet, and the review bot already covers drafts
 * 5. **too large**: skipped rather than read in part, because half a diff produces a confident
 *    verdict about code nobody saw
 * 6. **already reviewed at this exact head**, in `new` mode only
 * 7. **over the cap**, per repository then per run, and what is left over is **named**
 *
 * Rules 2, 3, 4 and 6 are the "nobody asked" family and an **explicit single-pull target overrides
 * them all**: clicking `Review` on a draft is asking for that draft. Rule 5 is not in that family
 * and overrides nothing, because it is not about who asked but about whether an honest answer is
 * possible at all.
 */
export function selectPulls(input: {
  readonly repos: readonly RepoPulls[];
  /** Key from `reviewKey`, value the head sha the stored review was about. */
  readonly reviewed: ReadonlyMap<string, string>;
  readonly target: PullReviewTarget;
  /** The signed-in login. Empty disables the feature upstream, so it only makes everything postable. */
  readonly viewerLogin: string;
}): Selection {
  const explicit = input.target.kind === 'pull';
  const skips = { ...NOTHING_SKIPPED };
  const deferred: string[] = [];
  const selected: PullTarget[] = [];

  for (const repo of input.repos) {
    if (repo.slug === null) {
      continue;
    }
    if (input.target.projectId !== null && repo.projectId !== input.target.projectId) {
      continue;
    }

    const eligible: PullTarget[] = [];
    for (const pull of ordered(repo.pulls)) {
      if (input.target.kind === 'pull' && pull.number !== input.target.number) {
        continue;
      }
      if (!explicit && isBotAuthor(pull.authorLogin)) {
        skips.bot += 1;
        continue;
      }
      if (!explicit && pull.review === 'changes-requested') {
        skips.blocked += 1;
        continue;
      }
      if (!explicit && pull.isDraft) {
        skips.draft += 1;
        continue;
      }
      if (pull.changedFiles > MAX_CHANGED_FILES) {
        skips.tooLarge += 1;
        continue;
      }
      if (!explicit && input.target.kind === 'new' && isReviewedAtHead(input.reviewed, repo.slug, pull)) {
        skips.alreadyReviewed += 1;
        continue;
      }
      eligible.push({
        projectId: repo.projectId,
        slug: repo.slug,
        pull,
        // `isAuthor` is false for everything when `gh` is not signed in, which would make every pull
        // request look like somebody else's. The feature is disabled upstream in that case; the
        // belt here is the login being empty, so nothing is ever postable on a guess.
        postable: input.viewerLogin.length > 0 && !pull.isAuthor,
      });
    }

    // Per repository first, so one busy repository cannot fill the run on its own.
    const taken = explicit ? eligible : eligible.slice(0, MAX_PRS_PER_REPO);
    for (const target of eligible.slice(taken.length)) {
      skips.overLimit += 1;
      deferred.push(reviewKey(target.slug, target.pull.number));
    }
    selected.push(...taken);
  }

  if (!explicit && selected.length > MAX_PRS_PER_RUN) {
    for (const target of selected.slice(MAX_PRS_PER_RUN)) {
      skips.overLimit += 1;
      deferred.push(reviewKey(target.slug, target.pull.number));
    }
    return { selected: selected.slice(0, MAX_PRS_PER_RUN), skipped: skips, deferred };
  }

  return { selected, skipped: skips, deferred };
}

/**
 * The order the cap eats from: what is waiting on you first, then the longest waiting.
 *
 * A cap has to choose, and choosing by the order `gh` happened to answer in would make two runs over
 * an unchanged repository review different pull requests. Review-requested first because that is the
 * queue this feature exists to drain; oldest next because a pull request nobody has looked at for a
 * week is the one going stale.
 */
function ordered(pulls: readonly PullRequest[]): PullRequest[] {
  return [...pulls].sort((left, right) => {
    if (left.isReviewer !== right.isReviewer) {
      return left.isReviewer ? -1 : 1;
    }
    return left.updatedAt.localeCompare(right.updatedAt);
  });
}

/**
 * Whether a stored verdict already covers this pull request **as it stands now**.
 *
 * Read at the head sha and not at the mere existence of a review, which is what makes `new` mean
 * "not reviewed in its current state" rather than "never reviewed": a pull request reviewed
 * yesterday and pushed to since is new again, and that is the case the button is pressed for. An
 * empty sha on either side never matches, for the reason `isReviewCurrent` gives.
 */
function isReviewedAtHead(
  reviewed: ReadonlyMap<string, string>,
  slug: string,
  pull: PullRequest,
): boolean {
  const stored = reviewed.get(reviewKey(slug, pull.number));
  if (stored === undefined || stored.length === 0 || pull.headSha.length === 0) {
    return false;
  }
  return stored === pull.headSha;
}

/** A pull request opened by a machine. Matched on both spellings, with and without `[bot]`. */
function isBotAuthor(login: string): boolean {
  return BOT_AUTHORS.includes(login.toLowerCase());
}
