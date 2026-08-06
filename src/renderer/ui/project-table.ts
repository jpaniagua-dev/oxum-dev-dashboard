import type { ProjectId, ProjectRow } from '@shared/contracts.js';
import { clearChildren, createElement, hitsInteractive } from './dom.js';
import { canStart, canStop, presentChecks, presentGit, presentServer, type Pill } from './presenters.js';

export interface TableActions {
  /** Runs one of the project's configured actions. */
  onRunAction: (projectId: ProjectId, actionId: string) => void;
  /** Commits a new label for the project. */
  onRename: (projectId: ProjectId, label: string) => void;
  /** Called when an inline edit opens or closes, so the caller can pause re-rendering. */
  onEditingChange: (editing: boolean) => void;
  onStop: (projectId: ProjectId) => void;
  onOpenFolder: (projectId: ProjectId) => void;
  /**
   * Opens the repository's shell, reusing the one already there.
   *
   * The row-level gesture. Reuse is what makes it safe: a click on a row is too easy to trigger to
   * stack a tab each time.
   */
  onOpenTerminal: (projectId: ProjectId) => void;
  /**
   * Opens **a new** shell in the repository's folder, every time.
   *
   * The button, and deliberately not the same thing as the row: the row has one shell it comes back
   * to, whereas the button is how you get a second one to work alongside it. Those tabs carry no
   * `projectId`, so they are invisible to the row's reuse lookup and nothing ever closes them for you.
   */
  onNewTerminal: (projectId: ProjectId) => void;
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
  tr.className = 'table__row';
  tr.title = 'Clic : ouvrir le terminal de ce dépôt';
  // The guard covers two conflicts: a click on an action button would otherwise both run the action and
  // open a shell, and the double-click that renames a project fires two clicks, so the row would steal
  // the focus from the input that just appeared.
  tr.addEventListener('click', (event) => {
    if (hitsInteractive(event)) {
      return;
    }
    actions.onOpenTerminal(row.project.id);
  });

  // Project. The port is deliberately not repeated here: the server pill already shows it as
  // `sert :4201` when it matters, and a static "port 4200" said nothing the pill did not.
  const projectCell = createElement('td');
  projectCell.append(buildProjectName(row, actions));
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

/**
 * The action buttons of one row.
 *
 * The list comes from the project's configuration, in its declared order. Only the `server` action is
 * special: while it runs it is replaced by `Stop`, because a second click on it would do nothing
 * useful and the row needs a way to end what it started. The last two are built-ins that open something
 * rather than running a command, so they are not part of the editable list.
 */
function buildActions(row: ProjectRow, actions: TableActions): DocumentFragment {
  const fragment = document.createDocumentFragment();

  for (const action of row.project.actions) {
    if (action.role !== 'server') {
      const button = createElement('button', { className: 'button', text: action.label });
      button.type = 'button';
      button.title = action.command;
      button.addEventListener('click', () => actions.onRunAction(row.project.id, action.id));
      fragment.append(button);
      continue;
    }

    if (canStop(row.server)) {
      const stop = createElement('button', { className: 'button', text: 'Stop' });
      stop.type = 'button';
      stop.title = `Arrête « ${action.label} »`;
      stop.addEventListener('click', () => actions.onStop(row.project.id));
      fragment.append(stop);
      continue;
    }

    const start = createElement('button', {
      className: 'button button--primary',
      text: action.label,
    });
    start.type = 'button';
    start.disabled = !canStart(row.server);
    // Explains the disabled button instead of leaving the user guessing.
    start.title = canStart(row.server)
      ? action.command
      : 'Un serveur tourne déjà hors du dashboard';
    start.addEventListener('click', () => actions.onRunAction(row.project.id, action.id));
    fragment.append(start);
  }

  /*
   * A terminal button, on top of the row-level click, and **not** the same gesture.
   *
   * The row comes back to the repository's one shell; this opens a new tab in its folder every time,
   * which is how you get a second shell to work alongside a first. It was removed once as redundant
   * with the row, which it never was: that reading cost the only way to open more than one shell per
   * repository, and the row click is besides invisible and unreachable from the keyboard.
   */
  const terminal = createElement('button', { className: 'button', text: 'Terminal' });
  terminal.type = 'button';
  terminal.title = 'Ouvrir un nouvel onglet dans ce dossier';
  terminal.addEventListener('click', () => actions.onNewTerminal(row.project.id));
  fragment.append(terminal);

  const folder = createElement('button', { className: 'button button--quiet', text: '…' });
  folder.type = 'button';
  folder.title = 'Ouvrir le dossier';
  folder.addEventListener('click', () => actions.onOpenFolder(row.project.id));
  fragment.append(folder);

  return fragment;
}

/**
 * The project name, renameable in place on a double-click.
 *
 * Enter commits, Escape cancels, blur commits: clicking away after typing a name is far more common
 * than wanting to discard it. The caller is told when an edit opens so it can hold off re-rendering,
 * because this table refreshes on every git poll and would otherwise wipe the field mid-typing.
 */
function buildProjectName(row: ProjectRow, actions: TableActions): HTMLElement {
  const host = createElement('span', { className: 'cell-project' });

  const label = createElement('button', {
    className: 'cell-project__name',
    text: row.project.label,
    title: `${row.project.path}
(double-clic pour renommer)`,
  });
  label.type = 'button';

  label.addEventListener('dblclick', (event) => {
    event.preventDefault();
    actions.onEditingChange(true);

    const input = createElement('input', { className: 'cell-project__input' });
    input.type = 'text';
    input.value = row.project.label;
    input.setAttribute('aria-label', 'Renommer le projet');

    let settled = false;
    const finish = (accept: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      actions.onEditingChange(false);
      if (accept && input.value.trim().length > 0 && input.value.trim() !== row.project.label) {
        actions.onRename(row.project.id, input.value.trim());
      } else {
        input.replaceWith(label);
      }
    };

    input.addEventListener('keydown', (event2) => {
      if (event2.key === 'Enter') {
        event2.preventDefault();
        finish(true);
      } else if (event2.key === 'Escape') {
        event2.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));

    label.replaceWith(input);
    input.focus();
    input.select();
  });

  host.append(label);
  return host;
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
