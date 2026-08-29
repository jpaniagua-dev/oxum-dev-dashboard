import type {
  AppSettings,
  ChecksState,
  GitState,
  Project,
  ProjectId,
  ProjectRow,
  ServerState,
  WorkflowsState,
} from '@shared/contracts.js';
import { readGitState, readRemoteSlug } from '../git/git-service.js';
import { readChecksState } from '../github/checks-service.js';
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
    lastSuccessAt: null,
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
  private readonly checks = new Map<ProjectId, ChecksState>();
  private readonly workflows = new Map<ProjectId, WorkflowsState>();
  /** Resolved once per project: a remote does not move while the app runs. */
  private readonly slugs = new Map<ProjectId, string | null>();
  private gitTimer: NodeJS.Timeout | null = null;
  private checksTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly projects: readonly Project[],
    private readonly settings: () => AppSettings,
    private readonly onChange: (rows: ProjectRow[]) => void,
  ) {
    for (const project of projects) {
      this.servers.set(project.id, idleServer());
    }
  }

  rows(): ProjectRow[] {
    return this.projects.map((project) => ({
      project,
      server: this.servers.get(project.id) ?? idleServer(),
      git: this.git.get(project.id) ?? null,
      checks: this.checks.get(project.id) ?? null,
      workflows: this.workflows.get(project.id) ?? null,
    }));
  }

  /** Starts the polling loops and performs a first refresh immediately. */
  start(): void {
    void this.refreshGit();
    void this.refreshChecks();
    void this.refreshWorkflows();

    this.gitTimer = setInterval(() => {
      void this.refreshGit();
    }, this.settings().gitPollSeconds * 1000);

    // Workflow runs ride the checks cadence rather than getting a timer of their own: same cost class
    // (one `gh` call per project, over the network) and same thing being watched, so a second setting
    // would only offer a way to make the two GitHub columns disagree about how stale they are.
    this.checksTimer = setInterval(() => {
      void this.refreshChecks();
      void this.refreshWorkflows();
    }, this.settings().checksPollSeconds * 1000);
  }

  stop(): void {
    if (this.gitTimer !== null) {
      clearInterval(this.gitTimer);
      this.gitTimer = null;
    }
    if (this.checksTimer !== null) {
      clearInterval(this.checksTimer);
      this.checksTimer = null;
    }
  }

  /** Forces a full refresh, for the manual refresh button. */
  async refreshAll(): Promise<ProjectRow[]> {
    await Promise.all([this.refreshGit(), this.refreshChecks(), this.refreshWorkflows()]);
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
    // A successful build clears any previous error and stamps the success time, so a row does not
    // stay red after the user fixed the problem.
    if (parsed.phase === 'serving' || parsed.phase === 'watching') {
      patch.errorSummary = null;
      patch.errorCount = 0;
      patch.lastSuccessAt = new Date().toISOString();
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

  private patchServer(projectId: ProjectId, patch: ServerPatch): void {
    const current = this.servers.get(projectId) ?? idleServer();
    this.servers.set(projectId, { ...current, ...patch });
    this.emit();
  }

  /* --------------------------------------------------------------- git side */

  private async refreshGit(): Promise<void> {
    const results = await Promise.all(
      this.projects.map(async (project) => ({
        id: project.id,
        state: await readGitState(project.path),
      })),
    );
    for (const { id, state } of results) {
      this.git.set(id, state);
    }
    this.emit();
  }

  /* ------------------------------------------------------------ checks side */

  private async refreshChecks(): Promise<void> {
    const results = await Promise.all(
      this.projects.map(async (project) => {
        // The git state decides whether a lookup is worth making at all: a branch with no upstream
        // cannot have a pull request.
        const git = this.git.get(project.id);
        const hasUpstream = git?.hasUpstream ?? false;
        return { id: project.id, state: await readChecksState(project.path, hasUpstream) };
      }),
    );
    for (const { id, state } of results) {
      this.checks.set(id, state);
    }
    this.emit();
  }

  /* --------------------------------------------------------- workflows side */

  private async refreshWorkflows(): Promise<void> {
    const results = await Promise.all(
      this.projects.map(async (project) => ({
        id: project.id,
        state: await readWorkflowsState(await this.slugOf(project)),
      })),
    );
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
