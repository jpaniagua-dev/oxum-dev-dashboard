import type { JiraIssue, TriagedTicket } from '@shared/contracts.js';
import { VERDICT_LABEL } from './triage-labels.js';

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

/** Which handoff a "Work on this" entry starts: the asking one, or the same one in plan mode. */
export type TicketWorkMode = 'ask' | 'plan';

/**
 * "Work on this..." or "Work on this in plan mode...", greyed on a local ticket.
 *
 * @param planReady Whether the agent profile has plan mode arguments; without them the main process
 *   refuses the plan handoff, so the entry says so before the project is picked.
 */
export function workOnTicketItem(
  issue: Pick<JiraIssue, 'key' | 'source'>,
  mode: TicketWorkMode = 'ask',
  planReady = true,
): TicketWorkItem {
  const label = mode === 'plan' ? 'Work on this in plan mode...' : 'Work on this...';
  // Greyed rather than hidden: the skill it hands over to reads Jira, which has never heard of a
  // local key, and an entry that vanishes on some rows reads as a bug.
  if (issue.source === 'local') {
    return {
      label,
      hint: 'Local tickets cannot be handed to an agent: its skill reads Jira',
      disabled: true,
    };
  }
  if (mode === 'plan' && !planReady) {
    return {
      label,
      hint: 'No plan mode set: Settings, Agent, Advanced, Plan mode arguments',
      disabled: true,
    };
  }
  const how = mode === 'plan' ? ' in plan mode' : '';
  return {
    label,
    hint: `Starts the agent${how} on ${issue.key} in the project you pick`,
    disabled: false,
  };
}

/**
 * "Analyse this ticket": the Triage tab's analysis, on this ticket alone.
 *
 * A ticket in progress is allowed, unlike in a sprint run: here it is asked for by name. A finished one
 * is not, its row would be dropped from the Triage tab at the next refresh.
 */
export function analyseTicketItem(
  issue: Pick<JiraIssue, 'key' | 'source' | 'stage'>,
  running: boolean,
): TicketWorkItem {
  const label = 'Analyse this ticket';
  if (issue.source === 'local') {
    return {
      label,
      hint: 'Local tickets cannot be analysed: the analysis reads Jira',
      disabled: true,
    };
  }
  if (issue.stage === 'done') {
    return {
      label,
      hint: `${issue.key} is done: there is nothing left to analyse`,
      disabled: true,
    };
  }
  if (running) {
    return { label, hint: 'An analysis is already running', disabled: true };
  }
  return {
    label,
    hint: `Runs the Triage analysis on ${issue.key} alone; the verdict lands in the Triage tab, under its sprint`,
    disabled: false,
  };
}

/** The strip's line once a ticket is analysed: `PROJ-123: Ready to build, 2 points`. */
export function verdictMessage(
  ticket: Pick<TriagedTicket, 'key' | 'verdict' | 'estimate'>,
): string {
  const points =
    ticket.estimate === null
      ? ''
      : `, ${ticket.estimate} ${ticket.estimate === 1 ? 'point' : 'points'}`;
  return `${ticket.key}: ${VERDICT_LABEL[ticket.verdict]}${points}`;
}
