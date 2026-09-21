import type { FeedbackPhase } from '@shared/contracts.js';

/**
 * Whether a feedback pass may start on one pull request.
 *
 * Pure, and modelled on `review-gate.ts` down to its shape: one ordered list, one sentence per
 * refusal, the order being the contract. The reason is the same one that file records: every refusal
 * here is a way for a row to sit there doing nothing, and a reader who cannot see which rule fired has
 * to go and read the source.
 *
 * It is also where the loop is closed. Nothing else in this feature needs to be careful, because a
 * pass that cannot start cannot loop.
 */

export interface FeedbackGateInput {
  /** `feedbackPassEnabled`. Its own switch, not `reviewWritesEnabled`: see the field's own note. */
  readonly featureEnabled: boolean;
  readonly viewerLogin: string;
  /** Whether the project the run came from is still configured: the pass needs a path to spawn in. */
  readonly projectKnown: boolean;
  readonly phase: FeedbackPhase;
  /** The pull request's state, straight from the poll payload. */
  readonly state: string;
  readonly isDraft: boolean;
  /** Whether the ticket's own handoff tab is still running. */
  readonly originalRunActive: boolean;
  readonly newCount: number;
}

/**
 * The first rule that stops this pass, as a sentence, or `null` when none does.
 *
 * Two refusals from `review-gate.ts` are deliberately **absent**, and both will tempt the next reader
 * to add them. `postable` is inverted here: the review refuses your own pull request because GitHub
 * rejects the write, whereas this feature exists precisely **for** the pull requests an unattended run
 * opened under your name, so copying it would refuse every pull request the feature is about. And
 * `headMoved` has no meaning: a fix push is the expected outcome of a pass, not a race that invalidates
 * it.
 */
export function feedbackRefusal(input: FeedbackGateInput): string | null {
  if (!input.featureEnabled) {
    return 'Starting a feedback pass by itself is turned off in the settings';
  }
  // Not a formality. With no login, every reply the pass posts comes back looking like somebody
  // else's comment, and the pass relaunches on its own output: the loop, through the other door.
  if (input.viewerLogin.length === 0) {
    return 'gh is not signed in';
  }
  if (!input.projectKnown) {
    return 'The repository this run came from is no longer configured';
  }
  if (input.phase === 'passing') {
    return 'A feedback pass is already running on this pull request';
  }
  if (input.phase === 'done') {
    return 'This pull request has already had its feedback pass';
  }
  if (input.state !== 'OPEN') {
    return `The pull request is ${input.state.toLowerCase()}`;
  }
  if (input.isDraft) {
    return 'The pull request went back to draft';
  }
  // A second agent on one worktree is the outcome `workActionId` already calls worse than being
  // blocked, and the run that opened the pull request is still holding that worktree.
  if (input.originalRunActive) {
    return 'The run that opened this pull request is still going';
  }
  if (input.newCount === 0) {
    return 'No new review feedback';
  }
  return null;
}
