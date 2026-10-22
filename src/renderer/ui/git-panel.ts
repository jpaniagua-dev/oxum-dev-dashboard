import type {
  GitChange,
  GitCommit,
  GitRef,
  GitRepoState,
  GitStash,
  GitSyncOp,
  Project,
} from '@shared/contracts.js';
import { isDeletedOnDisk, isStaged } from '@shared/git-changes.js';
import { clearChildren, createElement, createIcon, createIconButton } from './dom.js';
import { renderDetail } from './git-detail.js';
import { renderCenter } from './git-graph-view.js';
import {
  SEQUENCER_LABELS,
  currentBranch,
  defaultTargetFor,
  writesBlocked,
  type GitMenuItem,
  type GitPanelActions,
  type GitPanelHosts,
  type GitPanelState,
} from './git-panel-model.js';
import { renderRefs } from './git-refs.js';
import { TERMINAL_ICON } from './icons.js';
import { buildPill } from './project-table.js';
import { remoteBranchName, tagOnRemote, undoStateFor } from './presenters.js';

export {
  defaultTargetFor,
  describeDay,
  type GitCreating,
  type GitPanelActions,
  type GitPanelHosts,
  type GitPanelState,
  type GitSectionKey,
  type GitSelection,
} from './git-panel-model.js';

/*
 * The Git tab, laid out like a graph client inside a 460 px strip (redesigned on 2026-10-15):
 *
 *   [ repository ▾, branch, distance, notices ...... undo · fetch pull push · branch stash pop · >_ ⋯ ]
 *   [ refs ][ graph, or the diff in its place      ][ detail: staging + commit, or a commit ]
 *
 * This module draws the toolbar on top and hands the three columns to their own modules. Every
 * write keeps the gesture the earlier tab gave it, for the reasons recorded there and in CLAUDE.md:
 * checkout is deliberate (now a double-click), history-changing writes are behind a right-click,
 * discarding is confirmed by the main process. What the redesign added is listed in CLAUDE.md under
 * the Git tab: the graph, the refs panel, Undo, the merge by drag.
 */

/**
 * Icons of the toolbar.
 *
 * Fetch, pull and push kept their drawings from the earlier tab (a circular arrow for the one that
 * changes nothing on disk, two mirrored arrows over a baseline for the two that do). The arrowheads
 * are sized against the rendered 14 px icon, not against the geometry: at 1.3 units of a 16-unit box
 * the first fetch arrow came out as a hairline and the icon read as a "C".
 */
const ICONS = {
  fetch: 'M12.4 8A4.4 4.4 0 1 1 8 3.6M6 1.6L8.2 3.6L6 5.6',
  pull: 'M8 2.5L8 9.7M5.3 7L8 9.7L10.7 7M3.5 13L12.5 13',
  push: 'M8 9.7L8 2.5M5.3 5.2L8 2.5L10.7 5.2M3.5 13L12.5 13',
  undo: 'M5.5 3.5L2.5 6.5L5.5 9.5M2.5 6.5L10 6.5A3.5 3.5 0 0 1 10 13.5L7 13.5',
  branch: 'M5 2.5L5 13.5M5 9.5C5 7 11 8 11 5.5M11 5.5L11 2.5M11 13.5L11 10.5M9.5 12L12.5 12',
  stash: 'M2.5 9.5L2.5 13.5L13.5 13.5L13.5 9.5M8 2.5L8 9.5M5.3 6.8L8 9.5L10.7 6.8',
  pop: 'M2.5 9.5L2.5 13.5L13.5 13.5L13.5 9.5M8 9.5L8 2.5M5.3 5.2L8 2.5L10.7 5.2',
} as const;

const SYNC_HINTS: Record<GitSyncOp, string> = {
  fetch: 'Fetch: updates the remote branches (git fetch --prune)',
  pull: 'Pull: git pull --ff-only. A diverged branch is merged by dropping its remote onto it, or in a terminal.',
  push: 'Push: git push',
};

/** Paints the whole tab: toolbar, refs, graph, detail. */
export function renderGitPanel(
  hosts: GitPanelHosts,
  state: GitPanelState,
  actions: GitPanelActions,
): void {
  clearChildren(hosts.toolbar);
  clearChildren(hosts.refs);
  clearChildren(hosts.center);
  clearChildren(hosts.detail);

  if (state.projects.length === 0) {
    hosts.center.append(
      createElement('p', { className: 'pulls__empty', text: 'No project configured.' }),
    );
    return;
  }
  // Drawn before the repository is read: the picker is how one gets away from a slow read.
  hosts.toolbar.append(buildToolbar(state.repo, state, actions));
  const repo = state.repo;
  if (repo === null) {
    hosts.center.append(createElement('p', { className: 'pulls__empty', text: 'Reading…' }));
    return;
  }
  if (repo.error !== null) {
    hosts.center.append(createElement('p', { className: 'pulls__error', text: repo.error }));
    return;
  }

  renderRefs(hosts.refs, repo, state, actions);
  renderCenter(hosts.center, repo, state, actions);
  renderDetail(hosts.detail, repo, state, actions);
}

/* ------------------------------------------------------- repo picker */

/**
 * The repository picker, a `<select>` at the head of the toolbar.
 *
 * A native select for the reason the Jira tab's assignee filter is one: the list is as long as the
 * configuration, and a row of tabs wider than the strip scrolled sideways and hid the repositories
 * past its edge.
 *
 * The panel is rebuilt on every git poll, and a select replaced while its list is open closes under
 * the pointer: hence the `gitEditing` guard the text fields use, raised while it has the focus.
 */
function buildRepoPicker(state: GitPanelState, actions: GitPanelActions): HTMLSelectElement {
  const select = createElement('select', { className: 'git__repo-select' });
  select.setAttribute('aria-label', 'Repository');
  for (const project of state.projects) {
    const option = createElement('option', { text: project.label });
    option.value = project.id;
    option.selected = project.id === state.selectedProject;
    select.append(option);
  }
  select.title =
    state.projects.find((project) => project.id === state.selectedProject)?.path ?? 'Repository';

  select.addEventListener('focus', () => actions.onEditing(true));
  select.addEventListener('blur', () => actions.onEditing(false));
  select.addEventListener('change', () => {
    // Lowered before the switch, or the guard would skip the very read the switch asks for.
    actions.onEditing(false);
    actions.onSelectProject(select.value);
  });
  return select;
}

/** Not disabled by `busy`, like the same entry of the repository menu: it runs no git command. */
function buildRepoTerminal(project: Project, actions: GitPanelActions): HTMLButtonElement {
  const button = createIconButton(TERMINAL_ICON, {
    label: `Open a terminal in ${project.label}`,
    title: `Open a new terminal tab in ${project.path}`,
    className: 'git__tool',
  });
  button.addEventListener('click', () => actions.onNewTerminal(project.id));
  return button;
}

/* -------------------------------------------------------------- toolbar */

/**
 * The status of the repository on the left, its verbs on the right.
 *
 * The left half is read at a glance: which repository, its branch, how far it stands from its
 * upstream, a half-done operation said out loud, and the line where fetch, pull and push report what
 * they did (they are the only writes that move nothing on screen). The right half is the toolbar a
 * graph client has, as icons: undo, the three network operations, a new branch, stash and pop, a
 * terminal, and the `⋯` menu, which a right-click anywhere on the row opens too.
 *
 * `repo` is null while the selected repository is being read: the picker alone, then.
 */
function buildToolbar(
  repo: GitRepoState | null,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLElement {
  const bar = createElement('div', { className: 'git__toolbar-row' });
  bar.append(buildRepoPicker(state, actions));
  if (repo === null) {
    return bar;
  }
  bar.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    actions.onMenu(event.clientX, event.clientY);
  });

  bar.append(
    createElement('span', {
      className: 'git__branch',
      text: repo.branch,
      title: `Current branch of ${repo.label}`,
    }),
  );

  if (repo.error === null) {
    if (repo.hasUpstream) {
      const marks: string[] = [];
      if (repo.ahead > 0) {
        marks.push(`↑${repo.ahead}`);
      }
      if (repo.behind > 0) {
        marks.push(`↓${repo.behind}`);
      }
      if (marks.length > 0) {
        bar.append(
          buildPill({
            label: marks.join(' '),
            tone: repo.behind > 0 ? 'busy' : 'info',
            title: `${repo.ahead} commit(s) ahead, ${repo.behind} behind`,
          }),
        );
      }
    } else if (currentBranch(repo) !== undefined) {
      bar.append(
        buildPill({
          label: 'no upstream',
          tone: 'neutral',
          // Not an error: the state of every branch before its first push, which Push fixes.
          title: 'The branch has never been pushed. Push will publish it with -u origin.',
        }),
      );
    }

    /*
     * A half-finished operation, said out loud beside the branch, `error`-toned: it is the state where
     * every other button fails for a reason unrelated to what was clicked. The way out is first in the
     * repository menu, `--abort` before `--continue`.
     */
    if (repo.sequencer !== 'none') {
      const pill = buildPill({
        label: `${SEQUENCER_LABELS[repo.sequencer]} in progress`,
        tone: 'error',
        title: `The repository is in the middle of a ${SEQUENCER_LABELS[repo.sequencer]}. Abort or continue from the ⋯ menu.`,
      });
      bar.append(pill);
    }
  }

  bar.append(createElement('span', { className: 'git__spacer' }));

  /*
   * What the last fetch, pull or push did. A success clears itself after a few seconds; a failure
   * stays until clicked, being the one that must not be missed.
   */
  if (state.notice !== null && state.notice.projectId === repo.projectId) {
    const notice = buildPill({
      label: state.notice.message,
      tone: state.notice.ok ? 'ok' : 'error',
      title: state.notice.ok ? 'Click to dismiss' : `${state.notice.message}\nClick to dismiss`,
    });
    notice.classList.add('git__notice');
    notice.addEventListener('click', () => actions.onDismissNotice());
    bar.append(notice);
  }

  if (repo.error === null) {
    const undo = undoStateFor(repo);
    bar.append(
      toolButton('undo', 'Undo the last commit', undo.reason, state.busy || !undo.enabled, () =>
        actions.onUndo(),
      ),
      createElement('span', { className: 'git__toolbar-gap' }),
    );
    for (const op of ['fetch', 'pull', 'push'] as const) {
      const title =
        op === 'push' && !repo.hasUpstream
          ? `Push and publish the branch: git push -u origin ${repo.branch}`
          : SYNC_HINTS[op];
      bar.append(toolButton(op, op[0]?.toUpperCase() + op.slice(1), title, state.busy, () => actions.onSync(op)));
    }
    bar.append(createElement('span', { className: 'git__toolbar-gap' }));

    const stashable = repo.changes.some((change) => !change.untracked);
    const latest = repo.stashes[0];
    bar.append(
      toolButton('branch', 'New branch', 'New branch from HEAD', state.busy, () =>
        actions.onCreating('branch'),
      ),
      toolButton(
        'stash',
        'Stash',
        stashable
          ? 'Stash the tracked changes (git stash push). The stashes panel names one or takes untracked files.'
          : 'Nothing tracked to stash. The + of the stashes panel can include untracked files.',
        writesBlocked(state) || !stashable,
        () => actions.onStashPush(),
      ),
      toolButton(
        'pop',
        'Pop',
        latest === undefined
          ? 'No stash to pop'
          : `Pop the latest stash, ${latest.ref} "${latest.subject}" (git stash pop)`,
        writesBlocked(state) || latest === undefined,
        () => {
          if (latest !== undefined) {
            actions.onStash(latest, 'pop');
          }
        },
      ),
    );
  }

  const project = state.projects.find((entry) => entry.id === repo.projectId);
  if (project !== undefined) {
    bar.append(
      createElement('span', { className: 'git__toolbar-gap' }),
      buildRepoTerminal(project, actions),
    );
  }

  const menu = createElement('button', {
    className: 'button button--quiet git__menu-button',
    text: '⋯',
    title: 'Repository actions (or right click this row)',
  });
  menu.type = 'button';
  menu.disabled = state.busy;
  menu.setAttribute('aria-label', 'Repository actions');
  menu.addEventListener('click', (event) => {
    // `stopPropagation`, or the opening click reaches the document listener that closes menus and
    // shuts this one in the same tick: a button that looks completely dead.
    event.stopPropagation();
    const box = menu.getBoundingClientRect();
    actions.onMenu(box.left, box.bottom + 2);
  });
  bar.append(menu);
  return bar;
}

function toolButton(
  icon: keyof typeof ICONS,
  label: string,
  title: string,
  disabled: boolean,
  run: () => void,
): HTMLButtonElement {
  const button = createElement('button', { className: 'icon-button git__tool' });
  button.type = 'button';
  button.disabled = disabled;
  button.title = title;
  button.setAttribute('aria-label', label);
  button.append(createIcon(ICONS[icon], { paint: 'stroke' }));
  button.addEventListener('click', run);
  return button;
}

/* ---------------------------------------------------------------- menus */

/**
 * The repository's actions, as a menu.
 *
 * The way out of a half-finished operation comes first when there is one, `--abort` before
 * `--continue`: you open this menu because something went wrong, and abort is the one that cannot
 * make it worse.
 */
export function buildRepoMenuItems(
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): GitMenuItem[] {
  const sequencer =
    repo.sequencer === 'none'
      ? []
      : [
          {
            label: `Abort the ${SEQUENCER_LABELS[repo.sequencer]}`,
            hint: `git ${repo.sequencer} --abort: the repository goes back to where it was.`,
            disabled: state.busy,
            run: () => actions.onSequencer('abort'),
          },
          {
            label: `Continue the ${SEQUENCER_LABELS[repo.sequencer]}`,
            hint: `git ${repo.sequencer} --continue, once the conflicts are resolved and staged.`,
            disabled: state.busy,
            run: () => actions.onSequencer('continue'),
          },
        ];
  const undo = undoStateFor(repo);
  return [
    ...sequencer,
    {
      label: 'Fetch',
      hint: 'git fetch --prune',
      disabled: state.busy,
      run: () => actions.onSync('fetch'),
    },
    {
      label: 'Pull (fast-forward only)',
      hint: 'git pull --ff-only. A diverged branch: drop its remote branch onto it to merge, or use a terminal.',
      disabled: state.busy,
      run: () => actions.onSync('pull'),
    },
    {
      label: repo.hasUpstream ? 'Push' : 'Push and publish the branch',
      hint: repo.hasUpstream ? 'git push' : `git push -u origin ${repo.branch}`,
      disabled: state.busy,
      run: () => actions.onSync('push'),
    },
    {
      label: 'Undo the last commit',
      hint: undo.reason,
      disabled: state.busy || !undo.enabled,
      run: () => actions.onUndo(),
    },
    {
      label: 'Open a terminal here',
      hint: `New tab in ${repo.path}`,
      disabled: false,
      run: () => actions.onNewTerminal(repo.projectId),
    },
  ];
}

/**
 * A commit's own actions, as a menu.
 *
 * A right-click and not a button: a cherry-pick changes the *history*, so it must not be reachable
 * without asking for it, and the graph is scrolled and clicked all day. Undo appears on the HEAD
 * commit only, the one it applies to.
 */
export function buildCommitMenuItems(
  commit: GitCommit,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): GitMenuItem[] {
  // A cherry-pick onto a dirty tree is refused by git itself; the item says so beforehand.
  const dirty = repo.changes.length > 0;
  const blocked = writesBlocked(state);
  const short = commit.sha.slice(0, 7);
  const items: GitMenuItem[] = [
    {
      label: `Cherry-pick onto ${repo.branch}`,
      hint: dirty
        ? 'git cherry-pick, but the working tree is not clean: git will refuse.'
        : `git cherry-pick ${short}: replays this commit on the current branch.`,
      disabled: blocked || commit.sha === repo.headSha,
      run: () => actions.onCherryPick(commit.sha, false),
    },
    {
      label: 'Cherry-pick without committing',
      hint: `git cherry-pick -n ${short}: the changes land in the index, committing is up to you.`,
      disabled: blocked || commit.sha === repo.headSha,
      run: () => actions.onCherryPick(commit.sha, true),
    },
    {
      label: 'Copy the sha',
      hint: commit.sha,
      disabled: false,
      run: () => actions.onCopy(commit.sha),
    },
    {
      label: 'See the whole diff',
      hint: 'Every file of this commit in one diff, against its first parent.',
      disabled: false,
      run: () => actions.onOpenDiff({ kind: 'commit', sha: commit.sha }),
    },
    {
      label: 'Tag this commit…',
      hint: `Opens the tag form on ${short}, in the Tags section.`,
      disabled: state.busy,
      run: () => actions.onTagCommit(commit.sha),
    },
  ];
  if (commit.sha === repo.headSha) {
    const undo = undoStateFor(repo);
    items.push({
      label: 'Undo this commit',
      hint: undo.reason,
      disabled: state.busy || !undo.enabled,
      run: () => actions.onUndo(),
    });
  }
  return items;
}

/**
 * What a branch or a tag offers on a right-click.
 *
 * Checkout is here as well as on the double-click, because the expert gesture does not have to be the
 * discoverable one but there has to be one; for the same reason the merge a drag starts is offered
 * here too, through the same menu the drop opens.
 */
export function buildRefMenuItems(
  ref: GitRef,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
  merge: (x: number, y: number) => void,
  at: { x: number; y: number },
): GitMenuItem[] {
  const items: GitMenuItem[] = [
    {
      label: 'Show the commit',
      hint: `${ref.sha.slice(0, 7)}, selected in the graph.`,
      disabled: false,
      run: () => actions.onSelect({ kind: 'commit', sha: ref.sha }),
    },
  ];
  if (ref.kind === 'local') {
    items.push({
      label: ref.current ? 'Checked out' : `Check out ${ref.name}`,
      hint: ref.current
        ? 'This is the current branch.'
        : `git checkout ${ref.name}. Nothing is stashed: local changes in the way make git refuse. Double-click does the same.`,
      disabled: ref.current || state.busy,
      run: () => actions.onCheckout(ref),
    });
  }
  if (ref.kind === 'remote') {
    const local = remoteBranchName(ref);
    const exists = repo.refs.some((entry) => entry.kind === 'local' && entry.name === local);
    items.push({
      label: exists ? `Check out ${local}` : `Check out as ${local}`,
      hint: exists
        ? `${local} already exists: it is checked out as it is. Pull brings it up to date.`
        : `git checkout -b ${local} --track ${ref.name}. Double-click does the same.`,
      disabled: state.busy,
      run: () => actions.onCheckout(ref),
    });
  }
  if (ref.kind === 'tag') {
    /*
     * Push one tag, and delete a local one. Both read whether the remote has the tag, which is only
     * known after a Fetch or a push: unknown leaves both entries enabled, the main process asking the
     * remote itself (the push through its confirmation, the delete before touching anything).
     */
    const onRemote = tagOnRemote(ref.name, state.remoteTags);
    const remote = state.remoteTags?.remote ?? 'the remote';
    items.push(
      {
        label: onRemote === true ? `On ${remote}` : `Push to ${remote}…`,
        hint:
          onRemote === true
            ? `${remote} already has ${ref.name}.`
            : `git push ${remote} refs/tags/${ref.name}, after a confirmation that names the commit and any workflow the tag starts.`,
        disabled: onRemote === true || state.busy,
        run: () => actions.onPushTag(ref.name),
      },
      {
        label: 'Delete the local tag',
        hint:
          onRemote === true
            ? `${remote} has it: it would come back on the next fetch. Delete it from a terminal.`
            : 'git tag -d. Refused if the remote turns out to have it.',
        disabled: onRemote === true || state.busy,
        run: () => actions.onDeleteTag(ref.name),
      },
    );
  }
  const current = currentBranch(repo);
  if (ref.kind !== 'tag' && !ref.current && current !== undefined) {
    items.push({
      label: `Merge into ${current.name}…`,
      hint: 'Opens the merge choices, the same as dropping this branch onto the current one.',
      disabled: writesBlocked(state),
      run: () => merge(at.x, at.y),
    });
  }
  items.push({
    label: 'Copy the name',
    hint: ref.name,
    disabled: false,
    run: () => actions.onCopy(ref.name),
  });
  return items;
}

/**
 * What a changed file offers on a right-click.
 *
 * The diff, the editor, the staging toggle, and the one gesture that has nowhere else to live:
 * discard. The discard label says what will happen to **this** file, because an untracked file is
 * deleted, and someone who read "discard" as "unstage" has to be told before the dialog.
 */
export function buildChangeMenuItems(
  change: GitChange,
  state: GitPanelState,
  actions: GitPanelActions,
): GitMenuItem[] {
  const blocked = writesBlocked(state);
  const staged = isStaged(change);
  const deleted = isDeletedOnDisk(change);
  return [
    {
      label: 'See the diff',
      hint: 'The same thing a click on the row does.',
      disabled: false,
      run: () => actions.onOpenDiff(defaultTargetFor(change)),
    },
    // Not `blocked`: opening a file runs no git command, and a conflict is precisely the file one
    // wants to edit.
    {
      label: 'Edit',
      hint: deleted
        ? 'Deleted on disk: there is no file to open.'
        : 'Opens it in the Explorer tab, in the editor set in Settings.',
      disabled: deleted,
      run: () => actions.onEditFile(change.path, 'panel'),
    },
    {
      label: 'Edit in a window',
      hint: deleted
        ? 'Deleted on disk: there is no file to open.'
        : 'Opens it in a window of its own, and this tab stays on screen.',
      disabled: deleted,
      run: () => actions.onEditFile(change.path, 'window'),
    },
    {
      label: staged ? 'Unstage' : 'Stage',
      hint: staged ? 'git restore --staged on this file.' : 'git add on this file.',
      disabled: blocked,
      run: () => actions.onStage([change.path], !staged),
    },
    {
      label: change.untracked ? 'Discard (deletes the file)' : 'Discard the changes',
      hint: change.untracked
        ? 'git clean: this file is not tracked, so discarding it means deleting it. Nothing can get it back.'
        : 'git restore --staged --worktree: this file goes back to HEAD, including what is staged. Nothing can get it back.',
      disabled: blocked,
      run: () => actions.onDiscard([change.path]),
    },
  ];
}

/**
 * A stash's actions. `drop` says it cannot be undone: git keeps the commit in its reflog for a while,
 * but nothing in this tab can find it again, and promising a recovery it does not offer would be
 * worse than saying it is final.
 */
export function buildStashMenuItems(
  stash: GitStash,
  state: GitPanelState,
  actions: GitPanelActions,
): GitMenuItem[] {
  const blocked = writesBlocked(state);
  return [
    {
      label: 'Show what it holds',
      hint: 'Its files in the panel on the right.',
      disabled: false,
      run: () => actions.onSelect({ kind: 'stash', sha: stash.sha, ref: stash.ref }),
    },
    {
      label: 'See the whole diff',
      hint: 'git stash show -p, in the centre.',
      disabled: false,
      run: () => actions.onOpenDiff({ kind: 'stash', sha: stash.sha, ref: stash.ref }),
    },
    {
      label: 'Apply (and keep)',
      hint: `git stash apply: the changes come back into the working tree, ${stash.ref} stays in the list.`,
      disabled: blocked,
      run: () => actions.onStash(stash, 'apply'),
    },
    {
      label: 'Apply and pop',
      hint: `git stash pop: like "apply", but ${stash.ref} leaves the list if all goes well.`,
      disabled: blocked,
      run: () => actions.onStash(stash, 'pop'),
    },
    {
      label: 'Delete',
      hint: 'git stash drop: the content is lost, and this tab cannot get it back.',
      disabled: blocked,
      run: () => actions.onStash(stash, 'drop'),
    },
  ];
}
