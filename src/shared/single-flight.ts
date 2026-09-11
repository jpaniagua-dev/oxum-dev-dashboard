/**
 * Running an expensive async job at most once at a time, without ever answering with stale state.
 *
 * The shape this solves is a read with two kinds of trigger. A **poll** fires it on a cadence, and a
 * **gesture** fires it because the user just changed the very thing it reads. Both call the same
 * function, and letting them overlap is what turned the two git-backed tabs of this app into an
 * unbounded number of child processes: each read is five to eighteen spawns, each spawn has roughly a
 * one-in-thirteen chance of blocking the process for over 100 ms, and two reads in flight simply
 * doubled that. Measured on 2026-09-09; see `main/concurrency.ts`.
 *
 * The naive guard is to hand a late caller the read already running. That is wrong for the gesture
 * trigger, and wrong in the way that is hard to see: a click that stages a file, arriving just after
 * a poll's read started, would be answered with the state from **before** it staged anything, and the
 * tab would keep showing that until the next poll seconds later. A click that appears to do nothing
 * is worse than a slow click.
 *
 * So this is single-flight with a trailing re-run: while a job runs, further calls set one flag, and
 * when it finishes the job runs exactly once more. Whatever happened during a read is therefore
 * always followed by a read that could see it, and the flag is a boolean rather than a counter
 * because ten calls during one read still only need one fresh answer. Concurrency stays at one.
 *
 * Callers get a promise that resolves when the work their call is covered by is done, so `await`
 * still means "the state is now current".
 */
export interface Flight {
  /** The job in flight, or null when nothing runs. */
  running: Promise<void> | null;
  /** Set when a call arrived mid-flight, so the job owes one more pass. */
  again: boolean;
}

/** A `Flight` in its resting state, for a field initialiser. */
export function idleFlight(): Flight {
  return { running: null, again: false };
}

export async function singleFlight(flight: Flight, job: () => Promise<void>): Promise<void> {
  if (flight.running !== null) {
    flight.again = true;
    return flight.running;
  }

  const cycle = (async (): Promise<void> => {
    try {
      await job();
      // Drains rather than re-entering: a gesture landing during the trailing pass sets the flag
      // again, and looping here keeps the whole chain under one `running` promise, so a caller
      // awaiting it is never handed a promise that settles before the pass its own call asked for.
      while (flight.again) {
        flight.again = false;
        await job();
      }
    } finally {
      flight.running = null;
      flight.again = false;
    }
  })();

  flight.running = cycle;
  return cycle;
}
