import type {
  AppSettings,
  Sprint,
  TriagedTicket,
  TriageMode,
  TriageProgress,
  TriageResult,
  TriageState,
} from '@shared/contracts.js';
import {
  listSprints,
  readSprintIssues,
  searchIssues,
  type JiraCredentials,
} from '../jira/jira-service.js';
import type { SecretStore } from '../store/secret-store.js';
import { runAgent } from '../agent/run-agent.js';
import { parseTriage } from './triage-parse.js';
import { readProgress } from '../agent/agent-progress.js';
import { buildTriagePrompt, trimDescription } from './triage-prompt.js';
import { selectIssues } from './triage-select.js';
import { TriageStore } from './triage-store.js';

/**
 * The Triage tab's whole behaviour: list the sprints, analyse one on request, remember the answer.
 *
 * A service and not a monitor, for the reason the Git tab has none either: nothing here changes on
 * its own. Sprints move once a fortnight, and an analysis only ever happens because someone asked
 * for it. Reading is pulled when the tab is shown, and pushed only around a run.
 */
/**
 * How many ticket keys one live-field query may carry.
 *
 * They end up in a JQL string inside a URL, and a request refused for length fails with a message
 * about the request rather than about triage. Generous next to a fortnight of analyses, and bounded.
 */
const LIVE_REFRESH_KEY_CAP = 200;

export class TriageService {
  private readonly store = new TriageStore();
  private sprints: Sprint[] = [];
  private running: number | null = null;
  private progress: TriageProgress | null = null;
  private error: string | null = null;

  constructor(
    private readonly settings: () => AppSettings,
    private readonly secrets: SecretStore,
    private readonly onChange: (state: TriageState) => void,
  ) {}

  async load(): Promise<void> {
    await this.store.load();
  }

  state(): TriageState {
    return {
      sprints: this.sprints.map((sprint) => ({ ...sprint })),
      results: this.store.snapshot(),
      running: this.running,
      progress: this.progress === null ? null : { ...this.progress },
      error: this.error,
    };
  }

  /**
   * The estimate the last analysis put on a ticket, or `null`.
   *
   * Read off disk rather than passed through the handoff channel, which carries keys and nothing else.
   * That is the same reasoning the channel was designed with: a verdict copied into a shell argument
   * would be stale from the moment it was made, and the whole point of storing the analysis is that any
   * part of the app can go and get the current one.
   */
  estimateFor(key: string): number | null {
    return this.store.findTicket(key)?.estimate ?? null;
  }

  /**
   * Drops one ticket from a stored analysis.
   *
   * A local edit of the tab's own list: the ticket is not touched in Jira, and the next run on that
   * sprint puts the row back. It is the answer to the one thing a verdict cannot say, "this one is
   * dealt with", which no amount of re-reading a description will ever produce.
   *
   * Allowed **while a run is going**, unlike `analyse`: the run holds its own copy of the result and
   * writes it whole at the end, so the worst case is a dismissed row coming back with the new
   * analysis, which is exactly what a new analysis is for.
   */
  async dismiss(sprintId: number, key: string): Promise<TriageState> {
    if (this.store.remove(sprintId, key)) {
      await this.store.write();
    }
    return this.push();
  }

  /**
   * The sprint list, fetched once if nothing has been read yet.
   *
   * The fallback fetch is the load-bearing half. Every path that reaches here today comes from the
   * Triage tab, which lists the sprints when it is shown, so the cache is normally warm; but a handoff
   * that silently skipped the sprint move because no list had been fetched would look exactly like a
   * board with no active sprint, and nothing in the message could tell those two apart.
   *
   * Returns the list rather than the active sprint: which one counts as current is decided by
   * `pickActiveSprint`, one pure function, and a second answer to that question living here is how the
   * two would drift.
   */
  async sprintList(): Promise<readonly Sprint[]> {
    if (this.sprints.length === 0) {
      await this.refresh();
    }
    return this.sprints;
  }

  /**
   * Re-reads the sprint list, and the live fields of the tickets already analysed.
   *
   * The **verdicts** are untouched and outlive any refresh: they are what a long, paid run concluded,
   * and nothing but another run may replace them. The **status** and the **assignee** are the opposite
   * kind of fact, and they used to be frozen with the rest: a ticket analysed as `Ready` still read
   * `Ready` after `Work on this` had moved it to in progress, and still read `Ready` once it was done.
   * The one column that has to be current was the only one that never changed.
   *
   * One extra search per refresh, and this is a **pulled** service with no poll behind it: the tab asks
   * when it is shown. A failure there is deliberately not surfaced as the tab's error either, since the
   * sprint list is what the tab is for and stale statuses are worth less than a red banner over a
   * perfectly usable analysis.
   */
  async refresh(): Promise<TriageState> {
    const credentials = await this.credentials();
    if (credentials === null) {
      this.sprints = [];
      this.error = 'Jira is not configured';
      return this.push();
    }

    const { sprints, error } = await listSprints(credentials, this.settings().jira.projectKeys);
    this.sprints = sprints;
    this.error = error;
    await this.refreshLiveFields(credentials);
    return this.push();
  }

  /**
   * Re-reads `status` and `assignee` for every ticket held on disk.
   *
   * Queried by key rather than by sprint, because a stored analysis outlives the sprint it was made in:
   * tickets get carried over, and a query scoped to open sprints would silently stop refreshing exactly
   * the tickets that moved on, which is the case this exists for.
   *
   * Capped, because the keys go into a JQL string and that string goes into a URL. The cap is stated in
   * the code rather than left to the server's own limit, whose failure mode is a request refused for a
   * reason that has nothing to do with triage. Beyond it the newest analyses win, being the ones the
   * tab is showing.
   */
  private async refreshLiveFields(credentials: JiraCredentials): Promise<void> {
    const keys = this.store.keys().slice(0, LIVE_REFRESH_KEY_CAP);
    if (keys.length === 0) {
      return;
    }
    const jql = `key in (${keys.map((key) => `"${key}"`).join(', ')})`;
    const { issues, error: searchError } = await searchIssues(credentials, jql, credentials.email);
    if (searchError !== null) {
      // Swallowed on purpose: see `refresh`. The analysis on screen stays usable with a stale status,
      // which is strictly better than replacing it with an error about a query nobody asked for.
      return;
    }
    const live = new Map(
      issues.map((issue) => [
        issue.key.toUpperCase(),
        { status: issue.status, assignee: issue.assignee },
      ]),
    );
    if (this.store.applyLiveFields(live)) {
      await this.store.write();
    }
  }

  /**
   * Analyses one sprint and stores the verdicts.
   *
   * The previous result is deliberately left in place for the whole run and replaced only when a
   * new one is complete: that is what makes the tab readable while it works, and what stops a
   * failure from erasing an answer that was still useful. A failed run therefore keeps the old
   * tickets and only carries the new error.
   *
   * The mode comes from the click rather than from the settings, for the reason the sprint id does:
   * it decides what the run is given, so the button pressed and the run started have to agree by
   * construction. It is not stored with the result, unlike the scope it might be mistaken for: what a
   * reader needs afterwards is what the run left out, and that is in `skipped`, counted rather than
   * inferred from a mode.
   */
  async analyse(sprintId: number, mode: TriageMode): Promise<TriageState> {
    if (this.running !== null) {
      // One at a time: the run is long and costs tokens, and two would race on the same file.
      return this.state();
    }
    const sprint = this.sprints.find((candidate) => candidate.id === sprintId);
    if (sprint === undefined) {
      this.error = 'That sprint is no longer in the list';
      return this.push();
    }

    this.running = sprintId;
    this.error = null;
    this.progress = {
      sprintId,
      phase: 'fetching',
      detail: 'Reading the sprint from Jira',
      steps: 0,
      startedAt: new Date().toISOString(),
      tickets: 0,
    };
    this.push();

    try {
      const result = await this.run(sprint, mode);
      await this.store.save(result);
    } catch (failure) {
      this.error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      this.running = null;
      this.progress = null;
    }
    return this.push();
  }

  private async run(sprint: Sprint, mode: TriageMode): Promise<TriageResult> {
    const previous = this.store.get(sprint.id);
    const keep = (error: string): TriageResult => ({
      sprintId: sprint.id,
      sprintName: sprint.name,
      analysedAt: previous?.analysedAt ?? '',
      tickets: previous?.tickets ?? [],
      error,
      // The counts of the answer being **kept**, not of the run that just failed: they describe the
      // tickets on screen, and those are the previous ones.
      skipped: previous?.skipped ?? { inProgress: 0, alreadyAnalysed: 0 },
    });

    const credentials = await this.credentials();
    if (credentials === null) {
      return keep('Jira is not configured');
    }

    const { issues, error } = await readSprintIssues(credentials, sprint.id);
    if (error !== null) {
      return keep(error);
    }

    const { analysed, skipped } = selectIssues(
      issues,
      mode === 'new' ? this.store.analysedKeys(sprint.id) : new Set<string>(),
    );

    /*
     * What an incremental run keeps from the previous answer.
     *
     * Empty for a full run, which replaces the stored result outright. For an incremental one it is
     * every row whose ticket is **still in the sprint**, which is the one subtraction this mode makes:
     * a ticket carried over to the next sprint would otherwise sit in this sprint's list for good,
     * since only a full run ever drops a row, and the two modes would end up disagreeing about what
     * the sprint contains. A row that is now in progress is kept, unlike in a full run: this mode adds
     * verdicts and does not delete them, and the live-field refresh is already what keeps its status
     * true.
     */
    const inSprint = new Set(issues.map((issue) => issue.key.toUpperCase()));
    const carried =
      mode === 'new'
        ? (previous?.tickets ?? []).filter((ticket) => inSprint.has(ticket.key.toUpperCase()))
        : [];

    /*
     * `at` is passed rather than taken here, and that is not a detail.
     *
     * The verdicts this run produces are stamped with it too, and `describeTicketAge` stays silent on
     * a row whose stamp **equals** the result's, which is how a full run avoids dating every one of
     * its own rows in the overview. Two calls to `now()` a few milliseconds apart would break that
     * equality and put a redundant "analysed just now" under every ticket of every run.
     */
    const settle = (
      tickets: readonly TriagedTicket[],
      error: string | null,
      at: string,
    ): TriageResult => ({
      sprintId: sprint.id,
      sprintName: sprint.name,
      // When the sprint was last **read**, which after a merge is not when every verdict in it was
      // made. That is why each ticket carries its own stamp, and why the coverage line states how
      // many of these rows an earlier run produced.
      analysedAt: at,
      tickets,
      error,
      skipped,
    });

    if (analysed.length === 0) {
      // A real answer, not a failure: the sprint was read and everything in it was skipped, either
      // because it is in progress or because it was analysed before. The counts are what stop that
      // from reading as an empty sprint, and they travel with the result.
      return settle(carried, null, now());
    }

    this.advance({ phase: 'starting', detail: `Starting ${this.settings().agentProfile.label}`, tickets: analysed.length });

    /*
     * Trimmed once, then used for both the prompt and the stored ticket.
     *
     * The overview shows exactly the text the analysis was given, never more: a column showing a
     * full description beside a verdict drawn from an extract would invite blaming the verdict for
     * something the model never read.
     */
    const asked = analysed.map((issue) => ({ ...issue, description: trimDescription(issue.description) }));

    const answer = await runAgent({
      profile: this.settings().agentProfile,
      cwd: this.settings().projectsRoot,
      prompt: buildTriagePrompt(sprint.name, asked),
      model: this.settings().agentAnalysisModel,
      label: 'The analysis',
      onEvent: (event) => {
        const step = readProgress(event);
        if (step === null || step.phase === 'done') {
          return;
        }
        this.advance({ phase: step.phase, detail: step.detail, counts: step.counts });
      },
    });
    if (!answer.ok) {
      return keep(answer.error ?? 'The analysis failed');
    }

    /*
     * The new verdicts go **after** the carried ones.
     *
     * List order is what the sub-tabs and the batch button read, so it decides what gets worked first.
     * Freshly analysed last rather than first on purpose: an incremental run is a top-up, and pushing
     * three new tickets above nine that were waiting would reorder a worklist the reader has already
     * been through, which is the kind of quiet reshuffle that costs a re-read every morning.
     */
    const at = now();
    const tickets = [...carried, ...parseTriage({ answer: answer.answer, asked, analysedAt: at })];
    return settle(tickets, null, at);
  }

  /**
   * Moves the progress along and pushes it.
   *
   * Every event is broadcast rather than sampled on a timer: they arrive a few seconds apart at
   * most, so the cost is nothing, and a status line that lags behind the work is worse than none.
   */
  private advance(step: {
    phase: TriageProgress['phase'];
    detail: string;
    counts?: boolean;
    tickets?: number;
  }): void {
    if (this.progress === null) {
      return;
    }
    this.progress = {
      ...this.progress,
      phase: step.phase,
      // An empty detail keeps whatever was showing: an event that says nothing new must not blank
      // the one line the user is reading.
      detail: step.detail.length > 0 ? step.detail : this.progress.detail,
      steps: this.progress.steps + (step.counts === true ? 1 : 0),
      tickets: step.tickets ?? this.progress.tickets,
    };
    this.push();
  }

  private async credentials(): Promise<{ siteUrl: string; email: string; token: string } | null> {
    const { siteUrl, email } = this.settings().jira;
    if (siteUrl.length === 0 || email.length === 0) {
      return null;
    }
    const token = await this.secrets.read();
    return token.length === 0 ? null : { siteUrl, email, token };
  }

  private push(): TriageState {
    const state = this.state();
    this.onChange(state);
    return state;
  }
}

function now(): string {
  return new Date().toISOString();
}
