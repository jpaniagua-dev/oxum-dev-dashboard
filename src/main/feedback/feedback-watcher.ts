import { basename } from 'node:path';
import type {
  AppSettings,
  AutoRunRecord,
  Project,
  PullRequest,
  RepoPulls,
  TerminalId,
} from '@shared/contracts.js';
import { feedbackActionId, workActionId } from '@shared/contracts.js';
import type { ReviewComment } from '../github/review-comments.js';
import type { AutoRunRecords } from '../autorun/auto-run-store.js';
import { resolveWorkspaceRoot } from '../triage/work-command.js';
import { buildFeedbackCommand } from './feedback-command.js';
import { advanceRun, looksGone, matchRunPull, pullsFor } from './feedback-rules.js';

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
  /** Confirms what became of a pull request the open list no longer carries. */
  readonly readState: (slug: string, number: number) => Promise<string | null>;
  /** Moves the ticket to whatever the workflow calls done. Best effort, never blocking. */
  readonly closeTicket: (ticketKey: string) => Promise<{ ok: boolean; message: string }>;
  /** Stops a dev server this app started. `false` when there was none to stop. */
  readonly stopServer: (projectId: string) => boolean;
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
  async tick(repos: readonly RepoPulls[]): Promise<void> {
    if (this.busy || this.store.all().length === 0) {
      return;
    }
    this.busy = true;
    try {
      await this.run(repos);
    } catch {
      // Swallowed on purpose, the rule `refreshLiveFields` already follows: this rides another
      // feature's poll, and a throw here would take the pull request list down with it.
    } finally {
      this.busy = false;
    }
  }

  private async run(repos: readonly RepoPulls[]): Promise<void> {
    const viewerLogin = await this.ports.viewerLogin();
    let dirty = false;

    for (const stored of this.store.all()) {
      const pulls = pullsFor(stored, repos);
      const record = this.join(stored, pulls, viewerLogin);
      if (record !== stored) {
        this.store.set(record);
        dirty = true;
      }

      if (looksGone(record, repos)) {
        dirty = (await this.close(record)) || dirty;
        continue;
      }

      const pull = pulls.find((entry) => entry.number === record.prNumber);
      if (record.prNumber === null || pull === undefined || record.mergedAt !== null) {
        // Not opened yet, its repository's poll did not land, or the record is already retired.
        continue;
      }
      dirty = (await this.consider(record, pull, viewerLogin)) || dirty;
    }

    if (dirty) {
      await this.store.write();
    }
  }

  /**
   * Finishes a ticket whose pull request has left the open list.
   *
   * The poll cannot tell a merge from a close, and the difference decides whether a ticket is marked
   * done on a board the whole team reads, so GitHub is asked once before anything is written anywhere.
   * A read that fails changes nothing and is simply retried at the next poll: the cost of waiting three
   * minutes is nothing next to closing a ticket somebody abandoned on purpose.
   *
   * The order is the one the `finish` skill already records, and it is not arrangement: **the server is
   * stopped before the worktree is anybody's business**, because a running dev server holds file locks
   * that make `git worktree remove` fail on Windows.
   *
   * The worktree itself is deliberately left alone. It is the one irreversible act in this chain, a
   * directory that can still hold uncommitted work, and the Worktrees tab already owns that gesture and
   * already shows whether the checkout is clean. A second judgement about it here would be a second
   * answer to "is this safe to delete", free to disagree with the one on screen.
   */
  private async close(record: AutoRunRecord): Promise<boolean> {
    const state = await this.ports.readState(record.slug, record.prNumber ?? 0);
    if (state === null) {
      return false;
    }
    if (state !== 'MERGED') {
      this.store.set({
        ...record,
        mergedAt: this.ports.now().toISOString(),
        notice: `Pull request ${state.toLowerCase()}, nothing was changed on the board`,
      });
      return true;
    }

    const jira = await this.ports.closeTicket(record.ticketKey);
    const stopped = this.ports.stopServer(record.projectId);
    const worktree = record.branch.length > 0 ? `, worktree ${record.branch} left to remove` : '';
    this.store.set({
      ...record,
      mergedAt: this.ports.now().toISOString(),
      notice: `Merged: ${jira.message}${stopped ? ', server stopped' : ''}${worktree}`,
    });
    return true;
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
