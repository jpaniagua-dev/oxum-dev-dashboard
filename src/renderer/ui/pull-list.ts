import type { ProjectId, PullRequest, RepoPulls } from '@shared/contracts.js';
import { clearChildren, createElement, createIcon, hitsInteractive } from './dom.js';
import { buildPill } from './project-table.js';
import { presentInvolvement, presentPullChecks, presentReview } from './presenters.js';

export interface PullListActions {
  /**
   * Opens the repository's terminal.
   *
   * What a click on a row does, the same gesture as a click on a project row: the reflex after seeing a
   * pull request is to go work on it, not to read it again in a browser.
   */
  onOpenTerminal: (projectId: ProjectId) => void;
  /** Opens a pull request on GitHub. Its own button, since it is the deliberate detour. */
  onOpenPull: (url: string) => void;
  /** Remembers which repository is selected, so a refresh does not jump back to the first. */
  onSelect: (projectId: ProjectId) => void;
}

/**
 * Pull requests to show for one repository.
 *
 * Only the ones that involve the user: author, or review requested. That is the question the tab exists
 * to answer, and on an active repository the full list buries it. The payload carries every open pull
 * request anyway, so widening this later costs nothing.
 */
export function ownPulls(repo: RepoPulls): PullRequest[] {
  return repo.pulls.filter((pull) => pull.isAuthor || pull.isReviewer);
}

/**
 * Renders the repository column and the pull requests of the selected one.
 *
 * A master-detail rather than one flat list: the counter per repository is itself the glance-level
 * answer ("three of mine are waiting on web-app"), and the detail stays readable in a strip
 * that is only a few hundred pixels tall.
 */
export function renderPullList(
  hosts: { repos: HTMLElement; list: HTMLElement },
  repos: readonly RepoPulls[],
  selected: ProjectId | null,
  actions: PullListActions,
): void {
  clearChildren(hosts.repos);
  clearChildren(hosts.list);

  if (repos.length === 0) {
    hosts.repos.append(
      createElement('p', {
        className: 'pulls__empty',
        text: 'Aucun dépôt suivi. Coche « Suivre les pull requests » sur un projet dans les réglages.',
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
    row.append(createElement('span', { className: 'pulls__repo-name', text: repo.label }));

    if (repo.error !== null) {
      // Shown rather than swallowed: an unauthenticated `gh` or a dead network must be readable here
      // instead of looking like a repository with no pull requests.
      row.append(createElement('span', { className: 'pulls__repo-error', text: '!' }));
      row.title = repo.error;
    } else if (repo.slug === null) {
      row.append(createElement('span', { className: 'pulls__repo-count', text: '—' }));
      row.title = 'Ce dépôt n’a pas de remote GitHub';
    } else {
      row.append(createElement('span', { className: 'pulls__repo-count', text: String(mine.length) }));
      row.title = `${repo.slug}\n${repo.pulls.length} PR ouverte(s), ${mine.length} qui vous concerne(nt)`;
    }

    row.addEventListener('click', () => actions.onSelect(repo.projectId));
    hosts.repos.append(row);
  }

  if (active === undefined) {
    return;
  }
  if (active.error !== null) {
    hosts.list.append(createElement('p', { className: 'pulls__error', text: active.error }));
    return;
  }

  const mine = ownPulls(active);
  if (mine.length === 0) {
    hosts.list.append(
      createElement('p', {
        className: 'pulls__empty',
        text:
          active.checkedAt === null
            ? 'Lecture en cours…'
            : 'Aucune PR ouverte qui vous concerne sur ce dépôt.',
      }),
    );
    return;
  }

  for (const pull of mine) {
    hosts.list.append(buildPullRow(pull, active.projectId, actions));
  }
}

/**
 * One pull request line.
 *
 * A `div` rather than a `button`, because it carries a button of its own and nesting them is invalid
 * HTML that browsers silently rearrange. The row-level click is guarded the same way the project table
 * guards its own, so the GitHub button does not also open a terminal.
 */
function buildPullRow(
  pull: PullRequest,
  projectId: ProjectId,
  actions: PullListActions,
): HTMLElement {
  const row = createElement('div', { className: 'pull' });
  row.title = `${pull.title}\n${pull.branch}\n(clic : terminal du dépôt)`;

  row.append(createElement('span', { className: 'pull__number', text: `#${pull.number}` }));
  // `textContent` everywhere: titles and branch names come from outside the app.
  row.append(createElement('span', { className: 'pull__title', text: pull.title }));

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

  const open = createElement('button', { className: 'button button--quiet pull__open' });
  open.type = 'button';
  open.title = `Ouvrir la PR #${pull.number} sur GitHub`;
  open.setAttribute('aria-label', open.title);
  // Drawn rather than a character, for the same reason as the shell picker's chevron: as text its size
  // and baseline are the font's decision.
  open.append(createIcon('M6.5 3.5h-3v9h9v-3M9.5 3.5h3v3M12.2 3.8l-5 5', { paint: 'stroke' }));
  open.addEventListener('click', () => actions.onOpenPull(pull.url));
  row.append(open);

  row.addEventListener('click', (event) => {
    if (hitsInteractive(event)) {
      return;
    }
    actions.onOpenTerminal(projectId);
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
