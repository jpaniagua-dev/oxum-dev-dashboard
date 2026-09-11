import type {
  AppSettings,
  GitState,
  Project,
  ProjectId,
  ProjectRow,
  ServerState,
  WorkflowsState,
} from '@shared/contracts.js';
import { POLL_CONCURRENCY, mapWithLimit } from '../concurrency.js';
import { readGitState, readRemoteSlug } from '../git/git-service.js';
import { readWorkflowsState } from '../github/runs-service.js';
import type { ParsedOutput } from './output-parser.js';

/**
 * A partial update to a server state.
 *
 * `ServerState` is deeply readonly so the renderer cannot mutate what it receives; building a patch
 * therefore needs the modifiers stripped, which is what `-readonly` does here.
 */
type ServerPatch = { -readonly [K in keyof ServerState]?: ServerState[K] };

/** Server state for a project the dashboard has never touched. */
function idleServer(): ServerState {
  return {
    phase: 'stopped',
    pid: null,
    port: null,
    errorSummary: null,
    errorCount: 0,
    owned: false,
  };
}

/**
 * Keeps the aggregated state of every project and notifies when it changes.
 *
 * Three sources feed one row, each on its own cadence because they cost differently: the pty output
 * is a live push, git is local and cheap, GitHub is a network round trip. Merging them here rather
 * than in the renderer keeps a single authority for what a row means.
 */
export class ProjectMonitor {
  private readonly servers = new Map<ProjectId, ServerState>();
  private readonly git = new Map<ProjectId, GitState>();
  private readonly workflows = new Map<ProjectId, WorkflowsState>();
  /** Resolved once per project: a remote does not move while the app runs. */
  private readonly slugs = new Map<ProjectId, string | null>();
  private gitTimer: NodeJS.Timeout | null = null;
  private githubTimer: NodeJS.Timeout | null = null;

  constructor(
    private projects: readonly Project[],
    private readonly settings: () => AppSettings,
    private readonly onChange: (rows: ProjectRow[]) => void,
    /**
     * Called once per finished git poll, and by nothing else.
     *
     * Separate from `onChange` because the two answer different questions. `onChange` means "a row
     * looks different now", which is true five times as often and for reasons that say nothing about
     * a working tree: a checks read, a workflows read, a reorder, a byte of server output. The Git
     * and Worktrees tabs need "the working trees were just re-read", and using the first as a proxy
     * for the second is what made a dev server's output fire the widest read in the app.
     */
    private readonly onGitPolled: () => void = () => undefined,
  ) {
    for (const project of projects) {
      this.servers.set(project.id, idleServer());
    }
  }

  /**
   * Adopts a project list holding the same projects in another order, keeping every state.
   *
   * The alternative, and what the code did until 2026-08-24, is to throw the monitor away and build a
   * new one. That is right when the **set** changes: the state maps are keyed by project id, so a
   * rebuild is how rows for a deleted project go away. It is wrong for a permutation, and expensively
   * so: `servers` is seeded to `idleServer()` in the constructor and only ever refilled by pty output,
   * so a running dev server that had nothing new to say would have read `stopped` until it was
   * restarted. Reordering the table would have appeared to stop every server in it.
   *
   * Only the order is trusted here. The caller checks the set with `sameProjectSet` and rebuilds
   * otherwise, so this method never has to invent a state for a project it has never seen.
   */
  reorder(next: readonly Project[]): void {
    this.projects = next;
    this.onChange(this.rows());
  }

  rows(): ProjectRow[] {
    return this.projects.map((project) => ({
      project,
      server: this.servers.get(project.id) ?? idleServer(),
      git: this.git.get(project.id) ?? null,
      workflows: this.workflows.get(project.id) ?? null,
    }));
  }

  /** Starts the polling loops and performs a first refresh immediately. */
  start(): void {
    void this.refreshGit();
    void this.refreshWorkflows();

    this.gitTimer = setInterval(() => {
      void this.refreshGit();
    }, this.settings().gitPollSeconds * 1000);

    // `checksPollSeconds` still names this timer's cadence, and it now drives one column instead of
    // two. The projects table's `Checks` column stopped being a query on 2026-09-09: it is a join
    // against the pull requests the renderer already holds, so nothing is polled for it here. The
    // setting was not renamed, since it is what a user set to say how often this app should go and ask
    // GitHub anything.
    this.githubTimer = setInterval(() => {
      void this.refreshWorkflows();
    }, this.settings().checksPollSeconds * 1000);
  }

  stop(): void {
    if (this.gitTimer !== null) {
      clearInterval(this.gitTimer);
      this.gitTimer = null;
    }
    if (this.githubTimer !== null) {
      clearInterval(this.githubTimer);
      this.githubTimer = null;
    }
  }

  /**
   * Forces a full refresh, for the manual refresh button.
   *
   * Left parallel across the two sources, unlike the timer tick: this one answers a click, the user is
   * waiting on it, and each source is pooled internally. A burst of two pools is 8 spawns at worst, on
   * a gesture nobody makes twice a second.
   */
  async refreshAll(): Promise<ProjectRow[]> {
    await Promise.all([this.refreshGit(), this.refreshWorkflows()]);
    return this.rows();
  }

  /* ------------------------------------------------------------ server side */

  /** Records that the dashboard just spawned a process for this project. */
  markStarting(projectId: ProjectId, pid: number | null): void {
    this.patchServer(projectId, {
      phase: 'starting',
      pid,
      owned: true,
      errorSummary: null,
      errorCount: 0,
    });
  }

  /** Applies whatever the output parser could infer. */
  applyParsed(projectId: ProjectId, parsed: ParsedOutput): void {
    const current = this.servers.get(projectId);
    if (current === undefined) {
      return;
    }

    const patch: ServerPatch = {};
    if (parsed.phase !== null) {
      patch.phase = parsed.phase;
    }
    if (parsed.port !== null) {
      patch.port = parsed.port;
    }
    if (parsed.errorSummary !== null) {
      patch.errorSummary = parsed.errorSummary;
    }
    if (parsed.errorCount !== null) {
      patch.errorCount = parsed.errorCount;
    }
    // A successful build clears any previous error, so a row does not stay red after the user fixed
    // the problem.
    //
    // It used to stamp a `lastSuccessAt` here as well. That field had **no consumer anywhere**, which
    // is the failure `GitState.stashes` already recorded, and it was worse than merely unused: a fresh
    // timestamp on every success marker made the patch differ from the current state by construction,
    // so it was the one field able to defeat the identity check below and push a row set for a row
    // that looked exactly the same.
    if (parsed.phase === 'serving' || parsed.phase === 'watching') {
      patch.errorSummary = null;
      patch.errorCount = 0;
    }

    if (Object.keys(patch).length > 0) {
      this.patchServer(projectId, patch);
    }
  }

  /** Records that an owned process ended. */
  markExited(projectId: ProjectId, exitCode: number, stopped: boolean): void {
    this.patchServer(projectId, {
      // A non-zero exit that nobody asked for is a crash; anything else is simply stopped.
      phase: stopped || exitCode === 0 ? 'stopped' : 'crashed',
      pid: null,
      port: null,
      owned: false,
    });
  }

  /**
   * Applies a patch, and pushes **only if it changed something**.
   *
   * The comparison is not a micro-optimisation. `applyParsed` runs on every chunk of a server's
   * output, and the output parser answers a phase for any chunk containing `Building` or a
   * `localhost:` banner, which a dev server reprints on every rebuild. Each of those used to push a
   * full row set to the renderer, and the Git and Worktrees tabs used that push as their heartbeat,
   * so re-stating a phase the row already had cost eighteen child processes. Every field of
   * `ServerState` is a primitive, so identity is decided field by field.
   */
  private patchServer(projectId: ProjectId, patch: ServerPatch): void {
    const current = this.servers.get(projectId) ?? idleServer();
    const next = { ...current, ...patch };
    if (sameServerState(current, next)) {
      return;
    }
    this.servers.set(projectId, next);
    this.emit();
  }

  /* --------------------------------------------------------------- git side */

  private async refreshGit(): Promise<void> {
    const results = await mapWithLimit(this.projects, POLL_CONCURRENCY, async (project) => ({
      id: project.id,
      state: await readGitState(project.path),
    }));
    for (const { id, state } of results) {
      this.git.set(id, state);
    }
    this.emit();
    // After the rows, never before: the tabs woken by this signal read git themselves, and the row
    // they are about should already be on screen when they start.
    this.onGitPolled();
  }

  /* --------------------------------------------------------- workflows side */

  private async refreshWorkflows(): Promise<void> {
    const results = await mapWithLimit(this.projects, POLL_CONCURRENCY, async (project) => ({
      id: project.id,
      state: await readWorkflowsState(await this.slugOf(project)),
    }));
    for (const { id, state } of results) {
      this.workflows.set(id, state);
    }
    this.emit();
  }

  /**
   * The repository's `owner/name`, resolved once.
   *
   * `PullMonitor` caches the same thing for its own projects, and the two caches are deliberately not
   * shared: both monitors are rebuilt from scratch when the project list changes, so a cache outliving
   * either of them would be the only thing in the app still holding a stale project.
   */
  private async slugOf(project: Project): Promise<string | null> {
    const known = this.slugs.get(project.id);
    if (known !== undefined) {
      return known;
    }
    const slug = await readRemoteSlug(project.path);
    this.slugs.set(project.id, slug);
    return slug;
  }

  private emit(): void {
    this.onChange(this.rows());
  }
}

/** Field-by-field identity of two server states, all of whose fields are primitives. */
function sameServerState(a: ServerState, b: ServerState): boolean {
  return (
    a.phase === b.phase &&
    a.pid === b.pid &&
    a.port === b.port &&
    a.errorSummary === b.errorSummary &&
    a.errorCount === b.errorCount &&
    a.owned === b.owned
  );
}
