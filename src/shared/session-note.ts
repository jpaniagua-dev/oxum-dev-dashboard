import type { TriagedTicket } from './contracts.js';

/**
 * The one thing on the terminal surface a human wrote.
 *
 * A session board past a dozen cards answers "what have I got running" and not "which of these is
 * the one about the fiscal year dropdown", because everything on a card is derived: a title built
 * from a project and an action, an activity read off timing, a phase read off a project row. None
 * of it can say what a session was opened FOR, and that is the question a hundred cards make
 * unanswerable.
 *
 * ⚠️ **It is also the only thing here that can be confidently wrong.** Every other field on a card
 * is a fact the app observed a second ago; a note is a sentence somebody typed once and did not
 * come back to. It answers "what was this for", which never goes stale, and it must not be relied
 * on for "where is it at", which the activity dot already refuses to claim for the same reason.
 *
 * Both surfaces showed the note's age for exactly that reason, and both stopped: the pane's box is
 * three lines pinned over a terminal and the card's is read in a glance across forty of them, so in
 * neither did a timestamp earn its line. The caveat above is now carried by this comment and by
 * nothing on screen, which is a deliberate trade and the one to revisit first if a stale note ever
 * misleads somebody.
 */

/**
 * How long a note may be.
 *
 * Three lines on a card at the width the board draws, and the cap is enforced here rather than by
 * the textarea alone: a note also arrives from the handoff, which builds it from a Jira description
 * nobody capped.
 */
export const NOTE_LIMIT = 240;

/**
 * Cleans a note on its way in, wherever it came from.
 *
 * Returns `null` for a note with nothing in it, which is how a note is removed: there is no separate
 * delete, clearing the field IS the delete, and two ways to say "no note" would be two states to
 * keep in step.
 */
export function trimNote(text: string): string | null {
  const trimmed = text.trim().slice(0, NOTE_LIMIT).trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The note a ticket handoff is born with.
 *
 * Built from the analysis the run already paid for rather than from the ticket's title alone: the
 * key says which ticket and the reason says what the verdict was about, which together are what the
 * reader will have forgotten by the time forty cards are open. `question` is deliberately left out
 * even though it is the most interesting field: a session started from `Work on this` is one whose
 * question the reader decided to answer by starting it, so pinning the old question to the card
 * would describe a state that ended at the click.
 *
 * Returns `null` when there is nothing worth saying, and the caller then seeds no note at all. An
 * empty note is not a note, and a card carrying a blank box is worse than one carrying none.
 */
export function noteFromTicket(ticket: TriagedTicket | undefined, repo: string): string | null {
  if (ticket === undefined) {
    return null;
  }
  const head = repo.length > 0 ? `${ticket.key} in ${repo}` : ticket.key;
  const reason = ticket.reason.trim();
  return trimNote(reason.length > 0 ? `${head}\n${reason}` : head);
}
