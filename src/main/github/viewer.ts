import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Resolved once and kept: the signed-in account does not change while the app runs. */
let cached: string | null = null;

/**
 * The GitHub login of whoever is signed in to `gh`.
 *
 * Needed to answer "is this pull request mine": the payload carries logins, so the comparison happens
 * locally rather than by asking GitHub to filter, which would cost two calls per repository.
 *
 * Returns an empty string when `gh` is not authenticated. That degrades gracefully: no pull request is
 * then attributed to the user, rather than the whole tab failing.
 */
export async function readViewerLogin(): Promise<string> {
  if (cached !== null) {
    return cached;
  }
  try {
    const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login'], {
      timeout: 15_000,
      windowsHide: true,
    });
    cached = stdout.trim();
  } catch {
    cached = '';
  }
  return cached;
}
