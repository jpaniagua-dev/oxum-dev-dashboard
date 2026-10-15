import type { GitRef, GitRepoState, GitStash } from '@shared/contracts.js';
import { showContextMenu } from './context-menu.js';
import { clearChildren, createElement, createIcon, createIconButton } from './dom.js';
import {
  describeDay,
  makeMergeDropZone,
  makeRefDraggable,
  type GitPanelActions,
  type GitPanelState,
  type GitSectionKey,
} from './git-panel-model.js';
import { CHEVRON_DOWN_ICON } from './icons.js';
import { presentTrack, refSections, tagOnRemote } from './presenters.js';

/** A plus, for the `create` button at the right of a section heading. */
const PLUS_ICON = 'M8 3.5L8 12.5M3.5 8L12.5 8';

/**
 * The refs panel, on the left: local branches, remote branches by remote, stashes, tags.
 *
 * Every ref is a **pointer to a commit** first, so a single click is a read: it selects that commit
 * in the graph and scrolls to it, which is where its history is. Changing anything is never one
 * click away:
 * - **checkout is a double-click** on a branch (decided on 2026-10-15), a gesture nobody makes by
 *   accident while reading a list, and also on the right-click menu so it can be found;
 * - **merging is a drag** of a branch onto the current one, which opens a menu rather than writing;
 * - **stashes keep their right-click menu**: `pop` and `drop` remove the entry, so neither belongs on
 *   a row that is also clicked to read what it holds.
 *
 * The sections fold, the state living in the app because the panel is rebuilt on every poll.
 */
export function renderRefs(
  host: HTMLElement,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): void {
  clearChildren(host);
  const sections = refSections(repo.refs);

  const local = buildSection('local', 'Local', sections.local.length, state, actions, {
    label: 'New branch',
    title: 'Create a branch from HEAD and switch to it',
    run: () => actions.onCreating(state.creating === 'branch' ? null : 'branch'),
  });
  host.append(local);
  if (!state.collapsed.has('local')) {
    if (state.creating === 'branch') {
      host.append(buildBranchForm(state, actions));
    }
    for (const ref of sections.local) {
      host.append(buildRefRow(ref, repo, state, actions));
    }
    if (sections.local.length === 0) {
      host.append(createElement('p', { className: 'git__refs-empty', text: 'No local branch' }));
    }
  }

  const remoteCount = sections.remotes.reduce((sum, group) => sum + group.refs.length, 0);
  host.append(buildSection('remote', 'Remote', remoteCount, state, actions, null));
  if (!state.collapsed.has('remote')) {
    for (const group of sections.remotes) {
      const key: GitSectionKey = `remote:${group.remote}`;
      host.append(buildGroup(key, group.remote, group.refs.length, state, actions));
      if (!state.collapsed.has(key)) {
        for (const ref of group.refs) {
          host.append(buildRefRow(ref, repo, state, actions));
        }
      }
    }
    if (sections.remotes.length === 0) {
      host.append(createElement('p', { className: 'git__refs-empty', text: 'No remote branch' }));
    }
  }

  host.append(
    buildSection('stashes', 'Stashes', repo.stashes.length, state, actions, {
      label: 'New stash',
      title: 'Set aside what is modified, under a name if you want one',
      run: () => actions.onCreating(state.creating === 'stash' ? null : 'stash'),
    }),
  );
  if (!state.collapsed.has('stashes')) {
    if (state.creating === 'stash') {
      host.append(buildStashForm(repo, state, actions));
    }
    for (const stash of repo.stashes) {
      host.append(buildStashRow(stash, state, actions));
    }
  }

  const head = repo.headSha;
  host.append(
    buildSection(
      'tags',
      'Tags',
      sections.tags.length,
      state,
      actions,
      head === null
        ? null
        : {
            label: 'New tag',
            title: 'Tag HEAD. To tag another commit, right-click it in the graph.',
            run: () =>
              state.creating === 'tag' ? actions.onCreating(null) : actions.onTagCommit(head),
          },
    ),
  );
  if (!state.collapsed.has('tags')) {
    if (state.creating === 'tag' && state.tagTarget !== null) {
      host.append(buildTagForm(repo, state.tagTarget, state, actions));
    }
    for (const ref of sections.tags) {
      host.append(buildRefRow(ref, repo, state, actions));
    }
  }
}

/**
 * The tag form: which commit, a name, an optional message, and `Create` or `Create and push`.
 *
 * The commit is spelled out at the top, sha and subject, because a tag on the wrong commit is the one
 * mistake this form can make, and the push confirmation names it a second time. `Create and push` is
 * in the chevron of `Create`, the arrangement `Commit and push` already has: the primary gesture
 * touches the local repository only.
 */
function buildTagForm(
  repo: GitRepoState,
  sha: string,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLElement {
  const form = createElement('div', { className: 'git__inline-form git__inline-form--stack' });
  const commit = repo.commits.find((entry) => entry.sha === sha);
  form.append(
    createElement('span', {
      className: 'git__inline-note',
      text: `On ${sha.slice(0, 7)}${commit === undefined ? '' : ` ${commit.subject}`}`,
      title: sha,
    }),
  );

  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'git__input';
  name.placeholder = 'v1.2.0';
  name.value = state.tagDraft;
  name.setAttribute('aria-label', 'Tag name');
  const message = document.createElement('input');
  message.type = 'text';
  message.className = 'git__input git__input--prose';
  message.placeholder = 'Message (optional)';
  message.value = state.tagMessage;
  message.setAttribute('aria-label', 'Tag message');
  for (const field of [name, message]) {
    field.addEventListener('focus', () => actions.onEditing(true));
    field.addEventListener('blur', () => actions.onEditing(false));
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        actions.onCreating(null);
      } else if (event.key === 'Enter' && name.value.trim().length > 0) {
        actions.onCreateTag(false);
      }
    });
  }
  name.addEventListener('input', () => actions.onTagDraft(name.value));
  message.addEventListener('input', () => actions.onTagMessage(message.value));

  const disabled = state.busy || state.tagDraft.trim().length === 0;
  const create = createElement('button', {
    className: 'button',
    text: 'Create',
    title: 'git tag -a: an annotated tag, kept local. The name is validated by git itself.',
  });
  create.type = 'button';
  create.disabled = disabled;
  create.addEventListener('click', () => actions.onCreateTag(false));

  const more = createElement('button', { className: 'button git__commit-more git__tag-more' });
  more.type = 'button';
  more.append(createIcon(CHEVRON_DOWN_ICON, { paint: 'stroke' }));
  more.disabled = disabled;
  more.title = 'Create and push';
  more.setAttribute('aria-label', 'More tag actions');
  more.setAttribute('aria-haspopup', 'menu');
  const split = createElement('div', { className: 'git__commit-split' });
  more.addEventListener('click', (event) => {
    // A menu opened on a left click stops the click here, or the document listener closes it.
    event.stopPropagation();
    const box = split.getBoundingClientRect();
    showContextMenu(box.left, box.bottom + 4, [
      {
        label: 'Create and push',
        hint: 'Creates the tag, then asks before pushing it: the confirmation names the remote and any workflow the tag would start.',
        disabled,
        run: () => actions.onCreateTag(true),
      },
    ]);
  });
  split.append(create, more);

  const footer = createElement('div', { className: 'git__inline-actions git__inline-actions--end' });
  footer.append(split);
  form.append(name, message, footer);
  return form;
}

/**
 * A section heading: a fold toggle with its count, and an optional `+` at the right.
 *
 * The heading follows the one recipe the visual grammar sets for column headings. The `+` is a
 * sibling of the toggle and not inside it, for the reason the repository row's terminal icon is: a
 * button inside a button is invalid HTML that browsers silently rearrange.
 */
function buildSection(
  key: GitSectionKey,
  label: string,
  count: number,
  state: GitPanelState,
  actions: GitPanelActions,
  create: { label: string; title: string; run: () => void } | null,
): HTMLElement {
  const line = createElement('div', { className: 'git__section' });
  const folded = state.collapsed.has(key);
  const toggle = createElement('button', { className: 'git__section-toggle' });
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(!folded));
  toggle.append(
    createElement('span', { className: 'git__chevron', text: folded ? '▸' : '▾' }),
    createElement('span', { text: label }),
    createElement('span', { className: 'git__section-count', text: String(count) }),
  );
  toggle.addEventListener('click', () => actions.onToggleSection(key));
  line.append(toggle);

  if (create !== null) {
    const button = createIconButton(PLUS_ICON, {
      label: create.label,
      title: create.title,
      className: 'icon-button--row',
    });
    button.disabled = state.busy;
    button.addEventListener('click', create.run);
    line.append(button);
  }
  return line;
}

/** A remote's group inside the REMOTE section, folding on its own: `upstream` is rarely read. */
function buildGroup(
  key: GitSectionKey,
  remote: string,
  count: number,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLElement {
  const folded = state.collapsed.has(key);
  const toggle = createElement('button', { className: 'git__group-toggle' });
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(!folded));
  toggle.append(
    createElement('span', { className: 'git__chevron', text: folded ? '▸' : '▾' }),
    createElement('span', { className: 'git__ref-name', text: remote }),
    createElement('span', { className: 'git__section-count', text: String(count) }),
  );
  toggle.addEventListener('click', () => actions.onToggleSection(key));
  return toggle;
}

/**
 * One branch or tag.
 *
 * The current branch is marked by a dot and is the drop zone of the merge gesture; every other branch
 * is a drag source. A remote branch shows its name without the remote, the group heading above it
 * already saying which one.
 */
function buildRefRow(
  ref: GitRef,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLElement {
  const selected =
    state.selection.kind === 'commit' && state.selection.sha === ref.sha && state.target === null;
  const row = createElement('div', {
    className: `git__ref${ref.current ? ' git__ref--current' : ''}${selected ? ' git__ref--selected' : ''}`,
  });
  row.tabIndex = 0;

  row.append(
    createElement('span', {
      className: `git__ref-mark git__ref-mark--${ref.kind}`,
      text: ref.current ? '●' : ref.kind === 'tag' ? '#' : '',
    }),
  );
  const slash = ref.name.indexOf('/');
  const name = ref.kind === 'remote' && slash !== -1 ? ref.name.slice(slash + 1) : ref.name;
  row.append(createElement('span', { className: 'git__ref-name', text: name }));

  if (ref.kind === 'local') {
    const track = presentTrack(ref);
    if (track.length > 0 && track !== 'local') {
      row.append(createElement('span', { className: 'git__track', text: track }));
    }
  }
  // A tag the remote is known not to have. Only against an answer: unknown draws nothing.
  if (ref.kind === 'tag' && tagOnRemote(ref.name, state.remoteTags) === false) {
    row.append(
      createElement('span', {
        className: 'git__badge-local',
        text: 'local',
        title: `Not on ${state.remoteTags?.remote ?? 'the remote'}: right-click to push it`,
      }),
    );
  }

  row.title = describeRef(ref, repo);
  row.addEventListener('click', () => actions.onSelect({ kind: 'commit', sha: ref.sha }));
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      actions.onSelect({ kind: 'commit', sha: ref.sha });
    }
  });
  if (ref.kind !== 'tag' && !ref.current) {
    row.addEventListener('dblclick', () => {
      if (!state.busy) {
        actions.onCheckout(ref);
      }
    });
  }
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    actions.onRefMenu(ref, event.clientX, event.clientY);
  });

  if (ref.current) {
    makeMergeDropZone(row, state, actions);
  } else {
    makeRefDraggable(row, ref, actions);
  }
  return row;
}

/** The tooltip of a ref: what it is, where it stands, and the gestures it answers to. */
function describeRef(ref: GitRef, repo: GitRepoState): string {
  const lines = [ref.name];
  if (ref.kind === 'local') {
    lines.push(
      ref.upstream === null
        ? 'Never pushed'
        : `Follows ${ref.upstream}${ref.gone ? ' (gone)' : ''}`,
    );
  }
  lines.push(ref.sha.slice(0, 7));
  if (ref.current) {
    lines.push(`Checked out. Drop another branch here to merge it into ${repo.branch}.`);
  } else if (ref.kind === 'tag') {
    lines.push('Click: show the commit. Right click: push, delete.');
  } else {
    lines.push(
      ref.kind === 'remote'
        ? 'Click: show the commit. Double-click: check it out as a local branch. Drag onto the current branch: merge.'
        : 'Click: show the commit. Double-click: check out. Drag onto the current branch: merge.',
    );
  }
  return lines.join('\n');
}

/** The branch creation field, opened by the `+` of the LOCAL heading. Enter creates, Escape closes. */
function buildBranchForm(state: GitPanelState, actions: GitPanelActions): HTMLElement {
  const bar = createElement('div', { className: 'git__inline-form' });

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'git__input';
  input.placeholder = 'PROJ-000-description';
  input.value = state.branchDraft;
  input.setAttribute('aria-label', 'New branch name');
  input.addEventListener('input', () => actions.onBranchDraft(input.value));
  input.addEventListener('focus', () => actions.onEditing(true));
  input.addEventListener('blur', () => actions.onEditing(false));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && input.value.trim().length > 0) {
      actions.onCreateBranch(input.value);
    } else if (event.key === 'Escape') {
      actions.onCreating(null);
    }
  });

  const create = createElement('button', {
    className: 'button',
    text: 'Create',
    title: 'git checkout -b, from HEAD. The name is validated by git itself.',
  });
  create.type = 'button';
  create.disabled = state.busy || state.branchDraft.trim().length === 0;
  create.addEventListener('click', () => actions.onCreateBranch(state.branchDraft));

  bar.append(input, create);
  return bar;
}

/**
 * The stash creation form: a label, the untracked switch, and the button.
 *
 * The label is optional, because git writes a perfectly usable `WIP on <branch>: <sha> <subject>` by
 * itself. `--include-untracked` is a **choice and off by default**: a checkout already refuses to
 * overwrite tracked changes, so those are the ones a stash is for, whereas new files are the ones a
 * checkout carries across happily, and sweeping them away by default would move work nobody asked
 * to move.
 */
function buildStashForm(
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLElement {
  const form = createElement('div', { className: 'git__inline-form git__inline-form--stack' });

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'git__input';
  input.placeholder = 'Stash name (optional)';
  input.value = state.stashDraft;
  input.setAttribute('aria-label', 'Stash name');
  input.addEventListener('input', () => actions.onStashDraft(input.value));
  input.addEventListener('focus', () => actions.onEditing(true));
  input.addEventListener('blur', () => actions.onEditing(false));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      actions.onCreating(null);
    }
  });

  const untracked = repo.changes.filter((change) => change.untracked).length;
  const tracked = repo.changes.length - untracked;

  const toggle = createElement('label', { className: 'git__toggle' });
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'git__check';
  box.checked = state.stashUntracked;
  box.disabled = state.busy || untracked === 0;
  box.addEventListener('change', () => actions.onStashUntracked(box.checked));
  toggle.append(box, createElement('span', { text: `+ untracked (${untracked})` }));
  toggle.title =
    untracked === 0
      ? 'No untracked file to include'
      : 'git stash push --include-untracked: also takes the files git does not track yet';

  // Untracked files count towards "is there anything to stash" only when they are included: with the
  // box unticked, a repository whose only changes are new files has nothing for `git stash` to take.
  const stashable = state.stashUntracked ? repo.changes.length : tracked;
  const push = createElement('button', {
    className: 'button',
    text: 'Stash',
    title:
      stashable === 0
        ? 'Nothing to set aside'
        : `git stash push on ${stashable} file(s). The working tree goes back to HEAD.`,
  });
  push.type = 'button';
  push.disabled = state.busy || stashable === 0;
  push.addEventListener('click', () => actions.onStashPush());

  const footer = createElement('div', { className: 'git__inline-actions' });
  footer.append(toggle, push);
  form.append(input, footer);
  return form;
}

/**
 * One stash: a click shows what it holds in the detail panel, a right-click acts on it.
 *
 * The ref is shown because it is what `git stash` prints and what one would retype in a terminal,
 * and it is shown *knowing* it is positional: everything this tab does with the entry goes by sha.
 */
function buildStashRow(
  stash: GitStash,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLElement {
  const selected = state.selection.kind === 'stash' && state.selection.sha === stash.sha;
  const row = createElement('div', {
    className: `git__ref git__ref--stash${selected ? ' git__ref--selected' : ''}`,
  });
  row.tabIndex = 0;
  const from = stash.branch.length > 0 ? `\nFrom ${stash.branch}` : '';
  row.title = `${stash.ref} · ${stash.subject}${from}\n${stash.date}\nClick: see what it holds. Right click: apply, pop, drop.`;

  row.append(
    createElement('span', { className: 'git__ref-mark git__ref-mark--stash', text: '' }),
    createElement('span', { className: 'git__ref-name git__ref-name--prose', text: stash.subject }),
    createElement('span', { className: 'git__track', text: describeDay(stash.date) }),
  );
  const select = (): void => actions.onSelect({ kind: 'stash', sha: stash.sha, ref: stash.ref });
  row.addEventListener('click', select);
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      select();
    }
  });
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    actions.onStashMenu(stash, event.clientX, event.clientY);
  });
  return row;
}
