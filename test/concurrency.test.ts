import { describe, expect, it } from 'vitest';
import { POLL_CONCURRENCY, mapWithLimit } from '../src/main/concurrency.js';

/** Resolves after `ms`, so a test can create real overlap between jobs. */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithLimit', () => {
  it('returns the results in the INPUT order, whatever order they finished in', () => {
    // The reason this matters: the callers zip the results back onto project ids by position. A pool
    // that returned completion order would attach every state to the wrong project, and the table
    // would look plausible while being wrong about which repository is dirty.
    return expect(
      mapWithLimit([30, 5, 20, 1], 2, async (ms) => {
        await wait(ms);
        return ms;
      }),
    ).resolves.toEqual([30, 5, 20, 1]);
  });

  it('never has more than `limit` jobs in flight', async () => {
    // The whole point of the module. Verified by watching the overlap rather than by trusting the
    // arithmetic, because an off-by-one here is invisible: the work still completes, it just blocks
    // the event loop for longer than intended, which is the bug this was written to fix.
    let inFlight = 0;
    let peak = 0;

    await mapWithLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await wait(5);
      inFlight -= 1;
    });

    expect(peak).toBe(4);
  });

  it('runs everything, and only once each', async () => {
    const seen: number[] = [];
    await mapWithLimit(Array.from({ length: 15 }, (_, i) => i), 4, async (item) => {
      await wait(1);
      seen.push(item);
    });
    expect(seen).toHaveLength(15);
    expect(new Set(seen).size).toBe(15);
  });

  it('passes the index along, so a caller can key on position', async () => {
    const pairs = await mapWithLimit(['a', 'b', 'c'], 2, async (item, index) => `${index}:${item}`);
    expect(pairs).toEqual(['0:a', '1:b', '2:c']);
  });

  it('answers an empty array for an empty list, and starts nothing', async () => {
    let called = 0;
    expect(
      await mapWithLimit([], 4, async () => {
        called += 1;
      }),
    ).toEqual([]);
    expect(called).toBe(0);
  });

  it('rejects with the first failure, like Promise.all', async () => {
    const boom = new Error('boom');
    await expect(
      mapWithLimit([1, 2, 3], 2, async (item) => {
        await wait(1);
        if (item === 2) {
          throw boom;
        }
        return item;
      }),
    ).rejects.toBe(boom);
  });

  it('stops STARTING work after a failure', async () => {
    // Nothing already running is abandoned, `Promise` having no cancellation; what stops is the queue.
    // Without it, a repository that fails at item two would still pay for the eighteen after it.
    let started = 0;
    await expect(
      mapWithLimit(Array.from({ length: 40 }, (_, i) => i), 2, async (item) => {
        started += 1;
        await wait(1);
        if (item === 0) {
          throw new Error('boom');
        }
      }),
    ).rejects.toThrow('boom');
    expect(started).toBeLessThan(10);
  });

  it('treats a limit of zero or less as one rather than hanging forever', async () => {
    // A zero would leave no worker to pull from the queue: the promise never settles, and the app
    // silently stops refreshing. Cheap to clamp, and impossible to notice if it is not.
    await expect(mapWithLimit([1, 2], 0, async (item) => item)).resolves.toEqual([1, 2]);
    await expect(mapWithLimit([1, 2], -3, async (item) => item)).resolves.toEqual([1, 2]);
  });

  it('does not spawn more workers than there are items', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithLimit([1, 2], POLL_CONCURRENCY, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await wait(2);
      inFlight -= 1;
    });
    expect(peak).toBe(2);
  });
});
