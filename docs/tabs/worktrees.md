# Worktrees

Every linked worktree of every watched project, in one list. Each row shows the project, the folder,
the branch, uncommitted changes and the distance to the remote.

- **Click a row** to open a shell in that worktree.
- **New worktree**: type a label and, for a ticket, what it is about:
  - `PROJ-123 documents list` makes the folder `PROJ-123-<repo>` on the branch
    `PROJ-123-documents-list`;
  - `toast fix` makes `wip-toast-fix-<repo>` on `wip/toast-fix`.

  The branch starts from the remote's default branch, and `node_modules` is linked from the main
  checkout instead of installed again.
- **The `⋯` menu**: **Rename…** (a `wip` worktree renamed to a ticket key takes the matching branch
  name), **Remove**, **Remove and delete the branch**, and on a worktree with uncommitted work, a
  removal that discards it, labelled with how many changes it throws away.
- A removal takes the `node_modules` link out first, so the main checkout's `node_modules` is never
  touched. A folder held open by an editor or a dev server is reported as locked: close what holds it
  and remove again.
- A row marked `prunable` is registered in git but its folder is gone; its one action cleans the
  registration.

Worktrees go in a `worktrees` folder next to each repository unless **Worktrees folder** says
otherwise (Settings → Projects → Advanced).
