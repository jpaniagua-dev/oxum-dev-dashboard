import {
  PULL_VERDICTS,
  type PullFinding,
  type PullVerdict,
} from '@shared/contracts.js';
import { findingId } from './review-body.js';

/**
 * Turns a model answer into a verdict and its findings, and never throws.
 *
 * The rules `parseTriage` established, transplanted, plus one this feature adds because it writes to
 * a third party: **a finding naming a file the pull request does not touch is dropped.** The diff's
 * own file list is the authority, exactly as `asked` is in the triage parse. Without it, a
 * hallucinated path becomes a confident public remark about a file nobody changed.
 */

export interface ParsedReview {
  readonly verdict: PullVerdict;
  readonly summary: string;
  readonly findings: PullFinding[];
  /** Set when the answer could not be read at all, so the caller can keep it out of every write. */
  readonly error: string | null;
}

export interface ReviewParseInput {
  /** Raw text the model returned. */
  readonly answer: string;
  /** Paths the patch touches. The authority on what this pull request changes. */
  readonly changedPaths: readonly string[];
}

export function parseReview(input: ReviewParseInput): ParsedReview {
  const raw = readObject(input.answer);
  if (raw === null) {
    return {
      verdict: 'unclear',
      summary: '',
      findings: [],
      error: 'The review did not come back as readable JSON',
    };
  }

  const known = new Set(input.changedPaths);
  const findings: PullFinding[] = [];
  for (const entry of Array.isArray(raw.findings) ? raw.findings : []) {
    if (!isObject(entry)) {
      continue;
    }
    const item = entry as RawFinding;
    const path = typeof item.path === 'string' ? item.path.trim() : '';
    const body = typeof item.body === 'string' ? item.body.trim() : '';
    if (body.length === 0) {
      continue;
    }
    // A path the patch does not carry is a file the run did not read a change to. Dropped rather
    // than posted about, and dropped silently: the alternative is a public remark whose subject is
    // a file the author never touched.
    if (path.length > 0 && !known.has(path)) {
      continue;
    }
    const title = typeof item.title === 'string' && item.title.trim().length > 0 ? item.title.trim() : body;
    findings.push({
      id: findingId(path, title),
      path,
      line: toLine(item.line),
      // Unknown reads as blocking, never as harmless. Same direction as `unclear`: the pessimistic
      // value is the honest one when the answer did not say.
      blocking: item.blocking !== false,
      body,
    });
  }

  const verdict = toVerdict(raw.verdict);
  return {
    verdict,
    summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
    findings,
    error: null,
  };
}

interface RawFinding {
  path?: unknown;
  line?: unknown;
  blocking?: unknown;
  title?: unknown;
  body?: unknown;
}

interface RawReview {
  verdict?: unknown;
  summary?: unknown;
  findings?: unknown;
}

/**
 * Pulls the JSON object out of the answer.
 *
 * From the first `{` to the last `}` rather than parsing the whole string, because a model that adds
 * one polite sentence or a code fence around its JSON is common and its answer is otherwise
 * perfectly usable. `null` rather than a throw when there is no object at all: the caller turns that
 * into `unclear`, which posts nothing.
 */
function readObject(answer: string): RawReview | null {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(answer.slice(start, end + 1));
    return isObject(parsed) ? (parsed as RawReview) : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An unrecognised verdict becomes `unclear`.
 *
 * Which is the one verdict that cannot write. The direction matters more here than in the triage:
 * falling back to `request-changes` would let a garbled answer block a colleague's merge.
 */
function toVerdict(value: unknown): PullVerdict {
  if (typeof value !== 'string') {
    return 'unclear';
  }
  const normalised = value.trim().toLowerCase();
  return PULL_VERDICTS.find((verdict) => verdict === normalised) ?? 'unclear';
}

/** A line number, or `null` for a finding about the change as a whole, which is a real answer. */
function toLine(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
