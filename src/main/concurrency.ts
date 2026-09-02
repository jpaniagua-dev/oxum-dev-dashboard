/**
 * Running the same async job over a list, a few at a time.
 *
 * Exists for one measured reason. On Windows, libuv's `uv_spawn` calls `CreateProcessW`
 * **synchronously on the event loop thread**, so every child process this app starts blocks the main
 * process for as long as process creation takes. On a machine with corporate endpoint protection that
 * is not a rounding error: measured on 2026-09-02, `cmd /c exit`, a process that does nothing at all,
 * costs **31 ms**, `git --version` 37 ms and `gh --version` 79 ms, against 3 to 8 ms on an unmanaged
 * machine. Two real-time scanners hook process creation there and their exclusion list is locked by
 * policy, so the tax cannot be turned off by whoever runs this.
 *
 * A `Promise.all` over ten projects therefore did not merely keep the loop busy, it **blocked** it for
 * the sum of every spawn. Measured on the real configuration, worst timer lateness during one poll:
 *
 * | shape                                   | spawns | loop blocked |
 * |-----------------------------------------|--------|--------------|
 * | four git calls per project, all at once |     40 |   489 ms (1390 ms cold) |
 * | four git calls per project, pool of 4   |     40 |   208 ms |
 * | one git call per project, all at once   |     10 |    48 ms |
 * | one git call per project, pool of 4     |     10 |    10 ms |
 * | two `gh` calls per project, all at once |     20 |  1799 ms |
 * | two `gh` calls per project, pool of 4   |     20 |   392 ms |
 *
 * A keystroke's echo travels renderer to main to pty to main to renderer, so a blocked main loop is
 * literally a frozen terminal: that column is what the user was feeling.
 *
 * The pool does **not** reduce the total work, and that is worth being clear about: it converts one
 * long stall into several short ones. Cutting the number of spawns is the lever that reduces the work,
 * and it is applied first (`readGitState` went from four calls to one). This is the second lever, and
 * the only one available where the call count cannot be cut.
 */

/**
 * How many child processes a poll may have in flight.
 *
 * Four, from the table above: it is where the stall drops below one frame while the wall time stays
 * within a few percent of the unbounded version. Not tuned per machine, deliberately: a setting here
 * would be a number nobody can choose well, and the difference between 4 and 8 is invisible next to
 * the difference between 4 and unbounded.
 */
export const POLL_CONCURRENCY = 4;

/**
 * Maps `items` through `job`, at most `limit` of them in flight, results in the input order.
 *
 * Same contract as `Promise.all` in every way that matters to a caller: the results come back in the
 * order the items were given, whatever order they finished in, and the first rejection rejects the
 * whole call. Jobs already started are left to settle rather than being abandoned, `Promise` having no
 * cancellation; what stops is the **starting** of new ones. Every caller in this app hands in a job
 * that catches its own failures (a project that is not a repository is a row, not an exception), so
 * that path is a guard rather than a behaviour anyone relies on.
 *
 * `limit` is clamped to at least one: a zero would otherwise hang forever, which is the kind of thing
 * a hand-written call site gets wrong once.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  job: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: unknown = null;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      // Non-null: `index` is inside the array, which is what the check above establishes. Written this
      // way because `noUncheckedIndexedAccess` is on, and a `?? ` fallback here would invent an item.
      const item = items[index] as T;
      try {
        results[index] = await job(item, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, () => worker()),
  );

  if (failed) {
    throw failure;
  }
  return results;
}
