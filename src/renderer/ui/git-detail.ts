import type { GitChange, GitCommitFile, GitRepoState } from '@shared/contracts.js';
import { hasStagedChanges, hasWorktreeChange, isStaged } from '@shared/git-changes.js';
import { clearChildren, createElement, createIcon, createIconButton } from './dom.js';
import { showContextMenu } from './context-menu.js';
import {
  defaultTargetFor,
  describeMoment,
  type GitPanelActions,
  type GitPanelState,
} from './git-panel-model.js';
import { CHEVRON_DOWN_ICON } from './icons.js';
import { buildPill } from './project-table.js';
import { presentChange } from './presenters.js';

/** A plus and a minus, for the per-file stage and unstage buttons that appear on hover. */
const STAGE_ICON = 'M8 3.5L8 12.5M3.5 8L12.5 8';
const UNSTAGE_ICON = 'M3.5 8L12.5 8';

/**
 * The panel on the right: what the selection is made of.
 *
 * - **The working tree** (the WIP row): two lists, unstaged then staged, and the commit form under
 *   them, the way a graph client lays out a commit. A file staged then edited again (`MM`) is in
 *   **both** lists, and that is the rule that keeps the index and the working tree apart rather than
 *   an accident: each list says honestly what the commit would and would not take.
 * - **A commit or a stash**: its message, its author and date, its parents, and the files it touched.
 *   A click on a file opens its diff in the centre.
 */
export function renderDetail(
  host: HTMLElement,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): void {
  clearChildren(host);
  if (state.selection.kind === 'wip') {
    renderWorkingTree(host, repo, state, actions);
    return;
  }
  renderCommitDetail(host, repo, state, actions);
}

/* ---------------------------------------------------------- working tree */

function renderWorkingTree(
  host: HTMLElement,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): void {
  const unstaged = repo.changes.filter((change) => !isStaged(change) || hasWorktreeChange(change));
  const staged = repo.changes.filter(isStaged);

  host.append(
    buildListHeading(`Unstaged (${unstaged.length})`, {
      text: 'Stage all',
      title: 'git add on every modified file',
      disabled: state.busy || unstaged.length === 0,
      run: () =>
        actions.onStage(
          unstaged.map((change) => change.path),
          true,
        ),
    }),
  );
  host.append(buildFileList(unstaged, false, state, actions, 'Nothing left to stage.'));

  host.append(
    buildListHeading(`Staged (${staged.length})`, {
      text: 'Unstage all',
      title: 'git restore --staged on the whole index',
      disabled: state.busy || staged.length === 0,
      run: () =>
        actions.onStage(
          staged.map((change) => change.path),
          false,
        ),
    }),
  );
  host.append(buildFileList(staged, true, state, actions, 'Nothing staged yet.'));

  const form = createElement('div', { className: 'git__commit' });
  renderCommitForm(form, repo, state, actions);
  host.append(form);
}

function buildListHeading(
  label: string,
  action: { text: string; title: string; disabled: boolean; run: () => void },
): HTMLElement {
  const heading = createElement('div', { className: 'git__detail-heading' });
  heading.append(createElement('span', { className: 'git__detail-label', text: label }));
  const button = createElement('button', {
    className: 'button button--quiet',
    text: action.text,
    title: action.title,
  });
  button.type = 'button';
  button.disabled = action.disabled;
  button.addEventListener('click', action.run);
  heading.append(button);
  return heading;
}

/**
 * One of the two file lists.
 *
 * The row is the diff gesture and the `+` / `-` beside it the staging gesture, which is why the row
 * click ignores a click on the button: staging a file must not also swap the centre to its diff.
 * Discarding stays behind the right-click, like cherry-pick and every stash operation: this list is
 * clicked all day, and the one action that destroys work must not be one stray click away from it.
 */
function buildFileList(
  changes: readonly GitChange[],
  staged: boolean,
  state: GitPanelState,
  actions: GitPanelActions,
  empty: string,
): HTMLElement {
  const list = createElement('div', { className: 'git__files' });
  if (changes.length === 0) {
    list.append(createElement('p', { className: 'git__refs-empty', text: empty }));
    return list;
  }
  for (const change of changes) {
    const target = staged
      ? { kind: 'file' as const, path: change.path, staged: true }
      : { ...defaultTargetFor(change), staged: false };
    const selected =
      state.target?.kind === 'file' &&
      state.target.path === change.path &&
      state.target.staged === staged;
    const label = presentChange(change);
    const row = createElement('div', {
      className: `git__row git__change${selected ? ' git__row--selected' : ''}`,
    });
    row.title = `${change.path}\n${label.title}\nClick: see the diff. Right click: edit, discard.`;
    row.append(buildPill(label));
    row.append(
      createElement('span', { className: 'git__path path-clip-start', text: change.path }),
    );

    const toggle = createIconButton(staged ? UNSTAGE_ICON : STAGE_ICON, {
      label: staged ? `Unstage ${change.path}` : `Stage ${change.path}`,
      title: staged ? 'Unstage (git restore --staged)' : 'Stage (git add)',
      className: 'icon-button--row',
    });
    toggle.disabled = state.busy;
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      actions.onStage([change.path], !staged);
    });
    row.append(toggle);

    row.addEventListener('click', () => actions.onOpenDiff(target));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      actions.onChangeMenu(change, event.clientX, event.clientY);
    });
    list.append(row);
  }
  return list;
}

/**
 * The commit form.
 *
 * The button is disabled when nothing is staged, using the same `hasStagedChanges` the main process
 * would: an enabled button that produces "nothing added to commit" in a terminal tab teaches nothing.
 * **Amending lifts that rule**: `git commit --amend` with an empty index is a reword.
 *
 * The amend is a checkbox rather than a second button: an amend rewrites history, so it must not be
 * reachable by the same single click that commits. Arming it first, watching the button change name,
 * then clicking, is the deliberate two-step gesture. Ticking it pre-fills the form with the message
 * being replaced (`headMessage`), because an amend that silently drops the old body would lose what
 * it promised to edit.
 */
function renderCommitForm(
  host: HTMLElement,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): void {
  const area = document.createElement('textarea');
  area.className = 'git__message';
  area.id = 'git-commit-message';
  area.rows = 3;
  area.placeholder = 'Commit message';
  area.value = state.message;
  area.addEventListener('input', () => actions.onMessage(area.value));
  // The panel is rebuilt on every poll; while this has the focus, the refresh holds off.
  area.addEventListener('focus', () => actions.onEditing(true));
  area.addEventListener('blur', () => actions.onEditing(false));

  const staged = hasStagedChanges(repo.changes);
  const head = repo.commits.find((commit) => commit.sha === repo.headSha);

  const heading = createElement('label', {
    className: 'git__commit-label',
    text: 'Commit message',
  });
  heading.htmlFor = area.id;

  const toggle = createElement('label', { className: 'git__toggle' });
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'git__check';
  box.checked = state.amend;
  box.disabled = state.busy || head === undefined;
  box.addEventListener('change', () => actions.onAmend(box.checked));
  toggle.append(box, createElement('span', { text: 'Amend' }));
  // The tooltip names the commit about to be rewritten, and says when that rewrite will need a
  // force push: with nothing ahead, HEAD is exactly what the upstream has.
  toggle.title =
    head === undefined
      ? 'No commit to amend yet'
      : `git commit --amend: rewrites ${head.sha.slice(0, 7)} "${head.subject}".${
          repo.hasUpstream && repo.ahead === 0
            ? '\nAlready pushed: the next push will have to be forced.'
            : ''
        }`;

  /*
   * `Generate`, which asks Claude Code for the message. Secondary and left of `Commit`, in the order
   * the gesture happens, under the same staged-or-amending rule: with an empty index there is no diff,
   * so a run would come back with an invented message. It does not care whether the field already
   * holds something: regenerating over a draft is a normal thing to want.
   */
  const generate = createElement('button', {
    className: 'button',
    text: state.generating ? 'Generating…' : 'Generate',
  });
  generate.type = 'button';
  generate.disabled = state.busy || state.generating || (!staged && !state.amend);
  generate.title = state.generating
    ? 'The agent is reading the diff'
    : staged || state.amend
      ? "Write the message from the staged diff, following this repository's conventions"
      : 'Nothing staged: stage at least one file';
  generate.addEventListener('click', () => actions.onGenerateMessage());

  const button = createElement('button', {
    className: 'button button--primary',
    text: state.amend ? 'Amend' : 'Commit',
  });
  button.type = 'button';
  button.disabled = state.busy || state.message.trim().length === 0 || (!staged && !state.amend);
  button.title = state.amend
    ? 'git commit --amend -F, launched in a terminal tab so the hooks stay visible'
    : staged
      ? 'git commit -F, launched in a terminal tab so the hooks stay visible'
      : 'Nothing staged: stage at least one file';
  button.addEventListener('click', () => actions.onCommit(false));

  /*
   * `Commit and push`, in the chevron of the primary `Commit`. The primary touches the local
   * repository only, and the one that publishes to a branch other people read is named in full rather
   * than inherited by muscle memory. Refused on an amend already upstream, the one case where a plain
   * push cannot work, with its reason, rather than vanishing.
   */
  const amendPushed = state.amend && repo.hasUpstream && repo.ahead === 0;
  const pushLabel = state.amend ? 'Amend and push' : 'Commit and push';
  const more = createElement('button', { className: 'button button--primary git__commit-more' });
  more.type = 'button';
  more.append(createIcon(CHEVRON_DOWN_ICON, { paint: 'stroke' }));
  more.disabled = button.disabled;
  more.title = pushLabel;
  more.setAttribute('aria-label', 'More commit actions');
  more.setAttribute('aria-haspopup', 'menu');
  const split = createElement('div', { className: 'git__commit-split' });
  more.addEventListener('click', (event) => {
    // A menu opened on a LEFT click has to stop the click here, or it reaches the document listener
    // that closes menus and shuts this one in the same tick.
    event.stopPropagation();
    const box = split.getBoundingClientRect();
    showContextMenu(box.left, box.bottom + 4, [
      {
        label: pushLabel,
        disabled: amendPushed,
        hint: amendPushed
          ? 'The commit being amended is already on the remote: the push would need --force, which this menu does not do'
          : `${button.title}\nThen git push, from here, if and only if the commit exits cleanly`,
        run: () => actions.onCommit(true),
      },
    ]);
  });
  split.append(button, more);

  const header = createElement('div', { className: 'git__commit-head' });
  header.append(heading, toggle);

  const footer = createElement('div', { className: 'git__commit-actions' });
  footer.append(
    createElement('span', {
      className: 'strip__meta',
      text: staged
        ? `${repo.changes.filter(isStaged).length} staged`
        : state.amend
          ? 'Rewords the last commit'
          : 'Empty index',
    }),
    generate,
    split,
  );

  host.append(header, area, footer);
}

/* --------------------------------------------------------------- commit */

/**
 * A commit or a stash, described.
 *
 * The message and the files are read when the selection lands here, never with the graph: four
 * hundred rows would be four hundred reads for the one somebody clicks. The files of a merge are
 * those it brought in, against its first parent; the files of a stash are the tracked changes it set
 * aside, its untracked files living in a third commit this view does not read.
 */
function renderCommitDetail(
  host: HTMLElement,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): void {
  const selection = state.selection;
  if (selection.kind === 'wip') {
    return;
  }
  const commit = repo.commits.find((entry) => entry.sha === selection.sha);
  const stash =
    selection.kind === 'stash'
      ? repo.stashes.find((entry) => entry.sha === selection.sha)
      : undefined;

  const head = createElement('div', { className: 'git__detail-head' });
  const sha = createElement('button', {
    className: 'button button--quiet git__detail-sha',
    text: selection.kind === 'stash' ? selection.ref : selection.sha.slice(0, 7),
    title: `${selection.sha}\nClick to copy the full sha`,
  });
  sha.type = 'button';
  sha.addEventListener('click', () => actions.onCopy(selection.sha));
  head.append(sha);
  const author = commit?.author ?? '';
  const date = commit?.date ?? stash?.date ?? '';
  head.append(
    createElement('span', {
      className: 'git__detail-meta',
      text: [author, describeMoment(date)].filter((part) => part.length > 0).join(' · '),
    }),
  );
  host.append(head);

  const detail = state.detail?.sha === selection.sha ? state.detail : null;
  if (detail === null) {
    host.append(createElement('p', { className: 'pulls__empty', text: 'Reading…' }));
    return;
  }
  if (detail.error !== null) {
    host.append(createElement('p', { className: 'pulls__error', text: detail.error }));
    return;
  }

  const [subject = '', ...body] = detail.message.split('\n');
  const message = createElement('div', { className: 'git__detail-message' });
  message.append(createElement('p', { className: 'git__detail-subject', text: subject }));
  const rest = body.join('\n').trim();
  if (rest.length > 0) {
    message.append(createElement('p', { className: 'git__detail-body', text: rest }));
  }
  host.append(message);

  if (commit !== undefined && commit.parents.length > 0) {
    const parents = createElement('div', { className: 'git__detail-parents' });
    parents.append(
      createElement('span', {
        className: 'git__detail-label',
        text: commit.parents.length > 1 ? 'Parents' : 'Parent',
      }),
    );
    for (const parent of commit.parents) {
      const link = createElement('button', {
        className: 'button button--quiet git__detail-sha',
        text: parent.slice(0, 7),
        title: 'Show this commit',
      });
      link.type = 'button';
      link.addEventListener('click', () => actions.onSelect({ kind: 'commit', sha: parent }));
      parents.append(link);
    }
    host.append(parents);
  }

  host.append(
    createElement('div', {
      className: 'git__detail-heading git__detail-label',
      text:
        commit !== undefined && commit.parents.length > 1
          ? `${detail.files.length} file(s), against the first parent`
          : `${detail.files.length} file(s)`,
    }),
  );
  const list = createElement('div', { className: 'git__files git__files--grow' });
  for (const file of detail.files) {
    list.append(buildCommitFileRow(file, selection.sha, state, actions));
  }
  host.append(list);
}

function buildCommitFileRow(
  file: GitCommitFile,
  sha: string,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLElement {
  const selected =
    state.target?.kind === 'commit-file' &&
    state.target.sha === sha &&
    state.target.path === file.path;
  const row = createElement('div', {
    className: `git__row git__change${selected ? ' git__row--selected' : ''}`,
  });
  row.title = file.from === null ? file.path : `${file.from} → ${file.path}`;
  row.append(
    buildPill({
      label: file.status,
      tone: file.status === 'A' ? 'ok' : file.status === 'D' ? 'error' : 'neutral',
      title: FILE_STATUS[file.status] ?? file.status,
    }),
    createElement('span', { className: 'git__path path-clip-start', text: file.path }),
  );
  row.addEventListener('click', () =>
    actions.onOpenDiff({ kind: 'commit-file', sha, path: file.path }),
  );
  return row;
}

const FILE_STATUS: Record<string, string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
};
