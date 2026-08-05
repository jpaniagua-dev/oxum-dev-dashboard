import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrReview, PullRequest } from '@shared/contracts.js';
import { classifyCheck, verdictFor } from './checks-service.js';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 25_000;
/** Enough to cover a busy repository without pulling a year of history into the strip. */
const LIMIT = 50;

/**
 * Fields asked of `gh`, verified to exist on `gh pr list --json`.
 *
 * `reviewRequests` is what makes "waiting for me" answerable, and `statusCheckRollup` is the same shape
 * the project rows already parse, so the two views cannot disagree about what green means.
 */
const FIELDS = [
  'number',
  'title',
  'url',
  'headRefName',
  'author',
  'isDraft',
  'reviewDecision',
  'reviewRequests',
  'statusCheckRollup',
  'updatedAt',
].join(',');

/**
 * Reads the open pull requests of one repository.
 *
 * A single call per repository, listing everything open, with the "is it mine" question answered
 * locally. Asking GitHub for "author me OR review-requested me" would have taken two calls, because its
 * search syntax has no usable `OR`; and having the full list in hand costs nothing and leaves room for
 * a wider filter later.
 */
export async function readRepoPulls(
  slug: string,
  login: string,
): Promise<{ pulls: PullRequest[]; error: string | null }> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'list', '--repo', slug, '--state', 'open', '--limit', String(LIMIT), '--json', FIELDS],
      { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    return { pulls: parsePullPayload(stdout, login), error: null };
  } catch (error) {
    return { pulls: [], error: describeError(error) };
  }
}

/**
 * Turns `gh pr list --json` output into pull requests.
 *
 * Exported for testing, and that is where the real risk lives. Three traps, all met on real payloads:
 * an empty `reviewDecision` means "no review required" and is **not** an approval; a review requested
 * from a **team** has no `login` at all, so it must be skipped rather than crash the parse; and an empty
 * `statusCheckRollup` is `no-checks`, never `passing`.
 */
export function parsePullPayload(stdout: string, login: string): PullRequest[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout.trim() === '' ? '[]' : stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(payload)) {
    return [];
  }

  const pulls: PullRequest[] = [];
  for (const entry of payload) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const pr = entry as Record<string, unknown>;
    if (typeof pr.number !== 'number') {
      continue;
    }

    const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
    let passed = 0;
    let failed = 0;
    let pending = 0;
    for (const check of rollup) {
      switch (classifyCheck(check)) {
        case 'passed':
          passed += 1;
          break;
        case 'failed':
          failed += 1;
          break;
        case 'pending':
          pending += 1;
          break;
      }
    }

    const authorLogin = readLogin(pr.author);
    const reviewers = Array.isArray(pr.reviewRequests)
      ? pr.reviewRequests.map((request) => readLogin(request)).filter((name) => name.length > 0)
      : [];

    pulls.push({
      number: pr.number,
      title: typeof pr.title === 'string' ? pr.title : '',
      url: typeof pr.url === 'string' ? pr.url : '',
      branch: typeof pr.headRefName === 'string' ? pr.headRefName : '',
      authorLogin,
      isDraft: pr.isDraft === true,
      review: asReview(pr.reviewDecision),
      checks: verdictFor(rollup.length, passed, failed, pending),
      passed,
      failed,
      pending,
      // An empty login (no `gh` auth) must not make everything "mine".
      isAuthor: login.length > 0 && authorLogin === login,
      isReviewer: login.length > 0 && reviewers.includes(login),
      updatedAt: typeof pr.updatedAt === 'string' ? pr.updatedAt : '',
    });
  }
  return pulls;
}

/** A user carries a `login`; a team carries none, and is therefore not a person to compare against. */
function readLogin(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }
  const login = (value as { login?: unknown }).login;
  return typeof login === 'string' ? login : '';
}

function asReview(value: unknown): PrReview {
  switch (value) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes-requested';
    case 'REVIEW_REQUIRED':
      return 'review-required';
    default:
      // Includes the empty string `gh` returns when the repository requires no review.
      return 'none';
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: string }).stderr;
    if (typeof stderr === 'string' && stderr.trim().length > 0) {
      return stderr.trim().split(/\r?\n/)[0] ?? error.message;
    }
    return error.message;
  }
  return String(error);
}
