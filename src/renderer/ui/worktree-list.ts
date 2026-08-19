import type { ProjectId, RepoWorktrees, Worktree, WorktreeCommand } from '@shared/contracts.js';
import { clearChildren, createElement, createIconButton } from './dom.js';
import { showContextMenu } from './context-menu.js';
import { MORE_ICON } from './icons.js';
import { presentGit } from './presenters.js';
import { buildPill } from './project-table.js';

export interface WorktreeListActions {
  /**
   * Opens a new shell in the worktree's own folder.
   *
   * Takes a path and not a project id, unlike every other terminal gesture in this app: a worktree is
   * not a configured project, so there is nothing to look it up in. That is also why it can never be
   * the row's shell: it spawns a fresh tab, tagged with no `projectId`, which no configuration change
   * can close behind the user's back.
   */
  onOpenTerminal: (path: string, name: string) => void;
  /**
   * Runs one life-cycle gesture, in the clone the worktree belongs to.
   *
   * An **intent** and not a command line. What reaches a shell is decided in the main process, from a
   * repository folder this view never names: the view says which project and which label, and a folder
   * name it read back from git is the only free text it can contribute.
   */
  onRun: (projectId: ProjectId, command: WorktreeCommand) => void;
  /**
   * Raised while one of this tab's fields is open, and lowered when it closes.
   *
   * The tab held no state until the life-cycle gestures landed, which is exactly why it needed no
   * guard: it re-reads on every git poll, and a refresh mid-typing would wipe the field under the
   * cursor. Same guard, same reason, as the project table's rename and the Git tab's message.
   */
  onEditingChange: (editing: boolean) => void;
}

/** One line of the list: a worktree, and which project's clone it belongs to. */
export interface WorktreeRow {
  readonly projectId: ProjectId;
  readonly projectLabel: string;
  readonly worktree: Worktree;
}

/**
 * One entry of a row's life-cycle menu.
 *
 * `command === null` means the entry opens the rename field rather than running anything: the only
 * gesture of the three that needs a value typed before there is a command to build.
 */
export interface WorktreeMenuEntry {
  readonly label: string;
  readonly hint: string;
  readonly command: WorktreeCommand | null;
}

/** Uncommitted work of any kind, which is what decides whether a forced removal is offered at all. */
function isDirty(worktree: Worktree): boolean {
  const git = worktree.git;
  if (git === null || git.error !== null) {
    return false;
  }
  return git.staged + git.modified + git.untracked > 0;
}

/**
 * The life-cycle entries a given row is allowed to offer.
 *
 * Derived from the state the list has just read, and that is the whole point of putting these gestures
 * here rather than leaving them in the terminal: the destructive flag is only ever on the menu of a row
 * that has something to destroy.
 *
 * - **A prunable row gets one entry.** Its folder is gone, so there is nothing to rename and nothing to
 *   discard; what is left is a registration git is waiting to be told to drop, and the helper prunes it
 *   rather than deleting anything.
 * - **A plain removal comes first**, and it is the one that can be refused: git declines a worktree
 *   holding uncommitted or unmerged work, and the helper relinks the junction it had unlinked and says
 *   how to force it. A refusal is a good outcome for the default entry.
 * - **`-f` is offered only on a dirty row**, and its label counts what it will throw away. On a clean
 *   row it would be a permanently armed footgun for no gain, the plain removal already succeeding.
 * - **`-d` is a separate entry, never implied.** The helper still refuses an unmerged branch and says
 *   so, which is why the entry is safe to offer on a row that has never been pushed; the hint says what
 *   it will cost if it is not.
 *
 * Pure and exported: which entry a row offers is decided from four fields, and getting that wrong shows
 * up as a menu that lets a folder be deleted with work in it.
 */
export function worktreeMenuEntries(worktree: Worktree): WorktreeMenuEntry[] {
  const label = worktree.name;

  if (worktree.prunable !== null) {
    return [
      {
        label: 'Prune the stale registration',
        hint: 'The folder is gone; this drops the entry git is still holding',
        command: { kind: 'remove', label, discardChanges: false, deleteBranch: false },
      },
    ];
  }

  const locked =
    worktree.locked !== null ? ' (git refuses a locked worktree until it is unlocked)' : '';
  const entries: WorktreeMenuEntry[] = [
    {
      label: 'Remove',
      hint: `Unlinks node_modules, then git worktree remove; refused if there is work in it${locked}`,
      command: { kind: 'remove', label, discardChanges: false, deleteBranch: false },
    },
    {
      label: 'Remove and delete the branch',
      hint: `Same, then git branch -d, which keeps an unmerged branch and says so${locked}`,
      command: { kind: 'remove', label, discardChanges: false, deleteBranch: true },
    },
  ];

  if (isDirty(worktree)) {
    const git = worktree.git;
    const count = git === null ? 0 : git.staged + git.modified + git.untracked;
    entries.push({
      label: `Remove, discarding ${count} change${count === 1 ? '' : 's'}`,
      hint: 'git worktree remove --force: the uncommitted work in this folder is lost',
      command: { kind: 'remove', label, discardChanges: true, deleteBranch: false },
    });
  }

  entries.push({
    label: 'Rename…',
    hint: 'Moves the folder and renames the branch with it, junction intact',
    command: null,
  });

  return entries;
}

/**
 * Flattens the per-project payload into the list the tab shows.
 *
 * Project order is the **configured** one, so the tab reads in the same order as the projects table
 * and the pull request column: a list that sorts its own repositories would be the only place in the
 * app where they move. Inside a project, worktrees are sorted by folder name with **numeric
 * collation**, and that is not decoration: plain text ordering puts `TEC-1000-web-app` before
 * `TEC-999-web-app`, because a bare comparison reads the counter as a string. The names of this
 * workspace's worktrees are ticket keys followed by a repository, so the digits are never at the end
 * and the issue-key comparison the Jira tab uses does not apply here.
 *
 * Pure and exported: that off-by-a-power-of-ten ordering is invisible until a project passes one.
 */
export function flattenWorktrees(repos: readonly RepoWorktrees[]): WorktreeRow[] {
  const rows: WorktreeRow[] = [];
  for (const repo of repos) {
    const sorted = [...repo.worktrees].sort((left, right) =>
      left.name.localeCompare(right.name, 'fr', { numeric: true }),
    );
    for (const worktree of sorted) {
      rows.push({ projectId: repo.projectId, projectLabel: repo.label, worktree });
    }
  }
  return rows;
}

/**
 * The one line above the list: how many worktrees, over how many projects.
 *
 * "Two of seven" rather than a bare total, because the useful reading is comparative: a workspace
 * where every clone has a checkout open is not the same situation as one where they are all piled on a
 * single repository. Unreadable projects are counted separately instead of being folded into the
 * total, a project whose `git worktree list` failed being a project this tab knows nothing about.
 *
 * Pure and exported, for the reason every count in this app is: a summary that disagrees with the list
 * under it is worse than no summary.
 */
export function summarizeWorktrees(repos: readonly RepoWorktrees[]): string {
  const total = repos.reduce((sum, repo) => sum + repo.worktrees.length, 0);
  const withAny = repos.filter((repo) => repo.worktrees.length > 0).length;
  const failed = repos.filter((repo) => repo.error !== null).length;

  const head =
    total === 0
      ? 'No worktree'
      : `${total} worktree${total === 1 ? '' : 's'} across ${withAny} of ${repos.length} project${
          repos.length === 1 ? '' : 's'
        }`;
  return failed === 0 ? head : `${head}, ${failed} unreadable`;
}

/**
 * Renders the whole tab: the summary bar, then one row per worktree.
 *
 * A flat list and no repository column to click through, unlike its four neighbours. The question this
 * tab exists for is the one that spans clones ("where are my checkouts, and which of them holds work I
 * have not committed"), and a master-detail would answer it one repository at a time, which is the
 * laborious version it replaces.
 */
export function renderWorktreeList(
  hosts: { bar: HTMLElement; list: HTMLElement },
  repos: readonly RepoWorktrees[] | null,
  actions: WorktreeListActions,
): void {
  clearChildren(hosts.bar);
  clearChildren(hosts.list);

  if (repos === null) {
    // Never read yet, which is a different statement from "there are none": the first is about the
    // app, the second about the workspace, and one sentence for both would be the useless one.
    hosts.bar.append(createElement('span', { className: 'strip__meta', text: 'Reading...' }));
    return;
  }

  hosts.bar.append(
    createElement('span', { className: 'strip__meta', text: summarizeWorktrees(repos) }),
  );
  hosts.bar.append(buildCreateButton(hosts.bar, repos, actions));

  if (repos.length === 0) {
    hosts.list.append(
      createElement('p', {
        className: 'pulls__empty',
        text: 'No project configured. Add one from the Projects tab.',
      }),
    );
    return;
  }

  // Errors first, and above the rows rather than in place of them: one unreadable project must not
  // hide the worktrees of the six that answered.
  for (const repo of repos) {
    if (repo.error !== null) {
      hosts.list.append(
        createElement('p', {
          className: 'pulls__error',
          text: `${repo.label}: ${repo.error}`,
        }),
      );
    }
  }

  const rows = flattenWorktrees(repos);
  if (rows.length === 0) {
    hosts.list.append(
      createElement('p', {
        className: 'pulls__empty',
        text: 'No worktree in these projects. `New worktree` creates one.',
      }),
    );
    return;
  }

  for (const row of rows) {
    hosts.list.append(buildWorktreeRow(row, actions));
  }
}

/**
 * The bar's `New worktree` button, and the two questions behind it.
 *
 * Which repository comes first and from a menu, for the reason the Jira tab asks it: this is the one
 * tab of the strip that does not select a repository, so a creation gesture has to ask, and a menu at
 * the cursor is the answer the rest of the app already uses. The label and the description come second,
 * in one field, because they are one thought and one line in the terminal.
 */
function buildCreateButton(
  bar: HTMLElement,
  repos: readonly RepoWorktrees[],
  actions: WorktreeListActions,
): HTMLElement {
  const button = createElement('button', {
    className: 'worktrees__new',
    text: 'New worktree',
    title: 'Create a worktree from the default branch, node_modules junctioned',
  });
  button.type = 'button';
  button.disabled = repos.length === 0;

  button.addEventListener('click', (event) => {
    // Kept, though `showContextMenu` now forgives its own opening click and this is no longer what
    // makes the menu appear. It still stops the click reaching anything upstream of the bar.
    event.stopPropagation();
    const box = button.getBoundingClientRect();
    showContextMenu(
      event.clientX === 0 ? box.left : event.clientX,
      event.clientY === 0 ? box.bottom : event.clientY,
      repos.map((repo) => ({
        label: repo.label,
        hint: `wt new in ${repo.path}`,
        run: () => openCreateField(bar, repo, actions),
      })),
    );
  });

  return button;
}

/**
 * Swaps the bar for the field that names a new worktree, then puts the bar back.
 *
 * In the bar and not in a modal: the tab has a summary line and a list, and a dialog over it would be
 * the only one in this strip. The field replaces the summary for as long as it is open, which is the
 * same trade the project table's rename makes with the name it edits.
 *
 * `onEditingChange` is not optional here. This tab re-reads on every git poll, and a refresh while the
 * field is open would rebuild the bar and drop what was being typed.
 */
function openCreateField(
  bar: HTMLElement,
  repo: RepoWorktrees,
  actions: WorktreeListActions,
): void {
  actions.onEditingChange(true);
  const previous = [...bar.childNodes];
  clearChildren(bar);

  const form = createElement('span', { className: 'worktrees__form' });
  form.append(
    createElement('span', { className: 'strip__meta', text: `New worktree in ${repo.label}` }),
  );

  const input = createElement('input', { className: 'worktrees__input' });
  input.type = 'text';
  // The two arguments the helper takes, spelled the way they are typed at a prompt. A ticket key needs
  // the description, a slug is its own; the placeholder says both rather than a form asking twice.
  input.placeholder = 'TEC-1482 documents list   ·   or   toast-zone-escape';
  input.setAttribute('aria-label', `Label and description of the new worktree in ${repo.label}`);
  form.append(input);
  bar.append(form);

  let settled = false;
  const finish = (accept: boolean): void => {
    if (settled) {
      return;
    }
    settled = true;
    actions.onEditingChange(false);
    const typed = input.value.trim();
    clearChildren(bar);
    bar.append(...previous);
    if (accept && typed.length > 0) {
      // Split here rather than in two fields, and parsed in the main process rather than trusted: what
      // travels is a label and a description, and the command is built where the repository is known.
      const cut = typed.indexOf(' ');
      const label = cut === -1 ? typed : typed.slice(0, cut);
      const description = cut === -1 ? '' : typed.slice(cut + 1);
      actions.onRun(repo.projectId, { kind: 'create', label, description });
    }
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  // Cancelled on blur and not accepted, unlike the project rename: that one edits a label already on
  // screen, so keeping the typed value is the safe reading, whereas this one creates a branch.
  input.addEventListener('blur', () => finish(false));

  input.focus();
}

/**
 * One worktree line: the row's own gesture, and the menu of everything else it can do.
 *
 * The row **is** a `<button>`, which is what makes the whole line the target for the mouse and keeps it
 * reachable with Tab and answerable with Enter. The life-cycle menu could not be nested inside it (a
 * button inside a button is invalid HTML that browsers silently rearrange), so it sits **beside** it in
 * a wrapper, and the wrapper carries the fixed track that keeps every row's dots on one vertical line.
 *
 * That the menu is visible rather than hidden behind a right-click is the whole argument for adding it
 * here. Removing a worktree by hand, having forgotten there was a command for it, is the failure this
 * answers, and a gesture nobody can see is a gesture nobody remembers.
 *
 * The row carried a terminal glyph until the menu arrived, on the grounds that it would otherwise be a
 * wide clickable strip with nothing on it saying what a click does. Two glyphs at the end of one line
 * is a worse problem: they read as two buttons, and only one of them is. The row's `title` and
 * `aria-label` still say where the click leads, and the hover highlight still says the line is one
 * target. `pull-list` keeps its glyph because there the terminal is genuinely a *second* gesture, on a
 * row whose own click opens a browser.
 */
function buildWorktreeRow(row: WorktreeRow, actions: WorktreeListActions): HTMLElement {
  const host = createElement('div', { className: 'worktree-row' });
  const { worktree } = row;
  const element = createElement('button', { className: 'worktree' });
  element.type = 'button';
  /*
   * Disabled on a prunable row rather than left to fail: the folder is gone, so the shell would open
   * wherever the profile's own directory happens to be, which looks like a row that aimed at the wrong
   * worktree. A disabled button is also the one state that keeps the row out of the tab order without
   * hiding it, and the `prunable` pill says why. The menu beside it stays enabled: pruning the stale
   * registration is precisely what such a row is for.
   */
  element.disabled = worktree.prunable !== null;
  element.setAttribute(
    'aria-label',
    worktree.prunable === null
      ? `Open a terminal in ${worktree.name}`
      : `${worktree.name}, folder missing`,
  );
  element.title =
    worktree.prunable === null
      ? `Open a new tab in ${worktree.path}`
      : `${worktree.path} (folder missing)`;
  element.addEventListener('click', () => actions.onOpenTerminal(worktree.path, worktree.name));

  element.append(
    createElement('span', {
      className: 'worktree__project',
      text: row.projectLabel,
      title: `Worktree of ${row.projectLabel}`,
    }),
  );
  const name = createElement('span', {
    className: 'worktree__name',
    text: worktree.name,
    // The path in the tooltip and not in a column: it is what you copy, never what you scan, and at
    // this width it would take the room the name and the branch are read in.
    title: worktree.path,
  });
  element.append(name);
  // `.cell-branch` is the project table's own branch cell, reused rather than copied: one definition
  // of how a branch name is drawn, for the reason `.subtab` was renamed out of the Git tab.
  element.append(
    createElement('span', {
      className: 'cell-branch',
      text: worktree.branch.length > 0 ? worktree.branch : '(no branch)',
      title: worktree.branch,
    }),
  );

  const state = createElement('span', { className: 'worktree__state' });

  if (worktree.prunable !== null) {
    /*
     * Registered, but there is nothing at the end of the path any more.
     *
     * The state a scan of the worktrees folder could never name, and the one row where the terminal
     * button cannot work. Painted as an error rather than dimmed: it is not a worktree in a slightly
     * unusual state, it is an entry git is waiting to be told to drop.
     */
    state.append(
      buildPill({
        label: 'prunable',
        tone: 'error',
        title:
          worktree.prunable.length > 0
            ? `git: ${worktree.prunable}`
            : 'Registered, but its folder is gone',
      }),
    );
  } else {
    const summary = presentGit(worktree.git);
    const counts = createElement('span', { className: 'counts' });
    for (const part of summary.parts) {
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
    state.append(counts);

    if (summary.warning !== null) {
      state.append(
        createElement('span', {
          className: 'badge-warn',
          text: summary.warning,
          title: 'Gap with the remote branch',
        }),
      );
    }
    if (worktree.git !== null && worktree.git.error === null && !worktree.git.hasUpstream) {
      state.append(
        createElement('span', {
          className: 'badge-warn',
          text: 'local',
          title: 'Branch never pushed',
        }),
      );
    }
  }

  if (worktree.locked !== null) {
    state.append(
      createElement('span', {
        className: 'badge-warn',
        text: 'locked',
        // git accepts a lock with no reason, so the empty string is a real value and not a missing one.
        title: worktree.locked.length > 0 ? `Locked: ${worktree.locked}` : 'Locked, no reason given',
      }),
    );
  }
  element.append(state);

  host.append(element);
  host.append(buildMenuButton(row, name, actions));
  return host;
}

/**
 * The dots beside a row, and the menu they open.
 *
 * A sibling of the row rather than a child, so neither button is nested in the other. It keeps its full
 * opacity for the reason the terminal glyph does: this tab's whole point is that the life cycle is
 * visible from the list, and an affordance that appears on hover is one you have to already know about.
 */
function buildMenuButton(
  row: WorktreeRow,
  nameCell: HTMLElement,
  actions: WorktreeListActions,
): HTMLElement {
  const button = createIconButton(MORE_ICON, {
    label: `Life cycle of ${row.worktree.name}`,
    title: 'Remove, rename…',
    className: 'worktree__menu',
  });

  button.addEventListener('click', (event) => {
    // Same as the bar's button above: no longer load-bearing for the menu, kept so the click does not
    // travel past the row.
    event.stopPropagation();
    const box = button.getBoundingClientRect();
    showContextMenu(
      event.clientX === 0 ? box.left : event.clientX,
      event.clientY === 0 ? box.bottom : event.clientY,
      worktreeMenuEntries(row.worktree).map((entry) => ({
        label: entry.label,
        hint: entry.hint,
        run: () => {
          if (entry.command === null) {
            openRenameField(row, nameCell, actions);
            return;
          }
          actions.onRun(row.projectId, entry.command);
        },
      })),
    );
  });

  return button;
}

/**
 * Swaps the row's name for the field that renames it.
 *
 * Empty and not pre-filled with the folder name, which is the detail that makes the gesture readable:
 * the helper takes the **new label** and appends the repository itself, so `TEC-1482` turns
 * `wip-toast-web-app` into `TEC-1482-web-app` and brings the branch along. Pre-filling the full folder
 * name would invite editing it by hand, and a hand-edited name is how the folder and the branch stop
 * agreeing.
 */
function openRenameField(
  row: WorktreeRow,
  nameCell: HTMLElement,
  actions: WorktreeListActions,
): void {
  actions.onEditingChange(true);

  const input = createElement('input', { className: 'worktrees__input worktree__rename' });
  input.type = 'text';
  input.placeholder = 'TEC-1482';
  input.setAttribute('aria-label', `New label for ${row.worktree.name}`);

  let settled = false;
  const finish = (accept: boolean): void => {
    if (settled) {
      return;
    }
    settled = true;
    actions.onEditingChange(false);
    const typed = input.value.trim();
    input.replaceWith(nameCell);
    if (accept && typed.length > 0) {
      actions.onRun(row.projectId, {
        kind: 'rename',
        label: row.worktree.name,
        newLabel: typed,
      });
    }
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  // Cancelled on blur, like the creation field and unlike the project rename: this one moves a folder
  // and renames a branch, so an accidental click elsewhere must not be an instruction.
  input.addEventListener('blur', () => finish(false));

  nameCell.replaceWith(input);
  input.focus();
}
