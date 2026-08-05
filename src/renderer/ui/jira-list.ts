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

/** Renders the two saved views and the issues of the selected one. */
export function renderJiraList(
  hosts: { views: HTMLElement; list: HTMLElement },
  state: JiraState,
  selected: JiraViewId,
  actions: JiraListActions,
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

  for (const issue of active.issues) {
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
