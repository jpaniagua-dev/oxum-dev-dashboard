import type { BotFinding } from '@shared/contracts.js';
import { spawnOffThread } from '../spawn/spawn-pool.js';
import { parseBotComments } from './bot-findings.js';
import { parseReviewComments, type ReviewComment } from './review-comments.js';

/**
 * Everything a review needs to read off a pull request, and nothing that writes.
 *
 * Separate from `gh-write.ts` on purpose, and the split is the point: one module reads, one module
 * writes, and "does this touch GitHub?" is answered by an import rather than by reading a function
 * body. Every call here goes through `spawnOffThread`, the app-wide rule that a bare `execFile` in
 * the main process is a bug.
 */

const TIMEOUT_MS = 25_000;
/** A patch is the biggest thing this app reads from `gh`; the default 1 MB would truncate a real one. */
const PATCH_BUFFER = 16 * 1024 * 1024;

/**
 * Environment every `gh` call runs under.
 *
 * `gh` that decides to prompt, page or colour its output is `gh` that either hangs until the timeout
 * or answers with escape codes in the middle of a JSON document. A hung call is the worst outcome
 * available here, because it is the one whose result cannot be classified.
 */
const GH_ENV = {
  ...process.env,
  GH_PROMPT_DISABLED: '1',
  GH_PAGER: 'cat',
  NO_COLOR: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
};

/** What one pull request looks like at the moment it is read. */
export interface PullDetail {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly authorLogin: string;
  readonly isDraft: boolean;
  /** `OPEN`, `CLOSED` or `MERGED`, as `gh` spells it. */
  readonly state: string;
  readonly changedFiles: number;
}

export interface ReadResult<T> {
  readonly value: T | null;
  readonly error: string | null;
}

/**
 * The pull request as it stands right now.
 *
 * Read again even though the poll already listed it, and that is not waste: the poll is up to three
 * minutes old, and this answer is what a write is allowed to depend on. It is called twice around a
 * run, once to capture the sha being reviewed and once to check it has not moved.
 */
export async function readPullDetail(slug: string, number: number): Promise<ReadResult<PullDetail>> {
  const fields = [
    'number',
    'title',
    'body',
    'headRefName',
    'baseRefName',
    'headRefOid',
    'baseRefOid',
    'author',
    'isDraft',
    'state',
    'changedFiles',
  ].join(',');

  try {
    const { stdout } = await spawnOffThread({
      file: 'gh',
      args: ['pr', 'view', String(number), '--repo', slug, '--json', fields],
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: GH_ENV,
    });
    const raw: unknown = JSON.parse(stdout);
    if (typeof raw !== 'object' || raw === null) {
      return { value: null, error: 'gh answered something that is not a pull request' };
    }
    const pr = raw as Record<string, unknown>;
    return {
      value: {
        number: typeof pr['number'] === 'number' ? pr['number'] : number,
        title: text(pr['title']),
        body: text(pr['body']),
        branch: text(pr['headRefName']),
        baseRef: text(pr['baseRefName']),
        headSha: text(pr['headRefOid']),
        baseSha: text(pr['baseRefOid']),
        authorLogin: login(pr['author']),
        isDraft: pr['isDraft'] === true,
        // Unknown reads as not open, so nothing is written to a pull request whose state did not parse.
        state: text(pr['state']) || 'UNKNOWN',
        changedFiles: typeof pr['changedFiles'] === 'number' ? pr['changedFiles'] : 0,
      },
      error: null,
    };
  } catch (error) {
    return { value: null, error: describeError(error) };
  }
}

/**
 * The patch, pinned to the sha that was captured.
 *
 * `compare/<base>...<head>` rather than `gh pr diff`, which resolves the head itself at the moment
 * it runs: a push landing between the two calls would have the run read one commit and attribute its
 * verdict to another. Pinning costs nothing and removes the whole question.
 */
export async function readPatch(
  slug: string,
  baseSha: string,
  headSha: string,
): Promise<ReadResult<string>> {
  try {
    const { stdout } = await spawnOffThread({
      file: 'gh',
      args: [
        'api',
        '-H',
        'Accept: application/vnd.github.v3.diff',
        `repos/${slug}/compare/${baseSha}...${headSha}`,
      ],
      timeout: TIMEOUT_MS,
      maxBuffer: PATCH_BUFFER,
      env: GH_ENV,
    });
    return { value: stdout, error: null };
  } catch (error) {
    return { value: null, error: describeError(error) };
  }
}

/**
 * The review bot's inline comments.
 *
 * `GET /pulls/{n}/comments` and **not** `gh pr view --json comments`, which returns issue comments
 * only. The bot's remarks are inline review comments, so reading the wrong collection comes back
 * empty and reads as "the bot found nothing", which is the most consequential mistake available in
 * this feature: it would turn a pull request the bot flagged into one that looks clean.
 */
export async function readBotFindings(
  slug: string,
  number: number,
  botLogin: string,
): Promise<ReadResult<BotFinding[]>> {
  try {
    const { stdout } = await spawnOffThread({
      file: 'gh',
      args: ['api', '--paginate', `repos/${slug}/pulls/${number}/comments`],
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: GH_ENV,
    });
    return { value: parseBotComments(JSON.parse(stdout), botLogin), error: null };
  } catch (error) {
    return { value: null, error: describeError(error) };
  }
}

/**
 * Every inline comment on the pull request, the bot's and the humans' alike.
 *
 * The **same endpoint** `readBotFindings` reads, and that is the point: the feedback watcher wants the
 * whole collection and gets the bot's subset by filtering, so a poll costs one call and not two. Never
 * call both in the same tick.
 *
 * ⚠️ Named blind spot, and it is deliberate: a reviewer who submits `CHANGES_REQUESTED` with a body and
 * no inline comment produces **zero rows here**, and that is the strongest feedback there is. Reading
 * `/pulls/{n}/reviews` as well would double the cost per pull request and add a second watermark axis,
 * so it is out of scope; it is written down because the miss is silent and reads as a broken watcher.
 */
export async function readReviewComments(
  slug: string,
  number: number,
): Promise<ReadResult<ReviewComment[]>> {
  try {
    const { stdout } = await spawnOffThread({
      file: 'gh',
      args: ['api', '--paginate', `repos/${slug}/pulls/${number}/comments`],
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: GH_ENV,
    });
    return { value: parseReviewComments(JSON.parse(stdout)), error: null };
  } catch (error) {
    return { value: null, error: describeError(error) };
  }
}

/** One review already on the pull request, reduced to what idempotency needs. */
export interface ExistingReview {
  readonly authorLogin: string;
  readonly state: string;
  readonly body: string;
  readonly submittedAt: string;
}

/**
 * Reviews already submitted on the pull request.
 *
 * What makes a second run silent rather than repetitive: the marker in a body of ours says what was
 * already said and at which sha, and a `CHANGES_REQUESTED` of the user's own **without** a marker
 * says they reviewed this by hand, which the agent never stacks on top of.
 */
export async function readReviews(slug: string, number: number): Promise<ReadResult<ExistingReview[]>> {
  try {
    const { stdout } = await spawnOffThread({
      file: 'gh',
      args: ['api', '--paginate', `repos/${slug}/pulls/${number}/reviews`],
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: GH_ENV,
    });
    const raw: unknown = JSON.parse(stdout);
    if (!Array.isArray(raw)) {
      return { value: [], error: null };
    }
    return {
      value: raw.filter(isObject).map((entry) => {
        const review = entry as Record<string, unknown>;
        return {
          authorLogin: login(review['user']),
          state: text(review['state']),
          body: text(review['body']),
          submittedAt: text(review['submitted_at']),
        };
      }),
      error: null,
    };
  } catch (error) {
    return { value: null, error: describeError(error) };
  }
}

/** Paths the patch touches, which is the authority on what a finding may name. */
export function patchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ b/')) {
      paths.add(line.slice('+++ b/'.length).trim());
    }
  }
  paths.delete('/dev/null');
  return [...paths];
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function login(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }
  const name = (value as { login?: unknown }).login;
  return typeof name === 'string' ? name : '';
}

/**
 * The first line `gh` had to say about the failure.
 *
 * Its own copy rather than a shared helper, matching `pulls-service.ts` and `runs-service.ts`: three
 * call sites with the same four lines is a smell, but a shared one would have to grow options for
 * `gh api`, whose message arrives as JSON on stdout rather than on stderr.
 */
function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const failure = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    // `gh api` puts GitHub's own message on stdout, as JSON. It is the useful one when it is there.
    if (typeof failure.stdout === 'string' && failure.stdout.includes('"message"')) {
      try {
        const parsed: unknown = JSON.parse(failure.stdout);
        const message = (parsed as { message?: unknown }).message;
        if (typeof message === 'string' && message.length > 0) {
          return message;
        }
      } catch {
        // Not JSON after all; fall through to stderr.
      }
    }
    if (typeof failure.stderr === 'string' && failure.stderr.trim().length > 0) {
      return failure.stderr.trim().split('\n')[0] ?? 'gh failed';
    }
    if (typeof failure.message === 'string' && failure.message.length > 0) {
      return failure.message;
    }
  }
  return String(error);
}
