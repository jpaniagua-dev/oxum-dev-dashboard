import type { IssueStage, JiraIssue, JiraState, JiraViewId } from '@shared/contracts.js';
import { clearChildren, createElement } from './dom.js';
import { buildPill } from './project-table.js';
import type { Pill } from './presenters.js';

export interface JiraListActions {
  /** Opens an issue in the real browser: there is no local equivalent of a ticket. */
  onOpen: (url: string) => void;
  onSelect: (view: JiraViewId) => void;
  /** Right-click: assigning and moving an issue, which are writes and deserve a deliberate gesture. */
  onMenu: (issue: JiraIssue, x: number, y: number) => void;
}

/**
 * Where to send the browser for a project's board.
 *
 * `/browse/<KEY>` rather than a `/jira/software/...` board path, and the reason is that the board path
 * needs two things this app does not have: the numeric board id, and the project's style. Verified on
 * the real site: `PROJ` is a **team-managed** project (`style: next-gen`), whose boards live under
 * `/jira/software/projects/<KEY>/boards/<id>`, while a company-managed one uses
 * `/jira/software/c/projects/...`. Guessing between the two would 404 half the time, and resolving the
 * id means an extra Agile API call on every start.
 *
 * `/browse/<KEY>` is the one form Jira Cloud resolves for every project type and redirects to that
 * project's own default view, which for a software project is its board. Pure and exported so the
 * choice is pinned by a test rather than rediscovered.
 */
export function boardUrl(siteUrl: string, projectKey: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(projectKey.trim().toUpperCase())}`;
}

/**
 * Label and tone for an issue's stage.
 *
 * Driven by Jira's status **category**, not its name: names are per-project and renamed at will, while the
 * category is the only part of a workflow that means the same thing on every board. The status name is
 * still what gets displayed, because that is the word the team says out loud.
 */
export function presentStage(stage: IssueStage, status: string): Pill {
  const label = status.length > 0 ? status : 'sans statut';
  switch (stage) {
    case 'in-progress':
      return { label, tone: 'busy', title: 'En cours' };
    case 'done':
      return { label, tone: 'ok', title: 'Terminé' };
    case 'todo':
      return { label, tone: 'neutral', title: 'À faire' };
    case 'unknown':
      return { label, tone: 'info', title: 'Statut hors catégorie connue' };
  }
}

/**
 * Where each stage lands in the list.
 *
 * In progress first: it is the work of the day, and it is the answer to the question this tab gets
 * asked most often. `unknown` sits after `todo` — a status outside the three known categories is rare
 * and there is nothing to do about it — and `done` last, both views excluding it anyway.
 */
const STAGE_ORDER: Record<IssueStage, number> = {
  'in-progress': 0,
  todo: 1,
  unknown: 2,
  done: 3,
};

/**
 * Display order of a view's issues, in progress at the top.
 *
 * Two decisions worth keeping. It sorts on the **stage**, not on the status name, for the same reason
 * `presentStage` does: names are per-project and renamed at will ("En review", "Ready for QA") while
 * the category is the only part of a workflow that means the same thing on every board.
 *
 * And it is a **stable** sort on that single key, which is what keeps it from becoming a second
 * authority on ordering: the JQL already sorts (`status ASC, key ASC` for the sprint, `updated DESC`
 * for mine) and a stable sort keeps that order inside each group. This only lifts a group to the top.
 *
 * Done locally rather than in the JQL on purpose. `ORDER BY statusCategory DESC` happens to read as
 * "in progress, then to do" *because* both searches exclude Done — it would silently invert the day
 * someone widens the scope, and Jira's category collation is not something this app can verify from
 * here. Pure and exported so the order is pinned by a test instead of read off the screen.
 */
export function orderIssues(issues: readonly JiraIssue[]): JiraIssue[] {
  return [...issues].sort((left, right) => STAGE_ORDER[left.stage] - STAGE_ORDER[right.stage]);
}

/** Renders the two saved views and the issues of the selected one. */
export function renderJiraList(
  hosts: { views: HTMLElement; list: HTMLElement },
  state: JiraState,
  selected: JiraViewId,
  actions: JiraListActions,
  boards: { siteUrl: string; projectKeys: readonly string[] } = { siteUrl: '', projectKeys: [] },
): void {
  clearChildren(hosts.views);
  clearChildren(hosts.list);

  if (!state.configured) {
    hosts.list.append(
      createElement('p', {
        className: 'pulls__empty',
        text: 'Jira n’est pas configuré. Renseigne le site, ton email et un jeton d’API dans les réglages.',
      }),
    );
    return;
  }

  const active = state.views.find((view) => view.id === selected) ?? state.views[0];

  for (const view of state.views) {
    const row = createElement('button', {
      className: `pulls__repo${view.id === active?.id ? ' pulls__repo--active' : ''}`,
    });
    row.type = 'button';
    row.append(createElement('span', { className: 'pulls__repo-name', text: view.label }));
    if (view.error !== null) {
      row.append(createElement('span', { className: 'pulls__repo-error', text: '!' }));
      row.title = view.error;
    } else {
      row.append(
        createElement('span', { className: 'pulls__repo-count', text: String(view.issues.length) }),
      );
    }
    row.addEventListener('click', () => actions.onSelect(view.id));
    hosts.views.append(row);
  }

  /*
   * One board shortcut per configured project, under the views rather than in the strip header: the
   * header is shared with the other tabs, and a control that only makes sense here belongs here.
   */
  if (boards.siteUrl.length > 0) {
    for (const key of boards.projectKeys) {
      // A full `.button`, not `--quiet`: borderless it read as a disabled list item rather than a
      // control, sitting as it does directly under two view rows.
      const open = createElement('button', {
        className: 'button jira__board',
        text: `Ouvrir ${key}`,
        title: `Ouvrir le board ${key} dans le navigateur`,
      });
      open.type = 'button';
      open.addEventListener('click', () => actions.onOpen(boardUrl(boards.siteUrl, key)));
      hosts.views.append(open);
    }
  }

  if (active === undefined) {
    return;
  }
  if (active.error !== null) {
    hosts.list.append(createElement('p', { className: 'pulls__error', text: active.error }));
    return;
  }
  if (active.issues.length === 0) {
    hosts.list.append(
      createElement('p', {
        className: 'pulls__empty',
        text: active.checkedAt === null ? 'Lecture en cours…' : 'Aucun ticket dans cette vue.',
      }),
    );
    return;
  }

  // The assignee column is dropped in "Mes tickets": every row would carry the same name, which is noise
  // in a strip that has little room to spare.
  const showAssignee = active.id !== 'mine';
  hosts.list.classList.toggle('issues--mine', !showAssignee);

  for (const issue of orderIssues(active.issues)) {
    hosts.list.append(buildIssueRow(issue, showAssignee, actions));
  }
}

/**
 * One issue line, laid out as a **grid** rather than a flex row.
 *
 * Real columns, so the statuses line up down the list instead of floating wherever the summary ends: with
 * a flex row and a conditional badge, no two rows agreed on where anything was. The assignee comes before
 * the status because it answers "whose is this" first, and "where is it" second.
 */
function buildIssueRow(
  issue: JiraIssue,
  showAssignee: boolean,
  actions: JiraListActions,
): HTMLElement {
  const row = createElement('div', { className: 'issue' });
  row.title = `${issue.key} · ${issue.summary}\n${issue.type} · ${issue.status}\n(clic droit pour agir)`;

  row.append(createElement('span', { className: 'pull__number', text: issue.key }));
  row.append(createElement('span', { className: 'issue__summary', text: issue.summary }));

  if (showAssignee) {
    row.append(
      createElement('span', {
        className: `issue__assignee${issue.assignee.length === 0 ? ' issue__assignee--none' : ''}`,
        // Unassigned is worth seeing: on a sprint board it is usually a mistake.
        text: issue.assignee.length > 0 ? issue.assignee : 'non assigné',
      }),
    );
  }

  const status = createElement('span', { className: 'issue__status' });
  status.append(buildPill(presentStage(issue.stage, issue.status)));
  row.append(status);

  row.addEventListener('click', () => actions.onOpen(issue.url));
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    actions.onMenu(issue, event.clientX, event.clientY);
  });
  return row;
}
