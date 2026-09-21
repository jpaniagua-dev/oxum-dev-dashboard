import type { BotFinding } from '@shared/contracts.js';

/**
 * What the review bot already said on a pull request, read back as plain text.
 *
 * It is **input to the run, never a gate**. Nothing here decides whether a pull request is
 * approvable: the run is asked to judge each remark on its merits, because the team's own experience
 * is that the bot's suggestions can reintroduce what a pull request just removed, and that a correct
 * remark can be about behaviour that predates the branch. Reading its badge and acting on it would
 * be trusting a vocabulary nobody has enumerated.
 */

/**
 * Two logins naming the same account, whichever way GitHub spelled them.
 *
 * GitHub reports an App author with the `[bot]` suffix in some payloads and without it in others, so
 * the comparison folds the suffix and the case. An empty login never matches anything, which is not
 * a detail: an empty one means "we do not know who we are", and answering `true` there would make
 * everything look like us.
 *
 * One implementation and two readings. `isBotLogin` asks "is this the review bot"; the feedback
 * watcher asks "is this comment one of our own replies", which is the same question about a different
 * account. Two copies of the folding rule would drift, and the drift would be a watcher reading its
 * own replies as somebody else's feedback.
 */
export function sameLogin(a: string, b: string): boolean {
  const left = a.replace(/\[bot\]$/i, '').toLowerCase();
  const right = b.replace(/\[bot\]$/i, '').toLowerCase();
  return left.length > 0 && left === right;
}

/** Whether a comment's author is the configured review bot. Reads as its own question at call sites. */
export function isBotLogin(login: string, configured: string): boolean {
  return sameLogin(login, configured);
}

/**
 * The severity badge a bot comment carries, lowercased, or empty when it carries none.
 *
 * Carried through **verbatim**. Only `critical` and `medium` have ever been seen on this team's pull
 * requests, and the levels around them are not written down anywhere; mapping an unseen badge onto a
 * scale of ours would file a finding under a word the bot never used. A comment with no recognisable
 * badge gets an empty severity and is shown all the same, because the remark is the point and the
 * badge is decoration.
 */
export function readSeverity(body: string): string {
  const found = /!\[(?:severity:)?\s*([a-z]+)\s*\]|\b(critical|high|medium|low)\b\s*(?:severity)?/i.exec(
    body,
  );
  if (found === null) {
    return '';
  }
  return (found[1] ?? found[2] ?? '').toLowerCase();
}

interface RawComment {
  path?: unknown;
  line?: unknown;
  original_line?: unknown;
  body?: unknown;
  user?: unknown;
}

/**
 * Reads the bot's inline review comments out of `GET /pulls/{n}/comments`.
 *
 * **That endpoint and not `gh pr view --json comments`**, which returns issue comments only. The
 * badges live on inline review comments, so reading the wrong collection returns an empty list and
 * concludes the bot found nothing: the single most consequential mistake available in this feature.
 */
export function parseBotComments(payload: unknown, botLogin: string): BotFinding[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const findings: BotFinding[] = [];
  for (const entry of payload) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const comment = entry as RawComment;
    if (!isBotLogin(readLogin(comment.user), botLogin)) {
      continue;
    }
    const body = typeof comment.body === 'string' ? comment.body.trim() : '';
    if (body.length === 0) {
      continue;
    }
    findings.push({
      path: typeof comment.path === 'string' ? comment.path : '',
      // `line` is null on a comment whose hunk has since changed; `original_line` still places it.
      line: toLine(comment.line) ?? toLine(comment.original_line),
      severity: readSeverity(body),
      body,
    });
  }
  return findings;
}

/** Whether the bot has reviewed at all, which is not the same as having found nothing. */
export function hasBotReviewed(reviews: unknown, botLogin: string): boolean {
  if (!Array.isArray(reviews)) {
    return false;
  }
  return reviews.some(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      isBotLogin(readLogin((entry as { user?: unknown }).user), botLogin),
  );
}

function readLogin(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }
  const login = (value as { login?: unknown }).login;
  return typeof login === 'string' ? login : '';
}

function toLine(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
