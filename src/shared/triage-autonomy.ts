import type { TriagedTicket } from './contracts.js';
import { AUTONOMY_MAX_POINTS, DESCRIPTION_TRUNCATED_MARK, STORY_POINT_SCALE } from './contracts.js';

/**
 * Whether a triaged ticket may be handed to an agent that nobody is going to watch.
 *
 * The second half of a two-author decision. The analysis answers `autonomous` against criteria spelled
 * out in the prompt and that answer is stored as `claimsAutonomy`; what lives here is the app's own
 * veto, applied at read time against facts nobody has to interpret. The split is the whole design: a
 * model asked whether it could do a job it has not tried is optimistic by construction, and a claim
 * that only it could check would be unfalsifiable.
 *
 * In `shared/` for the reason `pull-review.ts` is. The renderer paints the chip and builds the batch
 * today, and the unattended runner will cap the same batch tomorrow: two answers to "may this run with
 * nobody watching" would drift, and the drift would be an agent started on a ticket the tab refused.
 */

/**
 * The first rule that stops a ticket, named.
 *
 * A reason rather than a boolean, because every guardrail is one more silent way the flag vanishes and
 * a reader watching it disappear has no way to ask why. The tooltip that says "the analysis said yes,
 * its description was cut short" is the difference between a rule and a mystery.
 */
export type AutonomyBlock =
  'not-claimed' | 'not-ready' | 'unknown-domain' | 'no-estimate' | 'too-large' | 'truncated';

/**
 * The first rule that refuses this ticket, or `null` when none does.
 *
 * The order is fixed and tested, being the order the reader is told about: what the analysis itself
 * said comes before what the app adds, and the size rules come last because they are the ones a
 * re-analysis can change.
 */
export function autonomyBlock(ticket: TriagedTicket): AutonomyBlock | null {
  if (!ticket.claimsAutonomy) {
    return 'not-claimed';
  }
  if (ticket.verdict !== 'ready') {
    return 'not-ready';
  }
  if (ticket.domain === 'unknown') {
    return 'unknown-domain';
  }
  if (ticket.estimate === null || !STORY_POINT_SCALE.includes(ticket.estimate)) {
    return 'no-estimate';
  }
  if (ticket.estimate > AUTONOMY_MAX_POINTS) {
    return 'too-large';
  }
  if (ticket.description.trimEnd().endsWith(DESCRIPTION_TRUNCATED_MARK)) {
    return 'truncated';
  }
  return null;
}

/** Whether every guardrail clears this ticket. The predicate the chip and the batch both read. */
export function canRunUnattended(ticket: TriagedTicket): boolean {
  return autonomyBlock(ticket) === null;
}

/** The one sentence a missing `100% agent` flag is explained by. */
export function describeAutonomyBlock(block: AutonomyBlock): string {
  switch (block) {
    case 'not-claimed':
      return 'The analysis did not think this could run end to end on its own.';
    case 'not-ready':
      return 'Only a ticket that can be built today runs unattended: this one is not ready.';
    case 'unknown-domain':
      return 'Nothing says which side of the stack this is, and the run differs by side.';
    case 'no-estimate':
      return 'The analysis gave no size, and "end to end with nobody watching" needs one.';
    case 'too-large':
      return `Above ${AUTONOMY_MAX_POINTS} points, which is where a ticket stops being one sitting.`;
    case 'truncated':
      return 'The analysis read an extract: this description did not fit the prompt.';
  }
}
