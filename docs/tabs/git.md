# Git

Pick a repository among the tabs at the top (each carries its count of uncommitted files). Below the
toolbar, three columns: the branches, stashes and tags on the left, the **commit graph** in the
centre, and on the right whatever is selected in the graph.

## The graph

- Every local branch, remote branch and tag, the last 400 commits, one colour per line of history.
  Branch and tag labels sit left of the graph; `main ⇅` means the local branch and its remote are on
  the same commit.
- **// WIP** at the top is your working tree, when it has changes. Click it to stage and commit.
- Click a commit to see its message and files on the right; click a file there to see its diff in
  place of the graph. **← Graph** or **Escape** brings the graph back.
- **Right-click** a commit to cherry-pick it, copy its sha, see its whole diff, or undo it if it is the
  last one.

## Staging and committing

- Select **// WIP**. The right panel lists the **unstaged** files, then the **staged** ones. A file
  staged then edited again is in both lists.
- Click a file to see its diff. Use the **+** / **-** on its row, or **Stage all** / **Unstage all**.
- **Right-click** a file to edit it, in the Explorer tab or in a window of its own, to stage it, or to
  discard its changes (confirmed first; an untracked file is deleted).
- **Commit** runs in a terminal tab, so hooks (`husky`, `lint-staged`) show what they print. The
  message is kept if the commit is refused.
- **Commit and push**, in the chevron beside Commit, pushes only if the commit succeeded.
- **Amend** (above the message, at its right) rewrites the last commit; its tooltip names the commit
  and warns when it is already pushed.
- **Generate** writes a message from the staged diff with the agent, following the repository's own
  convention. It fills the field and never commits.

## Branches

- **Click** a branch or a tag to show its commit in the graph.
- **Double-click** a branch to check it out. A remote branch is checked out as a local branch that
  follows it. Nothing is stashed: a checkout blocked by local changes fails and git names the files.
- **Drag** a branch onto the current one (its row on the left, its label in the graph, or the WIP row)
  to merge it. A menu asks how: fast-forward when possible, a merge commit otherwise. The merge runs in
  a terminal tab; if it stops on a conflict, the toolbar says so and the **⋯** menu can abort or
  continue it.
- The **+** of LOCAL creates a branch from HEAD and switches to it. Names are checked by git itself.

## Tags

- **Right-click** a commit and choose **Tag this commit…**, or use the **+** of TAGS to tag HEAD.
  Tags are annotated; the message is optional. **Create and push**, in the chevron beside Create,
  creates the tag and then asks to push it.
- **Right-click** a tag to push it. A confirmation names the commit, the remote and any workflow the
  tag would start (a release, for instance): pushing a tag is hard to take back.
- A tag marked **local** is not on the remote. Whether the remote has a tag is checked on Fetch, Pull
  and after a tag push.
- **Delete the local tag** removes a tag the remote does not have. A pushed tag is deleted from a
  terminal.

## Toolbar

- **Undo** takes the last commit back: its changes are staged again and its message returns to the
  form. Not offered on a commit already pushed, on a merge, or on the first commit.
- **Fetch**, **Pull** (fast-forward only) and **Push**; what they did shows beside the branch.
- **New branch**, **Stash** (the tracked changes, under git's own message) and **Pop** (the newest
  stash). The **+** of STASHES names a stash and can include untracked files; right-click a stash to
  apply, pop or delete it.
- **⋯**, or a right-click on the toolbar: the same actions, and the way out of a half-done cherry-pick
  or merge.

## What it does not do

Conflict resolution, rebase, force push, moving a tag or deleting one on the remote, and staging of
individual hunks: use a terminal for those.
Files in conflict show as errors in the working tree's list.
