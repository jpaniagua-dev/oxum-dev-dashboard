import type { ProjectId, ProjectRow } from '@shared/contracts.js';
import { clearChildren, createElement, hitsInteractive } from './dom.js';
import {
  canStop,
  presentChecks,
  presentGit,
  presentServer,
  presentWorkflows,
  type Pill,
} from './presenters.js';

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
  /**
   * Commits a new order: `moved` lands in front of `before`, or last when `before` is `null`.
   *
   * Only the two ids, never a list: the stored configuration is the order, and the main process is the
   * one holding it. A table that sent back a whole list would be sending a copy of state it does not
   * own, and a poll landing mid-gesture would decide what that copy said.
   */
  onReorder: (moved: ProjectId, before: ProjectId | null) => void;
  /** Called when a drag starts and ends, so the caller can pause re-rendering, as it does for a rename. */
  onDraggingChange: (dragging: boolean) => void;
}

/**
 * The row being dragged, if any.
 *
 * Module state because this table is a render function and not a class, and the value has to outlive a
 * single call: a drag spans several events on several rows. There is one project table in one renderer,
 * so there is nothing for a second instance to disagree with. It is cleared on `dragend`, which
 * Chromium fires even for a drag cancelled with Escape or released outside the window.
 */
let dragging: ProjectId | null = null;

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
      text: 'No project found. Check the paths in the registry.',
    });
    cell.colSpan = 7;
    row.append(cell);
    tbody.append(row);
    return;
  }

  for (const [index, row] of rows.entries()) {
    // The row after this one names the drop position for "below this row", which is why the whole list
    // is handed down rather than the row alone.
    tbody.append(buildRow(row, rows[index + 1]?.project.id ?? null, actions));
  }
}

function buildRow(
  row: ProjectRow,
  next: ProjectId | null,
  actions: TableActions,
): HTMLTableRowElement {
  const tr = createElement('tr');
  tr.className = 'table__row';
  tr.title = 'Click: open this repository\'s terminal\nDrag: reorder the table';
  attachDragHandlers(tr, row.project.id, next, actions);
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
        title: 'Gap with the remote branch',
      }),
    );
  }
  if (row.git !== null && !row.git.hasUpstream) {
    branchCell.append(
      createElement('span', {
        className: 'badge-warn',
        text: 'local',
        title: 'Branch never pushed',
      }),
    );
  }
  tr.append(branchCell);

  // Checks
  const checksCell = createElement('td');
  checksCell.append(buildPill(presentChecks(row.checks, row.git)));
  tr.append(checksCell);

  // Workflows. Repository-wide, unlike the Checks column beside it: a run started by a merge to the
  // trunk keeps this project busy just as much as one started by the branch shown in the row.
  const workflowsCell = createElement('td');
  workflowsCell.append(buildPill(presentWorkflows(row.workflows)));
  tr.append(workflowsCell);

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
      stop.title = `Stops "${action.label}"`;
      stop.addEventListener('click', () => actions.onStop(row.project.id));
      fragment.append(stop);
      continue;
    }

    /*
     * Never disabled, and that is a fix rather than a relaxation.
     *
     * It used to be greyed out whenever the row claimed a process was owned, with a tooltip blaming a
     * server started outside the dashboard — a message left over from the port probe that no longer
     * exists, and simply false in the state that actually reached it. Worse, the states where a row
     * and the sessions disagree are exactly the ones a user needs a way out of, and a dead button is
     * the opposite of a way out. Run is a **restart** now (the main process stops what is running
     * first), so there is no state left where refusing to start is the right answer.
     */
    const start = createElement('button', {
      className: 'button button--primary',
      text: action.label,
    });
    start.type = 'button';
    start.title = `${action.command}\n(restart: a process still running is stopped first)`;
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
  terminal.title = 'Open a new tab in this folder';
  terminal.addEventListener('click', () => actions.onNewTerminal(row.project.id));
  fragment.append(terminal);

  const folder = createElement('button', { className: 'button button--quiet', text: '…' });
  folder.type = 'button';
  folder.title = 'Open the folder';
  folder.addEventListener('click', () => actions.onOpenFolder(row.project.id));
  fragment.append(folder);

  return fragment;
}

/**
 * Drag and drop for one row.
 *
 * Same shape as the terminal tabs, and the same rule holds: **nothing re-renders during a drag**.
 * Replacing the dragged element mid-gesture cancels the drag in Chromium, so the caller is told through
 * `onDraggingChange` and holds its refresh exactly as it does for a rename. The table refreshes on
 * every git poll, so without that guard a drag lasting longer than the cadence would die under the
 * cursor.
 *
 * The insertion point is named by a **neighbour** rather than an index: dropping on the top half of a
 * row means "in front of it", on the bottom half "in front of whatever follows it", and `null` for the
 * last row means the end. An index would have to state whether it is counted before or after the moved
 * row was taken out, which is the classic off-by-one of every reorder.
 */
function attachDragHandlers(
  tr: HTMLTableRowElement,
  id: ProjectId,
  next: ProjectId | null,
  actions: TableActions,
): void {
  tr.draggable = true;

  const clear = (): void => {
    tr.classList.remove('table__row--drop-before', 'table__row--drop-after');
  };

  tr.addEventListener('dragstart', (event) => {
    dragging = id;
    tr.classList.add('table__row--dragging');
    actions.onDraggingChange(true);
    if (event.dataTransfer !== null) {
      event.dataTransfer.effectAllowed = 'move';
      // Chromium refuses to start a drag with an empty payload.
      event.dataTransfer.setData('text/plain', id);
    }
  });

  tr.addEventListener('dragover', (event) => {
    if (dragging === null || dragging === id) {
      return;
    }
    // Without this the drop is refused and the cursor reads "not allowed".
    event.preventDefault();
    if (event.dataTransfer !== null) {
      event.dataTransfer.dropEffect = 'move';
    }
    clear();
    tr.classList.add(above(tr, event.clientY) ? 'table__row--drop-before' : 'table__row--drop-after');
  });

  tr.addEventListener('dragleave', clear);

  tr.addEventListener('drop', (event) => {
    const moved = dragging;
    clear();
    if (moved === null || moved === id) {
      return;
    }
    event.preventDefault();
    actions.onReorder(moved, above(tr, event.clientY) ? id : next);
  });

  // Covers a drop outside the table and a drag cancelled with Escape: the marker and the pause on
  // re-rendering must not survive the gesture.
  tr.addEventListener('dragend', () => {
    dragging = null;
    tr.classList.remove('table__row--dragging');
    clear();
    actions.onDraggingChange(false);
  });
}

/**
 * Turns the dragging of a whole row on or off, from inside one of its cells.
 *
 * Walks up to the row rather than taking it as a parameter: the name cell is built before it is
 * appended anywhere, so a reference passed down would have to be the row that does not exist yet.
 */
function setDraggable(inside: HTMLElement, draggable: boolean): void {
  inside.closest('tr')?.setAttribute('draggable', String(draggable));
}

/** Whether the cursor sits in the upper half of a row, which means "insert in front of it". */
function above(tr: HTMLTableRowElement, clientY: number): boolean {
  const box = tr.getBoundingClientRect();
  return clientY < box.top + box.height / 2;
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
(double-click to rename)`,
  });
  label.type = 'button';

  label.addEventListener('dblclick', (event) => {
    event.preventDefault();
    actions.onEditingChange(true);
    // The row stays draggable the rest of the time, but not while an input is up: selecting text in a
    // field inside a draggable ancestor starts a drag instead of a selection. The tabs met the same
    // trap and answered it the same way.
    setDraggable(host, false);

    const input = createElement('input', { className: 'cell-project__input' });
    input.type = 'text';
    input.value = row.project.label;
    input.setAttribute('aria-label', 'Rename the project');

    let settled = false;
    const finish = (accept: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      actions.onEditingChange(false);
      setDraggable(host, true);
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
