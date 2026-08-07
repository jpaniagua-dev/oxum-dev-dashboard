import type { TerminalCompat } from '@shared/contracts.js';

/**
 * Build number ConPTY became available at.
 *
 * `@lydell/node-pty` picks ConPTY over winpty on its own from this build up, and its `useConpty`
 * option is deprecated and ignored, so this is a report of what node-pty will do rather than a
 * setting: nothing here changes the spawn, it only tells the renderer what it is talking to.
 */
const CONPTY_MIN_BUILD = 18309;

/**
 * Reads the Windows build out of an `os.release()` string.
 *
 * The shape is `major.minor.build`, e.g. `10.0.26200`. Parsed rather than assumed because the whole
 * point of handing it to xterm is that its workarounds change at build 21376, so a wrong number is
 * worse than none: it would silently select the behaviour meant for the other era of ConPTY.
 *
 * A build of `0` is rejected along with the unparseable ones: it is what a release that merely looks
 * like the right shape yields (`6.11.0-24-generic` does), and it is not a build any Windows ever had.
 *
 * @returns the build, or `null` when the string is not that shape.
 */
export function parseWindowsBuild(release: string): number | null {
  const match = /^\d+\.\d+\.(\d+)/.exec(release.trim());
  const build = match?.[1];
  if (build === undefined) {
    return null;
  }
  const parsed = Number.parseInt(build, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Describes the pty backend the terminals run on, for xterm's `windowsPty` option.
 *
 * Pure, and taking the platform and release as arguments rather than reading `process` and `os`
 * itself, so the two branches that matter can be tested from a non-Windows CI as easily as from this
 * machine.
 *
 * @returns `null` off Windows, where xterm's default (Unix pty) assumptions are the right ones.
 */
export function terminalCompat(platform: string, release: string): TerminalCompat | null {
  if (platform !== 'win32') {
    return null;
  }
  const buildNumber = parseWindowsBuild(release);
  if (buildNumber === null) {
    return null;
  }
  return {
    backend: buildNumber >= CONPTY_MIN_BUILD ? 'conpty' : 'winpty',
    buildNumber,
  };
}
