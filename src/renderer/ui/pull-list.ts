import type { ProjectId, PullRequest, PullScope, RepoPulls } from '@shared/contracts.js';
import { clearChildren, createElement, createIconButton, hitsInteractive } from './dom.js';
import { TERMINAL_ICON } from './icons.js';
import { buildPill } from './project-table.js';
import { presentInvolvement, presentPullChecks, presentReview } from './presenters.js';
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
  hosts: { repos: HTMLElement; views: HTMLElement; list: HTMLElement },
  repos: readonly RepoPulls[],
  selected: ProjectId | null,
  scope: PullScope,
  tags: TagPalette,
  actions: PullListActions,
): void {
  clearChildren(hosts.repos);
  clearChildren(hosts.views);
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
    hosts.repos.append(row);
  }

  if (active === undefined) {
    return;
  }

  renderScopes(hosts.views, active, scope, actions);

  if (active.error !== null) {
    hosts.list.append(createElement('p', { className: 'pulls__error', text: active.error }));
    return;
  }

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
    hosts.list.append(buildPullRow(pull, active.projectId, actions));
  }
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
function buildPullRow(
  pull: PullRequest,
  projectId: ProjectId,
  actions: PullListActions,
): HTMLElement {
  const row = createElement('div', { className: 'pull' });
  row.title = `${pull.title}\n${pull.branch}\n(click: open the PR on GitHub)`;

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

  const involvement = presentInvolvement(pull);
  if (involvement !== null) {
    row.append(buildPill(involvement));
  }
  row.append(buildPill(presentReview(pull.review)));
  row.append(buildPill(presentPullChecks(pull)));
  row.append(createElement('span', { className: 'pull__age', text: describeAge(pull.updatedAt) }));

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

  row.addEventListener('click', (event) => {
    // Without this the terminal button would open the browser on its way out of the row.
    if (hitsInteractive(event)) {
      return;
    }
    actions.onOpenPull(pull.url);
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
