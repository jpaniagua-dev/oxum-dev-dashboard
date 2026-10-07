import type { GitChange } from './contracts.js';

/**
 * Rules about a change's two status columns, shared by both processes on purpose.
 *
 * The renderer draws the staging checkbox from them and the main process guards the commit with
 * them. Two implementations of "is this staged" would eventually disagree, and the way that failure
 * shows up is a commit button that is enabled while `git commit` has nothing to commit — the exact
 * class of bug `verdictFor` is shared to avoid on the checks side.
 */

/**
 * Whether anything of this file is in the index, i.e. whether a commit would include it.
 *
 * `?` is explicitly excluded: an untracked file has `??` in both columns, and treating a non-space
 * index column as "staged" would tick the box for a file `git commit` would ignore.
 */
export function isStaged(change: GitChange): boolean {
  return change.index !== ' ' && change.index !== '?';
}

/**
 * Whether the working tree holds changes beyond what is staged.
 *
 * Distinct from `isStaged` rather than its opposite: `MM` is both at once, a file staged and then
 * edited again, and it is the case that makes a single tri-state impossible.
 */
export function hasWorktreeChange(change: GitChange): boolean {
  return change.worktree !== ' ' && change.worktree !== '?';
}

/**
 * Whether the file is gone from the working tree, so there is nothing on disk to open.
 *
 * A deletion shows in the working-tree column (` D`, `MD`), or in the index alone once it is staged
 * (`D `). A conflict is the exception to read before the columns: `UD` and `DU` say one side deleted
 * the file and git leaves the other side's version on disk, which is exactly the file to open. Only
 * `DD`, deleted on both sides, has nothing left.
 */
export function isDeletedOnDisk(change: GitChange): boolean {
  if (change.index === 'U' || change.worktree === 'U') {
    return false;
  }
  return change.worktree === 'D' || (change.index === 'D' && change.worktree === ' ');
}

/** True when at least one file would go into a commit right now. */
export function hasStagedChanges(changes: readonly GitChange[]): boolean {
  return changes.some(isStaged);
}
