import type { JiraIssue } from '@shared/contracts.js';

/*
 * The pure part of a ticket's right-click menu in the Tickets tab: what the entries say and copy.
 *
 * Apart from `jira-board.ts` because that file carries a literal NUL character the editing tools
 * refuse, and apart from `main.ts` so it can be tested without a DOM.
 */

/** One copy entry: its label, the exact text it copies, and the confirmation shown on the strip. */
export interface TicketCopy {
  readonly label: string;
  readonly text: string;
  readonly message: string;
}

/** The entry that hands a ticket to the agent, before its action is attached. */
export interface TicketWorkItem {
  readonly label: string;
  readonly hint: string;
  readonly disabled: boolean;
}

/** `PROJ-123 - Fix the login timeout`, or the key alone when the ticket has no title. */
export function ticketFullName(key: string, summary: string): string {
  const title = summary.trim();
  return title.length === 0 ? key : `${key} - ${title}`;
}

/** The three copy entries of a ticket, in menu order. */
export function ticketCopies(issue: Pick<JiraIssue, 'key' | 'summary'>): readonly TicketCopy[] {
  const title = issue.summary.trim();
  const full = ticketFullName(issue.key, issue.summary);
  return [
    { label: 'Copy the ID', text: issue.key, message: `Copied ${issue.key}` },
    { label: 'Copy the title', text: title, message: `Copied the title of ${issue.key}` },
    { label: 'Copy ID and title', text: full, message: `Copied ${full}` },
  ];
}

/** "Work on this...", greyed on a local ticket. */
export function workOnTicketItem(issue: Pick<JiraIssue, 'key' | 'source'>): TicketWorkItem {
  // Greyed rather than hidden: the skill it hands over to reads Jira, which has never heard of a
  // local key, and an entry that vanishes on some rows reads as a bug.
  return issue.source === 'local'
    ? {
        label: 'Work on this...',
        hint: 'Local tickets cannot be handed to an agent: its skill reads Jira',
        disabled: true,
      }
    : {
        label: 'Work on this...',
        hint: `Starts the agent on ${issue.key} in the project you pick`,
        disabled: false,
      };
}
