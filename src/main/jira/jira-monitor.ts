import type { AppSettings, JiraState, JiraView } from '@shared/contracts.js';
import type { SecretStore } from '../store/secret-store.js';
import { buildJql, searchIssues } from './jira-service.js';

/**
 * Keeps the two Jira views.
 *
 * Its own loop again, and the slowest of the three: two JQL searches over the network per pass, against a
 * service that owes us nothing. Nothing is polled at all until a site, an email and a token are all
 * configured, so an unconfigured install makes no requests.
 */
export class JiraMonitor {
  private views: JiraView[] = [
    { id: 'sprint', label: 'Sprint courant', issues: [], checkedAt: null, error: null },
    { id: 'mine', label: 'My issues', issues: [], checkedAt: null, error: null },
  ];

  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly settings: () => AppSettings,
    private readonly secrets: SecretStore,
    private readonly onChange: (state: JiraState) => void,
  ) {}

  state(): JiraState {
    return { configured: this.configured(), views: this.views.map((view) => ({ ...view })) };
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.settings().jiraPollSeconds * 1000);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async refreshNow(): Promise<JiraState> {
    await this.refresh();
    return this.state();
  }

  private configured(): boolean {
    const { siteUrl, email } = this.settings().jira;
    return siteUrl.trim().length > 0 && email.trim().length > 0;
  }

  private async refresh(): Promise<void> {
    if (!this.configured()) {
      return;
    }
    const token = await this.secrets.read();
    if (token.length === 0) {
      this.views = this.views.map((view) => ({
        ...view,
        error: 'No Jira token saved',
      }));
      this.onChange(this.state());
      return;
    }

    const { siteUrl, email, projectKeys } = this.settings().jira;
    const credentials = { siteUrl, email, token };
    const jql = buildJql(projectKeys);
    const at = new Date().toISOString();

    const [sprint, mine] = await Promise.all([
      searchIssues(credentials, jql.sprint, email),
      searchIssues(credentials, jql.mine, email),
    ]);

    this.views = [
      { id: 'sprint', label: 'Sprint courant', issues: sprint.issues, checkedAt: at, error: sprint.error },
      { id: 'mine', label: 'My issues', issues: mine.issues, checkedAt: at, error: mine.error },
    ];
    this.onChange(this.state());
  }
}
