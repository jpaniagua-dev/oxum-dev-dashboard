import type {
  AppSettings,
  BotFinding,
  PullReview,
  PullReviewProgress,
  PullReviewState,
  PullReviewTarget,
  RepoPulls,
} from '@shared/contracts.js';
import type { AgentProfile } from '@shared/agent-profile.js';
import { reviewKey } from '@shared/pull-review.js';
import { PR_FILE_SOFT_LIMIT } from '@shared/pull-review.js';
import { readProgress } from '../agent/agent-progress.js';
import { buildReviewBody, readMarkerSha } from './review-body.js';
import { PER_PR_TIMEOUT_MS, RUN_TIMEOUT_MS } from './review-limits.js';
import { parseReview } from './review-parse.js';
import { buildReviewPrompt } from './review-prompt.js';
import { decideAction, decideManual, type GateInput, type ReviewEvent } from './review-gate.js';
import { selectPulls, type PullTarget } from './review-select.js';
import { PullReviewStore } from './review-store.js';
import type { ExistingReview, PullDetail } from '../github/gh-review-read.js';
import type { WriteOutcome } from '../github/gh-write.js';

/**
 * The Pull Requests tab's review agent: read a pull request, judge it, remember the verdict.
 *
 * A service and not a monitor, like the Triage tab's: nothing here happens on its own. A review is
 * minutes of model time and it can end in a write to somebody else's pull request, so it only ever
 * happens because somebody pressed a button.
 *
 * **Its dependencies are injected, unlike `TriageService`'s**, and that is deliberate rather than
 * fashion: this service can write to GitHub, and a test that cannot assert "this run posted nothing"
 * is not a test of this feature. The cost is a handful of constructor arguments; the benefit is that
 * every refusal in `review-gate.ts` can be exercised without a network.
 */

/** What the service needs from the outside world, so a test can hand it something inert. */
export interface ReviewPorts {
  readonly readDetail: (slug: string, number: number) => Promise<{ value: PullDetail | null; error: string | null }>;
  readonly readPatch: (
    slug: string,
    baseSha: string,
    headSha: string,
  ) => Promise<{ value: string | null; error: string | null }>;
  readonly readBotFindings: (
    slug: string,
    number: number,
    botLogin: string,
  ) => Promise<{ value: BotFinding[] | null; error: string | null }>;
  readonly readReviews: (
    slug: string,
    number: number,
  ) => Promise<{ value: ExistingReview[] | null; error: string | null }>;
  readonly patchPaths: (patch: string) => string[];
  readonly runAgent: (options: {
    profile: AgentProfile;
    cwd: string;
    prompt: string;
    model?: string;
    extraDirs?: readonly string[];
    timeoutMs?: number;
    label?: string;
    signal?: AbortSignal;
    onEvent?: (event: unknown) => void;
  }) => Promise<{ ok: boolean; answer: string; error: string | null }>;
  readonly viewerLogin: () => Promise<string>;
  /** Writes a body to disk and hands back its path. The body never travels as an argument. */
  readonly writeBody: (
    slug: string,
    number: number,
    headSha: string,
    body: string,
  ) => Promise<string>;
  readonly retract: (input: {
    slug: string;
    number: number;
    reviewId: number;
    reason: string;
    replacementPath: string | null;
  }) => Promise<WriteOutcome>;
  readonly submitReview: (input: {
    slug: string;
    number: number;
    headSha: string;
    event: ReviewEvent;
    bodyPath: string;
  }) => Promise<WriteOutcome>;
}

export class PullReviewService {
  private readonly store = new PullReviewStore();
  private running = false;
  private progress: PullReviewProgress | null = null;
  private error: string | null = null;
  private controller: AbortController | null = null;

  constructor(
    private readonly settings: () => AppSettings,
    private readonly pulls: () => readonly RepoPulls[],
    private readonly projectPath: (projectId: string) => string | null,
    private readonly ports: ReviewPorts,
    private readonly onChange: (state: PullReviewState) => void,
  ) {}

  async load(): Promise<void> {
    await this.store.load();
  }

  state(): PullReviewState {
    const snapshot = this.store.snapshot();
    return {
      reviews: snapshot.reviews,
      runs: snapshot.runs,
      running: this.running,
      progress: this.progress === null ? null : { ...this.progress },
      error: this.error,
      writesBlocked: this.writesBlocked,
    };
  }

  /**
   * Why nothing may be written right now, recomputed on every push.
   *
   * Held rather than asked for by the renderer, because a disabled button whose reason is not on
   * screen is a button that looks broken. The login half is filled in by the run, which is the only
   * moment this process talks to `gh` about identity.
   */
  private writesBlocked: string | null = 'Writing to GitHub is turned off in the settings';

  /** Drops one row. Local to the file: nothing already posted is unsaid by this. */
  async dismiss(slug: string, number: number): Promise<PullReviewState> {
    if (this.store.remove(slug, number)) {
      await this.store.write();
    }
    return this.push();
  }

  /** Stops the run at the next step it can stop at. Nothing half-written is left behind. */
  cancel(): PullReviewState {
    this.controller?.abort();
    return this.state();
  }

  /**
   * Reviews what the target names.
   *
   * One run at a time, like the triage analysis, and for one reason more than it has: these runs
   * share a single GitHub identity, so two of them could post twice about the same pull request.
   */
  async run(target: PullReviewTarget): Promise<PullReviewState> {
    if (this.running) {
      return this.state();
    }

    const login = await this.ports.viewerLogin();
    this.writesBlocked = login.length === 0 ? 'gh is not signed in' : null;

    const repos = this.pulls();
    const { selected, skipped, deferred } = selectPulls({
      repos,
      reviewed: this.store.reviewedHeads(),
      target,
      viewerLogin: login,
    });

    const slugs = [...new Set(selected.map((entry) => entry.slug))];
    const ranAt = now();
    if (selected.length === 0) {
      // A real answer and not a failure: the repositories were read and everything in them was
      // skipped. The counts are what stop that from reading as "nothing is open".
      for (const repo of repos) {
        if (repo.slug !== null && (target.projectId === null || repo.projectId === target.projectId)) {
          this.store.saveRun({ slug: repo.slug, ranAt, skipped, deferred, error: null });
        }
      }
      await this.store.write();
      return this.push();
    }

    this.running = true;
    this.error = null;
    this.controller = new AbortController();
    this.progress = {
      target,
      phase: 'reading',
      detail: `Reading ${selected.length} pull request(s)`,
      steps: 0,
      startedAt: ranAt,
      pulls: selected.length,
      done: 0,
    };
    this.push();

    const deadline = Date.now() + RUN_TIMEOUT_MS;
    try {
      for (const entry of selected) {
        if (this.controller.signal.aborted) {
          break;
        }
        if (Date.now() > deadline) {
          // The budget stops the run from STARTING another one; whatever is in flight finishes on
          // its own timeout, because killing mid-review spends the money and stores nothing.
          this.error = 'The run reached its time budget and stopped starting new reviews';
          break;
        }
        const review = await this.reviewOne(entry, login);
        this.store.save(review);
        this.advance({ done: (this.progress?.done ?? 0) + 1 });
        await this.store.write();
      }
      /*
       * Posting is its own phase, after every verdict is in.
       *
       * That is what gives the stop button a meaning worth having: stopping during the reviews posts
       * nothing at all, stopping during the posting stops before the next one. Posting each verdict
       * as it landed would leave a cancelled run having already spoken on somebody's pull request.
       */
      if (!this.controller.signal.aborted) {
        this.advance({ phase: 'posting', detail: 'Posting what is blocking' });
        for (const entry of selected) {
          if (this.controller.signal.aborted) {
            break;
          }
          await this.postOne(entry, login);
        }
      }
    } catch (failure) {
      this.error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      for (const slug of slugs) {
        this.store.saveRun({ slug, ranAt, skipped, deferred, error: this.error });
      }
      await this.store.write();
      this.running = false;
      this.progress = null;
      this.controller = null;
    }
    return this.push();
  }

  /**
   * One pull request, from its sha to its verdict.
   *
   * Every failure here is a **row**, never a throw: one unreadable pull request must not take the
   * other nine down with it, the same rule `readRepoPulls` follows by capturing its error into a
   * string.
   */
  private async reviewOne(entry: PullTarget, login: string): Promise<PullReview> {
    const { slug, pull } = entry;
    const failed = (error: string, headSha: string): PullReview => ({
      slug,
      number: pull.number,
      title: pull.title,
      branch: pull.branch,
      authorLogin: pull.authorLogin,
      headSha,
      verdict: 'unclear',
      summary: '',
      findings: [],
      changedFiles: pull.changedFiles,
      oversized: pull.changedFiles > PR_FILE_SOFT_LIMIT,
      postable: false,
      bot: [],
      reviewedAt: now(),
      posted: this.store.get(slug, pull.number)?.posted ?? null,
      error,
    });

    this.advance({ phase: 'reading', detail: `${reviewKey(slug, pull.number)}: reading GitHub` });

    const detail = await this.ports.readDetail(slug, pull.number);
    if (detail.value === null) {
      return failed(detail.error ?? 'Could not read the pull request', pull.headSha);
    }
    // The sha the review is about, captured here and compared again before anything is written.
    const headSha = detail.value.headSha;

    const patch = await this.ports.readPatch(slug, detail.value.baseSha, headSha);
    if (patch.value === null) {
      return failed(patch.error ?? 'Could not read the patch', headSha);
    }

    const botLogin = this.settings().geminiBotLogin;
    const bot = await this.ports.readBotFindings(slug, pull.number, botLogin);
    // A failure to read the bot is not a failure to review: its remarks are input, not a gate.
    const botFindings = bot.value ?? [];

    const repoPath = this.projectPath(entry.projectId) ?? '';
    const prompt = buildReviewPrompt({
      slug,
      number: pull.number,
      title: detail.value.title,
      body: detail.value.body,
      branch: detail.value.branch,
      authorLogin: detail.value.authorLogin,
      changedFiles: detail.value.changedFiles,
      patch: patch.value,
      bot: botFindings,
      answered: [],
      repoPath,
    });

    this.advance({ phase: 'reviewing', detail: `${reviewKey(slug, pull.number)}: reviewing` });

    /*
     * A review needs two trees: the standards, kept in the workspace, and the repository's own
     * conventions. When the agent can open a second directory it starts in the workspace and the
     * repository comes in beside it; when it cannot, it starts **in the repository** instead. That
     * is the honest degradation rather than a refusal: of the two, the code under review is the one
     * a code review cannot do without.
     */
    const profile = this.settings().agentProfile;
    const canOpenTwo = profile.extraDirFlag.trim().length > 0;
    const workspace = this.settings().workspaceRoot;
    const answer = await this.ports.runAgent({
      profile,
      cwd: canOpenTwo && workspace.length > 0 ? workspace : repoPath || workspace,
      extraDirs: canOpenTwo && workspace.length > 0 && repoPath.length > 0 ? [repoPath] : [],
      prompt,
      model: this.settings().agentReviewModel,
      timeoutMs: PER_PR_TIMEOUT_MS,
      label: 'The review',
      ...(this.controller === null ? {} : { signal: this.controller.signal }),
      onEvent: (event) => {
        const step = readProgress(event);
        if (step === null || step.phase === 'done') {
          return;
        }
        this.advance({
          detail: `${reviewKey(slug, pull.number)}: ${step.detail}`,
          counts: step.counts === true,
        });
      },
    });
    if (!answer.ok) {
      return failed(answer.error ?? 'The review failed', headSha);
    }

    const parsed = parseReview({
      answer: answer.answer,
      changedPaths: this.ports.patchPaths(patch.value),
    });

    return {
      slug,
      number: pull.number,
      // Every fact from `gh`, never from the model: it is asked to judge, not to restate.
      title: detail.value.title,
      branch: detail.value.branch,
      authorLogin: detail.value.authorLogin,
      headSha,
      verdict: parsed.verdict,
      summary: parsed.summary,
      findings: parsed.findings,
      changedFiles: detail.value.changedFiles,
      oversized: detail.value.changedFiles > PR_FILE_SOFT_LIMIT,
      // Re-derived from the fresh read, never from the three-minute-old poll.
      postable: login.length > 0 && detail.value.authorLogin !== login,
      bot: botFindings,
      reviewedAt: now(),
      posted: this.store.get(slug, pull.number)?.posted ?? null,
      error: parsed.error,
    };
  }

  /**
   * Submits the review of one pull request, if every gate lets it.
   *
   * The sha is read **again** here, immediately before the write, and never taken from the review
   * that was just made: minutes passed while the model read the patch, and a push in that window
   * means the verdict is about a commit that is no longer what would merge.
   */
  private async postOne(entry: PullTarget, login: string): Promise<void> {
    const review = this.store.get(entry.slug, entry.pull.number);
    if (review === undefined) {
      return;
    }

    const fresh = await this.ports.readDetail(entry.slug, entry.pull.number);
    const existing = await this.ports.readReviews(entry.slug, entry.pull.number);
    const reviews = existing.value ?? [];

    const gate: GateInput = {
      writesEnabled: this.settings().reviewWritesEnabled,
      viewerLogin: login,
      dryRun: false,
      postable: review.postable,
      state: fresh.value?.state ?? 'UNKNOWN',
      isDraft: fresh.value?.isDraft ?? true,
      headMoved: fresh.value === null || fresh.value.headSha !== review.headSha,
      alreadyPostedAtHead: PullReviewService.alreadyPostedAtHead(reviews, login, review.headSha),
      humanBlockPresent: PullReviewService.humanBlockPresent(reviews, login),
      aborted: this.controller?.signal.aborted === true,
    };

    const action = decideAction(review.verdict, gate);
    if (action.kind === 'none') {
      // Not an error and not silence either: the row says which gate refused, because each one has
      // a different fix and "not posted" on its own sends the reader to the code.
      this.store.save({ ...review, error: review.error ?? action.reason });
      return;
    }

    await this.submit(review, action.event, login);
  }

  /** The write itself, shared by the run and by the three buttons. */
  private async submit(
    review: PullReview,
    event: ReviewEvent,
    login: string,
  ): Promise<WriteOutcome> {
    const body = this.bodyFor(review);
    const bodyPath = await this.ports.writeBody(review.slug, review.number, review.headSha, body);
    const outcome = await this.ports.submitReview({
      slug: review.slug,
      number: review.number,
      headSha: review.headSha,
      event,
      bodyPath,
    });

    if (outcome.kind === 'posted') {
      this.store.save({
        ...review,
        posted: {
          at: now(),
          headSha: review.headSha,
          event: event === 'REQUEST_CHANGES' ? 'request-changes' : event === 'APPROVE' ? 'approve' : 'comment',
          url: outcome.url,
          reviewId: outcome.reviewId,
        },
        error: null,
      });
    } else {
      /*
       * A timeout says the request MAY have reached GitHub, so the row says exactly that and nothing
       * is retried. Retrying a timed-out review is how the same blocking comment gets posted twice
       * on somebody's pull request, and the next run resolves it for free by reading the marker back.
       */
      this.store.save({
        ...review,
        error:
          outcome.kind === 'unknown'
            ? `${outcome.message}. Check the pull request on GitHub before running again.`
            : outcome.message,
      });
    }
    await this.store.write();
    this.push();
    // `login` is unused past the gate, and kept in the signature so a caller cannot forget it exists.
    void login;
    return outcome;
  }

  /**
   * One of the three review events, asked for by hand.
   *
   * The same gates as a run, minus the verdict, plus one for `APPROVE`: approving is what unblocks a
   * merge, so it refuses unless the stored review is about the head that is live **right now**, and
   * the refusal names both shas rather than saying no.
   */
  async submitManual(
    slug: string,
    number: number,
    event: ReviewEvent,
  ): Promise<PullReviewState> {
    const review = this.store.get(slug, number);
    if (review === undefined) {
      this.error = 'Nothing has reviewed this pull request yet';
      return this.push();
    }

    const login = await this.ports.viewerLogin();
    this.writesBlocked = login.length === 0 ? 'gh is not signed in' : null;

    const fresh = await this.ports.readDetail(slug, number);
    const existing = await this.ports.readReviews(slug, number);
    const reviews = existing.value ?? [];
    const liveSha = fresh.value?.headSha ?? '';

    const action = decideManual(event, {
      writesEnabled: this.settings().reviewWritesEnabled,
      viewerLogin: login,
      dryRun: false,
      postable: review.postable,
      state: fresh.value?.state ?? 'UNKNOWN',
      isDraft: fresh.value?.isDraft ?? true,
      // A manual comment is allowed on a head that moved; only the approve gate cares, below.
      headMoved: false,
      alreadyPostedAtHead: event === 'APPROVE' ? false : PullReviewService.alreadyPostedAtHead(reviews, login, review.headSha),
      humanBlockPresent: false,
      aborted: false,
      reviewIsCurrent: liveSha.length > 0 && liveSha === review.headSha,
    });

    if (action.kind === 'none') {
      this.error =
        event === 'APPROVE' && liveSha.length > 0 && liveSha !== review.headSha
          ? `Reviewed ${review.headSha.slice(0, 7)}, the head is now ${liveSha.slice(0, 7)}. Review it again.`
          : action.reason;
      return this.push();
    }

    this.error = null;
    await this.submit(review, action.event, login);
    return this.push();
  }

  /**
   * Whether a body of ours is already on the pull request for this exact sha.
   *
   * The second half of idempotency, and the one that survives `pull-reviews.json` being deleted,
   * hand-edited, or left on another machine: the pull request is the only authority on what has
   * actually been said out loud.
   */
  static alreadyPostedAtHead(reviews: readonly ExistingReview[], login: string, headSha: string): boolean {
    return reviews.some(
      (review) => review.authorLogin === login && readMarkerSha(review.body) === headSha.toLowerCase(),
    );
  }

  /**
   * Whether the user has blocked this pull request by hand.
   *
   * A `CHANGES_REQUESTED` of theirs carrying **no** marker of ours. The agent never stacks a second,
   * machine-written block under one its owner wrote and is already discussing.
   */
  static humanBlockPresent(reviews: readonly ExistingReview[], login: string): boolean {
    return reviews.some(
      (review) =>
        review.authorLogin === login &&
        review.state === 'CHANGES_REQUESTED' &&
        readMarkerSha(review.body) === null,
    );
  }

  /**
   * Retracts a review this app posted.
   *
   * Dismisses it, which is what unblocks the merge, **and** replaces its body, which is what a reader
   * of the thread sees. Neither half is enough alone, so they are one gesture, and the honest label
   * for it is "retract" rather than "delete": a submitted GitHub review cannot be deleted, the text
   * stays in the timeline marked as dismissed, and it is already in everybody's inbox.
   *
   * The stored row keeps `posted` pointing at the same review id afterwards, with its own note: what
   * happened, happened, and a row that forgot it had spoken would let the next run speak again.
   */
  async retract(slug: string, number: number): Promise<PullReviewState> {
    const review = this.store.get(slug, number);
    if (review?.posted == null) {
      this.error = 'Nothing was posted about this pull request';
      return this.push();
    }

    const note = `Retracted: this review was posted in error.${'\n'}`;
    const path = await this.ports.writeBody(slug, number, review.headSha, note);
    const outcome = await this.ports.retract({
      slug,
      number,
      reviewId: review.posted.reviewId,
      reason: 'Posted in error',
      replacementPath: path,
    });

    this.error = outcome.kind === 'posted' ? null : outcome.message;
    this.store.save({
      ...review,
      error: outcome.kind === 'posted' ? 'Retracted on GitHub' : review.error,
    });
    await this.store.write();
    return this.push();
  }

  /** The body of one stored review, or empty when there is none. What the tab asks for by key. */
  bodyOf(slug: string, number: number): string {
    const review = this.store.get(slug, number);
    return review === undefined ? '' : this.bodyFor(review);
  }

  /** The body a review would post, or has posted. Built here so the tab can show it before it exists. */
  bodyFor(review: PullReview): string {
    return buildReviewBody({
      summary: review.summary,
      findings: review.findings,
      headSha: review.headSha,
      workspaceRoot: this.settings().workspaceRoot,
      carriedOver: [],
    });
  }

  private advance(step: {
    phase?: PullReviewProgress['phase'];
    detail?: string;
    counts?: boolean;
    done?: number;
  }): void {
    if (this.progress === null) {
      return;
    }
    this.progress = {
      ...this.progress,
      phase: step.phase ?? this.progress.phase,
      // An empty detail keeps whatever was showing: an event that says nothing new must not blank
      // the one line the user is reading.
      detail: step.detail !== undefined && step.detail.length > 0 ? step.detail : this.progress.detail,
      steps: this.progress.steps + (step.counts === true ? 1 : 0),
      done: step.done ?? this.progress.done,
    };
    this.push();
  }

  private push(): PullReviewState {
    const state = this.state();
    this.onChange(state);
    return state;
  }
}

function now(): string {
  return new Date().toISOString();
}
