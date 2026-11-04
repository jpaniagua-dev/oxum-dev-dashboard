import type { Sprint, TriagedTicket, TriageResult } from '@shared/contracts.js';

/**
 * Puts the verdict of a ticket analysed alone into its sprint's stored result.
 *
 * The row with the same key is replaced **in place**, so a re-analysed ticket keeps its position in a
 * worklist the reader has already been through; a new key goes last, like an incremental run's.
 *
 * The sprint-level fields are the previous result's, untouched: `analysedAt` says when the sprint was
 * last read as a whole, and analysing one ticket did not read it. With no previous result the sprint
 * has never been read, hence the empty stamp and zero skips; the ticket carries its own `analysedAt`,
 * which is what dates its row.
 */
export function mergeTicketVerdict(
  previous: TriageResult | undefined,
  sprint: Pick<Sprint, 'id' | 'name'>,
  ticket: TriagedTicket,
): TriageResult {
  const key = ticket.key.toUpperCase();
  const tickets = previous?.tickets ?? [];
  const at = tickets.findIndex((row) => row.key.toUpperCase() === key);
  return {
    sprintId: sprint.id,
    sprintName: sprint.name,
    analysedAt: previous?.analysedAt ?? '',
    tickets:
      at === -1 ? [...tickets, ticket] : tickets.map((row, index) => (index === at ? ticket : row)),
    error: previous?.error ?? null,
    skipped: previous?.skipped ?? { done: 0, inProgress: 0, alreadyAnalysed: 0 },
  };
}
