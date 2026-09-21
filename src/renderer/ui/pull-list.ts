import type {
  AutoRunRecord,
  ProjectId,
  PullRequest,
  PullReview,
  PullReviewState,
  PullReviewTarget,
  PullScope,
  RepoPulls,
} from '@shared/contracts.js';
import { isReviewCurrent, reviewKey, PR_FILE_SOFT_LIMIT } from '@shared/pull-review.js';
import { clearChildren, createElement, createIconButton, hitsInteractive } from './dom.js';
import { RUN_ICON, RUN_NEW_ICON, TERMINAL_ICON } from './icons.js';
import { buildPill } from './project-table.js';
import {
  describeReviewCoverage,
  presentInvolvement,
  presentPullChecks,
  presentPullVerdict,
  presentReview,
} from './presenters.js';
import { buildTagDots, type TagPalette } from './tags.js';

/** The two sub-tabs, in display order. Labelled here so the view and its counts stay together. */
export const PULL_SCOPES: readonly { id: PullScope; label: string; hint: string }[] = [
  {
    id: 'mine',
    label: 'Mine',
    hint: 'The PRs you authored or are a requested reviewer on',
  },
  { id: 'all', label: 'All', hint: 'Every open PR in this repository' },
];

export interface PullListActions {
  /**
   * Opens **a new** shell in the repository's folder.
   *
   * Same meaning as the `Terminal` button of the project table, on purpose: one label, one behaviour.
   * Two buttons reading `Terminal` and doing different things would be worse than either choice.
   */
  onNewTerminal: (projectId: ProjectId) => void;
  /**
   * Opens a pull request on GitHub.
   *
   * What a click on a row does. The two gestures were the other way round until use decided it: the
   * reflex in front of a pull request list is to go read the pull request, and the terminal is the
   * deliberate move.
   */
  onOpenPull: (url: string) => void;
  /** Remembers which repository is selected, so a refresh does not jump back to the first. */
  onSelect: (projectId: ProjectId) => void;
  /** Switches between "the ones that need me" and "everything open here". */
  onSelectScope: (scope: PullScope) => void;
  /**
   * Remembers which pull request the overview describes.
   *
   * New with the review column, and it is what changed the meaning of a click on a row. Until there
   * was something local to show, going to GitHub was the only thing a click could usefully do; now
   * the reason for a verdict is on this machine, so reading it is the everyday gesture and the
   * browser is the deliberate one, behind a button. Same reversal the Triage tab made, for the same
   * reason and with the same grammar.
   */
  onSelectPull: (number: number) => void;
  /** Starts a review run. The target says which pull requests and how much of them. */
  onReview: (target: PullReviewTarget) => void;
  /** Stops the run at the next step it can stop at. */
  onCancelReview: () => void;
  /**
   * Opens a pull request's own menu, from a right click on its row.
   *
   * Where the state changes live (ready, draft), for the reason the Git tab puts its destructive
   * entries behind one: this list is clicked all day to read verdicts, and a control that changes
   * what the team sees has no business under a cursor that is browsing.
   */
  onRowMenu: (pull: PullRequest, x: number, y: number) => void;
}

/**
 * Pull requests that involve the user: author, or review requested.
 *
 * The question the tab was built to answer, and on an active repository the full list buries it.
 * Kept as its own function rather than folded into `scopedPulls` because the count it produces is
 * shown next to the widened list too, which is what makes the widened list readable.
 */
export function ownPulls(repo: RepoPulls): PullRequest[] {
  return repo.pulls.filter((pull) => pull.isAuthor || pull.isReviewer);
}

/**
 * Pull requests for a scope.
 *
 * Both scopes come out of the **same payload**: `gh pr list` returns every open pull request in one
 * call, and the "mine" filter has always been local. That is why the second sub-tab costs no request
 * at all — the widening had been paid for since the tab was written, it simply had no way in.
 */
export function scopedPulls(repo: RepoPulls, scope: PullScope): PullRequest[] {
  return scope === 'all' ? [...repo.pulls] : ownPulls(repo);
}

/**
 * Renders the repository column, the two scope sub-tabs, and the pull requests of the selection.
 *
 * A master-detail rather than one flat list: the counter per repository is itself the glance-level
 * answer ("three of mine are waiting on web-app"), and the detail stays readable in a strip
 * that is only a few hundred pixels tall.
 */
export function renderPullList(
  hosts: { repos: HTMLElement; views: HTMLElement; bar: HTMLElement; list: HTMLElement },
  repos: readonly RepoPulls[],
  selected: ProjectId | null,
  scope: PullScope,
  tags: TagPalette,
  review: PullReviewState,
  autoRuns: readonly AutoRunRecord[],
  actions: PullListActions,
): void {
  clearChildren(hosts.repos);
  clearChildren(hosts.views);
  clearChildren(hosts.bar);
  clearChildren(hosts.list);

  if (repos.length === 0) {
    hosts.repos.append(
      createElement('p', {
        className: 'pulls__empty',
        text: 'No repository followed. Tick "Follow pull requests" on a project in the settings.',
      }),
    );
    return;
  }

  const active = repos.find((repo) => repo.projectId === selected) ?? repos[0];

  for (const repo of repos) {
    const mine = ownPulls(repo);
    const row = createElement('button', {
      className: `pulls__repo${repo.projectId === active?.projectId ? ' pulls__repo--active' : ''}`,
    });
    row.type = 'button';
    /*
     * Before the name and not after it, so the dots of the whole column line up on one edge: a strip
     * that followed the name would sit at a different offset on every row, which is the alignment this
     * column is scanned on. Absent entirely for an untagged repository rather than reserved as an
     * empty gutter: most of a workspace carries no tag at all, so the gutter would be paid for by
     * every row to align the few that have one.
     */
    const dots = buildTagDots(tags, repo.projectId);
    if (dots !== null) {
      row.append(dots);
    }
    row.append(createElement('span', { className: 'pulls__repo-name', text: repo.label }));

    if (repo.error !== null) {
      // Shown rather than swallowed: an unauthenticated `gh` or a dead network must be readable here
      // instead of looking like a repository with no pull requests.
      row.append(createElement('span', { className: 'pulls__repo-error', text: '!' }));
      row.title = repo.error;
    } else if (repo.slug === null) {
      row.append(createElement('span', { className: 'pulls__repo-count', text: '—' }));
      row.title = 'This repository has no GitHub remote';
    } else {
      // The count follows the selected scope, or the badge would contradict the list next to it.
      row.append(
        createElement('span', {
          className: 'pulls__repo-count',
          text: String(scopedPulls(repo, scope).length),
        }),
      );
      row.title = `${repo.slug}\n${repo.pulls.length} open PR(s), ${mine.length} involving you`;
    }

    row.addEventListener('click', () => actions.onSelect(repo.projectId));

    /*
     * The pair of run buttons, on the row, exactly as the Triage tab puts them on a sprint.
     *
     * Both are always drawn, including on a repository nobody has reviewed where they do the same
     * thing: a button that appeared once a result existed would shift the other one sideways between
     * two states of the same row. The everyday one is on the left and reads only what has moved,
     * because re-reading nine unchanged pull requests costs minutes for verdicts nobody asked to
     * change.
     */
    const line = createElement('div', { className: 'git__repo-line' });
    line.append(row);
    if (repo.slug !== null) {
      const runs = createElement('div', { className: 'triage__actions' });
      runs.append(
        buildRunButton(RUN_NEW_ICON, {
          label: `Review what is new in ${repo.label}`,
          title: 'Reviews only the pull requests no verdict covers at their current head',
          busy: review.running,
          onRun: () => actions.onReview({ kind: 'new', projectId: repo.projectId }),
        }),
      );
      runs.append(
        buildRunButton(RUN_ICON, {
          label: `Review every open pull request in ${repo.label}`,
          title: 'Reviews every open pull request here, including the ones already reviewed',
          busy: review.running,
          onRun: () => actions.onReview({ kind: 'all', projectId: repo.projectId }),
        }),
      );
      line.append(runs);
    }
    hosts.repos.append(line);
  }

  if (active === undefined) {
    return;
  }

  renderScopes(hosts.views, active, scope, actions);

  if (active.error !== null) {
    hosts.list.append(createElement('p', { className: 'pulls__error', text: active.error }));
    return;
  }

  renderBar(hosts.bar, active, review, actions);

  const pulls = scopedPulls(active, scope);
  if (pulls.length === 0) {
    hosts.list.append(
      createElement('p', {
        className: 'pulls__empty',
        text: emptyMessage(active, scope),
      }),
    );
    return;
  }

  for (const pull of pulls) {
    const stored = active.slug === null ? undefined : review.reviews[reviewKey(active.slug, pull.number)];
    const autoRun = findRun(autoRuns, active.slug, pull.number);
    hosts.list.append(
      buildPullRow(pull, active.projectId, stored, autoRun, review.running, actions),
    );
  }
}

/**
 * The line between the sub-tabs and the list: what a run is doing, or what the last one left out.
 *
 * Never both. The coverage counts describe the **previous** run, and putting them beside a live
 * status invites reading them as the one being produced, which is the rule the Triage bar already
 * states.
 */
function renderBar(
  host: HTMLElement,
  repo: RepoPulls,
  review: PullReviewState,
  actions: PullListActions,
): void {
  if (review.progress !== null) {
    const track = createElement('div', { className: 'triage__progress' });
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', 'Review in progress');
    // No `aria-valuenow`: nothing here knows how long a review takes, and inventing a percentage
    // would tell a screen reader something the sighted view is careful not to claim.
    track.append(createElement('div', { className: 'triage__progress-bar' }));
    host.append(track);
    host.append(createElement('span', { className: 'triage__phase', text: review.progress.detail }));
    host.append(
      createElement('span', {
        className: 'triage__meta',
        text: `${review.progress.done} / ${review.progress.pulls}`,
      }),
    );
    const stop = createElement('button', { className: 'button', text: 'Stop' });
    stop.type = 'button';
    stop.title = 'Stops before the next pull request. Nothing half written is left behind.';
    stop.addEventListener('click', () => actions.onCancelReview());
    host.append(stop);
    return;
  }

  if (review.error !== null) {
    host.append(createElement('span', { className: 'pulls__error', text: review.error }));
  }

  const run = repo.slug === null ? undefined : review.runs[repo.slug];
  if (run !== undefined && run.ranAt.length > 0) {
    host.append(
      createElement('span', { className: 'triage__meta', text: describeReviewAge(run.ranAt) }),
    );
  }
  const coverage = describeReviewCoverage(run);
  if (coverage.length > 0) {
    host.append(
      createElement('span', {
        className: 'triage__meta triage__coverage',
        text: coverage,
        title: 'Those pull requests were not sent to the review',
      }),
    );
  }
  if (run !== undefined && run.deferred.length > 0) {
    // Named, never truncated in silence: a run that stopped at its cap has to say which ones it did
    // not reach, or the list looks like the whole answer.
    host.append(
      createElement('span', {
        className: 'triage__meta',
        text: `Not reached: ${run.deferred.join(', ')}`,
      }),
    );
  }
  if (review.writesBlocked !== null) {
    host.append(
      createElement('span', {
        className: 'triage__meta',
        text: review.writesBlocked,
        title: 'The review runs and shows its verdicts, but nothing is written to GitHub',
      }),
    );
  }
}

/** How old a run is, in words. Relative, because the question is whether it can still be trusted. */
function describeReviewAge(iso: string, now: Date = new Date()): string {
  const ran = new Date(iso);
  if (Number.isNaN(ran.getTime())) {
    return '';
  }
  const minutes = Math.max(0, Math.round((now.getTime() - ran.getTime()) / 60_000));
  if (minutes < 1) {
    return 'Reviewed just now';
  }
  if (minutes < 60) {
    return `Reviewed ${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `Reviewed ${hours} h ago` : `Reviewed ${Math.round(hours / 24)} d ago`;
}

/** One of the two run buttons, disabled while any run is going: they share a process and a file. */
function buildRunButton(
  icon: string,
  options: { label: string; title: string; busy: boolean; onRun: () => void },
): HTMLButtonElement {
  const button = createIconButton(icon, {
    label: options.busy ? 'A review is running' : options.label,
    title: options.busy ? 'A review is already running' : options.title,
    className: `triage__analyse${options.busy ? ' triage__analyse--running' : ''}`,
  });
  button.disabled = options.busy;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    options.onRun();
  });
  return button;
}

/**
 * The two scope sub-tabs, each carrying the count it would show.
 *
 * Counts on the tabs rather than only in the list, because that is the whole reason the second view
 * exists: "0 miennes / 3 toutes" is the answer to "is this repository quiet or am I just not in it",
 * and it is readable without switching.
 *
 * Same shape as the Git tab's sub-tabs and deliberately so: one grammar for "this panel has views",
 * so there is nothing new to learn between two neighbouring tabs.
 */
function renderScopes(
  host: HTMLElement,
  repo: RepoPulls,
  scope: PullScope,
  actions: PullListActions,
): void {
  for (const entry of PULL_SCOPES) {
    const active = entry.id === scope;
    const button = createElement('button', {
      className: `subtab${active ? ' subtab--active' : ''}`,
      title: entry.hint,
    });
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(active));
    button.append(createElement('span', { text: entry.label }));
    button.append(
      createElement('span', {
        className: 'subtab__count',
        text: String(scopedPulls(repo, entry.id).length),
      }),
    );
    button.addEventListener('click', () => actions.onSelectScope(entry.id));
    host.append(button);
  }
}

/**
 * Why the list is empty, which is three different things.
 *
 * "Not read yet", "nothing open at all" and "plenty open, none of them yours" ask for three different
 * next moves, and one sentence covering all three would be the useless one.
 */
function emptyMessage(repo: RepoPulls, scope: PullScope): string {
  if (repo.checkedAt === null) {
    return 'Reading...';
  }
  if (scope === 'all') {
    return 'No open PR in this repository.';
  }
  return repo.pulls.length === 0
    ? 'No open PR in this repository.'
    : `No PR involving you, out of ${repo.pulls.length} open. See "All".`;
}

/**
 * One pull request line.
 *
 * A `div` rather than a `button`, because it carries a button of its own and nesting them is invalid
 * HTML that browsers silently rearrange. The row-level click is guarded the same way the project table
 * guards its own, so the terminal button does not also open the browser.
 */
/**
 * The unattended run this pull request came from, if it came from one.
 *
 * Matched on the pair the record itself was filed under. A pull request nobody ran unattended has no
 * record, which is the normal case and draws nothing: this tab is mostly other people's work.
 */
export function findRun(
  records: readonly AutoRunRecord[],
  slug: string | null,
  number: number,
): AutoRunRecord | undefined {
  if (slug === null) {
    return undefined;
  }
  return records.find((record) => record.slug === slug && record.prNumber === number);
}

/**
 * What the feedback watcher has to say about a row, in one short phrase.
 *
 * The notice comes first because it is about what happened; the refusal only when there is no notice,
 * being about what did not. A row that showed both would be asking its reader to work out which of the
 * two is the current fact.
 */
export function describeRun(record: AutoRunRecord | undefined): string | null {
  if (record === undefined) {
    return null;
  }
  if (record.feedbackPhase === 'passing') {
    return 'treating feedback';
  }
  return record.notice ?? record.lastRefusal;
}

function buildPullRow(
  pull: PullRequest,
  projectId: ProjectId,
  review: PullReview | undefined,
  autoRun: AutoRunRecord | undefined,
  busyReview: boolean,
  actions: PullListActions,
): HTMLElement {
  const row = createElement('div', { className: 'pull' });
  row.title = `${pull.title}\n${pull.branch}\n(click: read the review, right click: act)`;

  row.append(createElement('span', { className: 'pull__number', text: `#${pull.number}` }));
  // `textContent` everywhere: titles and branch names come from outside the app.
  row.append(createElement('span', { className: 'pull__title', text: pull.title }));

  /*
   * The author, whenever it is not the user.
   *
   * Written for the widened view, where every row would otherwise be an anonymous title, but it earns
   * its place in "mine" too: a pull request waiting on your review says "review requested" without saying
   * whose it is, which is the first thing you want to know. Omitted when it *is* yours — a column
   * repeating your own name down the whole list is what the assignee column already taught us not to do.
   */
  if (!pull.isAuthor && pull.authorLogin.length > 0) {
    row.append(
      createElement('span', {
        className: 'pull__author',
        text: pull.authorLogin,
        title: `Opened by ${pull.authorLogin}`,
      }),
    );
  }

  if (pull.isDraft) {
    row.append(createElement('span', { className: 'badge-warn', text: 'brouillon' }));
  }

  /*
   * What the feedback watcher decided, before the pills.
   *
   * Recorded facts are useless on disk: every refusal this feature can produce is a way for a row to
   * sit there doing nothing, and a reader who cannot see which rule fired has to go and read the
   * source. Muted rather than coloured, the pills after it being the ones that claim something.
   */
  const note = describeRun(autoRun);
  if (note !== null) {
    row.append(
      createElement('span', {
        className: 'pull__run-note',
        text: note,
        title: autoRun?.pendingCount
          ? `${autoRun.pendingCount} comment(s) nobody has looked at`
          : note,
      }),
    );
  }

  const involvement = presentInvolvement(pull);
  if (involvement !== null) {
    row.append(buildPill(involvement));
  }
  row.append(buildPill(presentReview(pull.review)));
  row.append(buildPill(presentPullChecks(pull)));

  /*
   * What the review concluded, after the pills GitHub answers for.
   *
   * Placed last of the three on purpose: the first two are facts about the pull request, this one is
   * an opinion about it, and an opinion reads better after the facts it was formed from. A verdict
   * about a head that has moved keeps its place in the row and loses its colour, rather than
   * disappearing: a row that dropped a pill between two paints would move every pill after it.
   */
  if (review !== undefined) {
    const current = isReviewCurrent(review, pull);
    const verdict = buildPill(presentPullVerdict(review.verdict, current));
    if (!current) {
      verdict.classList.add('pull__verdict--stale');
    }
    row.append(verdict);
  }
  if (review?.posted != null) {
    row.append(
      buildPill({
        label: 'posted',
        tone: 'info',
        title: `A review was submitted on GitHub at ${review.posted.at}`,
      }),
    );
  }
  if (pull.changedFiles > PR_FILE_SOFT_LIMIT) {
    row.append(
      buildPill({
        label: `${pull.changedFiles} files`,
        tone: 'neutral',
        title: `Past the ${PR_FILE_SOFT_LIMIT} file convention: read rather than skimmed`,
      }),
    );
  }

  row.append(createElement('span', { className: 'pull__age', text: describeAge(pull.updatedAt) }));

  /*
   * Reviewing one pull request, from its own row.
   *
   * The label says which of the two things it does, because on a row that already carries a verdict
   * the gesture is "do it again from scratch" and not "do it": the same button, whose meaning the
   * word makes explicit rather than leaving to be discovered.
   */
  const run = createIconButton(RUN_ICON, {
    label: review === undefined ? `Review #${pull.number}` : `Review #${pull.number} again`,
    title:
      review === undefined
        ? 'Reads this pull request and judges it'
        : 'Reads it again from scratch, whatever the stored verdict says',
    className: 'icon-button--row',
  });
  run.disabled = busyReview;
  run.addEventListener('click', () => actions.onReview({ kind: 'pull', projectId, number: pull.number }));
  row.append(run);

  /*
   * An icon rather than the word `Terminal`.
   *
   * The label was the widest thing on the row after the title, and it was spending that width to say
   * something the row already implies — every gesture in this app ends in a terminal tab. The glyph is
   * the same one the Git tab's repository column uses (`TERMINAL_ICON`), because it is the same gesture:
   * a new tab in that repository's folder. What the words carried moves to `aria-label` and `title`, so
   * nothing is lost for a screen reader or on hover.
   */
  const terminal = createIconButton(TERMINAL_ICON, {
    label: 'Open a terminal',
    title: 'Open a new tab in this folder',
    className: 'icon-button--row pull__terminal',
  });
  terminal.addEventListener('click', () => actions.onNewTerminal(projectId));
  row.append(terminal);

  /*
   * Clicking a row SELECTS it, where it used to open the browser.
   *
   * The reversal is deliberate and its reason is in the old rule: opening GitHub was the right
   * gesture while nothing local could show a pull request. Now the verdict and its findings are on
   * this machine, so reading them is the everyday move and the browser is the deliberate one,
   * behind a button in the overview. Exactly the grammar of the Triage tab, which made the same
   * choice for the same reason, and having the two neighbouring master-detail tabs disagree about
   * what a click means would be worse than either answer.
   */
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    // Selected first, for the reason the Triage tab's row menu does it: a menu acting on a row the
    // overview is not describing would act out of sight of the text that justifies it.
    actions.onSelectPull(pull.number);
    actions.onRowMenu(pull, event.clientX, event.clientY);
  });

  row.addEventListener('click', (event) => {
    // Without this the row's own buttons would also select on their way out.
    if (hitsInteractive(event)) {
      return;
    }
    actions.onSelectPull(pull.number);
  });
  return row;
}

/**
 * How long ago a pull request last moved, in the shortest form that stays unambiguous.
 *
 * Exported for testing. Relative rather than a date, because the useful question is "has this gone
 * stale", not "which Tuesday was it".
 */
export function describeAge(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return '';
  }
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h`;
  }
  return `${Math.round(hours / 24)} j`;
}
