import { readFile } from 'node:fs/promises';
import type {
  BotFinding,
  PostedReview,
  PullFinding,
  PullReview,
  PullReviewRun,
  PullReviewSkips,
  PullVerdict,
} from '@shared/contracts.js';
import { PULL_VERDICTS } from '@shared/contracts.js';
import { reviewKey } from '@shared/pull-review.js';
import { atomicWriteFile } from '../store/atomic-write.js';
import { AppPaths } from '../store/paths.js';

/**
 * The last review of each pull request, and the last run over each repository, kept on disk.
 *
 * Keyed `owner/repo#12` and **not** by project id: a project can be renamed, re-pathed, un-followed
 * and followed again, while the pull request keeps its identity. The stored fact is about the pull
 * request, so it is filed under the pull request's name.
 *
 * Read back defensively key by key, like `triage.json`, and that matters more here: a row carries
 * what was posted publicly, so a half-read one would either hide a review that exists or claim one
 * that does not.
 */
export class PullReviewStore {
  private reviews = new Map<string, PullReview>();
  private runs = new Map<string, PullReviewRun>();

  async load(): Promise<void> {
    try {
      const raw = await readFile(AppPaths.pullReviews(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) {
        return;
      }
      const file = parsed as { reviews?: unknown; runs?: unknown };
      for (const [key, value] of Object.entries(asRecord(file.reviews))) {
        const review = readReview(value);
        if (review !== null) {
          this.reviews.set(key, review);
        }
      }
      for (const [key, value] of Object.entries(asRecord(file.runs))) {
        const run = readRun(value);
        if (run !== null) {
          this.runs.set(key, run);
        }
      }
    } catch {
      // No file yet, or one left unreadable. An empty history is the correct starting state, and
      // refusing to start over a corrupt cache would be worse than losing it.
    }
  }

  get(slug: string, number: number): PullReview | undefined {
    return this.reviews.get(reviewKey(slug, number));
  }

  /**
   * Head sha per pull request, which is what `new` mode subtracts.
   *
   * A map rather than a set of keys: `new` does not mean "never reviewed", it means "not reviewed at
   * its current head", so the sha has to travel with the key.
   */
  reviewedHeads(): Map<string, string> {
    const heads = new Map<string, string>();
    for (const [key, review] of this.reviews) {
      heads.set(key, review.headSha);
    }
    return heads;
  }

  save(review: PullReview): void {
    this.reviews.set(reviewKey(review.slug, review.number), review);
  }

  saveRun(run: PullReviewRun): void {
    this.runs.set(run.slug, run);
  }

  /**
   * Drops one review from the list.
   *
   * Local to this file: the pull request is untouched, and anything already posted stays posted,
   * which is the honest half. Reviewing it again brings the row back.
   *
   * The **run record is kept** when its last review goes, the same rule that keeps an empty triage
   * result: `ranAt` is what says a repository was looked at, and dropping it would make one you
   * cleared look like one nobody ever ran.
   */
  remove(slug: string, number: number): boolean {
    return this.reviews.delete(reviewKey(slug, number));
  }

  snapshot(): { reviews: Record<string, PullReview>; runs: Record<string, PullReviewRun> } {
    return {
      reviews: Object.fromEntries(this.reviews),
      runs: Object.fromEntries(this.runs),
    };
  }

  async write(): Promise<void> {
    await atomicWriteFile(AppPaths.pullReviews(), `${JSON.stringify(this.snapshot(), null, 2)}\n`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Validates one stored review.
 *
 * A row without a slug, a number or a verdict is **dropped rather than repaired**: a half-read
 * review would put a verdict on screen that nobody computed, and here it could also make the app
 * believe something was already posted when it was not.
 */
function readReview(value: unknown): PullReview | null {
  const record = asRecord(value);
  if (typeof record['slug'] !== 'string' || typeof record['number'] !== 'number') {
    return null;
  }
  const verdict = readVerdict(record['verdict']);
  if (verdict === null) {
    return null;
  }
  return {
    slug: record['slug'],
    number: record['number'],
    title: text(record['title']),
    branch: text(record['branch']),
    authorLogin: text(record['authorLogin']),
    headSha: text(record['headSha']),
    verdict,
    summary: text(record['summary']),
    findings: readFindings(record['findings']),
    changedFiles: count(record['changedFiles']),
    oversized: record['oversized'] === true,
    // Absent reads as NOT postable. An old row that gained the field by default would be one the
    // app is willing to write about, which is the direction never to guess in.
    postable: record['postable'] === true,
    bot: readBotFindings(record['bot']),
    reviewedAt: text(record['reviewedAt']),
    posted: readPosted(record['posted']),
    error: typeof record['error'] === 'string' ? record['error'] : null,
  };
}

function readRun(value: unknown): PullReviewRun | null {
  const record = asRecord(value);
  if (typeof record['slug'] !== 'string') {
    return null;
  }
  const skipped = asRecord(record['skipped']);
  const skips: PullReviewSkips = {
    draft: count(skipped['draft']),
    bot: count(skipped['bot']),
    blocked: count(skipped['blocked']),
    alreadyReviewed: count(skipped['alreadyReviewed']),
    tooLarge: count(skipped['tooLarge']),
    overLimit: count(skipped['overLimit']),
  };
  return {
    slug: record['slug'],
    ranAt: text(record['ranAt']),
    skipped: skips,
    deferred: Array.isArray(record['deferred'])
      ? record['deferred'].filter((entry): entry is string => typeof entry === 'string')
      : [],
    error: typeof record['error'] === 'string' ? record['error'] : null,
  };
}

/** An unknown verdict drops the row rather than becoming `unclear`: see `readReview`. */
function readVerdict(value: unknown): PullVerdict | null {
  if (typeof value !== 'string') {
    return null;
  }
  return PULL_VERDICTS.find((verdict) => verdict === value) ?? null;
}

function readFindings(value: unknown): PullFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    if (typeof record['id'] !== 'string' || typeof record['body'] !== 'string') {
      return [];
    }
    return [
      {
        id: record['id'],
        path: text(record['path']),
        line: typeof record['line'] === 'number' ? record['line'] : null,
        blocking: record['blocking'] === true,
        body: record['body'],
      },
    ];
  });
}

function readBotFindings(value: unknown): BotFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    if (typeof record['body'] !== 'string') {
      return [];
    }
    return [
      {
        path: text(record['path']),
        line: typeof record['line'] === 'number' ? record['line'] : null,
        severity: text(record['severity']),
        body: record['body'],
      },
    ];
  });
}

/**
 * What was posted, or `null`.
 *
 * A record with no `reviewId` is read as **not posted**. The id is what makes a review dismissable,
 * so a row claiming a post it cannot point at is worse than one claiming nothing.
 */
function readPosted(value: unknown): PostedReview | null {
  const record = asRecord(value);
  const event = record['event'];
  if (typeof record['reviewId'] !== 'number') {
    return null;
  }
  if (event !== 'request-changes' && event !== 'comment' && event !== 'approve') {
    return null;
  }
  return {
    at: text(record['at']),
    headSha: text(record['headSha']),
    event,
    url: text(record['url']),
    reviewId: record['reviewId'],
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Clamped rather than trusted: these numbers are printed in a sentence about what a run left out. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
