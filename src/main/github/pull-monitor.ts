import type { AppSettings, Project, ProjectId, RepoPulls } from '@shared/contracts.js';
import { POLL_CONCURRENCY, mapWithLimit } from '../concurrency.js';
import { readRemoteSlug } from '../git/git-service.js';
import { readRepoPulls } from './pulls-service.js';
import { readViewerLogin } from './viewer.js';

/**
 * Keeps the pull requests of the watched repositories.
 *
 * A loop of its own rather than another job inside `ProjectMonitor`: the cadence is minutes instead of
 * seconds, the failure mode is a network one, and that class is already the busiest in the app. It is
 * rebuilt whenever the project list changes, for the same reason the project monitor is: it keys its
 * state by project.
 */
export class PullMonitor {
  private readonly pulls = new Map<ProjectId, RepoPulls>();
  /** Resolved once per project: a remote does not move while the app runs. */
  private readonly slugs = new Map<ProjectId, string | null>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private projects: readonly Project[],
    private readonly settings: () => AppSettings,
    private readonly onChange: (repos: RepoPulls[]) => void,
  ) {}

  /**
   * Adopts the same projects in another order, keeping the pulls and the resolved remotes.
   *
   * The counterpart of `ProjectMonitor.reorder`, and it earns its place for the same reason plus one:
   * this monitor polls every 180 s by default, so a rebuild would blank the Pull requests tab for up to
   * three minutes and spend a `gh` call per repository to learn what it already knew. Reordering a
   * table is not a reason to go back to the network.
   */
  reorder(next: readonly Project[]): void {
    this.projects = next;
    this.onChange(this.rows());
  }

  /** Watched repositories, in project order, so the list does not dance between refreshes. */
  rows(): RepoPulls[] {
    return this.projects
      .filter((project) => this.followed(project.id))
      .map((project) => this.pulls.get(project.id) ?? idle(project));
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.settings().pullsPollSeconds * 1000);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Forces a refresh, for the manual button. */
  async refreshNow(): Promise<RepoPulls[]> {
    await this.refresh();
    return this.rows();
  }

  private followed(projectId: ProjectId): boolean {
    const config = this.settings().projects.find((entry) => entry.id === projectId);
    return config?.followPulls !== false;
  }

  private async refresh(): Promise<void> {
    const login = await readViewerLogin();
    const targets = this.projects.filter((project) => this.followed(project.id));

    // Pooled: one `gh pr list` per followed repository, and `gh` costs 79 ms of pure process creation
    // on a machine with endpoint protection, blocking the event loop each time. See
    // `main/concurrency.ts` for the measurements.
    await mapWithLimit(targets, POLL_CONCURRENCY, async (project) => {
      const slug = await this.slugOf(project);
      if (slug === null) {
        // Not a GitHub remote: recorded as such so the row can say why it is empty rather than look
        // like a failed lookup.
        this.pulls.set(project.id, { ...idle(project), checkedAt: new Date().toISOString() });
        return;
      }
      const { pulls, error } = await readRepoPulls(slug, login);
      this.pulls.set(project.id, {
        projectId: project.id,
        label: project.label,
        slug,
        pulls,
        checkedAt: new Date().toISOString(),
        error,
      });
    });

    this.onChange(this.rows());
  }

  private async slugOf(project: Project): Promise<string | null> {
    const known = this.slugs.get(project.id);
    if (known !== undefined) {
      return known;
    }
    const slug = await readRemoteSlug(project.path);
    this.slugs.set(project.id, slug);
    return slug;
  }
}

/** A repository the monitor has not read yet, or one with nothing to read. */
function idle(project: Project): RepoPulls {
  return {
    projectId: project.id,
    label: project.label,
    slug: null,
    pulls: [],
    checkedAt: null,
    error: null,
  };
}
