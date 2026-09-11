/**
 * Running the same async job over a list, a few at a time.
 *
 * This file is where the app keeps what it knows about the cost of starting a process, because that
 * cost is the reason the terminal used to stop echoing while you typed in it. The knowledge was
 * revised on 2026-09-09, and the revision matters more than the numbers: **the first analysis
 * measured the median, and the symptom lives in the tail.**
 *
 * The mechanism, unchanged and not in doubt. On Windows, libuv's `uv_spawn` calls `CreateProcessW`
 * **synchronously on the event loop thread of whoever calls it**, so a spawn is not work the loop has
 * to get through, it is time the loop is not running. A keystroke's echo travels renderer to main to
 * pty to main to renderer, so a blocked main process is literally a frozen terminal.
 *
 * What was wrong. Measured on 2026-09-02, `cmd /c exit` took 31 ms, `git --version` 37 ms and
 * `gh --version` 79 ms, and those figures were read as the price of a spawn. They are the **median
 * wall time of the whole call**, which is neither the blocking part nor representative. Measured
 * properly on 2026-09-09, over 150 sequential spawns, separating the part that runs before control
 * returns to the loop from the total:
 *
 * | command                    | sync p50 | sync p90 | sync p99 | sync max | share of spawns blocking >100 ms |
 * |----------------------------|----------|----------|----------|----------|----------------------------------|
 * | `cmd /c exit`              | 8 ms     | 22 ms    | 851 ms   | 1653 ms  | 9 %                              |
 * | `git status --porcelain=v2`| 8 ms     | 11 ms    | 833 ms   | 846 ms   | 6 %                              |
 *
 * So a spawn is **cheap nine times out of ten and catastrophic about one time in thirteen**. The
 * distribution is the same for a process that does nothing at all as for a real `git status`, which
 * is what proves it is process creation being hooked by the two real-time scanners on this machine
 * rather than git working. Their exclusion list is locked by policy and cannot be changed by whoever
 * runs this.
 *
 * **Why a pool was not enough, which is the practical consequence.** A concurrency limit spreads the
 * median out and does nothing at all to the tail: every spawn is still a ticket in the same lottery,
 * and running four at a time rather than eleven does not change a single ticket's odds. Measured on
 * the real eleven-project configuration, the projects table's poll, already reduced to one call per
 * project and already pooled at four, still blocked the main process for **429 to 468 ms on four
 * passes out of five**. That is the state the app shipped in at 5.9.0, and it is why the freezes
 * carried on after the first round of work.
 *
 * **The two levers that do work**, in the order they were applied:
 *
 * 1. **Spawn fewer times.** This scales the number of tickets, so it is real and it is where the
 *    obvious wins are. `readGitState` went from four calls to one; the Git tab's read from seven to
 *    four; the projects table's `Checks` column stopped being a `gh pr view` per project and became a
 *    join against the pull requests already read, worth eleven `gh` processes a minute. And the
 *    Worktrees tab stopped being re-read on every push of the row set, which was firing eighteen
 *    processes whenever a dev server printed a build marker.
 * 2. **Do not spawn on the main thread at all.** `main/spawn/spawn-pool.ts` runs every `execFile` in
 *    this app on a worker thread, which takes the main process out of the lottery instead of playing
 *    it more carefully. Same eleven calls, same pool of four: worst main-loop lag **529 ms on the main
 *    thread against 27 ms on a worker**, at the price of wall time on a background poll, where nobody
 *    is waiting. That file carries the full measurement.
 *
 * The pool below therefore keeps a smaller job than it was given at first. It is no longer what
 * protects the UI, since the spawns are not on its thread any more; it is what keeps this app from
 * putting forty-four processes on a machine at once, which is politeness to everything else running
 * and a bound on how much memory a poll can ask for. Worth keeping, worth not overselling.
 */

/**
 * How many child processes a poll may have in flight.
 *
 * Four, and it is now a load figure rather than a latency one: since the spawns happen on worker
 * threads, this decides how many processes the machine is asked for at once, not how long the UI
 * stops for. Kept at four because that is where the wall time of a poll stopped improving
 * measurably, and because `spawn-pool.ts` runs four lanes, so a caller already limited to four never
 * finds its next request queued behind a lane stuck in `CreateProcessW`. Not tuned per machine,
 * deliberately: a setting here would be a number nobody can choose well.
 */
export const POLL_CONCURRENCY = 4;

/**
 * How many child processes a read behind a visible tab may have in flight.
 *
 * Six, and the gap with `POLL_CONCURRENCY` is measured rather than a feeling. A poll runs over eleven
 * projects and nobody is waiting for it, so four keeps the machine's process load down at no visible
 * cost. The Git tab's read is five calls about one repository and it answers a click as well as the
 * poll, so its wall time is something a person sits through. Measured on 2026-09-09, that read
 * through the spawn pool:
 *
 * | in flight | mean wall | worst main-loop lag |
 * |---|---|---|
 * | 4 | 1068 ms | 15 ms |
 * | 6 |  173 ms | 14 ms |
 * | 8 |  168 ms | 14 ms |
 *
 * Four was the bottleneck and not the mechanism: the read has five calls, so a limit of four forced a
 * second wave and doubled the wall time. Six clears it, and eight buys nothing, which is what makes
 * six a number rather than a guess. It is also `WORKER_COUNT` in `spawn/spawn-pool.ts`, deliberately:
 * a read allowed six in flight finds six lanes waiting, and the two constants are meant to be equal.
 *
 * Note that 173 ms is **better** than the 285 ms this read measured when it fired all seven of its
 * old calls at once on the main thread, so nothing was traded away here. What the worker threads cost
 * is wall time on the reads that stay pooled at four, where it is invisible.
 */
export const VIEW_CONCURRENCY = 6;

/**
 * `Promise.all` over a fixed tuple of **different** jobs, at most `limit` of them in flight.
 *
 * The counterpart of {@link mapWithLimit} for the other shape a burst of spawns takes here. That one
 * runs one job over many items, which is the polls; this one runs a handful of unrelated reads that
 * together make up one view, which is the Git tab. Both need the same ceiling, for the reason spelled
 * out at the top of this file, and before this existed the second shape simply had no way to ask for
 * it: `Promise.all` has no limit, and pushing heterogeneous jobs through `mapWithLimit` collapses
 * their return types into a union that every call site then has to cast back apart.
 *
 * The mapped return type is what makes it worth writing: `allWithLimit(4, () => readBranches(p), () =>
 * readChanges(p))` destructures to `[GitBranch[], GitChange[]]` with no annotation and no cast, so
 * adding a read to a view cannot silently mistype the one next to it.
 */
export async function allWithLimit<T extends readonly (() => Promise<unknown>)[]>(
  limit: number,
  ...jobs: T
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const results = await mapWithLimit(jobs, limit, (job) => job());
  return results as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

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
