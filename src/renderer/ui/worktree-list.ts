import type { ProjectId, RepoWorktrees, Worktree } from '@shared/contracts.js';
import { clearChildren, createElement, createIcon } from './dom.js';
import { TERMINAL_ICON } from './icons.js';
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
}

/** One line of the list: a worktree, and which project's clone it belongs to. */
export interface WorktreeRow {
  readonly projectId: ProjectId;
  readonly projectLabel: string;
  readonly worktree: Worktree;
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
        text: 'No worktree in these projects. `git worktree add` creates one.',
      }),
    );
    return;
  }

  for (const row of rows) {
    hosts.list.append(buildWorktreeRow(row, actions));
  }
}

/**
 * One worktree line, and it is the button.
 *
 * A real `<button>` rather than a `div` carrying one, which is what makes the whole line the target and
 * keeps the row reachable with Tab and answerable with Enter. It can be one precisely because the row
 * has a **single** gesture: there is no second control to nest, which is the constraint that keeps a
 * pull request row a `div`. The Git tab's repository row is the same shape for the same reason.
 *
 * The terminal glyph stays, decorative and `aria-hidden` (`createIcon` marks it so, and the button is
 * named by its own `aria-label`): the row would otherwise be a wide clickable strip with nothing on it
 * saying what the click does, and the icon is what makes this gesture recognisable as the same one the
 * projects table and the Git tab offer.
 */
function buildWorktreeRow(row: WorktreeRow, actions: WorktreeListActions): HTMLElement {
  const { worktree } = row;
  const element = createElement('button', { className: 'worktree' });
  element.type = 'button';
  /*
   * Disabled on a prunable row rather than left to fail: the folder is gone, so the shell would open
   * wherever the profile's own directory happens to be, which looks like a row that aimed at the wrong
   * worktree. A disabled button is also the one state that keeps the row out of the tab order without
   * hiding it, and the `prunable` pill says why.
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
  element.append(
    createElement('span', {
      className: 'worktree__name',
      text: worktree.name,
      // The path in the tooltip and not in a column: it is what you copy, never what you scan, and at
      // this width it would take the room the name and the branch are read in.
      title: worktree.path,
    }),
  );
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

  /*
   * The terminal glyph, legible on every row and not only on the hovered one.
   *
   * Deliberately **not** the `.icon-button--row` treatment, which sits at `opacity: 0.4` until its row
   * is hovered. That fade is right for the pull request and Git lists, where the terminal is a secondary
   * affordance beside a row whose main gesture is elsewhere; here it *is* the row's gesture and the
   * reason the tab was asked for, and an affordance nobody sees until they hover the right line is one
   * nobody finds. Same judgement as the Triage tab's `Analyse`, which turned down the same fade.
   */
  const glyph = createElement('span', { className: 'worktree__glyph' });
  glyph.append(createIcon(TERMINAL_ICON, { paint: 'stroke' }));
  element.append(glyph);

  return element;
}
