import { STORY_POINT_SCALE, type IssueTransition, type Sprint } from '@shared/contracts.js';
import {
  applyTransition,
  assignIssue,
  findStoryPointField,
  moveToSprint,
  readTransitions,
  setStoryPoints,
  type JiraCredentials,
} from './jira-service.js';

/**
 * What `Work on this` writes to Jira before the terminal tab opens.
 *
 * Four writes, in the order a human would make them: bring the ticket into the sprint being worked,
 * put your name on it, record the estimate, then move it to in progress. The order is not cosmetic. A
 * transition can sit behind a screen that requires an assignee, and a ticket left "In progress" while
 * unassigned and outside the sprint is precisely the state a standup argues about, so the state changes
 * that describe the work come before the one that announces it.
 *
 * **Nothing here can stop the handoff.** Every step is independent, a failure is collected rather than
 * thrown, and the caller opens the tab whatever comes back. The session is the thing that was asked
 * for; the Jira update is the bookkeeping around it, and bookkeeping that can cancel the work is
 * bookkeeping nobody trusts. Jira not being configured at all is the same case, reported as skipped.
 */

/** What was written for one ticket, what was not, and why. */
export interface StartReport {
  readonly key: string;
  /** Steps that went through, in the words the view shows. */
  readonly done: string[];
  /** Steps not attempted, each saying what was missing. */
  readonly skipped: string[];
  /** Steps attempted and refused, each carrying Jira's own sentence. */
  readonly failed: string[];
}

/** Everything resolved once per handoff, rather than once per ticket. */
export interface StartContext {
  readonly credentials: JiraCredentials;
  readonly accountId: string;
  /** The sprint the tickets are moved into, `null` when the board has no active one. */
  readonly sprintId: number | null;
  /** The site's story point field, `null` when it has none. */
  readonly storyPointField: string | null;
}

/**
 * The sprint a ticket is moved into: the board's active one.
 *
 * "Current" is a statement about state and not about position in the list, so it is read from `state`
 * and never from "the first one": `listSprints` sorts active first, and relying on that would make this
 * silently wrong the day the sort changes for a display reason. A board between sprints has none, which
 * is a real situation and reported as such rather than falling back to the next future sprint: moving a
 * ticket into a sprint nobody has started is not what was asked.
 *
 * Pure and exported, because it decides where a ticket lands and the wrong answer is a ticket in the
 * wrong iteration, which the board shows to the whole team.
 */
export function pickActiveSprint(sprints: readonly Sprint[]): Sprint | null {
  return sprints.find((sprint) => sprint.state === 'active') ?? null;
}

/**
 * The transition that starts work, chosen by category and not by name.
 *
 * `stage === 'in-progress'` is the rule, for the reason an issue's own stage comes from
 * `statusCategory`: status names are per-project and renamed at will, so matching the string "in
 * progress" finds nothing on a board that calls it "Développement" or "Ready for QA".
 *
 * The name is only a **tiebreak**, and only when a workflow offers several in-progress destinations at
 * once, which happens as soon as a board can go straight from "To do" to "In review". Jira returns
 * transitions in workflow order, so the first is a defensible answer, but preferring the one that
 * actually says "in progress" is a better one when it is on offer. The word list is deliberately short
 * and never the primary rule: it is allowed to help, never to decide alone.
 *
 * Returns `null` when the workflow offers no in-progress move from where the ticket is, which is a
 * legitimate answer: a ticket already in progress has none, and neither does one whose workflow needs
 * two steps. Reported, not forced.
 */
export function pickStartTransition(
  transitions: readonly IssueTransition[],
): IssueTransition | null {
  const candidates = transitions.filter((transition) => transition.stage === 'in-progress');
  if (candidates.length === 0) {
    return null;
  }
  const preferred = candidates.find((transition) =>
    START_WORDS.some((word) => transition.label.toLowerCase().includes(word)),
  );
  return preferred ?? candidates[0] ?? null;
}

/** Tiebreak words only. See `pickStartTransition`: the category decides, this only ranks. */
const START_WORDS: readonly string[] = ['progress', 'cours', 'develop', 'wip'];

/**
 * Snaps an estimate onto `STORY_POINT_SCALE`.
 *
 * A model handed a numeric field answers 4, 6 or 7.5 often enough that the value has to be rounded to
 * something a board is planned in. Rounding is by absolute distance, and a tie goes to the **larger**
 * point: an estimate sitting exactly between 3 and 5 is a ticket nobody was sure about, and the cost of
 * under-promising is lower than the cost of over-promising.
 *
 * Anything that is not a finite positive number is refused outright rather than defaulted. There is no
 * such thing as a safe default here: the number gets written to a ticket and planned against, so "no
 * estimate" has to stay available as an answer.
 */
export function nearestStoryPoints(value: unknown): number | null {
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  let best: number | null = null;
  for (const point of STORY_POINT_SCALE) {
    if (best === null || Math.abs(point - raw) <= Math.abs(best - raw)) {
      best = point;
    }
  }
  return best;
}

/**
 * Resolves everything the writes share, in one round of calls.
 *
 * The account id and the story point field are the same for every ticket in a batch, and the field
 * lookup returns every field defined on the site: doing either per ticket would be eight identical
 * payloads for one answer. A missing piece is not an error, it is a step that will be reported skipped.
 */
export async function readStartContext(
  credentials: JiraCredentials,
  accountId: string,
  sprints: readonly Sprint[],
): Promise<StartContext> {
  const { fieldId } = await findStoryPointField(credentials);
  return {
    credentials,
    accountId,
    sprintId: pickActiveSprint(sprints)?.id ?? null,
    storyPointField: fieldId,
  };
}

/**
 * Runs the four writes for one ticket.
 *
 * Sequential and not `Promise.all`, on purpose: the transition is the step that can be refused because
 * of the state the others just put the ticket in, so it has to see their result. Sequential also keeps
 * Jira's rate limit out of the picture for a batch of eight.
 */
export async function startIssue(
  context: StartContext,
  key: string,
  estimate: number | null,
): Promise<StartReport> {
  const done: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  if (context.sprintId === null) {
    skipped.push('sprint (no active sprint on the board)');
  } else {
    const moved = await moveToSprint(context.credentials, key, context.sprintId);
    (moved.ok ? done : failed).push(moved.ok ? 'moved to the active sprint' : `sprint: ${moved.message}`);
  }

  const assigned = await assignIssue(context.credentials, key, context.accountId);
  (assigned.ok ? done : failed).push(assigned.ok ? 'assigned to you' : `assignee: ${assigned.message}`);

  if (estimate === null) {
    skipped.push('estimate (the analysis gave none)');
  } else if (context.storyPointField === null) {
    skipped.push('estimate (this site has no story point field)');
  } else {
    const written = await setStoryPoints(context.credentials, key, context.storyPointField, estimate);
    (written.ok ? done : failed).push(
      written.ok ? `estimated at ${estimate}` : `estimate: ${written.message}`,
    );
  }

  /*
   * Read the legal moves, then take the one that starts work.
   *
   * Read at this moment and never cached, the rule the tab's own context menu records: a workflow
   * decides which moves are legal from the **current** status, and the three writes above may have
   * changed it. A remembered transition id is one Jira would refuse while talking about something else.
   */
  const { transitions, error } = await readTransitions(context.credentials, key);
  if (error !== null) {
    failed.push(`status: ${error}`);
  } else {
    const start = pickStartTransition(transitions);
    if (start === null) {
      // Already in progress is the common case here, and it is not a failure: the ticket is in the
      // state that was asked for. So is a workflow that needs two steps, which this must not guess at.
      skipped.push('status (no in-progress move available from here)');
    } else {
      const moved = await applyTransition(context.credentials, key, start.id);
      (moved.ok ? done : failed).push(
        moved.ok ? `moved to ${start.label}` : `status: ${moved.message}`,
      );
    }
  }

  return { key, done, skipped, failed };
}

/**
 * One line saying what happened in Jira, for the message the handoff returns.
 *
 * Failures are named and counted rather than summarised as "some writes failed": the whole reason this
 * is reported at all is that the writes happen out of sight, and a ticket that was assigned but never
 * moved is a ticket you have to go and look at. Skips are mentioned only when nothing failed, so the
 * important half is never pushed off the end of the line by an expected omission.
 *
 * Pure and exported: it is the only account the user gets of four writes they did not watch.
 */
export function describeStart(reports: readonly StartReport[]): string {
  if (reports.length === 0) {
    return '';
  }
  const failures = reports.filter((report) => report.failed.length > 0);
  if (failures.length > 0) {
    const detail = failures
      .map((report) => `${report.key} (${report.failed.join('; ')})`)
      .join(', ');
    return `Jira partly updated, ${failures.length} of ${reports.length} with problems: ${detail}`;
  }
  const skips = reports.flatMap((report) => report.skipped);
  const head = reports.length === 1 ? 'Jira updated' : `Jira updated for ${reports.length} tickets`;
  // The distinct reasons, not one per ticket: eight tickets skipping the estimate for the same missing
  // field is one fact, and repeating it eight times buries whatever else is on the line.
  const reasons = [...new Set(skips)];
  return reasons.length === 0 ? head : `${head}, except ${reasons.join(', ')}`;
}
