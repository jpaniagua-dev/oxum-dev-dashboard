import type { AppSettings, Project, ProjectId, RepoPulls } from '@shared/contracts.js';
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
    private readonly projects: readonly Project[],
    private readonly settings: () => AppSettings,
    private readonly onChange: (repos: RepoPulls[]) => void,
  ) {}

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

    await Promise.all(
      targets.map(async (project) => {
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
      }),
    );

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
