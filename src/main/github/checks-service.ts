import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChecksState, ChecksVerdict } from '@shared/contracts.js';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 20_000;

/** Empty result reused for the "nothing to look up" cases. */
const NO_PR: ChecksState = {
  verdict: 'no-pr',
  prNumber: null,
  prUrl: null,
  prTitle: null,
  isDraft: false,
  passed: 0,
  failed: 0,
  pending: 0,
  checkedAt: null,
  error: null,
};

/**
 * Reads the pull request and check status of a repository's current branch.
 *
 * Uses `gh pr view --json` rather than `gh pr checks --watch`: the latter blocks until every check
 * settles, which is right for a terminal and useless for a dashboard that must render now.
 *
 * @param hasUpstream Skip the call entirely when the branch was never pushed: no upstream means no
 * pull request can exist, and asking anyway costs a network round trip to learn nothing.
 */
export async function readChecksState(
  repoPath: string,
  hasUpstream: boolean,
): Promise<ChecksState> {
  if (!hasUpstream) {
    return { ...NO_PR, checkedAt: new Date().toISOString() };
  }

  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'view',
        '--json',
        'number,title,url,isDraft,statusCheckRollup',
      ],
      { cwd: repoPath, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    return { ...parsePrPayload(stdout), checkedAt: new Date().toISOString(), error: null };
  } catch (error) {
    const message = describeError(error);
    // `gh` exits non-zero with this message when the branch simply has no pull request, which is a
    // normal state rather than a failure worth showing in red.
    if (/no pull requests found/i.test(message)) {
      return { ...NO_PR, checkedAt: new Date().toISOString() };
    }
    return { ...NO_PR, verdict: 'unknown', error: message };
  }
}

/**
 * Turns `gh pr view --json` output into a verdict.
 *
 * Exported for testing, and the empty-rollup case is the reason: two open pull requests on the
 * real repository returned zero checks, and reporting that as green would be a lie. `no-checks`
 * therefore exists as its own verdict.
 */
export function parsePrPayload(stdout: string): Omit<ChecksState, 'checkedAt' | 'error'> {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    return { ...stripMeta(NO_PR), verdict: 'unknown' };
  }
  if (typeof payload !== 'object' || payload === null) {
    return { ...stripMeta(NO_PR), verdict: 'unknown' };
  }

  const pr = payload as Record<string, unknown>;
  const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];

  let passed = 0;
  let failed = 0;
  let pending = 0;

  for (const entry of rollup) {
    switch (classifyCheck(entry)) {
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

  return {
    verdict: verdictFor(rollup.length, passed, failed, pending),
    prNumber: typeof pr.number === 'number' ? pr.number : null,
    prUrl: typeof pr.url === 'string' ? pr.url : null,
    prTitle: typeof pr.title === 'string' ? pr.title : null,
    isDraft: pr.isDraft === true,
    passed,
    failed,
    pending,
  };
}

function verdictFor(
  total: number,
  passed: number,
  failed: number,
  pending: number,
): ChecksVerdict {
  if (total === 0) {
    return 'no-checks';
  }
  if (failed > 0) {
    return 'failing';
  }
  if (pending > 0) {
    return 'pending';
  }
  return passed > 0 ? 'passing' : 'no-checks';
}

/**
 * Classifies one rollup entry.
 *
 * The rollup mixes two shapes: check runs carry `status` plus `conclusion`, while commit statuses
 * carry only `state`. Reading a single field would silently drop half the entries.
 */
export function classifyCheck(entry: unknown): 'passed' | 'failed' | 'pending' | 'ignored' {
  if (typeof entry !== 'object' || entry === null) {
    return 'ignored';
  }
  const record = entry as Record<string, unknown>;
  const raw = (
    (typeof record.conclusion === 'string' && record.conclusion.length > 0
      ? record.conclusion
      : undefined) ??
    (typeof record.state === 'string' ? record.state : undefined) ??
    (typeof record.status === 'string' ? record.status : '')
  ).toUpperCase();

  if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(raw)) {
    return 'passed';
  }
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(raw)) {
    return 'failed';
  }
  if (['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED'].includes(raw)) {
    return 'pending';
  }
  return 'ignored';
}

/** Drops the fields the caller fills in itself, so the fallback shape stays in one place. */
function stripMeta(state: ChecksState): Omit<ChecksState, 'checkedAt' | 'error'> {
  return {
    verdict: state.verdict,
    prNumber: state.prNumber,
    prUrl: state.prUrl,
    prTitle: state.prTitle,
    isDraft: state.isDraft,
    passed: state.passed,
    failed: state.failed,
    pending: state.pending,
  };
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
