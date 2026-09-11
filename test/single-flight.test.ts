import { describe, expect, it } from 'vitest';
import { idleFlight, singleFlight } from '../src/shared/single-flight.js';

/** A job recording how many times it ran, resolvable from the test. */
function controllable(): {
  job: () => Promise<void>;
  runs: number;
  release: () => void;
} {
  const state = { runs: 0, release: (): void => undefined };
  const job = (): Promise<void> => {
    state.runs += 1;
    return new Promise<void>((resolve) => {
      state.release = resolve;
    });
  };
  return {
    job,
    get runs() {
      return state.runs;
    },
    release: () => state.release(),
  };
}

describe('singleFlight', () => {
  it('runs the job once when nothing overlaps', async () => {
    const flight = idleFlight();
    let runs = 0;
    await singleFlight(flight, async () => {
      runs += 1;
    });
    expect(runs).toBe(1);
    expect(flight.running).toBeNull();
  });

  it('never runs two jobs at the same time', async () => {
    const flight = idleFlight();
    let inFlight = 0;
    let peak = 0;
    const job = async (): Promise<void> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    };
    await Promise.all([
      singleFlight(flight, job),
      singleFlight(flight, job),
      singleFlight(flight, job),
    ]);
    expect(peak).toBe(1);
  });

  /**
   * The reason this helper exists rather than a plain "return the promise in flight" guard: a caller
   * arriving mid-flight is usually a gesture that has just changed what the job reads, so it needs a
   * pass that starts **after** it called, not the one already running.
   */
  it('re-runs once for calls that arrived mid-flight', async () => {
    const flight = idleFlight();
    const first = controllable();
    const done = singleFlight(flight, first.job);
    expect(first.runs).toBe(1);

    void singleFlight(flight, first.job);
    void singleFlight(flight, first.job);
    void singleFlight(flight, first.job);
    expect(first.runs).toBe(1);

    first.release();
    await Promise.resolve();
    // Exactly one extra pass for three late callers: they all want the same fresh answer.
    expect(first.runs).toBe(2);
    first.release();
    await done;
    expect(first.runs).toBe(2);
    expect(flight.running).toBeNull();
  });

  it('resolves a late caller only once the trailing pass is done', async () => {
    const flight = idleFlight();
    const controller = controllable();
    const leader = singleFlight(flight, controller.job);
    let lateSettled = false;
    const late = singleFlight(flight, controller.job).then(() => {
      lateSettled = true;
    });

    controller.release();
    await Promise.resolve();
    expect(lateSettled).toBe(false);

    controller.release();
    await Promise.all([leader, late]);
    expect(lateSettled).toBe(true);
  });

  it('clears the flight when the job throws, so the next call still runs', async () => {
    const flight = idleFlight();
    let runs = 0;
    const boom = async (): Promise<void> => {
      runs += 1;
      throw new Error('nope');
    };
    await expect(singleFlight(flight, boom)).rejects.toThrow('nope');
    expect(flight.running).toBeNull();
    expect(flight.again).toBe(false);
    await expect(singleFlight(flight, boom)).rejects.toThrow('nope');
    expect(runs).toBe(2);
  });
});
