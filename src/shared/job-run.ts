import type { PullReviewState, PullReviewTarget, TriageState } from './contracts.js';

/**
 * A headless agent run, as a surface that lists what is running draws it.
 *
 * Two runs in this app never get a terminal tab, on purpose: the sprint analysis and the pull
 * request review both produce a payload the app parses rather than output a reader watches, so they
 * go through `runAgent` and a pipe instead of through a pty. The consequence is that the board,
 * which paints `TerminalSession`s, could not see either of them, and a surface whose subject is
 * "what have I got running" with two running agents missing from it is one that misleads by
 * omission. This is the shape that lets them be drawn without pretending they are sessions.
 *
 * Pure and shared rather than built in the board, for the reason every presenter here is: the
 * renderer paints it today and a test asserts it without a DOM.
 */
export type JobKind = 'triage' | 'review';

export interface JobRun {
  /**
   * Stable per KIND, not per run.
   *
   * Both services enforce one run at a time (`TriageState.running`, `PullReviewState.running`), so
   * a kind identifies a run uniquely while one exists. Keying on the sprint or the target instead
   * would give every run a fresh card at the default position, which throws away wherever the last
   * one was dragged to.
   */
  readonly id: string;
  readonly kind: JobKind;
  /** What the run is, in the two words a card head has room for. */
  readonly title: string;
  /** What it is running on: the sprint's name, or which pull requests were selected. */
  readonly subject: string;
  /** The line the run last reported, which is the whole reason a card is worth looking at. */
  readonly detail: string;
  /** How much of the work is done, or `null` before the run knows its own size. */
  readonly progress: string | null;
  /** Tool calls so far. A count that keeps moving is the proof the run is alive. */
  readonly steps: number;
  readonly startedAt: string;
}

/** The card ids, exported so a caller can compare without spelling the string. */
export const TRIAGE_JOB_ID = 'job:triage';
export const REVIEW_JOB_ID = 'job:review';

/**
 * The sprint analysis as a job, or `null` when nothing is running.
 *
 * `progress` is the sprint's ticket count and not a fraction, because the analysis is one call over
 * the whole sprint: there is no "4 of 12" to report, and inventing one would be the indeterminate
 * bar's own lie in another place.
 */
export function triageJob(state: TriageState): JobRun | null {
  const progress = state.progress;
  if (progress === null) {
    return null;
  }
  const sprint = state.sprints.find((entry) => entry.id === progress.sprintId);
  return {
    id: TRIAGE_JOB_ID,
    kind: 'triage',
    title: 'Sprint analysis',
    subject: sprint?.name ?? `Sprint ${String(progress.sprintId)}`,
    detail: progress.detail,
    progress: progress.tickets > 0 ? `${String(progress.tickets)} tickets` : null,
    steps: progress.steps,
    startedAt: progress.startedAt,
  };
}

/** How a run says what it was pointed at, without needing the project list to resolve a label. */
export function describeReviewTarget(target: PullReviewTarget): string {
  switch (target.kind) {
    case 'pull':
      return `Pull request #${String(target.number)}`;
    case 'new':
      return 'Pull requests not reviewed yet';
    case 'all':
      return 'Every open pull request';
  }
}

/**
 * The pull request review as a job, or `null` when nothing is running.
 *
 * `done` of `pulls` is a real fraction here, unlike the analysis: the run is serial by design, one
 * pull request at a time, precisely so that "which ones went out before I pressed Stop" has an
 * answer.
 */
export function reviewJob(state: PullReviewState): JobRun | null {
  const progress = state.progress;
  if (progress === null) {
    return null;
  }
  return {
    id: REVIEW_JOB_ID,
    kind: 'review',
    title: 'Pull request review',
    subject: describeReviewTarget(progress.target),
    detail: progress.detail,
    progress: progress.pulls > 0 ? `${String(progress.done)} of ${String(progress.pulls)}` : null,
    steps: progress.steps,
    startedAt: progress.startedAt,
  };
}

/**
 * Every headless run going right now.
 *
 * The order is fixed rather than by start time, so two runs at once do not swap places on the board
 * between one poll and the next. A card's position is remembered by id anyway; this only decides
 * where a card that has never been dragged first lands.
 */
export function jobRuns(
  triage: TriageState | null,
  review: PullReviewState | null,
): readonly JobRun[] {
  const jobs: JobRun[] = [];
  const analysis = triage === null ? null : triageJob(triage);
  if (analysis !== null) {
    jobs.push(analysis);
  }
  const reviewing = review === null ? null : reviewJob(review);
  if (reviewing !== null) {
    jobs.push(reviewing);
  }
  return jobs;
}

/**
 * How long a run has been going, as `m:ss`.
 *
 * Minutes and seconds rather than a friendly phrase, because the reader here is watching a clock and
 * "a moment ago" answers nothing. Shared with the Triage tab's own progress line: two spellings of
 * one duration in two places showing the same run is exactly the drift `verdictFor` already records.
 */
export function describeElapsed(startedAt: string, now: Date): string {
  const started = new Date(startedAt).getTime();
  // A stamp that will not parse reads as zero rather than as `NaN:aN`, which is what a card would
  // otherwise print for the whole run.
  const from = Number.isNaN(started) ? now.getTime() : started;
  const seconds = Math.max(0, Math.floor((now.getTime() - from) / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}
