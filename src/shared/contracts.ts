/**
 * Single source of truth for everything crossing the main <-> renderer boundary.
 *
 * The renderer is sandboxed: no `fs`, no `child_process`, no `ipcRenderer`. Every capability it
 * needs is declared here, implemented in the main process, and exposed through the narrow bridge
 * in `src/preload/index.ts`.
 */

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

/**
 * Stable identifier for a watched project.
 *
 * A free-form string rather than a closed union: projects are declared by the user in settings, so
 * the set cannot be known at compile time. Ids are generated from the folder name and never change
 * when a project is renamed, which is what keeps a rename from orphaning its running terminal.
 */
export type ProjectId = string;

/**
 * What an action does to the row it belongs to.
 *
 * `server` is the long-running dev process: it owns the row's server state, its output is parsed for
 * build markers, and it is the one replaced by `Stop` while it runs. `task` is anything one-shot
 * (`commit`, a test run, a generator): it says nothing about the server and its tab is closable at
 * any time. A project has at most one `server` action, because a row has one server state.
 */
export type ActionRole = 'server' | 'task';

/**
 * A command the user can launch on a project, straight into a terminal tab.
 *
 * Actions are configuration, not code. They used to be two hardcoded buttons (`npm run start` and
 * `commit`); since every one of them is just a command line run in a shell, there is no reason the
 * list should be fixed.
 */
export interface ProjectAction {
  /**
   * Stable identifier, derived from the label when the action is created and never changed after.
   *
   * It keys the terminal tab, so renaming an action must not change it: the id is what keeps a
   * running process attached to the button that started it.
   */
  readonly id: string;
  /** Button text in the table. */
  readonly label: string;
  /** Command line, run through the chosen shell exactly as typed. */
  readonly command: string;
  readonly role: ActionRole;
  /** Shell profile to run it in. Null follows the default profile. */
  readonly profileId: string | null;
}

/**
 * A project as the user declared it.
 *
 * `kind` and `expectedPort` are optional because both are inferred from the repository's own
 * `package.json`; they are only stored when the user overrides the inference.
 */
export interface ProjectConfig {
  readonly id: ProjectId;
  readonly label: string;
  readonly path: string;
  /** Commands offered on this project's row. */
  readonly actions: readonly ProjectAction[];
  readonly kind: ProjectKind | null;
  readonly expectedPort: number | null;
  /** Excluded from the table without deleting the entry. */
  readonly enabled: boolean;
  /** Include this repository's pull requests in the pull request tab. */
  readonly followPulls: boolean;
}

/** A repository found by scanning the projects root, offered when adding a project. */
export interface ProjectCandidate {
  readonly label: string;
  readonly path: string;
  readonly kind: ProjectKind;
  readonly expectedPort: number | null;
  /** True when a project already points at this path. */
  readonly alreadyAdded: boolean;
}

/** What is wrong with a project's configuration, surfaced next to the field. */
export interface ProjectValidation {
  readonly id: ProjectId;
  readonly issues: { level: 'error' | 'warning'; message: string }[];
  /** Inferred command line of the server action, shown so the deduction is auditable. */
  readonly serverCommand: string;
  /** Scripts the repository actually declares, to help pick a valid one. */
  readonly scripts: string[];
  readonly inferredKind: ProjectKind | null;
  readonly inferredPort: number | null;
}

/**
 * How a project's dev process behaves, which decides what can be observed about it.
 *
 * `server` projects run `ng serve` and open a port, so a port probe can confirm they really
 * serve. `watch` projects run `ng build --watch`: no HTTP server, no port, so their state can
 * only come from the process output. That difference is why the dashboard owns the processes.
 */
export type ProjectKind = 'server' | 'watch';

export interface Project {
  readonly id: ProjectId;
  /** Short label for the table. */
  readonly label: string;
  /** Absolute path to the repository. */
  readonly path: string;
  readonly actions: readonly ProjectAction[];
  readonly kind: ProjectKind;
  /** Port the dev server is expected to listen on. Null for `watch` projects. */
  readonly expectedPort: number | null;
}

/* ------------------------------------------------------------------ *
 * Dev server / watch state
 * ------------------------------------------------------------------ */

/**
 * Lifecycle of a project's dev process.
 *
 * Deliberately not a boolean. The `start` scripts run `npm run lint` before serving, so there is
 * a genuine window where the process is healthy but nothing is listening yet; a two-state model
 * would report that as "down".
 *
 * Every phase describes a process the dashboard **owns**. There used to be an `external` phase for a
 * server started elsewhere, dropped once every launch went through the embedded terminal: a state
 * nobody could act on, for a situation that had stopped happening.
 */
export type ServerPhase =
  | 'stopped'
  | 'starting'
  | 'linting'
  | 'building'
  | 'serving'
  | 'watching'
  | 'lint-error'
  | 'build-error'
  | 'crashed';

export interface ServerState {
  readonly phase: ServerPhase;
  /** Process id, or null when nothing runs. */
  readonly pid: number | null;
  /** Port the process announced it is serving on. */
  readonly port: number | null;
  /** First error line reported by the toolchain, shown in the table. */
  readonly errorSummary: string | null;
  /** Number of errors in the last failed build, when the toolchain reports it. */
  readonly errorCount: number;
  /** ISO timestamp of the last successful build. */
  readonly lastSuccessAt: string | null;
  /** True when the dashboard spawned this process and can therefore stop it. */
  readonly owned: boolean;
}

/* ------------------------------------------------------------------ *
 * Git
 * ------------------------------------------------------------------ */

export interface GitState {
  readonly branch: string;
  /** Working-tree counts, kept separate because they mean different things. */
  readonly modified: number;
  readonly staged: number;
  readonly untracked: number;
  /** Commits the branch is behind / ahead of its upstream. */
  readonly behind: number;
  readonly ahead: number;
  /**
   * False when the branch has no upstream at all.
   *
   * Worth its own flag: a branch that was never pushed cannot have a pull request, so the checks
   * column has nothing to look up and the dashboard should say so rather than show an error.
   */
  readonly hasUpstream: boolean;
  readonly stashes: number;
  /** Set when git itself failed, e.g. the path is not a repository. */
  readonly error: string | null;
}

/* ------------------------------------------------------------------ *
 * Git tab
 * ------------------------------------------------------------------ */

/**
 * One changed file, as `git status` reports it.
 *
 * The two status letters are kept apart rather than merged into one "state". They answer different
 * questions and a file can carry both at once: `MM` is a file staged with further edits on top, and
 * collapsing that into a single letter would make the staging checkbox lie about what a commit would
 * actually contain.
 */
export interface GitChange {
  /** Path relative to the repository root, in git's own forward-slash form. */
  readonly path: string;
  /** Index column: what is staged. A space when nothing is. */
  readonly index: string;
  /** Working-tree column: what is modified on disk beyond the index. */
  readonly worktree: string;
  /** True when git does not track this path at all yet. */
  readonly untracked: boolean;
  /** Previous path of a rename or a copy, which git reports as a separate field. */
  readonly from: string | null;
}

/**
 * One entry of `git stash list`.
 *
 * Carries **both** its ref and its sha, and that pair is the whole point. `stash@{0}` is a position,
 * not an identity: dropping an entry renumbers every one below it, so a ref read a minute ago can
 * name a different stash by the time a button is pressed. The sha is the stable handle, and every
 * write resolves it back to a fresh ref before touching anything.
 */
export interface GitStash {
  /** `stash@{0}`, as of the read that produced this entry. */
  readonly ref: string;
  /** Commit sha of the stash entry, which is what identifies it across a renumbering. */
  readonly sha: string;
  /** Branch it was taken from, as git records it in the entry's own message. */
  readonly branch: string;
  /** What the user typed, or git's own `WIP on <branch>: <sha> <subject>`. */
  readonly subject: string;
  readonly date: string;
}

/** What can be done to an existing stash. Creating one is `GitStashPush`, which takes a message. */
export type GitStashOp = 'apply' | 'pop' | 'drop';

/**
 * An operation git has left half-finished in this repository.
 *
 * Read because the Git tab now *starts* one of them: a cherry-pick that hits a conflict stops with
 * `CHERRY_PICK_HEAD` on disk, and from there every other button in the tab fails for a reason that
 * has nothing to do with what was clicked. The other three are read at the same cost from the same
 * place, and a repository left mid-rebase misleads exactly as badly.
 */
export type GitSequencer = 'none' | 'cherry-pick' | 'merge' | 'revert' | 'rebase';

/** The two ways out of a half-finished operation, both non-interactive. */
export type GitSequencerOp = 'continue' | 'abort';

/** A local branch, with how far it stands from its upstream. */
export interface GitBranch {
  readonly name: string;
  readonly current: boolean;
  /** `origin/x`, or null when the branch was never pushed. */
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  /** True when the upstream is gone from the remote, so pushing would recreate it. */
  readonly gone: boolean;
  /** ISO date of the tip commit, which is what "my recent branches" really sorts by. */
  readonly updatedAt: string;
}

/** One commit of the history, reduced to what a strip can show on a line. */
export interface GitCommit {
  /** Abbreviated sha, which is what the user copies and what `git show` takes. */
  readonly sha: string;
  readonly subject: string;
  readonly author: string;
  readonly date: string;
  /** Decorations pointing at it, e.g. `HEAD -> main, origin/main`. Empty when there are none. */
  readonly refs: string;
}

/**
 * What a line of a diff is.
 *
 * `meta` covers everything git prints around the content (`diff --git`, `index`, mode changes,
 * `\ No newline at end of file`): shown, because a mode change or a rename is part of what would be
 * committed, but never counted as an added or removed line.
 */
export type GitDiffLineKind = 'add' | 'del' | 'context' | 'hunk' | 'meta';

export interface GitDiffLine {
  readonly kind: GitDiffLineKind;
  /** The line as git printed it, leading marker included. */
  readonly text: string;
  /** Position in the old file, null on an added line and on a header. */
  readonly oldLine: number | null;
  /** Position in the new file, null on a removed line and on a header. */
  readonly newLine: number | null;
}

/**
 * What the diff column is showing.
 *
 * Either a file of the working tree or a whole commit, because both answer "what changed" and the
 * column renders them identically. Keeping one shape means the history and the change list share a
 * single view instead of growing two that drift.
 */
export type GitDiffTarget =
  | { readonly kind: 'file'; readonly path: string; readonly staged: boolean }
  | { readonly kind: 'commit'; readonly sha: string }
  /**
   * A stash entry, read by its **sha**.
   *
   * `git show` is not an option here: a stash is a merge commit, and `git show` prints nothing at all
   * for one unless asked for a combined diff. `git stash show -p` is the command that answers the
   * question, and it takes any commit-ish, so the sha keeps this target stable across a renumbering
   * exactly as the writes do.
   */
  | { readonly kind: 'stash'; readonly sha: string; readonly ref: string };

export interface GitDiff {
  /** Heading of the column: a path, or a sha and its subject. */
  readonly title: string;
  readonly lines: readonly GitDiffLine[];
  /**
   * Why there is nothing to show, when there is nothing.
   *
   * A binary file, an empty diff or a git failure are three different situations and an empty list
   * would say the same thing for all three.
   */
  readonly note: string | null;
}

/** Everything the Git tab shows for one repository. */
export interface GitRepoState {
  readonly projectId: ProjectId;
  readonly label: string;
  readonly path: string;
  /** Current branch, or `detached@<sha>`. */
  readonly branch: string;
  readonly branches: readonly GitBranch[];
  readonly changes: readonly GitChange[];
  readonly commits: readonly GitCommit[];
  readonly stashes: readonly GitStash[];
  /**
   * Full message of the HEAD commit, subject and body, empty when the repository has no commit.
   *
   * Read for the amend gesture: ticking "Amend" pre-fills the form with the message being
   * replaced, and `commits[0]` only carries the subject line.
   */
  readonly headMessage: string;
  /** `none` unless git has left a cherry-pick, a merge, a revert or a rebase half-finished. */
  readonly sequencer: GitSequencer;
  readonly ahead: number;
  readonly behind: number;
  readonly hasUpstream: boolean;
  /** ISO timestamp of the read, null while it has never succeeded. */
  readonly checkedAt: string | null;
  /** Set when git itself failed, e.g. the folder is not a repository. */
  readonly error: string | null;
}

/**
 * Outcome of a git write, reported where the button was pressed.
 *
 * The message is git's own first line rather than a sentence of ours: "Your local changes to the
 * following files would be overwritten by checkout" says exactly what to do next, and nothing this
 * app could word would beat it.
 */
export interface GitResult {
  readonly ok: boolean;
  readonly message: string;
}

/** A network operation of the Git tab, all three sharing one channel and one budget. */
export type GitSyncOp = 'fetch' | 'pull' | 'push';

/**
 * Action id prefix reserved for tabs the **app itself** opens.
 *
 * A `commit` tab is tied to a project but is **not** one of its configured actions, so it must be
 * exempt from the reconciliation that closes tabs whose action has disappeared. Without the exemption
 * every settings save would kill a commit in progress. See `isUnreachable`.
 *
 * The prefix reads `git:` for history rather than for meaning: the Git tab minted the first of these
 * ids, and renaming it now would orphan the tabs of a running instance for nothing.
 */
export const RESERVED_ACTION_PREFIX = 'git:';

/** Action id of the commit tab, one per project so a rerun reuses it. */
export const GIT_COMMIT_ACTION_ID = `${RESERVED_ACTION_PREFIX}commit`;

/**
 * Action id of the tab that runs `dev <TICKET>` from the Jira tab.
 *
 * Reserved like the commit tab, and for the same reason: it belongs to no configured action, so
 * without the prefix every settings save would close it mid-run.
 */
export const TICKET_BRANCH_ACTION_ID = `${RESERVED_ACTION_PREFIX}branch`;

/**
 * Action id **prefix** of the tabs where the Triage tab hands tickets to Claude Code.
 *
 * A prefix and not an id, unlike the three above, and that is the whole point:
 * `workActionId` appends the tickets so **each handoff gets its own tab**. Reuse is right for a commit
 * or a branch, where a second click means "do that again"; it is wrong here, where the tab holds a
 * long-lived interactive session. Shared, a second handoff found the first one still running and
 * `runProjectCommand` handed back the tab it was already in: the new prompt never ran, and the only
 * symptom was a session that ignored you.
 *
 * Still carries `RESERVED_ACTION_PREFIX`, which is what `isUnreachable` checks with `startsWith`, so a
 * suffixed id stays exempt from the reconciliation that closes tabs whose action has disappeared.
 */
export const TRIAGE_WORK_ACTION_ID = `${RESERVED_ACTION_PREFIX}triage-work`;

/**
 * The tab a handoff belongs to: one per set of tickets, per project.
 *
 * Keyed on the tickets rather than unique per click, deliberately. Two clicks on the **same** ticket
 * should land in the session already working it, not start a second agent on the same worktree, which
 * is the one outcome worse than being blocked. Two clicks on **different** tickets get two tabs, which
 * is what was missing.
 *
 * Pure and exported: the reuse rule is invisible until it is wrong in one direction or the other.
 */
export function workActionId(issueKeys: readonly string[]): string {
  return `${TRIAGE_WORK_ACTION_ID}:${[...issueKeys].sort().join('-')}`;
}

/**
 * Action id of the tab that runs the worktree helper from the Worktrees tab.
 *
 * Reserved like the three above, so a settings save cannot close a removal mid-run. One id for the
 * three gestures and therefore one tab per project, reused once its process has ended: `new`, `mv` and
 * `rm` are the same conversation with the same helper about the same clone, and three ids would leave
 * three tabs of finished output where the useful history is the last one.
 */
export const WORKTREE_ACTION_ID = `${RESERVED_ACTION_PREFIX}worktree`;

/**
 * How many tickets one batch may hand over at once.
 *
 * A session working twenty tickets in a row is one nobody supervises, which is the opposite of why
 * this lands in a terminal tab at all. The cap is stated rather than silent: the view says how many
 * it is about to send.
 */
export const WORK_BATCH_LIMIT = 8;

/**
 * Shape a Jira key must have before it is put on a command line.
 *
 * The key travels into `dev <KEY>` inside an interactive bash, which is the one place in this app
 * where renderer input reaches a shell. Anchored and deliberately narrow — letters, then a dash,
 * then digits — so nothing that is not a ticket key can get through, whatever the list it came from.
 */
export const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/;

/**
 * The only story point values this app will write.
 *
 * A Fibonacci-style scale, because that is what the estimate is asked for in and what a board is
 * planned in; a model handed a free numeric field answers 4, 6 or 7.5 often enough that the value has
 * to be snapped to something a human would have chosen. Anything outside the scale is rounded to the
 * nearest member, and anything that is not a finite positive number is refused outright rather than
 * defaulted: no estimate is an honest state, an invented one is not.
 *
 * 21 is the top on purpose. A ticket estimated above that is one to split, and writing a bigger number
 * would record an estimate nobody intends to plan against.
 */
export const STORY_POINT_SCALE: readonly number[] = [1, 2, 3, 5, 8, 13, 21];

/* ------------------------------------------------------------------ *
 * GitHub checks
 * ------------------------------------------------------------------ */

/**
 * Outcome of a pull request's checks.
 *
 * `no-checks` is distinct from `passing` on purpose: two open pull requests on the real
 * repository returned an empty rollup, and showing that as green would be a lie.
 */
export type ChecksVerdict =
  | 'no-pr'
  | 'no-checks'
  | 'pending'
  | 'passing'
  | 'failing'
  | 'unknown';

export interface ChecksState {
  readonly verdict: ChecksVerdict;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly prTitle: string | null;
  readonly isDraft: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
  /** ISO timestamp of the last successful lookup. */
  readonly checkedAt: string | null;
  readonly error: string | null;
}

/* ------------------------------------------------------------------ *
 * GitHub Actions runs
 * ------------------------------------------------------------------ */

/**
 * Whether a repository has a workflow run in flight.
 *
 * Repository-wide, unlike `ChecksVerdict` right next to it, and that is the point: a run started by a
 * merge to the trunk makes the project busy just as much as one started by the branch the row shows.
 * The column answers "is CI working on this project", not "is my branch green".
 *
 * `no-runs` is kept apart from `idle` for the reason `no-checks` is kept apart from `passing`: a
 * repository that never ran a workflow is not a repository whose workflows have all finished, and
 * flattening the two would claim a CI setup that does not exist.
 */
export type WorkflowsVerdict = 'running' | 'idle' | 'no-runs' | 'no-repo' | 'unknown';

export interface WorkflowsState {
  readonly verdict: WorkflowsVerdict;
  /** Runs executing right now. */
  readonly running: number;
  /** Runs accepted but not started: no free runner, a pending approval, a concurrency group. */
  readonly queued: number;
  /** ISO timestamp of the last successful lookup. */
  readonly checkedAt: string | null;
  readonly error: string | null;
}

/* ------------------------------------------------------------------ *
 * Pull requests
 * ------------------------------------------------------------------ */

/**
 * Where a pull request stands with its reviewers.
 *
 * `none` is **not** an approval: `gh` reports an empty `reviewDecision` when the repository requires no
 * review at all, and painting that green would say something GitHub never said.
 */
export type PrReview = 'approved' | 'changes-requested' | 'review-required' | 'none';

/** One open pull request, reduced to what answers "does this need me?" at a glance. */
export interface PullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  /** Head branch, the name you would check out. */
  readonly branch: string;
  readonly authorLogin: string;
  readonly isDraft: boolean;
  readonly review: PrReview;
  /** Same verdict vocabulary as a project row, including `no-checks` distinct from `passing`. */
  readonly checks: ChecksVerdict;
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
  /**
   * Whether it involves the signed-in user, computed locally from the payload.
   *
   * Two flags rather than one "mine": the list shows why a pull request concerns you, and asking GitHub
   * for the union would have cost two calls per repository since its search has no usable `OR`.
   */
  readonly isAuthor: boolean;
  readonly isReviewer: boolean;
  readonly updatedAt: string;
}

/**
 * Which pull requests the tab lists.
 *
 * `mine` is the question the tab was built to answer ("does this need me?"), `all` is the one it kept
 * failing to answer ("what is open on this repository?"). Two sub-tabs rather than a widened filter,
 * because the counts differ and a single list would have to pick which number to show. Both are
 * computed from the **same payload**: `gh pr list` already returns every open pull request, so the
 * second view costs no extra call.
 */
export type PullScope = 'mine' | 'all';

/** Pull requests of one watched repository, plus why there might be none. */
export interface RepoPulls {
  readonly projectId: ProjectId;
  readonly label: string;
  /** `owner/repo`, or null when the project's remote is not a GitHub one. */
  readonly slug: string | null;
  readonly pulls: PullRequest[];
  readonly checkedAt: string | null;
  readonly error: string | null;
}

/* ------------------------------------------------------------------ *
 * Jira
 * ------------------------------------------------------------------ */

/**
 * Coarse state of an issue, from Jira's own status **category** rather than its status name.
 *
 * Names are per-project and renamed at will ("En review", "Ready for QA"); the category is the only part
 * of a Jira workflow that means the same thing everywhere.
 */
export type IssueStage = 'todo' | 'in-progress' | 'done' | 'unknown';

export interface JiraIssue {
  readonly key: string;
  readonly summary: string;
  /** The status as configured, shown as written since that is what the team says out loud. */
  readonly status: string;
  readonly stage: IssueStage;
  readonly type: string;
  /** Display name, or an empty string when unassigned. */
  readonly assignee: string;
  readonly isMine: boolean;
  readonly url: string;
  readonly updatedAt: string;
}

/**
 * A move an issue can make right now, as Jira reports it.
 *
 * Read per issue rather than derived from a status list: a workflow decides which moves are legal from
 * where, and the `id` is what the move is made with.
 */
export interface IssueTransition {
  readonly id: string;
  /** The status it lands on, which is what the user is choosing. */
  readonly label: string;
  /**
   * Category of the status it lands on, so a transition can be chosen by meaning and not by name.
   *
   * The same reason an issue's own stage comes from `statusCategory`: names are per-project and
   * renamed at will ("In review", "Ready for QA", "Développement"), and code looking for the string
   * "in progress" finds nothing on a site that never used that word. `unknown` when the payload
   * carries no destination at all, which is also when `label` falls back to the transition's verb.
   */
  readonly stage: IssueStage;
}

/** One of the two saved views of the Jira tab. */
export type JiraViewId = 'sprint' | 'mine';

export interface JiraView {
  readonly id: JiraViewId;
  readonly label: string;
  readonly issues: JiraIssue[];
  readonly checkedAt: string | null;
  readonly error: string | null;
}

/** Everything the Jira tab needs, including why it might be empty. */
export interface JiraState {
  /** False until a site, an email and a token are all configured. */
  readonly configured: boolean;
  readonly views: JiraView[];
}

/** Jira connection, without the token: that one is encrypted in its own file. */
export interface JiraConfig {
  /** Site root, for instance `https://example.atlassian.net`. */
  readonly siteUrl: string;
  /** Account email, the user half of the API token's basic auth. */
  readonly email: string;
  /** Project keys to look at, `PROJ` and the like. */
  readonly projectKeys: readonly string[];
  /** Whether a token is stored. Never the token itself: it only ever travels towards the main process. */
  readonly hasToken: boolean;
}

/* ------------------------------------------------------------------ *
 * Aggregated row
 * ------------------------------------------------------------------ */

/** Everything the table needs for one project. */
export interface ProjectRow {
  readonly project: Project;
  readonly server: ServerState;
  readonly git: GitState | null;
  readonly checks: ChecksState | null;
  readonly workflows: WorkflowsState | null;
}

/* ------------------------------------------------------------------ *
 * Terminal
 * ------------------------------------------------------------------ */

/** A named shell launcher, in the spirit of Windows Terminal profiles. */
export interface ShellProfile {
  readonly id: string;
  readonly label: string;
  /** Absolute path to the executable. */
  readonly file: string;
  readonly args: readonly string[];
  /** Starting directory. */
  readonly cwd: string;
  /** True when found on this machine rather than declared by the user. */
  readonly detected: boolean;
}

/**
 * Identifier of one live terminal.
 *
 * Sessions are keyed by their own id rather than by project, because a terminal is no longer tied
 * to a project: a shell tab belongs to nothing, and a project can have output from a `start` and a
 * `commit` at different times.
 */
export type TerminalId = string;

/** What a terminal session is for, which decides how its exit is interpreted. */
export type TerminalKind = 'project' | 'shell';

export interface TerminalSession {
  readonly id: TerminalId;
  readonly title: string;
  readonly kind: TerminalKind;
  /**
   * Project this tab belongs to, so server state updates reach the right row.
   *
   * Also set on a **shell** opened in a repository, which is what lets that shell be found again
   * instead of a new one being stacked on every click. A shell therefore has a `projectId` and no
   * `actionId`: anything walking these two fields must treat that pair as valid.
   */
  readonly projectId: ProjectId | null;
  /** Action that opened this tab. Null for a shell, including a repository shell. */
  readonly actionId: string | null;
  /**
   * What kind of thing is running: a long-lived `server`, a one-shot `task`, or null for a shell.
   *
   * Comes from the action's own configured role. Exposed to the renderers because it is what tells a dev
   * server from a Claude Code session, which is the whole basis on which the servers window decides
   * what it owns. `closable` is already derived from it in the main process.
   */
  readonly role: ActionRole | null;
  /** Set for `shell` sessions. */
  readonly profileId: string | null;
  readonly cwd: string;
  /** False once the process has exited; the tab stays so its output can still be read. */
  readonly running: boolean;
  /**
   * Whether the tab can be closed.
   *
   * Derived from live state rather than stored: a one-shot task is always closable, a shell always
   * is, and a `server` action only once it has stopped, so `Stop` stays the deliberate way to end a
   * build.
   */
  readonly closable: boolean;
  /** True once the user renamed the tab, which stops the title being re-derived on a rerun. */
  readonly renamed: boolean;
}

/**
 * How the visible panes share the terminal surface.
 *
 * `columns` puts them side by side, `rows` stacks them. One direction for the whole surface, not a
 * nestable tree: three terminals side by side or three stacked, never a mix. That is the deliberate
 * limit of this layout, and what keeps a pane's position predictable from its index alone.
 */
export type PaneDirection = 'columns' | 'rows';

/**
 * How the surface is divided, and what each division holds.
 *
 * Held by the main process next to the sessions themselves, and it is now the **only** record of the
 * tab order: a group owns its tabs, so there is no second ordering to drift from. The renderer
 * restarts on every hot reload, so keeping it there would lose it several times a minute in
 * development. Empty only when no session exists at all.
 */
export interface TerminalLayout {
  readonly direction: PaneDirection;
  /** The panes, in display order. Each carries its own tabs. */
  readonly groups: readonly TerminalGroup[];
}

/** Chunk of terminal output. */
export interface TerminalChunk {
  readonly terminalId: TerminalId;
  readonly data: string;
}

/** Terminal geometry, pushed when the pane is resized. */
export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}


/** Request to open a shell tab. */
export interface OpenShellRequest {
  readonly profileId: string;
  /** Overrides the profile's starting directory, used by the per-repository action. */
  readonly cwd?: string;
  /** Title override, so a repo-scoped shell can say which repo it is in. */
  readonly title?: string;
}

/* ------------------------------------------------------------------ *
 * Theme
 * ------------------------------------------------------------------ */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeState {
  readonly mode: ThemeMode;
  readonly resolved: ResolvedTheme;
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

/**
 * Terminal font size, in CSS pixels.
 *
 * Lives here so the store's clamp, the settings field and the pane's own fallback all read the same
 * three numbers. The bounds are what stays legible: below the minimum xterm's cell grid stops being
 * readable, above the maximum a single tab fits almost nothing.
 */
export const TERMINAL_FONT_SIZE = { default: 14, min: 9, max: 28 } as const;

/**
 * Interface font size, in CSS pixels: the base of the type ladder in `tokens.css`.
 *
 * Separate from `TERMINAL_FONT_SIZE` because the two answer different questions — "can I read the
 * app" against "how much output fits in a pane" — and one number for both would force a compromise
 * neither side wants. Every size in the interface is a **ratio** of this one (`--font-3xs` to
 * `--font-xl`), so the ladder keeps its proportions at any value.
 *
 * The bounds are narrower than the terminal's on purpose: this size drives text inside boxes whose
 * padding is fixed, so far past 17px a tab row or a pill starts to crowd its own borders. The
 * terminal, being a grid of its own, has no such ceiling.
 */
export const UI_FONT_SIZE = { default: 13, min: 11, max: 17 } as const;

/** Which view the top strip shows. The terminal below is unaffected by this choice. */
export type StripTab = 'projects' | 'pulls' | 'jira' | 'git' | 'triage' | 'worktrees';

/**
 * A sprint offered for triage.
 *
 * Read from the Agile API rather than from an issue's sprint field: that field is a
 * `customfield_xxxxx` whose number differs per site, the same reason story points are not shown in
 * the Jira tab. A board endpoint answers the same question without guessing an id.
 */
export interface Sprint {
  readonly id: number;
  readonly name: string;
  /** `active` or `future`. Closed sprints are not offered: there is nothing left to plan in them. */
  readonly state: string;
  readonly boardName: string;
}

/**
 * What the triage says about one ticket.
 *
 * The three the user asked for, plus two that kept turning up in practice: a ticket whose
 * description is too thin to act on is not the same problem as one waiting on an API, and lumping
 * them together hides the one a single sentence would fix.
 */
export type TriageVerdict = 'ready' | 'needs-decision' | 'backend' | 'unclear' | 'blocked';

/**
 * Which of a sprint's tickets a run is asked to read.
 *
 * `mine` is not a display filter over an analysis that already happened: it decides what the run is
 * given, so it changes what the tokens are spent on. Hence a scope on the **result** as well
 * (`TriageResult.scope`), without which "Ready 0" would mean two different things and nothing on
 * screen could tell them apart.
 */
export type TriageScope = 'all' | 'mine';

export const TRIAGE_VERDICTS: readonly TriageVerdict[] = [
  'ready',
  'needs-decision',
  'backend',
  'unclear',
  'blocked',
];

export interface TriagedTicket {
  readonly key: string;
  readonly summary: string;
  readonly verdict: TriageVerdict;
  /** One sentence on why it landed there. Empty when the model gave none. */
  readonly reason: string;
  /** The closed question to answer, for `needs-decision`. Empty otherwise. */
  readonly question: string;
  /**
   * What answering the question sets in motion.
   *
   * The half that makes a question worth reading: "who does what next" is the difference between a
   * decision you can take in ten seconds and one you postpone because its consequences are unclear.
   */
  readonly next: string;
  /**
   * Story points the analysis thinks the ticket is worth, on `STORY_POINT_SCALE`.
   *
   * `null` when the model gave none or gave something off the scale, and that is a real answer rather
   * than a gap to fill with a default: `Work on this` writes this number to Jira, and a fabricated
   * estimate is a number a human will plan against. Asked of the analysis rather than computed at
   * click time, because it is the pass that actually read the description.
   */
  readonly estimate: number | null;
  readonly assignee: string;
  readonly status: string;
  /**
   * The ticket's own text, trimmed.
   *
   * Kept with the verdict so the overview can show what the analysis was actually reading. Without
   * it, judging a verdict means opening Jira in a browser, which is the trip this tab exists to
   * save.
   */
  readonly description: string;
}

/** The last analysis of one sprint, kept until that sprint is analysed again. */
export interface TriageResult {
  readonly sprintId: number;
  readonly sprintName: string;
  /** ISO instant, so the view can say how old the answer is. */
  readonly analysedAt: string;
  readonly tickets: readonly TriagedTicket[];
  /** Set when the run failed; the previous result is kept on screen and this explains why. */
  readonly error: string | null;
  /** The scope the run was launched with, so a stored list says what it covered. */
  readonly scope: TriageScope;
  /**
   * What the sprint held and the run was not given, per reason.
   *
   * Counted and shown rather than dropped in silence, the same rule that adds a forgotten ticket back
   * as `unclear`: a filtered list and a short sprint look identical on screen, and that is exactly the
   * failure nobody notices. The two reasons stay apart because they are answered differently: an
   * in-progress ticket is somebody's current work, a ticket that is not yours is one scope change away.
   */
  readonly skipped: TriageSkips;
}

/** Why a sprint's tickets were left out of a run. Both counts are zero on a full-sprint analysis. */
export interface TriageSkips {
  /** Already being worked on: `statusCategory` is `indeterminate`. */
  readonly inProgress: number;
  /** Assigned to somebody else, or to nobody, under the `mine` scope. */
  readonly notMine: number;
}

/**
 * Where a run has got to.
 *
 * Named after what the reader sees rather than after the protocol: `reading` covers every tool the
 * model uses to open the codebase, and `answering` is the stretch where nothing else will happen
 * until the verdicts land, which is exactly when a silent screen looks broken.
 */
export type TriagePhase = 'starting' | 'fetching' | 'reading' | 'answering' | 'done';

/**
 * Live state of the running analysis.
 *
 * Deliberately not a percentage. Nothing here knows how long a run takes, and a bar that fills at a
 * pace nobody can predict is a promise the tab cannot keep: what it reports instead is real
 * activity, the file being opened and the time spent, which is what tells a slow run from a stuck
 * one.
 */
export interface TriageProgress {
  readonly sprintId: number;
  readonly phase: TriagePhase;
  /** Human-facing line, such as `Reading schema.graphql`. */
  readonly detail: string;
  /** Tool calls so far. A count that keeps moving is the proof the run is alive. */
  readonly steps: number;
  /** ISO instant the run started, so the view can show elapsed time without its own clock. */
  readonly startedAt: string;
  /** How many tickets the sprint holds, known as soon as Jira answers. */
  readonly tickets: number;
}

export interface TriageState {
  readonly sprints: readonly Sprint[];
  /** Last analysis per sprint id, surviving restarts. */
  readonly results: Readonly<Record<string, TriageResult>>;
  /** Sprint currently being analysed, if any. One at a time: the run is long and costs tokens. */
  readonly running: number | null;
  /** Set only while a run is going, cleared when it lands. */
  readonly progress: TriageProgress | null;
  readonly error: string | null;
}

/* ------------------------------------------------------------------ *
 * Worktrees
 * ------------------------------------------------------------------ */

/**
 * One linked worktree of a repository.
 *
 * Everything here comes from `git worktree list --porcelain`, which is the only authority on the
 * question: a scan of the worktrees folder cannot tell a live checkout from a leftover, and it misses
 * every worktree created somewhere else, a real case in this workspace where one sits next to its
 * clone under `projects/` rather than in the canonical folder.
 */
export interface Worktree {
  /**
   * Folder name, which the naming convention makes the useful label (`TEC-1482-<repo>`).
   *
   * Derived from the path rather than stored by git, so it is exactly what a `cd` would show.
   */
  readonly name: string;
  /** Absolute path: the terminal's `cwd`, and the only identity a worktree has. */
  readonly path: string;
  /**
   * Branch checked out there, or `detached@<sha>` in the same spelling the project rows use.
   *
   * Read from the **registration** and never from `git.branch`, because it is the one that survives a
   * folder that has been wiped: git still knows which branch a prunable worktree was on, while a
   * `rev-parse` inside a missing directory can only fail.
   */
  readonly branch: string;
  /** Reason given to `git worktree lock`, or an empty string when it was locked without one. Null when unlocked. */
  readonly locked: string | null;
  /**
   * git's own reason for considering this worktree prunable, or null.
   *
   * The state the folder-scanning approach could never name: registered, but its directory is gone or
   * no longer a worktree. Shown rather than hidden, because it is the one row where the terminal
   * button cannot work and `wt rm` is the answer.
   */
  readonly prunable: string | null;
  /**
   * Working-tree state, or null when it was not read (a prunable worktree has nothing to read).
   *
   * The very same `GitState` the project table shows, deliberately: `presentGit` then paints these
   * rows with one definition of "modified", "clean" and "ahead" for the whole app. Its `stashes` is
   * not displayed here, and that is not an oversight: the stash list belongs to the repository, so
   * every worktree of one clone would report the same number and it would read as per-worktree.
   */
  readonly git: GitState | null;
}

/**
 * What `Generate` answered: a commit message, or why there is none.
 *
 * A message and not a commit. The answer goes into the form's textarea and the commit stays a separate
 * click, because a button that generated *and* committed would write history from a diff nobody
 * re-read. Same shape as `GitResult` on purpose, minus the assumption that something happened.
 */
export interface GeneratedCommit {
  readonly ok: boolean;
  /** The message, ready to be put in the form. Empty when the run failed. */
  readonly message: string;
  /** Why there is no message. Null on success. */
  readonly error: string | null;
}

/** The worktrees of one watched project, plus why there might be none. */
export interface RepoWorktrees {
  readonly projectId: ProjectId;
  readonly label: string;
  /** The main checkout's path, which is what the rows below are *not*. */
  readonly path: string;
  readonly worktrees: readonly Worktree[];
  /**
   * Set when `git worktree list` itself failed.
   *
   * Shown instead of swallowed, for the reason the pull request tab keeps its own error: a folder that
   * is not a git repository must not be readable as "this project has no worktree".
   */
  readonly error: string | null;
}

/**
 * A life-cycle gesture the Worktrees tab hands to the shell helper.
 *
 * A description of the **intent**, not a command line: the renderer says "remove this one, and the
 * branch with it", and the main process is the only place that turns that into an argument list. The
 * renderer therefore cannot compose a command, which is what keeps a folder name coming from a git
 * listing the only thing that can ever reach a shell.
 *
 * The repository is missing on purpose, including on `create`: the caller passes a `ProjectId`, and the
 * main process derives the folder from the configured path. A repository named by the renderer would be
 * a repository the renderer could get wrong.
 */
export type WorktreeCommand =
  | {
      readonly kind: 'remove';
      /** Folder name of the worktree, as the list read it back from `git worktree list`. */
      readonly label: string;
      /** `-f`: discards uncommitted work. Only ever offered on a row shown as dirty. */
      readonly discardChanges: boolean;
      /** `-d`: deletes the branch too, and the helper still refuses an unmerged one. */
      readonly deleteBranch: boolean;
    }
  | { readonly kind: 'rename'; readonly label: string; readonly newLabel: string }
  | {
      readonly kind: 'create';
      /** Ticket key or slug. A ticket key makes the description mandatory. */
      readonly label: string;
      readonly description: string;
    };

export interface AppSettings {
  themeMode: ThemeMode;
  /** Seconds between git refreshes. */
  gitPollSeconds: number;
  /** Seconds between GitHub checks refreshes. Kept well above the git interval: it hits the network. */
  checksPollSeconds: number;
  /** Seconds between pull request refreshes. Slower still: one call per watched repository. */
  pullsPollSeconds: number;
  /** Strip to reopen on, so the app comes back where it was left. */
  activeStrip: StripTab;
  /**
   * Whether the top strip is folded down to its tab row.
   *
   * The tabs stay visible when it is: a control that hides itself leaves no way back, and clicking a
   * tab is then the natural gesture for "show me that again". Persisted because someone working in
   * the terminal for an afternoon should not have to fold it again at every launch.
   */
  stripCollapsed: boolean;
  /**
   * Height of the top strip in pixels, per tab.
   *
   * One height each because the two views have different needs: a table of four rows against a
   * master-detail list of pull requests. Sharing one would mean resizing on every tab change.
   */
  projectsHeight: number;
  pullsHeight: number;
  jiraHeight: number;
  /** Sub-tab the pull request view reopens on, so the app comes back where it was left. */
  pullScope: PullScope;
  /**
   * Height of the Git tab, and the tallest default of the four.
   *
   * Three columns ending in a diff cannot be read in the 250 pixels a status table is happy with:
   * this tab is the one where the strip stops being a glance and becomes a place to work.
   */
  gitHeight: number;
  /**
   * Height of the Triage tab. Sized like the Git tab rather than like the status table: it lists a
   * sprint's tickets grouped by verdict, which is read for a while and not glanced at.
   */
  triageHeight: number;
  /**
   * Height of the Worktrees tab.
   *
   * Sized like the master-detail tabs rather than like the status table: this workspace holds eight
   * worktrees across two repositories on an ordinary day, and a list that scrolls at four rows is a
   * list you stop trusting to be complete.
   */
  worktreesHeight: number;
  /**
   * Width of the Git tab's working column, in pixels. The diff column takes what is left.
   *
   * Stored on the **list** side rather than the diff side, and that is the load-bearing half of the
   * choice: whichever column is not stored absorbs every window resize, and leftover width is worth
   * something to a diff (long lines of code) and nothing to a column of file paths.
   */
  gitListWidth: number;
  /** Seconds between Jira refreshes. Two JQL searches per pass, so the slowest loop of all. */
  jiraPollSeconds: number;
  /** Jira connection, token excluded. */
  jira: { siteUrl: string; email: string; projectKeys: string[] };
  /** Profile the bare "new tab" click uses. */
  defaultShellProfileId: string;
  /** Font size of every terminal, in pixels. */
  terminalFontSize: number;
  /** Font size of the interface, in pixels: the base every other size is a ratio of. */
  uiFontSize: number;
  /** User-declared shell profiles, merged over the detected ones by id. */
  shellProfiles: ShellProfile[];
  /** Where to look for repositories when detecting candidates. */
  projectsRoot: string;
  /**
   * Folder a `Work on this` session starts in, instead of the ticket's own repository.
   *
   * Claude Code reads its instructions, its skills and its memory from the folder it is launched in
   * and from that folder's ancestors. A repository sitting under a workspace therefore starts with
   * strictly less context than the workspace itself: the session knows the repository's own
   * `CLAUDE.md` and nothing of the conventions, the skills and the knowledge base kept one level up,
   * which is exactly where they live when several repositories share them. Starting at the workspace
   * root and naming the repository in the prompt is the way round that keeps both.
   *
   * Empty means "start in the repository", which is what every version before 5.2.0 did. Not in the
   * settings window, like `projectsRoot` and the poll cadences: a path that is right on the first
   * launch and never touched again does not need a field competing with the ones that are.
   */
  claudeContextRoot: string;
  /**
   * Model each Claude Code run is pinned to, or empty for whatever Claude Code itself is set to.
   *
   * Three fields and not one, because these are three different jobs. Classifying twenty tickets is
   * bulk reading where speed and cost dominate; implementing a ticket wants the strongest model there
   * is; writing a commit message from a diff is short, frequent and cheap. A single setting would be
   * wrong for two of the three, and the run that suffers most is the one nobody can intervene in.
   *
   * `--model` is *not* passed at all when the value is empty: the CLI rejects a blank model, so the
   * default has to be the absence of the flag rather than an empty one. Values are validated against
   * `CLAUDE_MODEL_PATTERN`, since one of the three reaches a shell.
   */
  /**
   * Whether the dev servers were in their own window when the app was last closed.
   *
   * Persisted for one reason: the window's whole point is to be parked on a second monitor and left
   * there, and a second monitor you have to re-populate at every launch is one you stop using. Restored
   * at startup **after** the terminals have been rebuilt, or there would be nothing to detach.
   */
  serversDetached: boolean;
  claudeAnalysisModel: string;
  /** Model for the `Work on this` handoff, the one run that is interactive. */
  claudeWorkModel: string;
  /** Model for `Generate` in the Git tab's commit form. */
  claudeCommitModel: string;
  /**
   * Watched projects.
   *
   * Empty on a fresh install, which triggers a one-time seeding from `projectsRoot` so the app is
   * useful immediately without asking the user to configure anything first.
   */
  projects: ProjectConfig[];
}

/** Window bounds remembered across sessions. */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ *
 * Terminal groups
 * ------------------------------------------------------------------ */

/**
 * One pane: its own tab strip, and which of those tabs it is showing.
 *
 * A pane used to *be* a session, with a single tab strip above the whole surface. Splitting then
 * split the view rather than the terminal, so the strip kept listing every session in the app while
 * each pane showed exactly one of them. A group is the fix: split, and you get a complete terminal
 * on the right, tabs included.
 *
 * **Every live session belongs to exactly one group.** That is what makes the layout the single
 * index of the tab strips instead of a subset of a separately ordered list, and it is enforced in
 * one place, `normalizeGroups`.
 */
export interface TerminalGroup {
  /** Tab order inside this pane, left to right. Never empty: an empty group is dropped. */
  readonly tabs: TerminalId[];
  /** The tab on screen in this pane. Always one of `tabs`. */
  readonly active: TerminalId;
}

/* ------------------------------------------------------------------ *
 * Terminal host
 * ------------------------------------------------------------------ */

/**
 * What kind of pty the terminals are actually talking to.
 *
 * Handed to xterm as its `windowsPty` option, which is not cosmetic: told nothing, xterm assumes a
 * Unix pty and reflows its own buffer when the grid is resized. ConPTY *also* reflows and reprints
 * the screen from the console buffer it owns, so both ends rewrite the same rows from different
 * ideas of where they start, and the loser leaves characters behind. Told the backend and the build
 * number, xterm turns off its reflow and grows into the scrollback the way ConPTY expects.
 *
 * `null` off Windows, where none of these workarounds apply.
 */
export interface TerminalCompat {
  readonly backend: 'conpty' | 'winpty';
  /** Windows build, e.g. 26200. The behaviour xterm picks changes at 21376. */
  readonly buildNumber: number;
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

export interface BootstrapState {
  readonly projects: Project[];
  readonly settings: AppSettings;
  readonly theme: ThemeState;
  /**
   * The running build's version, from `app.getVersion()`.
   *
   * Asked of Electron and never imported from `package.json`: the renderer is bundled, so an import
   * would freeze the number the bundle was built with, and the one question this answers is "which
   * build am I actually looking at". Three builds of this app can sit side by side (installed,
   * portable, unpacked zip), and they are indistinguishable on screen otherwise.
   */
  readonly appVersion: string;
  /** Detected profiles merged with the user's, ready for the new-tab menu. */
  readonly shellProfiles: ShellProfile[];
  /**
   * Terminals already alive in the main process.
   *
   * Sent because the renderer can restart without the main process doing so, on every hot reload in
   * development. Without this the tab strip came up empty until the next change event, and the
   * startup shell was opened again each time, stacking up identical "Git Bash" tabs.
   */
  readonly terminals: TerminalSession[];
  /** Which of those sessions are on screen, and how they share it. */
  readonly layout: TerminalLayout;
  /** Last known pull requests, so the tab is not empty on the first paint. */
  readonly pulls: RepoPulls[];
  readonly jira: JiraState;
  /** Jira connection as configured, token excluded. */
  readonly jiraConfig: JiraConfig;
  /** Pty backend the terminals run on, so xterm can be configured for it. `null` off Windows. */
  readonly terminalCompat: TerminalCompat | null;
}

/* ------------------------------------------------------------------ *
 * IPC channels
 * ------------------------------------------------------------------ */

export const IpcChannel = {
  /** invoke: () => BootstrapState */
  Bootstrap: 'app:bootstrap',
  /** on: (rows: ProjectRow[]) => void, pushed whenever any project's state changes */
  RowsChanged: 'projects:rows-changed',
  /** invoke: () => ProjectRow[], forces a full refresh */
  RefreshNow: 'projects:refresh',
  /** on: (repos: RepoPulls[]) => void, pushed whenever pull requests are re-read */
  PullsChanged: 'pulls:changed',
  /** invoke: () => RepoPulls[], forces a pull request refresh */
  PullsRefresh: 'pulls:refresh',
  /** invoke: (url: string) => void, opens a pull request in the real browser */
  OpenExternal: 'shell:open-external',
  /** invoke: (text) => void, puts a terminal selection on the system clipboard */
  ClipboardWrite: 'clipboard:write',
  /** invoke: () => string, reads the system clipboard for a terminal paste */
  ClipboardRead: 'clipboard:read',
  /** on: (state: JiraState) => void, pushed whenever the Jira searches are re-run */
  JiraChanged: 'jira:changed',
  /** invoke: () => JiraState, forces a Jira refresh */
  JiraRefresh: 'jira:refresh',
  /** invoke: (config, token?) => JiraConfig, saves the connection; the token goes to the secret store */
  JiraSave: 'jira:save',
  /** invoke: () => { ok, message }, one live query to tell whether the credentials work */
  JiraTest: 'jira:test',
  /** invoke: (key) => IssueTransition[], the moves this issue can make right now */
  JiraTransitions: 'jira:transitions',
  /** invoke: (key, transitionId) => { ok, message }, moves an issue */
  JiraTransition: 'jira:transition',
  /** invoke: (key) => { ok, message }, assigns an issue to the token's own account */
  JiraAssignMe: 'jira:assign-me',
  /**
   * invoke: () => RepoWorktrees[], every project's linked worktrees with their working-tree state
   *
   * Pulled and never pushed, like the Git tab: there is no monitor behind it, so nothing is read for
   * a tab nobody is looking at. Its heartbeat is the git poll's `RowsChanged`, which describes the
   * very working trees this list is about.
   */
  WorktreesRead: 'worktrees:read',
  /**
   * invoke: (projectId, command: WorktreeCommand) => { terminalId, result }
   *
   * Runs the shell helper's `new`, `mv` or `rm` in a terminal tab. A tab and not a silent `execFile`,
   * for the reason a commit gets one: the helper reports what it unlinked, what git refused and which
   * branch it kept, and a gesture that deletes a folder is the last one whose output should be
   * swallowed.
   */
  WorktreeRun: 'worktrees:run',
  /** invoke: (projectId) => GitRepoState | null, everything the Git tab shows for one repository */
  GitState: 'git:state',
  /**
   * invoke: (detached: boolean) => void, shows the `server` tabs in their own window, or brings them back
   *
   * One channel for both directions rather than an open and a close: the two windows would otherwise
   * each hold their own idea of whether the other exists, and the main process is the only side that
   * knows. Opening the window and detaching the sessions is deliberately the same gesture: a servers
   * window with no servers in it, or servers detached to a window that is not there, are both states
   * with nothing able to show or stop a running process.
   */
  ServersDetach: 'servers:detach',
  /** on: (detached: boolean) => void, pushed when the servers window opens or closes, however it closed */
  ServersDetachedChanged: 'servers:detached-changed',
  /**
   * invoke: (terminalId, toServers: boolean) => void, moves one tab between the two windows
   *
   * The escape hatch for what the role cannot know: a `npm run start` typed by hand into a shell is a
   * dev server in every way that matters, and a `shell` session as far as this app can tell.
   */
  ServersMove: 'servers:move',
  /** invoke: (projectId, target: GitDiffTarget) => GitDiff, a file's changes or a whole commit */
  GitDiff: 'git:diff',
  /**
   * invoke: (projectId, amend: boolean) => GeneratedCommit
   *
   * Writes a commit message from the staged diff with a headless Claude Code run, and returns it. It
   * fills the form; it never commits. Not a terminal tab, for the reason the sprint analysis is not
   * one: the output is a payload that has to land in a textarea, not something to read scroll past.
   */
  GitGenerateMessage: 'git:generate-message',
  /** invoke: (projectId, name, checkout: boolean) => GitResult */
  GitBranchCreate: 'git:branch-create',
  /** invoke: (projectId, name) => GitResult */
  GitCheckout: 'git:checkout',
  /** invoke: (projectId, paths: string[], staged: boolean) => GitResult, stages or unstages */
  GitStage: 'git:stage',
  /**
   * invoke: (projectId, paths: string[]) => GitResult
   *
   * Throws away what was done to those files: back to HEAD for a tracked one, deleted for an
   * untracked one. The only write in this app that destroys work with nothing able to bring it back,
   * so it is confirmed in a modal **in the main process** before a single file is touched, and the
   * paths are re-read from git rather than trusted from the renderer.
   */
  GitDiscard: 'git:discard',
  /**
   * invoke: (projectId, message, amend: boolean) => { terminalId, result }
   *
   * Writes the message to a file and runs `git commit -F` (`--amend` when asked) in a terminal
   * tab, so hooks and their output are visible rather than swallowed by a silent `execFile`.
   */
  GitCommit: 'git:commit',
  /** invoke: (projectId, op: GitSyncOp) => GitResult, the three network operations */
  GitSync: 'git:sync',
  /** invoke: (projectId, sha, noCommit: boolean) => GitResult, replays a commit onto the branch */
  GitCherryPick: 'git:cherry-pick',
  /** invoke: (projectId, op: GitSequencerOp) => GitResult, finishes or abandons a half-done operation */
  GitSequencer: 'git:sequencer',
  /** invoke: (projectId, message, includeUntracked: boolean) => GitResult, creates a stash */
  GitStashPush: 'git:stash-push',
  /**
   * invoke: (projectId, sha, op: GitStashOp) => GitResult
   *
   * Takes the **sha**, never the `stash@{n}` the renderer last saw: the main process re-reads the
   * list and resolves it, so a stale position cannot make this act on the wrong entry.
   */
  GitStashApply: 'git:stash-apply',
  /**
   * invoke: (projectId, issueKey) => { terminalId, result }
   *
   * Runs the `dev <TICKET>` alias in an interactive Git Bash tab, in the chosen project's folder.
   * The command is **built in the main process** from a key matched against `ISSUE_KEY_PATTERN`:
   * the renderer names a ticket and a project, never a command line.
   */
  JiraBranch: 'jira:branch',
  /**
   * invoke: (projectId, issueKeys[]) => { terminalId, result }
   *
   * Opens an interactive Claude Code session in a terminal tab, seeded with `/ticket <KEY>` for one
   * ticket or with the list for a whole batch. The keys are validated in the main process against
   * `ISSUE_KEY_PATTERN`, like the branch channel: the renderer names tickets, never a command line.
   */
  TriageWork: 'triage:work',
  /**
   * invoke: (issueKeys[]) => GitResult
   *
   * Records a handoff on the Jira board: active sprint, assigned to the token's account, story points
   * from the stored analysis, then in progress. A **separate** channel from `TriageWork` on purpose,
   * and called after it: four writes per ticket over the network is seconds for a batch, and folded
   * into the handoff they would delay the moment the tab comes forward. That tab holds an agent that
   * asks questions, and one waiting behind the current tab is one nobody answers.
   *
   * Keys only, like every other Jira channel. The estimate is looked up in `triage.json` by the main
   * process rather than travelling, so it is always the current one.
   */
  TriageStartInJira: 'triage:start-in-jira',
  /** on: (state: TriageState) => void, pushed when the sprint list, a result or the running flag moves */
  TriageChanged: 'triage:changed',
  /** invoke: () => TriageState, re-reads the sprints from Jira and returns the stored results */
  TriageRefresh: 'triage:refresh',
  /**
   * invoke: (sprintId, scope: TriageScope) => TriageState
   *
   * Fetches the sprint's issues, hands them to a headless Claude Code run for classification, and
   * stores the verdicts. The previous result stays on screen for the whole run and is only replaced
   * when a new one lands, which is the point of storing it at all.
   *
   * The scope travels with the run rather than being read from the settings: it decides what a paid
   * run is given, so it belongs to the click that started it and to the result it produced.
   */
  TriageAnalyse: 'triage:analyse',
  /**
   * invoke: (sprintId, issueKey) => TriageState
   *
   * Drops one ticket from a stored analysis. Local to `triage.json` and to nothing else: the ticket
   * itself is untouched, and the next run on that sprint brings the row back. What it removes is a
   * line from a worklist somebody has already dealt with.
   */
  TriageDismiss: 'triage:dismiss',
  /** invoke: (projectId, actionId) => TerminalId, runs one of a project's actions in its own tab */
  PtyRun: 'pty:run',
  /** invoke: (request: OpenShellRequest) => TerminalId */
  TerminalOpenShell: 'terminal:open-shell',
  /** invoke: (projectId) => TerminalId, opens the project's shell or brings the existing one back */
  ProjectShell: 'project:shell',
  /** invoke: (terminalId) => void, stops the process and its whole tree */
  PtyStop: 'pty:stop',
  /** invoke: (projectId) => boolean, stops the project's running `server` action, whichever it is */
  ProjectStop: 'project:stop',
  /** invoke: (terminalId) => void, stops it if needed and forgets the tab */
  TerminalClose: 'terminal:close',
  /** invoke: (terminalId, title) => void, renames a tab */
  TerminalRename: 'terminal:rename',
  /** send: (terminalId, data) => void, keystrokes from xterm to the pty */
  PtyInput: 'pty:input',
  /** send: (terminalId, size) => void */
  PtyResize: 'pty:resize',
  /** on: (chunk: TerminalChunk) => void */
  PtyOutput: 'pty:output',
  /** invoke: (terminalId) => string, replays buffered output when a tab is first shown */
  PtyBuffer: 'pty:buffer',
  /** send: (terminalId) => void, tells ConPTY the frontend cleared so it does not reprint the screen */
  PtyClear: 'pty:clear',
  /** on: (sessions: TerminalSession[]) => void, the tab strip is rebuilt from this */
  TerminalsChanged: 'terminal:sessions-changed',
  /** invoke: (panes: TerminalId[], direction) => void, replaces the whole visible layout */
  TerminalLayoutSet: 'terminal:layout-set',
  /** on: (layout: TerminalLayout) => void, pushed whenever the visible panes change */
  TerminalLayoutChanged: 'terminal:layout-changed',
  /** invoke: (projectId) => void, reveals the repository in the file explorer */
  OpenFolder: 'shell:open-folder',
  /** invoke: (mode: ThemeMode) => ThemeState */
  ThemeSet: 'theme:set',
  /** on: (state: ThemeState) => void */
  ThemeChanged: 'theme:changed',
  /** invoke: (patch) => AppSettings */
  SettingsUpdate: 'settings:update',
  /** invoke: (projects: ProjectConfig[]) => AppSettings, replaces the whole list */
  ProjectsSave: 'projects:save',
  /** invoke: (root?: string) => ProjectCandidate[] */
  ProjectsDetect: 'projects:detect',
  /** invoke: (path: string) => ProjectConfig, a candidate entry for a folder, not saved */
  ProjectsBuild: 'projects:build',
  /** invoke: (projects: ProjectConfig[]) => ProjectValidation[], checked as the user types */
  ProjectsValidate: 'projects:validate',
  /** invoke: (profiles: ShellProfile[], defaultId) => AppSettings */
  ProfilesSave: 'profiles:save',
  /** invoke: (title) => string | null, native folder picker */
  PickFolder: 'dialog:pick-folder',
  /** on: (settings: AppSettings) => void, pushed when settings change from anywhere */
  SettingsChanged: 'settings:changed',
  /** invoke: () => void, opens (or focuses) the settings window */
  SettingsOpen: 'settings:open',
  /** send: (dirty: boolean) => void, lets the main process warn before closing on unsaved edits */
  SettingsDirty: 'settings:dirty',
  /** invoke: () => void, closes the window the call came from */
  WindowClose: 'window:close',
} as const;

/**
 * The API exposed on `window.api`.
 *
 * Deliberately small: each member is one capability, so the renderer's blast radius is exactly
 * this list.
 */
export interface RendererApi {
  bootstrap(): Promise<BootstrapState>;
  refreshNow(): Promise<ProjectRow[]>;
  onRowsChanged(listener: (rows: ProjectRow[]) => void): () => void;

  refreshPulls(): Promise<RepoPulls[]>;
  onPullsChanged(listener: (repos: RepoPulls[]) => void): () => void;

  refreshJira(): Promise<JiraState>;
  onJiraChanged(listener: (state: JiraState) => void): () => void;
  refreshTriage(): Promise<TriageState>;
  workOnTickets(
    projectId: ProjectId,
    issueKeys: string[],
  ): Promise<{ terminalId: TerminalId | null; result: GitResult }>;
  startInJira(issueKeys: string[]): Promise<GitResult>;
  analyseSprint(sprintId: number, scope: TriageScope): Promise<TriageState>;
  /** Drops one row from a stored analysis. Touches `triage.json` and nothing in Jira. */
  dismissTriageTicket(sprintId: number, issueKey: string): Promise<TriageState>;
  onTriageChanged(listener: (state: TriageState) => void): () => void;
  /**
   * Saves the Jira connection.
   *
   * The token is passed separately and only ever travels **towards** the main process: it is written to
   * the encrypted store and never sent back, so a compromised renderer cannot read it out. Omit it to
   * leave the stored one untouched.
   */
  saveJira(config: { siteUrl: string; email: string; projectKeys: string[] }, token?: string):
    Promise<{ config: JiraConfig; message: string }>;
  testJira(): Promise<{ ok: boolean; message: string }>;
  /** The moves an issue can make, asked at the moment the menu opens rather than cached. */
  jiraTransitions(key: string): Promise<IssueTransition[]>;
  transitionJira(key: string, transitionId: string): Promise<{ ok: boolean; message: string }>;
  assignJiraToMe(key: string): Promise<{ ok: boolean; message: string }>;
  /**
   * Starts a ticket's branch in a terminal tab, by running the `dev <TICKET>` alias.
   *
   * A tab rather than a silent `execFile`, for the same reason a commit gets one: the alias is a
   * script that talks back, and the branch it creates is the user's to watch being created. Returns
   * the tab so the caller can bring it forward, exactly like `gitCommit`.
   */
  startTicketBranch(
    projectId: ProjectId,
    issueKey: string,
  ): Promise<{ terminalId: TerminalId | null; result: GitResult }>;
  /** Opens a pull request in the real browser. Only http(s) is followed, checked in the main process. */
  openExternal(url: string): Promise<void>;
  /**
   * Shows the `server` tabs in a window of their own, or brings them back to the dashboard.
   *
   * Called by the dashboard to detach, and by the servers window itself to give the sessions back before
   * it closes. Nothing about the ptys changes: a detached server keeps running and keeps its scrollback,
   * only the window painting it changes.
   */
  detachServers(detached: boolean): Promise<void>;
  /** Pushed whenever the servers window opens or closes, including when the user closes it by hand. */
  onServersDetachedChanged(listener: (detached: boolean) => void): () => void;
  /**
   * Moves one tab to the servers window, or back to the dashboard.
   *
   * A no-op while the servers window is closed: there would be nowhere for the session to go. Nothing
   * about the pty changes either way.
   */
  moveTerminalToServers(terminalId: TerminalId, toServers: boolean): Promise<void>;

  /**
   * Reads every project's linked worktrees, for the Worktrees tab.
   *
   * One call for the whole list rather than one per project: the tab's reason to exist is the view
   * *across* repositories, so a per-project channel would only let the renderer assemble what the main
   * process can answer in one pass.
   */
  readWorktrees(): Promise<RepoWorktrees[]>;
  /**
   * Creates, renames or removes a worktree, by running the shell helper in a terminal tab.
   *
   * The tab is the point and not a side effect. This is the one gesture in the strip that **deletes**
   * something, and the helper's own output is what says whether the junction was unlinked, whether git
   * refused on uncommitted work, and whether the branch was kept because it is not merged. A silent
   * call would replace all of that with a one-line verdict written by this app, about a command it did
   * not run.
   *
   * Returns the tab like `gitCommit` and `startTicketBranch` do, so the caller can bring it forward.
   */
  runWorktreeCommand(
    projectId: ProjectId,
    command: WorktreeCommand,
  ): Promise<{ terminalId: TerminalId | null; result: GitResult }>;
  /**
   * Reads a repository's full git state for the Git tab.
   *
   * Pulled on demand rather than pushed by a monitor: only the selected repository is ever displayed,
   * and polling branches, history and status for every project would be several times the work of the
   * strip's own git poll for something nobody is looking at.
   */
  gitState(projectId: ProjectId): Promise<GitRepoState | null>;
  /** The diff of one working-tree file, or of a whole commit. */
  gitDiff(projectId: ProjectId, target: GitDiffTarget): Promise<GitDiff>;
  /**
   * Writes a commit message from the staged diff, and returns it for the form.
   *
   * `amend` decides what the message has to describe: the index alone, or the last commit plus
   * whatever is staged on top of it. It is passed rather than read from the panel's state in the main
   * process, the amend being a draft the renderer owns and has not saved anywhere.
   */
  gitGenerateMessage(projectId: ProjectId, amend: boolean): Promise<GeneratedCommit>;
  /** Creates a branch, optionally switching to it. The name is validated by git itself. */
  gitCreateBranch(projectId: ProjectId, name: string, checkout: boolean): Promise<GitResult>;
  gitCheckout(projectId: ProjectId, name: string): Promise<GitResult>;
  /** Stages the given paths, or unstages them when `staged` is false. */
  gitStage(projectId: ProjectId, paths: string[], staged: boolean): Promise<GitResult>;
  /**
   * Throws the changes to those paths away: back to HEAD, or deleted when untracked.
   *
   * Confirmed by a modal in the main process before anything is touched, and `ok: false` with a
   * message is what a cancelled confirmation looks like from here: the renderer never learns whether
   * the dialog was answered or the command refused, both being "nothing happened".
   */
  gitDiscard(projectId: ProjectId, paths: string[]): Promise<GitResult>;
  /**
   * Commits what is staged, in a terminal tab.
   *
   * Returns the tab so the caller can bring it forward: the point of running it there is that the
   * pre-commit hooks are watchable, which is worth nothing if the tab stays hidden.
   *
   * `amend` swaps the command for `git commit --amend`: the staged changes (none is fine, that is
   * a reword) fold into the HEAD commit and the message replaces its message.
   */
  gitCommit(
    projectId: ProjectId,
    message: string,
    amend: boolean,
  ): Promise<{ terminalId: TerminalId | null; result: GitResult }>;
  gitSync(projectId: ProjectId, op: GitSyncOp): Promise<GitResult>;
  /**
   * Replays a commit onto the current branch.
   *
   * `noCommit` maps to `-n`: the changes land staged and uncommitted, which is what "take this commit
   * but let me adjust it" means. A conflict leaves the repository mid-cherry-pick, which is why
   * `GitRepoState.sequencer` exists and why the header grows a way out of it.
   */
  gitCherryPick(projectId: ProjectId, sha: string, noCommit: boolean): Promise<GitResult>;
  /** Finishes (`--continue --no-edit`) or abandons (`--abort`) whatever git left half-done. */
  gitSequencer(projectId: ProjectId, op: GitSequencerOp): Promise<GitResult>;
  /** Stashes the working tree. An empty message lets git write its own `WIP on <branch>`. */
  gitStashPush(projectId: ProjectId, message: string, includeUntracked: boolean): Promise<GitResult>;
  /** Applies, pops or drops a stash, identified by its sha rather than by its position. */
  gitStash(projectId: ProjectId, sha: string, op: GitStashOp): Promise<GitResult>;

  /**
   * The system clipboard, for terminal copy and paste.
   *
   * Handled by the main process because a renderer on a `file://` page under this CSP has neither the
   * permission nor the secure context `navigator.clipboard` requires for reading.
   */
  writeClipboard(text: string): Promise<void>;
  readClipboard(): Promise<string>;

  runAction(projectId: ProjectId, actionId: string): Promise<TerminalId>;
  openShell(request: OpenShellRequest): Promise<TerminalId>;
  /**
   * Opens a shell sitting in the project's repository, or brings back the one already open there.
   *
   * Reuse rather than a new tab, because this is what a click on a row does: a gesture that easy to
   * trigger must not be able to pile up terminals. The lookup is the main process's, since it owns the
   * sessions.
   */
  openProjectShell(projectId: ProjectId): Promise<TerminalId>;
  stopPty(terminalId: TerminalId): Promise<void>;
  /**
   * Stops a project's server action.
   *
   * Takes a project rather than a terminal on purpose: which session that is depends on the action
   * roles, and the main process is the only side that holds both. Resolves to false when there was
   * nothing running, so a dead button reports itself instead of looking like a no-op.
   */
  stopProjectServer(projectId: ProjectId): Promise<boolean>;
  closeTerminal(terminalId: TerminalId): Promise<void>;
  renameTerminal(terminalId: TerminalId, title: string): Promise<void>;
  /**
   * Replaces the layout, panes and tab order together.
   *
   * The whole structure at once rather than one operation per gesture: splitting, closing a pane,
   * clicking a tab and dragging one into another pane are all just different groups. The arithmetic
   * is pure and testable (`shared/terminal-groups.ts`), and the main process validates what it is
   * handed with the very same functions. It also replaced a separate "reorder the tabs" call, which
   * was a second authority on where a tab lives and could disagree with this one.
   */
  setTerminalLayout(groups: readonly TerminalGroup[], direction: PaneDirection): Promise<void>;
  onTerminalLayoutChanged(listener: (layout: TerminalLayout) => void): () => void;
  sendPtyInput(terminalId: TerminalId, data: string): void;
  resizePty(terminalId: TerminalId, size: TerminalSize): void;
  onPtyOutput(listener: (chunk: TerminalChunk) => void): () => void;
  readPtyBuffer(terminalId: TerminalId): Promise<string>;
  /**
   * Tells the pty its screen was cleared.
   *
   * A no-op outside ConPTY, and mandatory on it: ConPTY keeps its own copy of the console buffer and
   * happily reprints it after a frontend-only clear, which puts back exactly the text the user asked
   * to be rid of.
   */
  clearPty(terminalId: TerminalId): void;
  onTerminalsChanged(listener: (sessions: TerminalSession[]) => void): () => void;

  openFolder(projectId: ProjectId): Promise<void>;

  setThemeMode(mode: ThemeMode): Promise<ThemeState>;
  onThemeChanged(listener: (state: ThemeState) => void): () => void;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;

  saveProjects(projects: ProjectConfig[]): Promise<AppSettings>;
  detectProjects(root?: string): Promise<ProjectCandidate[]>;
  /**
   * Builds the configuration for a folder without saving it.
   *
   * The id, the label and the default actions are derived in the main process so there is exactly one
   * definition of what a new project looks like, whether it is added from the table or from the
   * settings window.
   */
  buildProjectConfig(path: string): Promise<ProjectConfig>;
  validateProjects(projects: ProjectConfig[]): Promise<ProjectValidation[]>;
  saveProfiles(profiles: ShellProfile[], defaultProfileId: string): Promise<AppSettings>;
  pickFolder(title: string): Promise<string | null>;
  onSettingsChanged(listener: (settings: AppSettings) => void): () => void;

  /** Opens the settings window, or focuses it when it is already up. */
  openSettings(): Promise<void>;
  /** Reports unsaved edits so closing the settings window can ask for confirmation. */
  reportSettingsDirty(dirty: boolean): void;
  /** Closes the window the renderer runs in. */
  closeWindow(): Promise<void>;
}
