# Git

Pick a repository on the left (each carries its count of uncommitted files), then **Changes**,
**Branches** or **History**, and read the diff on the right.

## Changes

- Tick a file to stage it; click it to see its diff. `MM` is a file staged and edited again.
- **Commit** runs in a terminal tab, so hooks (`husky`, `lint-staged`) show what they print. The
  message is kept if the commit is refused.
- **Commit and push**, in the chevron beside Commit, pushes only if the commit succeeded.
- **Amend** (the checkbox above the message, at its right) rewrites the last commit; its tooltip
  names the commit and warns when it is already pushed.
- **Generate** writes a message from the staged diff with the agent, following the repository's own
  convention. It fills the field and never commits.

## Branches and sync

- **Checkout** is a button per branch. Nothing is stashed: a checkout blocked by local changes fails
  and git names the files.
- New branch names are checked by git itself.
- **Fetch**, **Pull** (fast-forward only) and **Push** are the icons at the end of the tab row; what
  they did shows beside the branch.

## What it does not do

Stash, conflict resolution, rebase and staging of individual hunks: use a terminal for those.
Conflicts show as errors in the list.
