import type {
  GitChange,
  GitCommit,
  GitCommitDetail,
  GitDiff,
  GitDiffTarget,
  GitNotice,
  GitRef,
  GitRemoteTags,
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
import type { ExplorerTarget } from '@shared/explorer.js';
import { hasWorktreeChange, isStaged } from '@shared/git-changes.js';

/*
 * The Git tab's shared vocabulary: its state, its actions and the few helpers every part of it uses.
 *
 * A module of its own so the four parts of the tab (`git-panel.ts` for the frame, `git-refs.ts`,
 * `git-graph-view.ts` and `git-detail.ts` for the three columns) can share it without importing one
 * another: the frame imports the columns, and a column importing the frame back would be a cycle.
 */

/**
 * What the detail panel describes.
 *
 * The working tree (the `WIP` row at the top of the graph), a commit, or a stash. One selection for
 * the whole tab, as in any graph client: the row highlighted in the graph and the panel on the right
 * always talk about the same thing.
 */
export type GitSelection =
  | { readonly kind: 'wip' }
  | { readonly kind: 'commit'; readonly sha: string }
  | { readonly kind: 'stash'; readonly sha: string; readonly ref: string };

/** The inline creation form open in the refs panel, if any. */
export type GitCreating = 'branch' | 'stash' | 'tag' | null;

/** A section of the refs panel, or a remote's group inside the REMOTE section. */
export type GitSectionKey = 'local' | 'remote' | 'stashes' | 'tags' | `remote:${string}`;

/** One entry of a context menu, as `showContextMenu` takes it. */
export interface GitMenuItem {
  readonly label: string;
  readonly hint: string;
  readonly disabled: boolean;
  readonly run: () => void;
}

export interface GitPanelHosts {
  readonly repos: HTMLElement;
  readonly toolbar: HTMLElement;
  readonly refs: HTMLElement;
  readonly center: HTMLElement;
  readonly detail: HTMLElement;
}

export interface GitPanelState {
  /** Every watched project: the Git tab follows all of them, not just the ones with pull requests. */
  readonly projects: readonly Project[];
  /** `tagKey -> colour`, for the dots beside the names on the repository tabs. */
  readonly tagColors: TagColors;
  /**
   * Files not committed, per project, from the poll that already reads every repository.
   *
   * `undefined` for a project the poll has not answered for yet, which is not the same as zero and
   * must not be drawn as a clean repository.
   */
  readonly changedByProject: Readonly<Record<ProjectId, number | undefined>>;
  readonly selectedProject: ProjectId | null;
  /** Null while the first read of the selected repository is still in flight. */
  readonly repo: GitRepoState | null;
  readonly selection: GitSelection;
  /** Message and files of the selected commit or stash; null while being read, or for the WIP. */
  readonly detail: GitCommitDetail | null;
  /** The diff shown in the centre instead of the graph, or null for the graph. */
  readonly target: GitDiffTarget | null;
  readonly diff: GitDiff | null;
  /** Scroll position of the graph, held here because the panel is rebuilt whole on every poll. */
  readonly scrollTop: number;
  readonly collapsed: ReadonlySet<GitSectionKey>;
  readonly creating: GitCreating;
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
  /** Whether a new stash should sweep up untracked files. Off by default: see `git-refs.ts`. */
  readonly stashUntracked: boolean;
  /** The commit the tag form will tag, or null while the form is closed. */
  readonly tagTarget: string | null;
  /** Draft tag name and message, held for the same reason as the other drafts. */
  readonly tagDraft: string;
  readonly tagMessage: string;
  /**
   * The tags the remote has, as last read, or null when nothing has asked it yet.
   *
   * Null is "not known", which is not "none": a tag is badged `local` only against an answer.
   */
  readonly remoteTags: GitRemoteTags | null;
  /** True while a write is in flight, so a double click cannot launch two checkouts. */
  readonly busy: boolean;
  /**
   * True while `Generate` is waiting on Claude Code.
   *
   * Its own flag rather than `busy`: `busy` disables the whole form because a write is touching the
   * repository, whereas a generation touches nothing and only has to stop a second run from starting.
   */
  readonly generating: boolean;
  /** The outcome of the last write that had nothing to show for itself (fetch, pull, push), or null. */
  readonly notice: GitNotice | null;
}

export interface GitPanelActions {
  onSelectProject: (projectId: ProjectId) => void;
  /** Selects the WIP, a commit or a stash: the graph highlights it and the panel describes it. */
  onSelect: (selection: GitSelection) => void;
  /** Shows a diff in the centre, in place of the graph. */
  onOpenDiff: (target: GitDiffTarget) => void;
  /** Back to the graph. */
  onCloseDiff: () => void;
  onStage: (paths: string[], staged: boolean) => void;
  /**
   * Throws the changes to those paths away: back to HEAD, or deleted when untracked.
   *
   * The one action of this tab that destroys work, so it is behind a right-click **and** behind a
   * confirmation raised by the main process.
   */
  onDiscard: (paths: string[]) => void;
  /** Opens a changed file in the Explorer's editor: its panel, or a window of its own. */
  onEditFile: (path: string, target: ExplorerTarget) => void;
  /** Checks a branch out: a local one by name, a remote one as the local branch following it. */
  onCheckout: (ref: GitRef) => void;
  onCreating: (creating: GitCreating) => void;
  onCreateBranch: (name: string) => void;
  /** Opens the tag form on a commit. */
  onTagCommit: (sha: string) => void;
  onTagDraft: (value: string) => void;
  onTagMessage: (value: string) => void;
  /** Creates the tag of the form; with `push`, the main process then asks to push it. */
  onCreateTag: (push: boolean) => void;
  /** Pushes one tag, after the main process's confirmation. */
  onPushTag: (name: string) => void;
  /** Deletes a local tag the remote does not have. */
  onDeleteTag: (name: string) => void;
  /** Commits in a terminal tab. With `push`, a `git push` follows a commit that exited cleanly. */
  onCommit: (push: boolean) => void;
  onMessage: (value: string) => void;
  /** Asks Claude Code for a commit message and puts it in the field. It never commits. */
  onGenerateMessage: () => void;
  /** Arms or disarms the amend. Ticking it pre-fills the form with the message being replaced. */
  onAmend: (amend: boolean) => void;
  onBranchDraft: (value: string) => void;
  onSync: (op: GitSyncOp) => void;
  /** `reset --soft HEAD~1`, offered only where it loses nothing and rewrites nothing published. */
  onUndo: () => void;
  /** A branch was dropped on the current one: opens the merge menu at the drop point. */
  onDrop: (source: GitRef, x: number, y: number) => void;
  /** A ref started or stopped being dragged. The panel must not be rebuilt under a drag. */
  onDragging: (dragging: boolean) => void;
  /** Replays a commit onto the current branch. `noCommit` is `-n`: staged, not committed. */
  onCherryPick: (sha: string, noCommit: boolean) => void;
  /** Finishes or abandons whatever git left half-done. Only offered when something is. */
  onSequencer: (op: GitSequencerOp) => void;
  onStashDraft: (value: string) => void;
  onStashUntracked: (include: boolean) => void;
  /** Stashes the working tree under the current draft label, untracked files if the switch says so. */
  onStashPush: () => void;
  /** Applies, pops or drops a stash. Named by sha, never by its position in the list. */
  onStash: (stash: GitStash, op: GitStashOp) => void;
  onCopy: (text: string) => void;
  /** Opens a new terminal tab in the repository, same gesture as everywhere else in the app. */
  onNewTerminal: (projectId: ProjectId) => void;
  /** Clears the fetch/pull/push line, from a click on it. */
  onDismissNotice: () => void;
  /** Opens the repository's action menu, from the `⋯` button or a right-click on the toolbar. */
  onMenu: (x: number, y: number) => void;
  onCommitMenu: (commit: GitCommit, x: number, y: number) => void;
  onStashMenu: (stash: GitStash, x: number, y: number) => void;
  onChangeMenu: (change: GitChange, x: number, y: number) => void;
  onRefMenu: (ref: GitRef, x: number, y: number) => void;
  onToggleSection: (key: GitSectionKey) => void;
  /** Stores the graph's scroll position, without a repaint: the graph repaints its own rows. */
  onScroll: (scrollTop: number) => void;
  /**
   * Reports that a text field has the focus.
   *
   * The panel is rebuilt on every git poll, so a refresh landing mid-sentence would replace the field
   * under the cursor. Same guard, and the same reason, as the project table's inline rename.
   */
  onEditing: (editing: boolean) => void;
}

/**
 * The custom type a dragged ref travels under.
 *
 * Its own type, and the payload is the ref's full name, for the reason the Jira board carries the
 * whole issue: the panel is rebuilt on every poll, so a "currently dragged" variable held by the
 * module would be pointing into a list that no longer exists by the time of the drop.
 */
export const GIT_REF_DRAG_TYPE = 'application/x-oxum-git-ref';

/**
 * How each half-finished operation is named to the user.
 *
 * git's own words, not translations: `cherry-pick` and `rebase` are what the command prints and what
 * every answer found online calls them.
 */
export const SEQUENCER_LABELS: Record<Exclude<GitSequencer, 'none'>, string> = {
  'cherry-pick': 'cherry-pick',
  merge: 'merge',
  revert: 'revert',
  rebase: 'rebase',
};

/**
 * Which side of a change a diff opens on.
 *
 * The working-tree side whenever there is one, the index otherwise. For a file that is staged *and*
 * edited again, what is on disk is the version still being worked on, and it is also the only choice
 * that is never empty: `git diff` on a file with nothing unstaged returns nothing at all.
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

/** The same date with the year and the time, for the detail panel where there is room for it. */
export function describeMoment(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return '';
  }
  return new Date(at).toLocaleString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The current branch, if HEAD is on one. */
export function currentBranch(repo: GitRepoState): GitRef | undefined {
  return repo.refs.find((ref) => ref.current);
}

/** Whether a write can start: nothing in flight and git not stuck in the middle of an operation. */
export function writesBlocked(state: GitPanelState): boolean {
  return state.busy || (state.repo !== null && state.repo.sequencer !== 'none');
}

/**
 * Wires a ref's element as a drag source for the merge gesture.
 *
 * Local and remote branches only: a tag is not something one merges from this tab, and offering the
 * gesture on it would make a drop that the menu then has to refuse.
 */
export function makeRefDraggable(
  element: HTMLElement,
  ref: GitRef,
  actions: GitPanelActions,
): void {
  if (ref.kind === 'tag' || ref.current) {
    return;
  }
  element.draggable = true;
  element.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData(GIT_REF_DRAG_TYPE, ref.ref);
    if (event.dataTransfer !== null) {
      event.dataTransfer.effectAllowed = 'link';
    }
    actions.onDragging(true);
  });
  element.addEventListener('dragend', () => actions.onDragging(false));
}

/**
 * Wires an element as a drop zone for the merge gesture: the current branch, in any of its places.
 *
 * The drop opens a menu and writes nothing: a merge changes the branch, so the menu is the
 * confirmation, and Escape the way out. The dragged ref is looked up again in the repository state
 * of the drop, not of the drag.
 */
export function makeMergeDropZone(
  element: HTMLElement,
  state: GitPanelState,
  actions: GitPanelActions,
): void {
  const accepts = (event: DragEvent): boolean =>
    event.dataTransfer?.types.includes(GIT_REF_DRAG_TYPE) ?? false;
  element.addEventListener('dragover', (event) => {
    if (!accepts(event)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer !== null) {
      event.dataTransfer.dropEffect = 'link';
    }
    element.classList.add('git__drop--over');
  });
  element.addEventListener('dragleave', () => element.classList.remove('git__drop--over'));
  element.addEventListener('drop', (event) => {
    element.classList.remove('git__drop--over');
    if (!accepts(event)) {
      return;
    }
    event.preventDefault();
    const name = event.dataTransfer?.getData(GIT_REF_DRAG_TYPE) ?? '';
    const source = state.repo?.refs.find((ref) => ref.ref === name);
    actions.onDragging(false);
    if (source !== undefined) {
      actions.onDrop(source, event.clientX, event.clientY);
    }
  });
}
