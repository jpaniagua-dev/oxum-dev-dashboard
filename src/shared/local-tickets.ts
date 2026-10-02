import { branchNameFor } from './branch-name.js';
import type { IssueStage, JiraIssue } from './contracts.js';

/**
 * Tickets that live on this machine, one Markdown file each, next to the ones Jira holds.
 *
 * A file and not a row in an app store, on purpose: it can be read and edited by hand, versioned
 * with git, and read by an agent handed the ticket. The frontmatter carries what the board needs,
 * the body is the description and is never parsed. Everything here is pure, so the format is
 * pinned by tests.
 */

/** Every local key starts with this, which is what tells it from a Jira key at a glance. */
export const LOCAL_KEY_PREFIX = 'LOC';

export const LOCAL_TICKET_TYPES: readonly string[] = ['Task', 'Bug', 'Story'];

export const LOCAL_STAGES: readonly IssueStage[] = ['todo', 'in-progress', 'done'];

export interface LocalTicket {
  readonly key: string;
  readonly summary: string;
  readonly type: string;
  readonly stage: IssueStage;
  readonly created: string;
  readonly updated: string;
  /** The file it was read from, absolute. */
  readonly file: string;
}

export interface LocalTicketsState {
  /** The folder the tickets are read from, so the tab can say where they are. */
  readonly dir: string;
  readonly tickets: readonly LocalTicket[];
  /** Files in the folder that are not readable tickets. Named, never dropped in silence. */
  readonly problems: readonly string[];
}

export interface LocalTicketDraft {
  readonly summary: string;
  readonly type: string;
  readonly stage: IssueStage;
  readonly description: string;
}

export interface LocalTicketResult {
  readonly ok: boolean;
  readonly message: string;
  readonly state: LocalTicketsState;
}

/** The words a stage is shown with, the status a local ticket has no other name for. */
export function localStatus(stage: IssueStage): string {
  switch (stage) {
    case 'todo':
      return 'To do';
    case 'in-progress':
      return 'In progress';
    case 'done':
      return 'Done';
    case 'unknown':
      return 'No status';
  }
}

function isStage(value: string): value is IssueStage {
  return value === 'todo' || value === 'in-progress' || value === 'done' || value === 'unknown';
}

/** A frontmatter value: JSON-quoted when it holds anything YAML would read differently. */
function yamlValue(value: string): string {
  return /^[\w .,()/@+-]*$/.test(value) && value.trim() === value && value.length > 0 ? value : JSON.stringify(value);
}

function readValue(raw: string): string {
  const text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

/** Splits a file into its frontmatter fields and its body. Null when it has no frontmatter. */
export function splitTicketFile(text: string): { fields: Record<string, string>; body: string } | null {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (match === null) {
    return null;
  }
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (pair !== null) {
      fields[pair[1] ?? ''] = readValue(pair[2] ?? '');
    }
  }
  return { fields, body: match[2] ?? '' };
}

/**
 * The ticket a file holds, or the reason it does not hold one.
 *
 * The key is the identity, so a file without a well-formed `LOC-<n>` key is refused rather than
 * given one: two files claiming to be the same ticket is worse than one the board does not show.
 * A stage nobody wrote, or misspelt, is `todo`, which is what a ticket nobody has started is.
 */
export function parseTicket(text: string, file: string): LocalTicket | string {
  const parts = splitTicketFile(text);
  if (parts === null) {
    return 'no frontmatter';
  }
  const key = parts.fields['key'] ?? '';
  if (!new RegExp(`^${LOCAL_KEY_PREFIX}-\\d+$`).test(key)) {
    return `no ${LOCAL_KEY_PREFIX}-<number> key`;
  }
  const stage = parts.fields['stage'] ?? '';
  return {
    key,
    summary: parts.fields['summary'] ?? '',
    type: parts.fields['type'] ?? 'Task',
    stage: isStage(stage) ? stage : 'todo',
    created: parts.fields['created'] ?? '',
    updated: parts.fields['updated'] ?? '',
    file,
  };
}

/** A ticket as a file. The body is kept byte for byte: it is the reader's text, not this app's. */
export function serializeTicket(
  ticket: Omit<LocalTicket, 'file'>,
  body: string,
): string {
  const lines = [
    '---',
    `key: ${ticket.key}`,
    `summary: ${yamlValue(ticket.summary)}`,
    `type: ${yamlValue(ticket.type)}`,
    `stage: ${ticket.stage}`,
    `status: ${localStatus(ticket.stage)}`,
    `created: ${ticket.created}`,
    `updated: ${ticket.updated}`,
    '---',
  ];
  return `${lines.join('\n')}\n${body.length > 0 && !body.startsWith('\n') ? '\n' : ''}${body}`;
}

/** The key after the highest one in use, so a deleted ticket's number is never handed out again. */
export function nextTicketKey(keys: readonly string[], floor = 0): string {
  let highest = floor;
  for (const key of keys) {
    const match = new RegExp(`^${LOCAL_KEY_PREFIX}-(\\d+)$`).exec(key);
    if (match !== null) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  return `${LOCAL_KEY_PREFIX}-${highest + 1}`;
}

/** `LOC-12-fix-the-login.md`, the same slug a branch made from the ticket would carry. */
export function ticketFileName(key: string, summary: string): string {
  return `${branchNameFor(key, summary)}.md`;
}

/** Why a draft cannot be saved, or null. */
export function ticketDraftProblem(draft: LocalTicketDraft): string | null {
  if (draft.summary.trim().length === 0) {
    return 'A ticket needs a title';
  }
  if (draft.summary.length > 200) {
    return 'The title is longer than 200 characters';
  }
  if (!LOCAL_STAGES.includes(draft.stage)) {
    return 'Pick a column for the ticket';
  }
  return null;
}

/**
 * A local ticket in the shape the board draws.
 *
 * `isMine` is true and the assignee empty: a ticket on this machine is the reader's own, and naming
 * them on every card would be the same word forty times. `url` is empty, since there is no page;
 * opening a local ticket opens its file.
 */
export function localAsIssue(ticket: LocalTicket): JiraIssue {
  return {
    key: ticket.key,
    summary: ticket.summary,
    status: localStatus(ticket.stage),
    stage: ticket.stage,
    type: ticket.type,
    assignee: '',
    isMine: true,
    url: '',
    updatedAt: ticket.updated,
    source: 'local',
  };
}

/** Reads a draft sent over IPC, or null. */
export function readDraft(value: unknown): LocalTicketDraft | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { summary, type, stage, description } = record;
  if (
    typeof summary !== 'string' ||
    typeof type !== 'string' ||
    typeof stage !== 'string' ||
    typeof description !== 'string' ||
    !isStage(stage)
  ) {
    return null;
  }
  return { summary: summary.trim(), type: type.trim() || 'Task', stage, description };
}
