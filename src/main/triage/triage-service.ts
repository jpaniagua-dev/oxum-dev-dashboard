import type {
  AppSettings,
  Sprint,
  TriageProgress,
  TriageResult,
  TriageState,
} from '@shared/contracts.js';
import { listSprints, readSprintIssues } from '../jira/jira-service.js';
import type { SecretStore } from '../store/secret-store.js';
import { runClaude } from './run-claude.js';
import { parseTriage } from './triage-parse.js';
import { readProgress } from './triage-progress.js';
import { buildTriagePrompt, trimDescription } from './triage-prompt.js';
import { TriageStore } from './triage-store.js';

/**
 * The Triage tab's whole behaviour: list the sprints, analyse one on request, remember the answer.
 *
 * A service and not a monitor, for the reason the Git tab has none either: nothing here changes on
 * its own. Sprints move once a fortnight, and an analysis only ever happens because someone asked
 * for it. Reading is pulled when the tab is shown, and pushed only around a run.
 */
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

  /** Re-reads the sprint list. The stored results are untouched: they outlive any refresh. */
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
    return this.push();
  }

  /**
   * Analyses one sprint and stores the verdicts.
   *
   * The previous result is deliberately left in place for the whole run and replaced only when a
   * new one is complete: that is what makes the tab readable while it works, and what stops a
   * failure from erasing an answer that was still useful. A failed run therefore keeps the old
   * tickets and only carries the new error.
   */
  async analyse(sprintId: number): Promise<TriageState> {
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
      const result = await this.run(sprint);
      await this.store.save(result);
    } catch (failure) {
      this.error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      this.running = null;
      this.progress = null;
    }
    return this.push();
  }

  private async run(sprint: Sprint): Promise<TriageResult> {
    const previous = this.store.get(sprint.id);
    const keep = (error: string): TriageResult => ({
      sprintId: sprint.id,
      sprintName: sprint.name,
      analysedAt: previous?.analysedAt ?? '',
      tickets: previous?.tickets ?? [],
      error,
    });

    const credentials = await this.credentials();
    if (credentials === null) {
      return keep('Jira is not configured');
    }

    const { issues, error } = await readSprintIssues(credentials, sprint.id);
    if (error !== null) {
      return keep(error);
    }
    if (issues.length === 0) {
      return { sprintId: sprint.id, sprintName: sprint.name, analysedAt: now(), tickets: [], error: null };
    }

    this.advance({ phase: 'starting', detail: 'Starting Claude Code', tickets: issues.length });

    /*
     * Trimmed once, then used for both the prompt and the stored ticket.
     *
     * The overview shows exactly the text the analysis was given, never more: a column showing a
     * full description beside a verdict drawn from an extract would invite blaming the verdict for
     * something the model never read.
     */
    const asked = issues.map((issue) => ({ ...issue, description: trimDescription(issue.description) }));

    const answer = await runClaude({
      cwd: this.settings().projectsRoot,
      prompt: buildTriagePrompt(sprint.name, asked),
      model: this.settings().claudeAnalysisModel,
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

    const tickets = parseTriage({ answer: answer.answer, asked });
    return { sprintId: sprint.id, sprintName: sprint.name, analysedAt: now(), tickets, error: null };
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
