import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkflowsState } from '@shared/contracts.js';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 20_000;

/**
 * How many runs to look at.
 *
 * `gh run list` returns the newest first, and a run that is still in flight was created moments ago:
 * anything unfinished is therefore near the top whatever the repository's history looks like. Twenty
 * is already far more than needed to answer a yes/no question.
 */
const LIMIT = 20;

/** Empty result reused for the "nothing to look up" cases. */
const NO_REPO: WorkflowsState = {
  verdict: 'no-repo',
  running: 0,
  queued: 0,
  checkedAt: null,
  error: null,
};

/**
 * Reads whether a repository has a GitHub Actions run in flight.
 *
 * `gh run list` and not `gh run watch`: the latter blocks until the run settles, which is right for a
 * terminal and useless for a strip that has to render now. Same trade-off, and the same reason, as
 * the checks service avoiding `gh pr checks --watch`.
 *
 * Queried by slug rather than by working directory, like the pull requests are: the answer is a
 * property of the repository on GitHub, so nothing here needs to depend on which folder it was cloned
 * into.
 *
 * @param slug `owner/name`, or `null` when the repository has no GitHub remote. A missing remote is a
 * state to report, not a lookup to attempt: `gh` would fail on it at every poll, forever.
 */
export async function readWorkflowsState(slug: string | null): Promise<WorkflowsState> {
  if (slug === null) {
    return { ...NO_REPO, checkedAt: new Date().toISOString() };
  }

  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['run', 'list', '--repo', slug, '--limit', String(LIMIT), '--json', 'status'],
      { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    return { ...parseRunsPayload(stdout), checkedAt: new Date().toISOString(), error: null };
  } catch (error) {
    return { ...NO_REPO, verdict: 'unknown', error: describeError(error) };
  }
}

/**
 * Turns `gh run list --json status` output into a verdict.
 *
 * Exported for testing, and the empty list is why: a repository that has never defined a workflow
 * answers `[]` with a zero exit code, exactly like one whose runs have all finished. Verified on a
 * real repository with no `.github/workflows` at all. The two are told apart here, so the column can
 * say "no runs" instead of implying an idle pipeline that does not exist.
 */
export function parseRunsPayload(stdout: string): Omit<WorkflowsState, 'checkedAt' | 'error'> {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    return { verdict: 'unknown', running: 0, queued: 0 };
  }
  if (!Array.isArray(payload)) {
    return { verdict: 'unknown', running: 0, queued: 0 };
  }
  if (payload.length === 0) {
    return { verdict: 'no-runs', running: 0, queued: 0 };
  }

  let running = 0;
  let queued = 0;

  for (const entry of payload) {
    switch (classifyRun(entry)) {
      case 'running':
        running += 1;
        break;
      case 'queued':
        queued += 1;
        break;
    }
  }

  return { verdict: running + queued > 0 ? 'running' : 'idle', running, queued };
}

/**
 * Classifies one run's `status`.
 *
 * A run carries `status` and `conclusion`, and only the first is read: `conclusion` describes how a
 * finished run ended, which is the question the checks column already answers for the branch that
 * matters. Here the only thing asked is whether something is still moving.
 *
 * An unrecognised status is `ignored` rather than counted as running. GitHub has added statuses to
 * this field before, and the failure modes are not symmetrical: guessing "running" would light the
 * column up permanently, and a column that is always on says nothing at all.
 */
export function classifyRun(entry: unknown): 'running' | 'queued' | 'done' | 'ignored' {
  if (typeof entry !== 'object' || entry === null) {
    return 'ignored';
  }
  const record = entry as Record<string, unknown>;
  const raw = (typeof record.status === 'string' ? record.status : '').toUpperCase();

  if (raw === 'IN_PROGRESS') {
    return 'running';
  }
  // Four ways of not having started yet: no runner free, a required approval, a concurrency group, a
  // deployment gate. They matter to whoever debugs the pipeline, not to a column whose whole question
  // is "is something coming".
  if (['QUEUED', 'WAITING', 'REQUESTED', 'PENDING'].includes(raw)) {
    return 'queued';
  }
  return raw === 'COMPLETED' ? 'done' : 'ignored';
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
