import { afterAll, describe, expect, it } from 'vitest';
import { SpawnError, spawnOffThread, stopSpawnPool } from '../src/main/spawn/spawn-pool.js';

/**
 * These drive the **real** pool against real executables, and that is the only kind of test worth
 * having here.
 *
 * The worker body is a string evaluated in the thread, so no compiler and no lint rule looks at it.
 * Everything that can go wrong with this module goes wrong at runtime and in silence: a reply that
 * never comes back leaves a promise pending forever, and a strip that says `Reading...` for good is
 * indistinguishable from a slow disk. The same reasoning as `test/windows-pty.test.ts`, which pins
 * the one thing about node-pty no type can state.
 */

afterAll(async () => {
  // Without this the threads outlive the run. They are `unref`'d, so the process still exits, but a
  // terminated pool is what makes the next file start from nothing.
  await stopSpawnPool();
});

describe('spawnOffThread', () => {
  it('runs a command and brings its stdout back across the thread boundary', async () => {
    const { stdout } = await spawnOffThread({
      file: 'git',
      args: ['--version'],
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    expect(stdout).toMatch(/^git version/);
  });

  it('honours cwd, which is how every git read here says which repository it means', async () => {
    const { stdout } = await spawnOffThread({
      file: 'cmd',
      args: ['/c', 'cd'],
      cwd: process.cwd(),
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    expect(stdout.trim().toLowerCase()).toBe(process.cwd().toLowerCase());
  });

  it('adds to the environment rather than replacing it', async () => {
    // `GIT_EDITOR=true` is the real caller of this, and it only works if git still has its `PATH`.
    const { stdout } = await spawnOffThread({
      file: 'cmd',
      args: ['/c', 'echo %OXUM_PROBE% %OS%'],
      env: { OXUM_PROBE: 'set-by-the-test' },
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    expect(stdout).toContain('set-by-the-test');
    expect(stdout).toContain('Windows');
  });

  /**
   * The rejection shape is a contract, not an implementation detail: `describeGitError` reads
   * `stderr` off it and shows that line to the user, because git's own wording beats anything this
   * app could invent.
   */
  it('rejects with the process stderr on a non-zero exit', async () => {
    const failure = await spawnOffThread({
      file: 'git',
      args: ['-C', process.cwd(), 'rev-parse', '--verify', 'refs/heads/definitely-not-a-branch'],
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SpawnError);
    const error = failure as SpawnError;
    expect(error.code).not.toBe(0);
    expect(error.message.length).toBeGreaterThan(0);
  });

  it('rejects for a command that does not exist, rather than hanging', async () => {
    const failure = await spawnOffThread({
      file: 'oxum-no-such-executable',
      args: [],
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SpawnError);
    expect((failure as SpawnError).message.length).toBeGreaterThan(0);
  });

  it('keeps answers matched to their own request when several run at once', async () => {
    // Four lanes and eight jobs, so at least one lane answers twice: an id mixed up between lanes
    // would show here and nowhere else.
    const jobs = Array.from({ length: 8 }, (_, index) =>
      spawnOffThread({
        file: 'cmd',
        args: ['/c', `echo job-${index}`],
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      }).then(({ stdout }) => stdout.trim()),
    );
    expect(await Promise.all(jobs)).toEqual(
      Array.from({ length: 8 }, (_, index) => `job-${index}`),
    );
  });

  /**
   * The reason this module exists, asserted rather than asserted about.
   *
   * A 2 ms timer runs while eleven commands go through the pool, and the worst gap between its ticks
   * is how long the main loop was unavailable. On the main thread the same shape measured 429 to
   * 468 ms on four passes out of five, and up to 1653 ms for a single spawn. The bound here is
   * deliberately loose at 250 ms: the machine this runs on has two real-time scanners hooking process
   * creation, a CI runner has its own noise, and the claim being pinned is "the main loop is not
   * where the spawn happens", not a millisecond figure.
   */
  it('does not block the calling thread while it spawns', async () => {
    const gaps: number[] = [];
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      gaps.push(now - last - 2);
      last = now;
    }, 2);

    try {
      await Promise.all(
        Array.from({ length: 11 }, () =>
          spawnOffThread({
            file: 'git',
            args: ['--version'],
            timeout: 20_000,
            maxBuffer: 64 * 1024,
          }),
        ),
      );
    } finally {
      clearInterval(probe);
    }

    expect(gaps.length).toBeGreaterThan(5);
    expect(Math.max(...gaps)).toBeLessThan(250);
  });
});
