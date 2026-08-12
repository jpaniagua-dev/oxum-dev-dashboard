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
} from '@shared/contracts.js';
import { hasStagedChanges, hasWorktreeChange, isStaged } from '@shared/git-changes.js';
import { clearChildren, createElement, createIcon, createIconButton, hitsInteractive } from './dom.js';
import { TERMINAL_ICON } from './icons.js';
import { buildPill } from './project-table.js';
import { presentChange, presentTrack } from './presenters.js';

/**
 * Which working area the middle column shows.
 *
 * Three views rather than three panels, for the same reason the strip has tabs: they answer three
 * separate questions ("what have I changed", "where am I", "what happened") and only one of them is
 * ever being asked. The diff column serves all three, which is what keeps them one tab.
 */
export type GitViewId = 'changes' | 'branches' | 'history' | 'stashes';

export const GIT_VIEWS: readonly { id: GitViewId; label: string }[] = [
  { id: 'changes', label: 'Changements' },
  { id: 'branches', label: 'Branches' },
  { id: 'history', label: 'Historique' },
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
  /** Draft branch name, held for the same reason. */
  readonly branchDraft: string;
  /** Draft stash label, held for the same reason. */
  readonly stashDraft: string;
  /** Whether a new stash should sweep up untracked files. Off by default: see `buildStashForm`. */
  readonly stashUntracked: boolean;
  /** True while a write is in flight, so a double click cannot launch two checkouts. */
  readonly busy: boolean;
}

export interface GitPanelActions {
  onSelectProject: (projectId: ProjectId) => void;
  onSelectView: (view: GitViewId) => void;
  /** Shows something in the diff column: a file of the working tree, or a whole commit. */
  onSelectTarget: (target: GitDiffTarget) => void;
  onStage: (paths: string[], staged: boolean) => void;
  onCheckout: (name: string) => void;
  onCreateBranch: (name: string) => void;
  onCommit: () => void;
  onMessage: (value: string) => void;
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
      createElement('p', { className: 'pulls__empty', text: 'Aucun projet configuré.' }),
    );
    return;
  }

  const repo = state.repo;
  if (repo === null) {
    hosts.list.append(createElement('p', { className: 'pulls__empty', text: 'Lecture en cours…' }));
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

  for (const project of state.projects) {
    const active = project.id === state.selectedProject;
    // The wrapper exists only so the terminal icon can be a sibling of the row; see `buildRepoTerminal`.
    const line = createElement('div', { className: 'git__repo-line' });
    const row = createElement('button', {
      className: `pulls__repo${active ? ' pulls__repo--active' : ''}`,
    });
    row.type = 'button';
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
      row.title = `${state.repo.branch}\n${count} fichier(s) modifié(s)`;
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
    label: `Ouvrir un terminal dans ${project.label}`,
    title: `Ouvrir un nouvel onglet de terminal dans ${project.path}`,
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
      title: `Branche courante de ${repo.label}`,
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
          title: `${repo.ahead} commit(s) d’avance, ${repo.behind} de retard`,
        }),
      );
    }
  } else {
    header.append(
      buildPill({
        label: 'pas d’upstream',
        tone: 'neutral',
        // Not an error: it is simply the state of every branch before its first push, and `Push`
        // below is precisely the button that fixes it.
        title: 'La branche n’a jamais été poussée. « Push » la publiera avec -u origin.',
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
        label: `${SEQUENCER_LABELS[repo.sequencer]} en cours`,
        tone: 'error',
        title: `Le dépôt est au milieu d’un ${SEQUENCER_LABELS[repo.sequencer]}. Continue ou abandonne depuis le menu du dépôt (clic droit).`,
      }),
    );
  }

  header.append(createElement('span', { className: 'git__spacer' }));

  const menu = createElement('button', {
    className: 'button button--quiet git__menu-button',
    text: '⋯',
    title: 'Actions du dépôt : fetch, pull, push, terminal (ou clic droit sur cette ligne)',
  });
  menu.type = 'button';
  menu.disabled = state.busy;
  menu.setAttribute('aria-label', 'Actions du dépôt');
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
            label: `Abandonner le ${SEQUENCER_LABELS[repo.sequencer]}`,
            hint: `git ${repo.sequencer} --abort : le dépôt revient où il était avant.`,
            disabled: state.busy,
            run: () => actions.onSequencer('abort'),
          },
          {
            label: `Continuer le ${SEQUENCER_LABELS[repo.sequencer]}`,
            hint: `git ${repo.sequencer} --continue, une fois les conflits résolus et ajoutés à l’index.`,
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
      hint: 'git pull --ff-only. Une branche divergée doit passer par le terminal : cet onglet ne sait pas finir un rebase.',
      disabled: state.busy,
      run: () => actions.onSync('pull'),
    },
    {
      label: repo.hasUpstream ? 'Push' : 'Push et publier la branche',
      hint: repo.hasUpstream ? 'git push' : `git push -u origin ${repo.branch}`,
      disabled: state.busy,
      run: () => actions.onSync('push'),
    },
    {
      label: 'Ouvrir un terminal ici',
      hint: `Nouvel onglet dans ${repo.path}`,
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
  fetch: { label: 'Fetch', hint: 'Récupère les références distantes (git fetch --prune)' },
  pull: {
    label: 'Pull',
    hint: 'git pull --ff-only. Une branche divergée doit passer par le terminal : cet onglet ne sait pas finir un rebase.',
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
      ? `Push et publier la branche : git push -u origin ${repo.branch}`
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
      createElement('p', { className: 'pulls__empty', text: 'Rien à committer, tout est propre.' }),
    );
    return;
  }

  host.append(buildStagingBar(repo, state, actions));

  for (const change of repo.changes) {
    host.append(buildChangeRow(change, state, actions));
  }
}

/** "Tout ajouter" / "Tout retirer", the two gestures a per-file checkbox makes tedious. */
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
    text: `Tout ajouter (${unstaged.length})`,
    title: 'git add sur tous les fichiers modifiés',
  });
  addAll.type = 'button';
  addAll.disabled = state.busy || unstaged.length === 0;
  addAll.addEventListener('click', () =>
    actions.onStage(unstaged.map((change) => change.path), true),
  );

  const removeAll = createElement('button', {
    className: 'button button--quiet',
    text: `Tout retirer (${staged.length})`,
    title: 'git restore --staged sur tout l’index',
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
  row.title = `${change.path}\n${label.title}\n(clic : voir le diff)`;

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'git__check';
  box.checked = isStaged(change);
  box.disabled = state.busy;
  box.title = box.checked ? 'Retirer de l’index' : 'Ajouter à l’index';
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
  area.placeholder = 'Message de commit';
  area.value = state.message;
  area.addEventListener('input', () => actions.onMessage(area.value));
  // The panel is rebuilt on every poll; while this has the focus, the refresh holds off.
  area.addEventListener('focus', () => actions.onEditing(true));
  area.addEventListener('blur', () => actions.onEditing(false));

  const staged = hasStagedChanges(repo.changes);
  const button = createElement('button', { className: 'button button--primary', text: 'Commit' });
  button.type = 'button';
  button.disabled = state.busy || !staged || state.message.trim().length === 0;
  button.title = staged
    ? 'git commit -F, lancé dans un onglet du terminal pour que les hooks soient visibles'
    : 'Rien dans l’index : coche au moins un fichier';
  button.addEventListener('click', () => actions.onCommit());

  const footer = createElement('div', { className: 'git__commit-actions' });
  footer.append(
    createElement('span', {
      className: 'strip__meta',
      text: staged
        ? `${repo.changes.filter(isStaged).length} fichier(s) dans l’index`
        : 'index vide',
    }),
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
    host.append(createElement('p', { className: 'pulls__empty', text: 'Aucune branche locale.' }));
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
  input.placeholder = 'PROJ-0000-description';
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
    text: 'Créer et basculer',
    title: 'git checkout -b, depuis la branche courante. Le nom est validé par git lui-même.',
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
    host.append(createElement('p', { className: 'pulls__empty', text: 'Aucun commit.' }));
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
      label: `Cherry-pick sur ${repo.branch}`,
      hint: dirty
        ? 'git cherry-pick, mais l’arbre de travail n’est pas propre : git refusera.'
        : `git cherry-pick ${commit.sha} : rejoue ce commit sur la branche courante.`,
      disabled: blocked,
      run: () => actions.onCherryPick(commit.sha, false),
    },
    {
      label: 'Cherry-pick sans committer',
      hint: `git cherry-pick -n ${commit.sha} : les modifications arrivent dans l’index, à toi de committer.`,
      disabled: blocked,
      run: () => actions.onCherryPick(commit.sha, true),
    },
    {
      label: 'Copier le sha',
      hint: commit.sha,
      disabled: false,
      run: () => actions.onCopy(commit.sha),
    },
    {
      label: 'Voir le diff',
      hint: 'Même chose qu’un clic sur la ligne.',
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
  row.title = `${commit.subject}\n${commit.author} — ${commit.date}${refs}\n(clic : voir le diff, clic droit : agir)`;

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
        text: 'Aucun stash. Le formulaire ci-dessus met de côté ce qui est modifié.',
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
  input.placeholder = 'Nom du stash (optionnel)';
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
  toggle.append(box, createElement('span', { text: `+ nouveaux (${untracked})` }));
  toggle.title =
    untracked === 0
      ? 'Aucun fichier non suivi à inclure'
      : 'git stash push --include-untracked : emporte aussi les fichiers que git ne suit pas encore';

  // Untracked files count towards "is there anything to stash" only when they are included: with the
  // box unticked, a repository whose only changes are new files has nothing for `git stash` to take.
  const stashable = state.stashUntracked ? repo.changes.length : tracked;
  const push = createElement('button', {
    className: 'button',
    text: 'Stasher',
    title:
      stashable === 0
        ? 'Rien à mettre de côté'
        : `git stash push sur ${stashable} fichier(s). L’arbre de travail revient à HEAD.`,
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
  row.title = `${stash.ref} · ${stash.subject}${from}\n${stash.date}\n(clic : voir le diff, clic droit : appliquer, retirer, supprimer)`;

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
      label: 'Appliquer (et garder)',
      hint: `git stash apply : les modifications reviennent dans l’arbre de travail, ${stash.ref} reste dans la liste.`,
      disabled: blocked,
      run: () => actions.onStash(stash, 'apply'),
    },
    {
      label: 'Appliquer et retirer',
      hint: `git stash pop : comme « appliquer », mais ${stash.ref} quitte la liste si ça se passe bien.`,
      disabled: blocked,
      run: () => actions.onStash(stash, 'pop'),
    },
    {
      label: 'Supprimer',
      hint: 'git stash drop : le contenu est perdu, et cet onglet ne sait pas le retrouver.',
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
        text: 'Sélectionne un fichier ou un commit pour voir son diff.',
      }),
    );
    return;
  }

  const diff = state.diff;
  if (diff === null) {
    host.append(createElement('p', { className: 'pulls__empty', text: 'Lecture du diff…' }));
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
        text: `Diff tronqué : ${MAX_DIFF_LINES} lignes sur ${diff.lines.length}. Ouvre-le dans le terminal pour la suite.`,
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
    text: target.staged ? 'Voir le disque' : 'Voir l’index',
    title: target.staged
      ? 'Affiche les modifications non indexées (git diff)'
      : 'Affiche ce qui est indexé (git diff --cached)',
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
 * "when was this", and "il y a 34 j" is a worse answer to it than a date.
 */
export function describeDay(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return '';
  }
  return new Date(at).toLocaleDateString('fr-CH', { day: '2-digit', month: '2-digit' });
}
