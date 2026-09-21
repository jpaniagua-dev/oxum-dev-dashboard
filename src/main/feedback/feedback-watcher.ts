import { basename } from 'node:path';
import type { AppSettings, AutoRunRecord, Project, PullRequest, TerminalId } from '@shared/contracts.js';
import { feedbackActionId, workActionId } from '@shared/contracts.js';
import type { ReviewComment } from '../github/review-comments.js';
import type { AutoRunRecords } from '../autorun/auto-run-store.js';
import { resolveWorkspaceRoot } from '../triage/work-command.js';
import { buildFeedbackCommand } from './feedback-command.js';
import { advanceRun, matchRunPull } from './feedback-rules.js';

/**
 * Watches the pull requests unattended runs opened, and hands one to an agent when feedback lands.
 *
 * **No timer of its own.** It rides `PullMonitor`'s `onChange`, and the reason is not thrift: the poll
 * payload is the authority on whether a pull request is still open, so a pull request that has left it
 * must stop being watched. A second timer would be free to disagree with the state it depends on.
 *
 * Its dependencies are injected, for the reason `ReviewPorts` gives and one notch harder: a test that
 * cannot assert "this tick launched nothing" is not a test of this feature.
 */

export interface FeedbackPorts {
  readonly readComments: (
    slug: string,
    number: number,
  ) => Promise<{ value: ReviewComment[] | null; error: string | null }>;
  readonly viewerLogin: () => Promise<string>;
  /** Whether a tab of that action is open and its process alive. */
  readonly isActionRunning: (projectId: string, actionId: string) => boolean;
  readonly spawn: (input: {
    project: Project;
    actionId: string;
    title: string;
    command: string;
    cwd: string;
    onExit: () => void;
  }) => TerminalId | null;
  readonly now: () => Date;
}

export class FeedbackWatcher {
  /**
   * One tick at a time.
   *
   * A plain flag rather than `singleFlight`, whose trailing re-run would start a second agent on the
   * same pull request: the same reason `PullReviewService` keeps a bare `running` boolean.
   */
  private busy = false;

  constructor(
    private readonly store: AutoRunRecords,
    private readonly settings: () => AppSettings,
    private readonly projects: () => readonly Project[],
    private readonly ports: FeedbackPorts,
  ) {}

  /** Called on every pull request poll. Never throws: a watcher that can break the poll is worse than none. */
  async tick(pulls: readonly PullRequest[]): Promise<void> {
    if (this.busy || this.store.all().length === 0) {
      return;
    }
    this.busy = true;
    try {
      await this.run(pulls);
    } catch {
      // Swallowed on purpose, the rule `refreshLiveFields` already follows: this rides another
      // feature's poll, and a throw here would take the pull request list down with it.
    } finally {
      this.busy = false;
    }
  }

  private async run(pulls: readonly PullRequest[]): Promise<void> {
    const viewerLogin = await this.ports.viewerLogin();
    let dirty = false;

    for (const stored of this.store.all()) {
      const record = this.join(stored, pulls, viewerLogin);
      if (record !== stored) {
        this.store.set(record);
        dirty = true;
      }
      const pull = pulls.find((entry) => entry.number === record.prNumber);
      if (record.prNumber === null || pull === undefined) {
        // Not opened yet, or gone from the open list, which means merged or closed and is the merge
        // watcher's business rather than this one's.
        continue;
      }
      dirty = (await this.consider(record, pull, viewerLogin)) || dirty;
    }

    if (dirty) {
      await this.store.write();
    }
  }

  /** Fills in the pull request number the first time the poll shows it, and never overwrites one. */
  private join(record: AutoRunRecord, pulls: readonly PullRequest[], viewerLogin: string): AutoRunRecord {
    if (record.prNumber !== null) {
      return record;
    }
    const found = matchRunPull(record, pulls, viewerLogin);
    if (found === null) {
      return record;
    }
    // The branch is learned here rather than guessed at handoff time: the skill names it, and this is
    // the first moment anything on this side can read what it chose.
    return {
      ...record,
      prNumber: found.number,
      branch: found.branch,
      prMatchedAt: this.ports.now().toISOString(),
    };
  }

  private async consider(
    record: AutoRunRecord,
    pull: PullRequest,
    viewerLogin: string,
  ): Promise<boolean> {
    const project = this.projects().find((entry) => entry.id === record.projectId);
    const { value: comments } = await this.ports.readComments(record.slug, pull.number);
    if (comments === null) {
      // A failed read is not an empty pull request. Saying "no new feedback" here would advance
      // nothing but would write a refusal that is simply untrue.
      return false;
    }

    const advance = advanceRun(record, comments, viewerLogin, {
      featureEnabled: this.settings().feedbackPassEnabled,
      viewerLogin,
      projectKnown: project !== undefined,
      phase: record.feedbackPhase,
      // Always OPEN, and not a shortcut: `gh pr list --state open` is what produced this payload, so
      // a pull request that reached here is open by construction. The gate keeps the check anyway,
      // because the manual entry point resolves its pull request another way.
      state: 'OPEN',
      isDraft: pull.isDraft,
      originalRunActive: this.ports.isActionRunning(record.projectId, workActionId([record.ticketKey])),
    }, this.ports.now());

    if (advance === null) {
      return false;
    }
    this.store.set(advance.record);
    if (!advance.start || project === undefined) {
      return true;
    }

    /*
     * The record is written BEFORE the tab is spawned, and the write is awaited.
     *
     * Recording afterwards leaves a window in which the file still says `watching` while an agent is
     * running, and the next poll is three minutes away: two agents on one worktree, which the handoff's
     * own note already calls worse than being blocked.
     */
    await this.store.write();
    this.launch(advance.record, project, pull.number);
    return false;
  }

  private launch(record: AutoRunRecord, project: Project, number: number): void {
    const settings = this.settings();
    const command = buildFeedbackCommand(
      number,
      basename(project.path),
      settings.agentWorkModel,
      settings.agentProfile,
    );
    if (command.length === 0) {
      return;
    }
    const terminalId = this.ports.spawn({
      project,
      actionId: feedbackActionId(record.slug, number),
      title: `${project.label} · PR #${number} feedback`,
      command,
      cwd: resolveWorkspaceRoot(settings.workspaceRoot, project.path),
      onExit: () => void this.finish(record.ticketKey),
    });
    if (terminalId === null) {
      void this.finish(record.ticketKey, 'The feedback tab could not be opened');
    }
  }

  /**
   * Closes a pass when its tab ends.
   *
   * `passing` to `done` and never back to `watching`: the gate refuses on both, so loop safety never
   * depended on this arriving, and a pass whose tab was killed stays where it is. An interrupted pass
   * needs a human, which beats a resume that cannot know what the agent had already pushed.
   */
  private async finish(ticketKey: string, notice?: string): Promise<void> {
    const record = this.store.get(ticketKey);
    if (record === undefined || record.feedbackPhase !== 'passing') {
      return;
    }
    this.store.set({
      ...record,
      feedbackPhase: 'done',
      feedbackFinishedAt: this.ports.now().toISOString(),
      notice: notice ?? 'Feedback pass finished',
    });
    await this.store.write();
  }
}
