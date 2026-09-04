import type {
  GitBranch,
  GitChange,
  GitCommit,
  GitDiff,
  GitDiffTarget,
  GitRepoState,
  GitSequencer,
  GitSequencerOp,
  GitStash,
  GitStashOp,
  GitSyncOp,
  Project,
  ProjectId,
  TagColors,
} from '@shared/contracts.js';
import { hasStagedChanges, hasWorktreeChange, isStaged } from '@shared/git-changes.js';
import { clearChildren, createElement, createIcon, createIconButton, hitsInteractive } from './dom.js';
import { TERMINAL_ICON } from './icons.js';
import { buildPill } from './project-table.js';
import { presentChange, presentTrack } from './presenters.js';
import { buildTagDots, type TagPalette } from './tags.js';

/**
 * Which working area the middle column shows.
 *
 * Three views rather than three panels, for the same reason the strip has tabs: they answer three
 * separate questions ("what have I changed", "where am I", "what happened") and only one of them is
 * ever being asked. The diff column serves all three, which is what keeps them one tab.
 */
export type GitViewId = 'changes' | 'branches' | 'history' | 'stashes';

export const GIT_VIEWS: readonly { id: GitViewId; label: string }[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'branches', label: 'Branches' },
  { id: 'history', label: 'History' },
  /*
   * The stash list, added last and on the right for a reason: it is the view you go to on purpose,
   * whereas the first three are where the tab lands.
   *
   * It is also the one thing this tab used to refuse to do, and the refusal deserves its epitaph. The
   * argument was that a stash leaves the repository in a state the strip can neither show nor finish —
   * which was true of the *gesture* nobody wanted (an automatic stash behind a checkout) and false of
   * the object: a stash is a named, listed, complete snapshot, and creating one leaves a clean tree.
   * The states that argument really protects against are conflicts and rebases, and those are still
   * out. What did have to come with this view is the way back out of a conflicted `pop`, which is what
   * `sequencer` is for.
   */
  { id: 'stashes', label: 'Stash' },
];

/**
 * How many diff lines are painted.
 *
 * A generated lockfile or a bulk rename runs to tens of thousands of lines, and one element per line
 * is what makes the strip freeze. The cap is announced in the view rather than applied quietly: a
 * diff silently cut in half is worse than one that says it was cut.
 */
const MAX_DIFF_LINES = 4000;

export interface GitPanelHosts {
  readonly repos: HTMLElement;
  readonly header: HTMLElement;
  readonly views: HTMLElement;
  readonly list: HTMLElement;
  readonly commit: HTMLElement;
  readonly diff: HTMLElement;
}

export interface GitPanelState {
  /** Every watched project: the Git tab follows all of them, not just the ones with pull requests. */
  readonly projects: readonly Project[];
  /**
   * `tagKey -> colour`, for the dots beside the names in the repository column.
   *
   * The words come off `projects`, which already carries them; only the colour map has to be handed
   * over, and it is the whole map rather than a per-project slice because the colour belongs to the
   * tag and one row cannot be told what a word is painted anywhere else.
   */
  readonly tagColors: TagColors;
  readonly selectedProject: ProjectId | null;
  /** Null while the first read of the selected repository is still in flight. */
  readonly repo: GitRepoState | null;
  readonly view: GitViewId;
  readonly target: GitDiffTarget | null;
  readonly diff: GitDiff | null;
  /**
   * Draft commit message.
   *
   * Held by the application rather than left in the textarea, because the panel is rebuilt whole on
   * every refresh. The refresh is also suppressed while a field has focus, so this only ever has to
   * survive a rebuild that happened between two bursts of typing, never one during a keystroke.
   */
  readonly message: string;
  /**
   * Whether the commit form is amending the HEAD commit instead of creating a new one.
   *
   * Held here like the message, and reset with it when the repository changes: an amend armed on
   * one project must not survive onto another, where it would rewrite an unrelated commit.
   */
  readonly amend: boolean;
  /** Draft branch name, held for the same reason. */
  readonly branchDraft: string;
  /** Draft stash label, held for the same reason. */
  readonly stashDraft: string;
  /** Whether a new stash should sweep up untracked files. Off by default: see `buildStashForm`. */
  readonly stashUntracked: boolean;
  /** True while a write is in flight, so a double click cannot launch two checkouts. */
  readonly busy: boolean;
  /**
   * True while `Generate` is waiting on Claude Code.
   *
   * Its own flag rather than `busy`, and the difference is not cosmetic: `busy` disables the whole
   * form because a write is touching the repository, whereas a generation touches nothing and only
   * has to stop a second run from starting. Folding it into `busy` would grey out the textarea, which
   * is precisely where the answer is about to land and the one place still worth typing in while the
   * run takes its minute.
   */
  readonly generating: boolean;
}

export interface GitPanelActions {
  onSelectProject: (projectId: ProjectId) => void;
  onSelectView: (view: GitViewId) => void;
  /** Shows something in the diff column: a file of the working tree, or a whole commit. */
  onSelectTarget: (target: GitDiffTarget) => void;
  onStage: (paths: string[], staged: boolean) => void;
  /**
   * Throws the changes to those paths away: back to HEAD, or deleted when untracked.
   *
   * The one action of this tab that destroys work, so it is behind a right-click **and** behind a
   * confirmation raised by the main process. Neither guard is redundant: the gesture keeps it out of
   * reach of a stray click in a list, the dialog names the files before anything is touched.
   */
  onDiscard: (paths: string[]) => void;
  onCheckout: (name: string) => void;
  onCreateBranch: (name: string) => void;
  onCommit: () => void;
  onMessage: (value: string) => void;
  /**
   * Asks Claude Code for a commit message and puts it in the field.
   *
   * Fills the form; it never commits. The answer is a draft like anything else typed there, and the
   * commit stays the separate, deliberate click it already was.
   */
  onGenerateMessage: () => void;
  /** Arms or disarms the amend. Ticking it pre-fills the form with the message being replaced. */
  onAmend: (amend: boolean) => void;
  onBranchDraft: (value: string) => void;
  onSync: (op: GitSyncOp) => void;
  /** Replays a commit onto the current branch. `noCommit` is `-n`: staged, not committed. */
  onCherryPick: (sha: string, noCommit: boolean) => void;
  /** Finishes or abandons whatever git left half-done. Only offered when something is. */
  onSequencer: (op: GitSequencerOp) => void;
  onStashDraft: (value: string) => void;
  onStashUntracked: (include: boolean) => void;
  /** Stashes the working tree under the current draft label. */
  onStashPush: () => void;
  /** Applies, pops or drops a stash. Named by sha, never by its position in the list. */
  onStash: (stash: GitStash, op: GitStashOp) => void;
  /** Puts a short sha on the clipboard: the one thing a commit row is asked for outside this app. */
  onCopy: (text: string) => void;
  /** Opens a new terminal tab in the repository, same gesture as everywhere else in the app. */
  onNewTerminal: (projectId: ProjectId) => void;
  /** Opens the repository's action menu, from the `⋯` button or from a right-click on the header. */
  onMenu: (x: number, y: number) => void;
  /** Opens a commit's action menu, from a right-click on its row in the history. */
  onCommitMenu: (commit: GitCommit, x: number, y: number) => void;
  /** Opens a stash's action menu, from a right-click on its row. */
  onStashMenu: (stash: GitStash, x: number, y: number) => void;
  /** Opens a changed file's action menu, from a right-click on its row in the Changes view. */
  onChangeMenu: (change: GitChange, x: number, y: number) => void;
  /**
   * Reports that a text field has the focus.
   *
   * The panel is rebuilt on every git poll, so a refresh landing mid-sentence would replace the
   * textarea under the cursor. Same guard, and the same reason, as the project table's inline rename.
   */
  onEditing: (editing: boolean) => void;
}

/** Paints the whole tab: repositories, working area, diff. */
export function renderGitPanel(
  hosts: GitPanelHosts,
  state: GitPanelState,
  actions: GitPanelActions,
): void {
  renderRepos(hosts.repos, state, actions);

  clearChildren(hosts.header);
  clearChildren(hosts.views);
  clearChildren(hosts.list);
  clearChildren(hosts.commit);
  clearChildren(hosts.diff);

  if (state.projects.length === 0) {
    hosts.list.append(
      createElement('p', { className: 'pulls__empty', text: 'No project configured.' }),
    );
    return;
  }

  const repo = state.repo;
  if (repo === null) {
    hosts.list.append(createElement('p', { className: 'pulls__empty', text: 'Reading...' }));
    return;
  }
  if (repo.error !== null) {
    hosts.header.append(buildHeader(repo, state, actions));
    hosts.list.append(createElement('p', { className: 'pulls__error', text: repo.error }));
    return;
  }

  hosts.header.append(buildHeader(repo, state, actions));
  renderViews(hosts.views, repo, state, actions);

  switch (state.view) {
    case 'changes':
      renderChanges(hosts.list, repo, state, actions);
      renderCommitForm(hosts.commit, repo, state, actions);
      break;
    case 'branches':
      renderBranches(hosts.list, repo, state, actions);
      break;
    case 'history':
      renderHistory(hosts.list, repo, state, actions);
      break;
    case 'stashes':
      renderStashes(hosts.list, repo, state, actions);
      break;
  }

  renderDiff(hosts.diff, state, actions);
}

/* ---------------------------------------------------------------- columns */

/**
 * The repository column.
 *
 * Every project, not only the ones following pull requests: `followPulls` says whether GitHub should
 * be polled for a repository, which has nothing to do with whether you might want to commit in it.
 * The badge counts changed files, so the column answers "where do I have work in progress" on its own.
 */
function renderRepos(host: HTMLElement, state: GitPanelState, actions: GitPanelActions): void {
  clearChildren(host);

  const palette: TagPalette = { projects: state.projects, colors: state.tagColors };

  for (const project of state.projects) {
    const active = project.id === state.selectedProject;
    // The wrapper exists only so the terminal icon can be a sibling of the row; see `buildRepoTerminal`.
    const line = createElement('div', { className: 'git__repo-line' });
    const row = createElement('button', {
      className: `pulls__repo${active ? ' pulls__repo--active' : ''}`,
    });
    row.type = 'button';
    // Before the name, same as in the pull request column and for the same reason: the dots of every
    // row then start on one edge, which is what makes a column of them scannable.
    const dots = buildTagDots(palette, project.id);
    if (dots !== null) {
      row.append(dots);
    }
    row.append(createElement('span', { className: 'pulls__repo-name', text: project.label }));

    // Only the selected repository has been read, so only it can show a count. Guessing one for the
    // others would mean reading every repository on every paint.
    if (active && state.repo !== null && state.repo.error === null) {
      const count = state.repo.changes.length;
      row.append(
        createElement('span', {
          className: 'pulls__repo-count',
          text: count === 0 ? '—' : String(count),
        }),
      );
      row.title = `${state.repo.branch}\n${count} modified file(s)`;
    } else {
      row.title = project.path;
    }

    row.addEventListener('click', () => actions.onSelectProject(project.id));
    line.append(row, buildRepoTerminal(project, actions));
    host.append(line);
  }
}

/**
 * The per-repository terminal shortcut, next to the project's name.
 *
 * A **sibling** of the row rather than a child of it, and that is the whole reason this column grew a
 * wrapper element. The row is a real `<button>`, so it is reachable by Tab and answers Enter; nesting
 * a button inside a button is invalid HTML that browsers silently rearrange, which is the same reason
 * a pull request row is a `div`. Here the row keeps its semantics and the icon is a control in its own
 * right, so neither has to give anything up.
 *
 * Being outside the row also settles what the gesture means: opening a terminal does **not** select
 * the repository, so it cannot set off a git read of a repo nobody asked to look at. And it is not
 * disabled by `state.busy`, unlike every other control of this tab — it runs no git command, exactly
 * like the same entry in the repository menu.
 */
function buildRepoTerminal(project: Project, actions: GitPanelActions): HTMLButtonElement {
  const button = createIconButton(TERMINAL_ICON, {
    // The name has to say which project: there is one of these per row.
    label: `Open a terminal in ${project.label}`,
    title: `Open a new terminal tab in ${project.path}`,
    className: 'icon-button--row',
  });
  button.addEventListener('click', () => actions.onNewTerminal(project.id));
  return button;
}

/**
 * Branch, distance from the upstream, and the way into the repository's actions.
 *
 * Fetch, pull, push and "open a terminal here" used to be four buttons across this row. They are a
 * menu now, and the row is better for it: a status strip is read at a glance, and four controls
 * competing with the branch name is not a glance. The menu is reached by right-clicking the row —
 * the gesture anyone tries on a repository line — with a `⋯` button kept for the same reason the
 * strip kept its chevron next to the double-click: the power gesture does not have to be the
 * discoverable one, but *something* has to be.
 */
function buildHeader(
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLElement {
  const header = createElement('div', { className: 'git__header-row' });
  header.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    actions.onMenu(event.clientX, event.clientY);
  });

  header.append(
    createElement('span', {
      className: 'git__branch',
      text: repo.branch,
      title: `Current branch of ${repo.label}`,
    }),
  );

  if (repo.hasUpstream) {
    const marks: string[] = [];
    if (repo.ahead > 0) {
      marks.push(`↑${repo.ahead}`);
    }
    if (repo.behind > 0) {
      marks.push(`↓${repo.behind}`);
    }
    if (marks.length > 0) {
      header.append(
        buildPill({
          label: marks.join(' '),
          tone: repo.behind > 0 ? 'busy' : 'info',
          title: `${repo.ahead} commit(s) ahead, ${repo.behind} behind`,
        }),
      );
    }
  } else {
    header.append(
      buildPill({
        label: 'no upstream',
        tone: 'neutral',
        // Not an error: it is simply the state of every branch before its first push, and `Push`
        // below is precisely the button that fixes it.
        title: 'The branch has never been pushed. "Push" will publish it with -u origin.',
      }),
    );
  }

  /*
   * A half-finished operation is said out loud, right next to the branch.
   *
   * This is the state where every other button of the tab fails for a reason that has nothing to do
   * with what was clicked: mid-cherry-pick, a checkout refuses, a commit commits the wrong thing, and
   * git's message talks about a sequencer nobody mentioned. The pill is `error`-toned on purpose — it
   * is not a mode you meant to be in, and the way out is one right-click away in the repository menu.
   */
  if (repo.sequencer !== 'none') {
    header.append(
      buildPill({
        label: `${SEQUENCER_LABELS[repo.sequencer]} in progress`,
        tone: 'error',
        title: `The repository is in the middle of a ${SEQUENCER_LABELS[repo.sequencer]}. Continue or abort from the repository menu (right click).`,
      }),
    );
  }

  header.append(createElement('span', { className: 'git__spacer' }));

  const menu = createElement('button', {
    className: 'button button--quiet git__menu-button',
    text: '⋯',
    title: 'Repository actions: fetch, pull, push, terminal (or right click this row)',
  });
  menu.type = 'button';
  menu.disabled = state.busy;
  menu.setAttribute('aria-label', 'Repository actions');
  menu.addEventListener('click', (event) => {
    /*
     * `stopPropagation` is what makes this button work at all.
     *
     * `showContextMenu` closes on any `click` reaching `document`, which is right for every other
     * caller: they all open from `contextmenu`, and a right-click fires no `click` at all. This is the
     * first menu opened by a **left** click, so without this the opening click carried on to the
     * document listener and shut the menu in the same tick — a button that looked completely dead.
     */
    event.stopPropagation();
    // Anchored under the button rather than at the pointer, so the menu lands in the same place
    // whether it was opened by click or by keyboard.
    const box = menu.getBoundingClientRect();
    actions.onMenu(box.left, box.bottom + 2);
  });
  header.append(menu);

  return header;
}

/**
 * How each half-finished operation is named to the user.
 *
 * git's own words, not translations: `cherry-pick` and `rebase` are what the command prints and what
 * every answer found online calls them, so renaming them here would make the message harder to act on
 * rather than friendlier.
 */
const SEQUENCER_LABELS: Record<Exclude<GitSequencer, 'none'>, string> = {
  'cherry-pick': 'cherry-pick',
  merge: 'merge',
  revert: 'revert',
  rebase: 'rebase',
};

/**
 * The repository's actions, as a menu.
 *
 * Built here rather than in `main.ts` so the labels and the reasons stay next to the view that
 * explains them. `hint` carries what the button tooltips used to say, which is where the two
 * deliberate limitations of this tab are written down: pull is fast-forward only, and push publishes
 * a new branch with `-u` on its first run.
 */
export function buildRepoMenuItems(
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): { label: string; hint: string; disabled: boolean; run: () => void }[] {
  /*
   * The way out of a half-finished operation, first in the list when there is one.
   *
   * First because in that state it is the only thing worth doing: fetch, pull and push all fail from
   * there, and a menu that opens on them is a menu that wastes a click. Abandoning comes before
   * continuing, which is the reverse of how they read but the right order for how they are used — you
   * open this menu because something went wrong, and `--abort` is the one that cannot make it worse.
   */
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

  return [
    ...sequencer,
    {
      label: 'Fetch',
      hint: 'git fetch --prune',
      disabled: state.busy,
      run: () => actions.onSync('fetch'),
    },
    {
      label: 'Pull (fast-forward seulement)',
      hint: 'git pull --ff-only. A diverged branch has to go through the terminal: this tab cannot finish a rebase.',
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
      label: 'Open a terminal here',
      hint: `New tab in ${repo.path}`,
      disabled: false,
      run: () => actions.onNewTerminal(repo.projectId),
    },
  ];
}

/**
 * Icons for the three network operations.
 *
 * A circular arrow for fetch, and two mirrored arrows over a baseline for pull and push: the line is
 * the local repository, down brings work in, up sends it out. Fetch gets a different *silhouette*
 * rather than a third arrow on purpose — it is the one that changes nothing on disk, and three
 * variations of the same arrow would make the harmless one look like the other two.
 */
const SYNC_ICONS: Record<GitSyncOp, string> = {
  /*
   * A three-quarter circle opening at the top right, with the arrowhead at twelve o'clock pointing
   * into that gap.
   *
   * The arrowhead is deliberately large — 2.2 units of a 16-unit box. The first version drew it at
   * 1.3 units, which after the 14px render is barely one pixel per barb: it came out as a hairline
   * stub and the icon read as a plain "C". An arrowhead has to be sized against the *rendered* icon,
   * not against the geometry that looks balanced in the editor.
   */
  fetch: 'M12.4 8A4.4 4.4 0 1 1 8 3.6M6 1.6L8.2 3.6L6 5.6',
  pull: 'M8 2.5L8 9.7M5.3 7L8 9.7L10.7 7M3.5 13L12.5 13',
  push: 'M8 9.7L8 2.5M5.3 5.2L8 2.5L10.7 5.2M3.5 13L12.5 13',
};

const SYNC_LABELS: Record<GitSyncOp, { label: string; hint: string }> = {
  fetch: { label: 'Fetch', hint: 'Fetches the remote refs (git fetch --prune)' },
  pull: {
    label: 'Pull',
    hint: 'git pull --ff-only. A diverged branch has to go through the terminal: this tab cannot finish a rebase.',
  },
  push: { label: 'Push', hint: 'git push' },
};

/**
 * The three sub-tabs, each carrying its own count, and the network actions on the right.
 *
 * The actions sit in this row rather than in the header because this is the row of controls: the
 * header is a status line (branch, distance from upstream) and mixing verbs into it is what made it
 * unreadable when they were four labelled buttons. As icons at the far end of the tab row they are
 * one click away without competing with anything for attention.
 */
function renderViews(
  host: HTMLElement,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): void {
  for (const view of GIT_VIEWS) {
    const active = view.id === state.view;
    const button = createElement('button', {
      className: `subtab${active ? ' subtab--active' : ''}`,
    });
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(active));
    button.append(createElement('span', { text: view.label }));

    const count = countFor(view.id, repo);
    if (count !== null) {
      button.append(createElement('span', { className: 'subtab__count', text: String(count) }));
    }

    button.addEventListener('click', () => actions.onSelectView(view.id));
    host.append(button);
  }

  host.append(createElement('span', { className: 'git__spacer' }));
  for (const op of ['fetch', 'pull', 'push'] as const) {
    host.append(buildSyncIcon(op, repo, state, actions));
  }
}

function buildSyncIcon(
  op: GitSyncOp,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLButtonElement {
  const { label, hint } = SYNC_LABELS[op];
  const button = createElement('button', { className: 'icon-button git__sync' });
  button.type = 'button';
  button.disabled = state.busy;
  // The label lives in the tooltip and in `aria-label`: an icon alone says nothing to a screen
  // reader, and `push -u` is worth spelling out the first time a branch is published.
  button.title =
    op === 'push' && !repo.hasUpstream
      ? `Push and publish the branch: git push -u origin ${repo.branch}`
      : `${label} — ${hint}`;
  button.setAttribute('aria-label', label);
  button.append(createIcon(SYNC_ICONS[op], { paint: 'stroke' }));
  button.addEventListener('click', () => actions.onSync(op));
  return button;
}

function countFor(view: GitViewId, repo: GitRepoState): number | null {
  switch (view) {
    case 'changes':
      return repo.changes.length;
    case 'branches':
      return repo.branches.length;
    case 'stashes':
      // Shown even at zero, unlike the history: "how many stashes do I have here" is exactly the
      // question this view answers, and the answer is often none.
      return repo.stashes.length;
    case 'history':
      return null;
  }
}

/* ---------------------------------------------------------------- changes */

/**
 * The changed files, each with a staging checkbox.
 *
 * The checkbox is the staging gesture and the row is the diff gesture, which is why the row-level
 * click is guarded by `hitsInteractive`: ticking a box must not also swap the diff column, or every
 * staging action would move the view out from under the file being staged.
 */
function renderChanges(
  host: HTMLElement,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): void {
  if (repo.changes.length === 0) {
    host.append(
      createElement('p', { className: 'pulls__empty', text: 'Nothing to commit, everything is clean.' }),
    );
    return;
  }

  host.append(buildStagingBar(repo, state, actions));

  for (const change of repo.changes) {
    host.append(buildChangeRow(change, state, actions));
  }
}

/** "Stage all" / "Unstage all", the two gestures a per-file checkbox makes tedious. */
function buildStagingBar(
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLElement {
  const bar = createElement('div', { className: 'git__bar' });

  const unstaged = repo.changes.filter((change) => !isStaged(change) || hasWorktreeChange(change));
  const staged = repo.changes.filter(isStaged);

  const addAll = createElement('button', {
    className: 'button button--quiet',
    text: `Stage all (${unstaged.length})`,
    title: 'git add on every modified file',
  });
  addAll.type = 'button';
  addAll.disabled = state.busy || unstaged.length === 0;
  addAll.addEventListener('click', () =>
    actions.onStage(unstaged.map((change) => change.path), true),
  );

  const removeAll = createElement('button', {
    className: 'button button--quiet',
    text: `Unstage all (${staged.length})`,
    title: 'git restore --staged on the whole index',
  });
  removeAll.type = 'button';
  removeAll.disabled = state.busy || staged.length === 0;
  removeAll.addEventListener('click', () =>
    actions.onStage(staged.map((change) => change.path), false),
  );

  bar.append(addAll, removeAll);
  return bar;
}

function buildChangeRow(
  change: GitChange,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLElement {
  const label = presentChange(change);
  const selected =
    state.target?.kind === 'file' && state.target.path === change.path
      ? ' git__row--selected'
      : '';
  const row = createElement('div', { className: `git__row git__change${selected}` });
  row.title = `${change.path}\n${label.title}\n(click: see the diff, right click: act)`;

  /*
   * Discarding is behind a right-click, like cherry-pick and every stash operation.
   *
   * The same judgement those two record, at its strongest: this row is clicked all day to read a
   * diff, and the action being added to it is the only one in the app that destroys work outright. A
   * button here would put it one stray click away from the gesture people make constantly, which is
   * precisely the arrangement `Checkout` was made a button to avoid in the other direction.
   */
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    actions.onChangeMenu(change, event.clientX, event.clientY);
  });

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'git__check';
  box.checked = isStaged(change);
  box.disabled = state.busy;
  box.title = box.checked ? 'Unstage' : 'Stage';
  box.addEventListener('change', () => actions.onStage([change.path], box.checked));
  row.append(box);

  row.append(buildPill(label));
  // `textContent` throughout: a path comes from the file system, not from this app.
  row.append(createElement('span', { className: 'git__path', text: change.path }));

  row.addEventListener('click', (event) => {
    if (hitsInteractive(event)) {
      return;
    }
    actions.onSelectTarget(defaultTargetFor(change));
  });

  return row;
}

/**
 * The commit form.
 *
 * The button is disabled when nothing is staged, using the same `hasStagedChanges` the main process
 * would: an enabled button that produces "nothing added to commit" in a terminal tab teaches nothing.
 * **Amending lifts that rule**: `git commit --amend` with an empty index is a reword, which is half
 * of what an amend is for.
 *
 * The amend is a checkbox rather than a second button, and that is a judgement call in line with the
 * cherry-pick one: an amend rewrites history, so it must not be reachable by the same single click
 * that commits. Arming it first, watching the button change name, then clicking, is the deliberate
 * two-step gesture. Ticking it pre-fills the form with the message being replaced (`headMessage`),
 * because an amend that silently drops the old body would lose what it promised to edit.
 */
function renderCommitForm(
  host: HTMLElement,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): void {
  const area = document.createElement('textarea');
  area.className = 'git__message';
  area.rows = 3;
  area.placeholder = 'Commit message';
  area.value = state.message;
  area.addEventListener('input', () => actions.onMessage(area.value));
  // The panel is rebuilt on every poll; while this has the focus, the refresh holds off.
  area.addEventListener('focus', () => actions.onEditing(true));
  area.addEventListener('blur', () => actions.onEditing(false));

  const staged = hasStagedChanges(repo.changes);
  const head = repo.commits[0];

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
      : `git commit --amend: rewrites ${head.sha} "${head.subject}".${
          repo.hasUpstream && repo.ahead === 0
            ? '\nAlready pushed: the next push will have to be forced.'
            : ''
        }`;

  /*
   * `Generate`, which asks Claude Code for the message rather than writing one from a template.
   *
   * Secondary and to the left of `Commit`, in the order the gesture happens. It obeys the same
   * staged-or-amending rule as the commit button, and for the same reason: with an empty index there
   * is no diff, so a run would take its minute and come back with an invented message. `busy` blocks
   * it because a write is in flight; `generating` blocks it because one is already running.
   *
   * It does **not** care whether the textarea already has something in it. Regenerating over a draft
   * is a normal thing to want, and a button that refused would be one you have to clear a field to
   * use. The answer replacing a draft is why this is a button and not something that fires on its own.
   */
  const generate = createElement('button', {
    className: 'button',
    text: state.generating ? 'Generating…' : 'Generate',
  });
  generate.type = 'button';
  generate.disabled = state.busy || state.generating || (!staged && !state.amend);
  generate.title = state.generating
    ? 'Claude Code is reading the diff'
    : staged || state.amend
      ? "Write the message from the staged diff, following this repository's conventions"
      : 'Nothing staged: tick at least one file';
  generate.addEventListener('click', () => actions.onGenerateMessage());

  const button = createElement('button', {
    className: 'button button--primary',
    text: state.amend ? 'Amend' : 'Commit',
  });
  button.type = 'button';
  button.disabled =
    state.busy || state.message.trim().length === 0 || (!staged && !state.amend);
  button.title = state.amend
    ? 'git commit --amend -F, launched in a terminal tab so the hooks stay visible'
    : staged
      ? 'git commit -F, launched in a terminal tab so the hooks stay visible'
      : 'Nothing staged: tick at least one file';
  button.addEventListener('click', () => actions.onCommit());


  const footer = createElement('div', { className: 'git__commit-actions' });
  footer.append(
    createElement('span', {
      className: 'strip__meta',
      text: staged
        ? `${repo.changes.filter(isStaged).length} staged file(s)`
        : state.amend
          ? 'Empty index: rewords the last commit'
          : 'Empty index',
    }),
    toggle,
    generate,
    button,
  );

  host.append(area, footer);
}

/* --------------------------------------------------------------- branches */

/**
 * The branch list, newest first, with the creation field above it.
 *
 * Checkout is a button rather than a click on the row: switching branch changes what is on disk, and
 * it is the one gesture in this tab that must not be reachable by a stray click on a list.
 */
function renderBranches(
  host: HTMLElement,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): void {
  host.append(buildBranchForm(state, actions));

  if (repo.branches.length === 0) {
    host.append(createElement('p', { className: 'pulls__empty', text: 'No local branch.' }));
    return;
  }

  for (const branch of repo.branches) {
    host.append(buildBranchRow(branch, state, actions));
  }
}

function buildBranchForm(state: GitPanelState, actions: GitPanelActions): HTMLElement {
  const bar = createElement('div', { className: 'git__bar' });

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'git__input';
  input.placeholder = 'PROJ-000-description';
  input.value = state.branchDraft;
  input.addEventListener('input', () => actions.onBranchDraft(input.value));
  input.addEventListener('focus', () => actions.onEditing(true));
  input.addEventListener('blur', () => actions.onEditing(false));
  // Enter is the gesture people use in a single-field form, and the button stays for discoverability.
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && input.value.trim().length > 0) {
      actions.onCreateBranch(input.value);
    }
  });

  const create = createElement('button', {
    className: 'button',
    text: 'Create and switch',
    title: 'git checkout -b, from the current branch. The name is validated by git itself.',
  });
  create.type = 'button';
  create.disabled = state.busy || state.branchDraft.trim().length === 0;
  create.addEventListener('click', () => actions.onCreateBranch(state.branchDraft));

  bar.append(input, create);
  return bar;
}

function buildBranchRow(
  branch: GitBranch,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLElement {
  const row = createElement('div', {
    className: `git__row git__branch-row${branch.current ? ' git__row--selected' : ''}`,
  });
  row.title = branch.upstream === null ? branch.name : `${branch.name} → ${branch.upstream}`;

  row.append(createElement('span', { className: 'git__label', text: branch.name }));

  const track = presentTrack(branch);
  if (track.length > 0) {
    row.append(
      createElement('span', {
        className: 'git__track',
        text: track,
      }),
    );
  }

  if (branch.current) {
    row.append(createElement('span', { className: 'badge-warn', text: 'courante' }));
  } else {
    const checkout = createElement('button', {
      className: 'button button--quiet',
      text: 'Checkout',
      title: `git checkout ${branch.name}`,
    });
    checkout.type = 'button';
    checkout.disabled = state.busy;
    checkout.addEventListener('click', () => actions.onCheckout(branch.name));
    row.append(checkout);
  }

  return row;
}

/* -------------------------------------------------------------- history */

/** The last commits, each opening its own diff in the third column. */
function renderHistory(
  host: HTMLElement,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): void {
  if (repo.commits.length === 0) {
    host.append(createElement('p', { className: 'pulls__empty', text: 'No commit.' }));
    return;
  }

  for (const commit of repo.commits) {
    host.append(buildCommitRow(commit, repo, state, actions));
  }
}

/**
 * A commit's own actions, as a menu.
 *
 * A right-click and not a button, and that is the same judgement the checkout button records in
 * reverse: a checkout changes the disk, so it must not be reachable by a stray click on a list; a
 * cherry-pick changes the *history*, so it must not be reachable at all without asking for it. The
 * history column is scrolled and clicked all day to read diffs, and a visible `Cherry-pick` sitting on
 * every row of it would be one mis-click away from a commit nobody wanted.
 *
 * Rebuilt at each opening like the repository menu, because it too depends on live state: the target
 * branch is in the labels, and a menu built once would name the branch you have since left. Exported
 * for the same reason `buildRepoMenuItems` is — the labels and the reasons belong next to the view.
 */
export function buildCommitMenuItems(
  commit: GitCommit,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): { label: string; hint: string; disabled: boolean; run: () => void }[] {
  // A cherry-pick onto a dirty tree is refused by git itself, and the refusal is worth pre-empting:
  // the item says why rather than letting the button produce an error two clicks later.
  const dirty = repo.changes.length > 0;
  const blocked = state.busy || repo.sequencer !== 'none';

  return [
    {
      label: `Cherry-pick onto ${repo.branch}`,
      hint: dirty
        ? 'git cherry-pick, but the working tree is not clean: git will refuse.'
        : `git cherry-pick ${commit.sha}: replays this commit on the current branch.`,
      disabled: blocked,
      run: () => actions.onCherryPick(commit.sha, false),
    },
    {
      label: 'Cherry-pick without committing',
      hint: `git cherry-pick -n ${commit.sha}: the changes land in the index, committing is up to you.`,
      disabled: blocked,
      run: () => actions.onCherryPick(commit.sha, true),
    },
    {
      label: 'Copy the sha',
      hint: commit.sha,
      disabled: false,
      run: () => actions.onCopy(commit.sha),
    },
    {
      label: 'See the diff',
      hint: 'Same as clicking the row.',
      disabled: false,
      run: () => actions.onSelectTarget({ kind: 'commit', sha: commit.sha }),
    },
  ];
}

function buildCommitRow(
  commit: GitCommit,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLElement {
  const selected =
    state.target?.kind === 'commit' && state.target.sha === commit.sha
      ? ' git__row--selected'
      : '';
  const row = createElement('div', { className: `git__row git__commit-row${selected}` });
  // The refs are in the tooltip because the badge is capped: on a merge commit the decoration is
  // longer than the row, and truncating it in the view must not make it unreadable altogether.
  const refs = commit.refs.length > 0 ? `\n${commit.refs}` : '';
  row.title = `${commit.subject}\n${commit.author}, ${commit.date}${refs}\n(click: see the diff, right click: act)`;

  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    actions.onCommitMenu(commit, event.clientX, event.clientY);
  });

  row.append(createElement('span', { className: 'git__sha', text: commit.sha }));
  row.append(createElement('span', { className: 'git__label', text: commit.subject }));

  if (commit.refs.length > 0) {
    row.append(createElement('span', { className: 'git__refs', text: commit.refs }));
  }
  row.append(createElement('span', { className: 'pull__age', text: describeDay(commit.date) }));

  row.addEventListener('click', (event) => {
    if (hitsInteractive(event)) {
      return;
    }
    actions.onSelectTarget({ kind: 'commit', sha: commit.sha });
  });

  return row;
}

/* --------------------------------------------------------------- stashes */

/**
 * The stash list, with the creation form above it.
 *
 * Same shape as the branches view (a form, then the list) because it is the same grammar: a list of
 * named things you can create one of. What differs is that every action on an entry is behind a
 * right-click rather than a button — `pop` and `drop` both *remove* the entry, and `drop` removes it
 * with nothing on screen able to bring it back, so neither belongs on a row that is also clicked to
 * read a diff.
 */
function renderStashes(
  host: HTMLElement,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): void {
  host.append(buildStashForm(repo, state, actions));

  if (repo.stashes.length === 0) {
    host.append(
      createElement('p', {
        className: 'pulls__empty',
        text: 'No stash. The form above sets aside what is modified.',
      }),
    );
    return;
  }

  for (const stash of repo.stashes) {
    host.append(buildStashRow(stash, state, actions));
  }
}

/**
 * The creation form: a label, the untracked switch, and the button.
 *
 * The label is optional and the placeholder says so, because git writes a perfectly usable
 * `WIP on <branch>: <sha> <subject>` by itself; forcing a name would be asking for one at the moment
 * someone is in a hurry to switch branches, which is when a stash is made.
 *
 * `--include-untracked` is a **choice and off by default**, and that is the load-bearing half. A
 * checkout already refuses to overwrite tracked changes, so those are the ones a stash is for; new
 * files are the ones a checkout carries across happily, so sweeping them away by default would move
 * work nobody asked to move. Off, the count next to the button says how many files are being left
 * behind, which is the honest way to offer the switch.
 */
function buildStashForm(
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLElement {
  const bar = createElement('div', { className: 'git__bar' });

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'git__input';
  input.placeholder = 'Stash name (optional)';
  input.value = state.stashDraft;
  input.addEventListener('input', () => actions.onStashDraft(input.value));
  input.addEventListener('focus', () => actions.onEditing(true));
  input.addEventListener('blur', () => actions.onEditing(false));

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

  bar.append(input, toggle, push);
  return bar;
}

function buildStashRow(
  stash: GitStash,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLElement {
  const selected =
    state.target?.kind === 'stash' && state.target.sha === stash.sha
      ? ' git__row--selected'
      : '';
  const row = createElement('div', { className: `git__row git__stash-row${selected}` });
  const from = stash.branch.length > 0 ? `\nDepuis ${stash.branch}` : '';
  row.title = `${stash.ref} · ${stash.subject}${from}\n${stash.date}\n(click: see the diff, right click: apply, pop, drop)`;

  // The ref is shown because it is what `git stash` prints and what the user would type in a terminal,
  // and it is shown *knowing* it is positional: everything this app does with the entry goes by sha.
  row.append(createElement('span', { className: 'git__sha', text: stash.ref }));
  row.append(createElement('span', { className: 'git__label', text: stash.subject }));

  if (stash.branch.length > 0) {
    row.append(createElement('span', { className: 'git__refs', text: stash.branch }));
  }
  row.append(createElement('span', { className: 'pull__age', text: describeDay(stash.date) }));

  row.addEventListener('click', (event) => {
    if (hitsInteractive(event)) {
      return;
    }
    actions.onSelectTarget({ kind: 'stash', sha: stash.sha, ref: stash.ref });
  });
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    actions.onStashMenu(stash, event.clientX, event.clientY);
  });

  return row;
}

/**
 * A stash's actions, as a menu.
 *
 * Three verbs that are easy to confuse and easy to regret, so each hint says what happens to the entry
 * itself and not only to the working tree. `drop` is last and says it cannot be undone: git keeps the
 * commit reachable through its reflog for a while, but nothing in this tab can find it again, and
 * promising a recovery it does not offer would be worse than saying it is final.
 */
/**
 * What a changed file offers on a right-click.
 *
 * Three entries and no more: the diff, the staging toggle the checkbox already carries, and the one
 * gesture that has nowhere else to live. The first two are repeated deliberately, since a menu
 * holding a single destructive item is a menu whose only purpose is that item, and it invites the
 * click it should be making people think about.
 *
 * The discard label says what will happen to **this** file rather than a generic "discard": an
 * untracked file is deleted, and someone who has read the word "discard" as "unstage" has to be told
 * before the dialog, not by it. The staging half of the same idea is why the label reads `Unstage`
 * only for something actually in the index.
 *
 * Rebuilt on every open, like the repository and stash menus: every label here depends on the row's
 * current state, and a menu built once would eventually describe the file as it was.
 */
export function buildChangeMenuItems(
  change: GitChange,
  state: GitPanelState,
  actions: GitPanelActions,
): { label: string; hint: string; disabled: boolean; run: () => void }[] {
  // Same guard as the stash menu, spelled out for the same reason: a repository half-way through a
  // cherry-pick refuses every one of these for a cause that has nothing to do with the click.
  const blocked = state.busy || (state.repo !== null && state.repo.sequencer !== 'none');
  const staged = isStaged(change);
  return [
    {
      label: 'See the diff',
      hint: 'The same thing a click on the row does.',
      disabled: false,
      run: () => actions.onSelectTarget(defaultTargetFor(change)),
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

export function buildStashMenuItems(
  stash: GitStash,
  state: GitPanelState,
  actions: GitPanelActions,
): { label: string; hint: string; disabled: boolean; run: () => void }[] {
  // Blocked mid-operation, and spelled out rather than written as `state.repo?.sequencer !== 'none'`:
  // that form also blocks when there is no repository at all, which happens to be right here and would
  // be wrong the first time someone reuses it.
  const blocked = state.busy || (state.repo !== null && state.repo.sequencer !== 'none');
  return [
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

/* ------------------------------------------------------------------ diff */

/**
 * The diff column.
 *
 * One view for a working-tree file and for a commit, because both are unified diffs and the reader's
 * question is the same. The line numbers are shown in two gutters rather than one: a diff is a
 * statement about two files at once, and a single column would have to lie about one of them.
 */
function renderDiff(host: HTMLElement, state: GitPanelState, actions: GitPanelActions): void {
  if (state.target === null) {
    host.append(
      createElement('p', {
        className: 'pulls__empty',
        text: 'Select a file or a commit to see its diff.',
      }),
    );
    return;
  }

  const diff = state.diff;
  if (diff === null) {
    host.append(createElement('p', { className: 'pulls__empty', text: 'Reading the diff...' }));
    return;
  }

  host.append(buildDiffHeader(diff, state, actions));

  if (diff.note !== null) {
    host.append(createElement('p', { className: 'pulls__empty', text: diff.note }));
    return;
  }

  const body = createElement('div', { className: 'diff' });
  for (const line of diff.lines.slice(0, MAX_DIFF_LINES)) {
    const row = createElement('div', { className: `diff__line diff__line--${line.kind}` });
    row.append(
      createElement('span', {
        className: 'diff__gutter',
        text: line.oldLine === null ? '' : String(line.oldLine),
      }),
      createElement('span', {
        className: 'diff__gutter',
        text: line.newLine === null ? '' : String(line.newLine),
      }),
      createElement('span', { className: 'diff__text', text: line.text }),
    );
    body.append(row);
  }
  host.append(body);

  if (diff.lines.length > MAX_DIFF_LINES) {
    // Announced rather than silent: a truncated diff that says nothing reads as a complete one.
    host.append(
      createElement('p', {
        className: 'pulls__empty',
        text: `Diff truncated: ${MAX_DIFF_LINES} lines out of ${diff.lines.length}. Open it in the terminal for the rest.`,
      }),
    );
  }
}

/**
 * The diff's heading, plus the index/disk switch when both sides exist.
 *
 * That switch only appears for a file that is staged **and** modified again, which is the one case
 * where "the diff of this file" has two different answers and picking one silently would hide the
 * other. Everywhere else there is nothing to choose and no button.
 */
function buildDiffHeader(
  diff: GitDiff,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLElement {
  const header = createElement('div', { className: 'git__bar' });
  header.append(createElement('span', { className: 'git__diff-title', text: diff.title }));

  const target = state.target;
  if (target === null || target.kind !== 'file') {
    return header;
  }

  const change = state.repo?.changes.find((entry) => entry.path === target.path);
  if (change === undefined || !isStaged(change) || !hasWorktreeChange(change)) {
    return header;
  }

  header.append(createElement('span', { className: 'git__spacer' }));
  const toggle = createElement('button', {
    className: 'button button--quiet',
    text: target.staged ? 'Show the disk' : 'Show the index',
    title: target.staged
      ? 'Shows the unstaged changes (git diff)'
      : 'Shows what is staged (git diff --cached)',
  });
  toggle.type = 'button';
  toggle.addEventListener('click', () =>
    actions.onSelectTarget({ kind: 'file', path: target.path, staged: !target.staged }),
  );
  header.append(toggle);
  return header;
}

/**
 * Which side of a change the diff column should open on.
 *
 * Shared by the click on a row and by the preselection made when the tab opens, so the two cannot
 * drift: the working-tree side whenever there is one, the index otherwise. For a file that is staged
 * *and* edited again, what is on disk is the version still being worked on, and it is also the only
 * choice that is never empty — `git diff` on a file with nothing unstaged returns nothing at all.
 */
export function defaultTargetFor(change: GitChange): GitDiffTarget {
  return {
    kind: 'file',
    path: change.path,
    staged: !hasWorktreeChange(change) && isStaged(change),
  };
}

/**
 * A commit's date, short enough for a list.
 *
 * Absolute rather than relative, unlike a pull request's age: the question in front of a history is
 * "when was this", and "34 days ago" is a worse answer to it than a date.
 */
export function describeDay(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return '';
  }
  // en-GB for the same reason as the refresh clock: day before month, which is what the
  // rest of the strip and every branch name in this window already assume.
  return new Date(at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
}
