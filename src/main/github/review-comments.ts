/**
 * Inline review comments on a pull request, read as identities rather than as prose.
 *
 * A sibling of `BotFinding` and deliberately not a widening of it, for two reasons that both bite.
 * `BotFinding` is **persisted** in `pull-reviews.json` and parsed back under the rule that an
 * incomplete row is dropped rather than repaired, so four new required fields would quietly empty the
 * bot findings of every review ever stored. And the two are about different things: a finding is input
 * to a prompt and is anonymous on purpose, while this is an identity to watermark against.
 *
 * Same endpoint as `readBotFindings`, `GET /pulls/{n}/comments`, read once per poll and filtered two
 * ways rather than requested twice.
 */

/** One inline review comment, with everything needed to tell it from one we posted ourselves. */
export interface ReviewComment {
  /**
   * GitHub's own comment id.
   *
   * The watermark is made of this. Ids are a globally increasing counter, so "greater than what I
   * have seen" is a total order and says exactly what a set of treated ids would say, without the
   * unbounded list.
   */
  readonly id: number;
  readonly authorLogin: string;
  readonly path: string;
  /** `null` on a file-level comment, or on one whose hunk has moved out of the diff. */
  readonly line: number | null;
  /** The comment this one answers, or `null` when it opens a thread. */
  readonly inReplyToId: number | null;
  readonly createdAt: string;
  readonly body: string;
}

interface RawComment {
  id?: unknown;
  path?: unknown;
  line?: unknown;
  original_line?: unknown;
  in_reply_to_id?: unknown;
  created_at?: unknown;
  body?: unknown;
  user?: unknown;
}

/**
 * Reads `GET /pulls/{n}/comments` into comments, and never throws.
 *
 * A comment with no numeric id is **skipped**, which is the one hard refusal here: a comment that
 * cannot be watermarked is one the watcher would rediscover as new at every poll, for ever. Everything
 * else degrades to an empty or null field, the payload being GitHub's and not ours to repair.
 *
 * Keeps file-level comments (`line: null`) and comments on outdated hunks. Both are real feedback, and
 * the endpoint returning them is not an accident: "attached to a diff line" is slightly narrower than
 * what a reviewer can actually leave here.
 */
export function parseReviewComments(payload: unknown): ReviewComment[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const comments: ReviewComment[] = [];
  for (const value of payload) {
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const raw = value as RawComment;
    const id = toId(raw.id);
    if (id === null) {
      continue;
    }
    comments.push({
      id,
      authorLogin: readLogin(raw.user),
      path: typeof raw.path === 'string' ? raw.path : '',
      line: toLine(raw.line, raw.original_line),
      inReplyToId: toId(raw.in_reply_to_id),
      createdAt: typeof raw.created_at === 'string' ? raw.created_at : '',
      body: typeof raw.body === 'string' ? raw.body : '',
    });
  }
  return comments;
}

/** The highest id in a payload, or the watermark unchanged. Never goes backwards: seen is seen. */
export function nextWatermark(comments: readonly ReviewComment[], watermark: number): number {
  return comments.reduce((highest, comment) => Math.max(highest, comment.id), watermark);
}

/**
 * A positive whole id, or `null`.
 *
 * `null` rather than `0` for an absent `in_reply_to_id`, and that is load bearing: 0 is a legal
 * watermark, so a thread root reported as id 0 would read as a reply to whatever was seen first.
 */
function toId(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** The line, falling back to the original one when the hunk has moved, the rule `parseBotComments` uses. */
function toLine(line: unknown, original: unknown): number | null {
  if (typeof line === 'number' && Number.isFinite(line)) {
    return line;
  }
  return typeof original === 'number' && Number.isFinite(original) ? original : null;
}

function readLogin(user: unknown): string {
  if (typeof user !== 'object' || user === null) {
    return '';
  }
  const login = (user as { login?: unknown }).login;
  return typeof login === 'string' ? login : '';
}
