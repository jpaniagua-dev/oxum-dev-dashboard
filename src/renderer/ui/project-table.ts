import type { ProjectId, ProjectRow } from '@shared/contracts.js';
import { clearChildren, createElement } from './dom.js';
import { canStart, canStop, presentChecks, presentGit, presentServer, type Pill } from './presenters.js';

export interface TableActions {
  onStart: (projectId: ProjectId) => void;
  onStop: (projectId: ProjectId) => void;
  onCommit: (projectId: ProjectId) => void;
  onOpenPr: (url: string) => void;
  onOpenFolder: (projectId: ProjectId) => void;
}

/**
 * Renders the project table.
 *
 * The whole body is rebuilt from the rows on every change. With three rows that is cheaper than
 * diffing, and it removes any chance of the DOM drifting from the state. All text goes through
 * `textContent`: branch names, error messages and pull request titles come from outside the app.
 */
export function renderProjectTable(
  tbody: HTMLElement,
  rows: readonly ProjectRow[],
  actions: TableActions,
): void {
  clearChildren(tbody);

  if (rows.length === 0) {
    const row = createElement('tr');
    const cell = createElement('td', {
      text: 'Aucun projet trouvé. Vérifie les chemins dans le registre.',
    });
    cell.colSpan = 6;
    row.append(cell);
    tbody.append(row);
    return;
  }

  for (const row of rows) {
    tbody.append(buildRow(row, actions));
  }
}

function buildRow(row: ProjectRow, actions: TableActions): HTMLTableRowElement {
  const tr = createElement('tr');

  // Project
  const projectCell = createElement('td');
  const projectBox = createElement('div', { className: 'cell-project' });
  projectBox.append(
    createElement('span', { className: 'cell-project__name', text: row.project.label }),
    createElement('span', {
      className: 'cell-project__hint',
      // Says out loud why this row has no port, instead of leaving an unexplained blank.
      text: row.project.kind === 'watch' ? 'build --watch, sans port' : `port ${row.project.expectedPort ?? '?'}`,
    }),
  );
  projectCell.append(projectBox);
  tr.append(projectCell);

  // Server
  const serverCell = createElement('td');
  serverCell.append(buildPill(presentServer(row.server)));
  if (row.server.errorSummary !== null) {
    serverCell.append(
      createElement('span', { className: 'cell-error', text: row.server.errorSummary }),
    );
  }
  tr.append(serverCell);

  // Files
  const gitSummary = presentGit(row.git);
  const filesCell = createElement('td');
  const counts = createElement('span', { className: 'counts' });
  for (const part of gitSummary.parts) {
    counts.append(
      createElement('span', {
        className:
          part.kind === 'dirty'
            ? 'counts__item counts__item--dirty'
            : part.kind === 'clean'
              ? 'counts__item counts__item--clean'
              : 'counts__item',
        text: part.label,
      }),
    );
  }
  filesCell.append(counts);
  tr.append(filesCell);

  // Branch
  const branchCell = createElement('td');
  const branch = createElement('span', {
    className: 'cell-branch',
    text: row.git?.branch ?? '…',
    title: row.git?.branch ?? '',
  });
  branchCell.append(branch);
  if (gitSummary.warning !== null) {
    branchCell.append(
      createElement('span', {
        className: 'badge-warn',
        text: gitSummary.warning,
        title: 'Écart avec la branche distante',
      }),
    );
  }
  if (row.git !== null && !row.git.hasUpstream) {
    branchCell.append(
      createElement('span', {
        className: 'badge-warn',
        text: 'local',
        title: 'Branche jamais poussée',
      }),
    );
  }
  tr.append(branchCell);

  // Checks
  const checksCell = createElement('td');
  checksCell.append(buildPill(presentChecks(row.checks, row.git)));
  tr.append(checksCell);

  // Actions
  const actionsCell = createElement('td', { className: 'table__actions' });
  actionsCell.append(buildActions(row, actions));
  tr.append(actionsCell);

  return tr;
}

function buildActions(row: ProjectRow, actions: TableActions): DocumentFragment {
  const fragment = document.createDocumentFragment();

  if (canStop(row.server)) {
    const stop = createElement('button', { className: 'button', text: 'Stop' });
    stop.type = 'button';
    stop.addEventListener('click', () => actions.onStop(row.project.id));
    fragment.append(stop);
  } else {
    const start = createElement('button', { className: 'button button--primary', text: 'Run' });
    start.type = 'button';
    start.disabled = !canStart(row.server);
    if (!canStart(row.server)) {
      // Explains the disabled button instead of leaving the user guessing.
      start.title = 'Un serveur tourne déjà hors du dashboard';
    }
    start.addEventListener('click', () => actions.onStart(row.project.id));
    fragment.append(start);
  }

  const commit = createElement('button', { className: 'button', text: 'Commit' });
  commit.type = 'button';
  commit.title = 'Lance ton alias commit dans le terminal';
  commit.addEventListener('click', () => actions.onCommit(row.project.id));
  fragment.append(commit);

  const prUrl = row.checks?.prUrl ?? null;
  const pr = createElement('button', { className: 'button', text: 'PR' });
  pr.type = 'button';
  pr.disabled = prUrl === null;
  pr.title = prUrl === null ? 'Aucune PR pour cette branche' : (row.checks?.prTitle ?? 'Ouvrir la PR');
  if (prUrl !== null) {
    pr.addEventListener('click', () => actions.onOpenPr(prUrl));
  }
  fragment.append(pr);

  const folder = createElement('button', { className: 'button button--quiet', text: '…' });
  folder.type = 'button';
  folder.title = 'Ouvrir le dossier';
  folder.addEventListener('click', () => actions.onOpenFolder(row.project.id));
  fragment.append(folder);

  return fragment;
}

/** Builds a status pill with its coloured dot. */
export function buildPill(pill: Pill): HTMLSpanElement {
  const element = createElement('span', {
    className: `pill pill--${pill.tone}`,
    title: pill.title,
  });
  element.append(createElement('span', { className: 'pill__dot' }));
  element.append(document.createTextNode(pill.label));
  return element;
}
