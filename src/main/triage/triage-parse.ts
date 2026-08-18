import { TRIAGE_VERDICTS, type TriagedTicket, type TriageVerdict } from '@shared/contracts.js';
import { nearestStoryPoints } from '../jira/jira-start.js';

/**
 * Turns a model answer into verdicts, and never throws.
 *
 * A model asked for bare JSON still wraps it in a code fence often enough that refusing those would
 * lose a good answer for a formatting habit. Everything else is treated as a defect of the answer,
 * not of the ticket: a key that was not asked about is dropped, an unknown verdict falls back to
 * `unclear`, and a ticket the model forgot is added back rather than disappearing from the tab.
 * A ticket silently missing from a triage is the one failure nobody would notice.
 */
export interface ParseInput {
  /** Raw text the model returned. */
  readonly answer: string;
  /**
   * The tickets that were asked about, in display order.
   *
   * Everything factual about a ticket is taken from here and never from the answer: the model is
   * asked to classify, not to restate, and letting it rewrite a summary or a description would put
   * text on screen that no longer matches the ticket.
   */
  readonly asked: readonly {
    key: string;
    summary: string;
    assignee: string;
    status: string;
    description: string;
  }[];
}

export function parseTriage(input: ParseInput): TriagedTicket[] {
  const byKey = new Map<string, RawVerdict>();
  for (const entry of readEntries(input.answer)) {
    if (typeof entry.key === 'string') {
      byKey.set(entry.key.trim().toUpperCase(), entry);
    }
  }

  return input.asked.map((ticket) => {
    const found = byKey.get(ticket.key.toUpperCase());
    return {
      key: ticket.key,
      summary: ticket.summary,
      assignee: ticket.assignee,
      status: ticket.status,
      description: ticket.description,
      verdict: toVerdict(found?.verdict),
      reason: toText(found?.reason, found === undefined ? 'The analysis did not mention it.' : ''),
      question: toText(found?.question, ''),
      next: toText(found?.next, ''),
      /*
       * Snapped onto the scale, or refused.
       *
       * Refused rather than defaulted, because this number is written to the ticket by `Work on this`
       * and then planned against: a fabricated estimate is worse than a blank field, which at least
       * reads as a question nobody answered. A model asked for a value from a list still returns 4 or
       * 7.5 sometimes, and the same rounding serves both that and a value read out of an older
       * `triage.json`.
       */
      estimate: nearestStoryPoints(found?.estimate),
    };
  });
}

interface RawVerdict {
  key?: unknown;
  verdict?: unknown;
  reason?: unknown;
  question?: unknown;
  next?: unknown;
  estimate?: unknown;
}

/**
 * Pulls the JSON array out of the answer.
 *
 * Scanning from the first `[` to the last `]` rather than parsing the whole string, because a model
 * that adds one polite sentence before its JSON is common and its answer is otherwise perfectly
 * usable. Returns nothing rather than throwing when there is no array at all: the caller turns that
 * into a readable error, which beats a stack trace in the main process.
 */
function readEntries(answer: string): RawVerdict[] {
  const start = answer.indexOf('[');
  const end = answer.lastIndexOf(']');
  if (start === -1 || end <= start) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(answer.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed.filter(isObject) as RawVerdict[]) : [];
  } catch {
    return [];
  }
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An unrecognised verdict becomes `unclear`: the honest answer is "this was not classified". */
function toVerdict(value: unknown): TriageVerdict {
  if (typeof value !== 'string') {
    return 'unclear';
  }
  const normalised = value.trim().toLowerCase();
  const match = TRIAGE_VERDICTS.find((verdict) => verdict === normalised);
  return match ?? 'unclear';
}

function toText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/** True when nothing usable came back, so the caller can keep the previous result and say why. */
export function isEmptyAnswer(answer: string): boolean {
  return readEntries(answer).length === 0;
}
