# Pull requests

The followed repositories on the left (a project is followed when **Follow pull requests** is ticked
in its settings), their pull requests on the right. **Mine** shows the ones you authored or are asked
to review; **All** every open one.

Each row shows the title, the author, your involvement, the review state and the checks. `no review`
means the repository requires none, not that it is approved. Click a row to see what the review
concluded about it; the terminal icon opens a shell in that repository.

## The review

A headless agent run reads a pull request against your team's standards and gives a verdict.

- **Start it** from a repository row (everything open, or only what has no verdict at its current
  commit) or from a pull request row (**Review**, then **Review again**).
- **Verdicts**: `clean` offers an **Approve** button; `remarks` waits for you; `blocking` posts a
  comment and requests changes; `unclear` posts nothing.
- **Nothing is posted** until **Let the review submit to GitHub** is on in the settings. Approve is
  never automatic, and is refused if the pull request moved since the review.
- Drafts and your own pull requests are reviewed and shown, never posted to.
- The same review is never posted twice, and at most ten pull requests are read per run; whatever
  the cap left out is named.

## Opening one to look at it

**Open as a workspace** checks the pull request out in a worktree, links `node_modules` from the main
checkout so nothing is installed, and starts the project's dev server on a free port, beside the one
already running on your own branch.
