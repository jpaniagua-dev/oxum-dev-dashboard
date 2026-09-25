import { describe, expect, it } from 'vitest';
import {
  MODEL_PRICES,
  type ModelTokens,
  describeStatsAge,
  estimateTotal,
  formatTokens,
  localDay,
  parseHistory,
  parseStatsCache,
  priceFor,
  recentDays,
  statsAgeDays,
  summariseActivity,
} from '../src/shared/usage.js';

/**
 * Reading what the coding agent on this machine has been doing, out of its own files.
 *
 * The properties worth pinning are the honesty ones: an unknown model has no price rather than a
 * wrong one, an absent cache is not an empty one, and the cache's age is computed because the whole
 * tab hangs on it.
 */

describe('parseHistory', () => {
  it('reads the shape Claude Code actually writes', () => {
    const line = JSON.stringify({
      display: 'hello',
      pastedContents: {},
      timestamp: 1790351809565,
      project: 'C:\\Users\\dev\\workspace',
      sessionId: 'abc-123',
    });
    expect(parseHistory(line)).toEqual([
      { timestamp: 1790351809565, project: 'C:\\Users\\dev\\workspace', sessionId: 'abc-123' },
    ]);
  });

  it('drops a line it cannot parse rather than failing the whole read', () => {
    // Another program appends to this file, and a half-written last line is the normal way to catch
    // it. One prompt missing from a count beats an empty tab.
    const good = JSON.stringify({ timestamp: 1, project: 'p', sessionId: 's' });
    expect(parseHistory(`${good}\n{"timestamp": 2, "pro`)).toHaveLength(1);
  });

  it('drops a record with no usable timestamp', () => {
    // The one field that must be there: without it the entry lands on the epoch and puts a bar in
    // 1970 on every chart the panel draws.
    const lines = [
      JSON.stringify({ project: 'p', sessionId: 's' }),
      JSON.stringify({ timestamp: '1790351809565', project: 'p', sessionId: 's' }),
      JSON.stringify({ timestamp: 0, project: 'p', sessionId: 's' }),
    ].join('\n');
    expect(parseHistory(lines)).toEqual([]);
  });

  it('keeps a record whose project or session is missing', () => {
    // Those only remove it from one panel; the prompt still happened and still counts.
    const entries = parseHistory(JSON.stringify({ timestamp: 5 }));
    expect(entries).toEqual([{ timestamp: 5, project: '', sessionId: '' }]);
  });
});

describe('summariseActivity', () => {
  const at = (day: number, hour: number): number =>
    new Date(2026, 8, day, hour, 0, 0).getTime();

  it('counts a resumed session once, not once per run of prompts', () => {
    // The reason sessions are counted with a Set: a session is resumed, so its prompts are NOT
    // contiguous in the log, and counting transitions would report one session as three.
    const activity = summariseActivity([
      { timestamp: at(1, 9), project: 'a', sessionId: 's1' },
      { timestamp: at(1, 10), project: 'a', sessionId: 's2' },
      { timestamp: at(1, 11), project: 'a', sessionId: 's1' },
    ]);
    expect(activity.sessions).toBe(2);
    expect(activity.days).toEqual([{ date: '2026-09-01', prompts: 3, sessions: 2 }]);
  });

  it('buckets by LOCAL day, not by UTC', () => {
    // An evening after 01:00 CEST would move to the next day under `toISOString`, which is most of
    // an evening's work landing on tomorrow.
    expect(localDay(at(1, 23))).toBe('2026-09-01');
  });

  it('ranks projects by prompts and remembers when each was last touched', () => {
    const activity = summariseActivity([
      { timestamp: at(1, 9), project: 'quiet', sessionId: 's1' },
      { timestamp: at(1, 9), project: 'busy', sessionId: 's2' },
      { timestamp: at(2, 9), project: 'busy', sessionId: 's3' },
    ]);
    expect(activity.projects.map((p) => p.path)).toEqual(['busy', 'quiet']);
    expect(activity.projects[0]?.lastAt).toBe(at(2, 9));
  });

  it('leaves a day with nothing in it out of the list', () => {
    // Absent rather than zero: the chart draws what happened, and a run of empty bars for a holiday
    // is noise, not information.
    const activity = summariseActivity([
      { timestamp: at(1, 9), project: 'a', sessionId: 's1' },
      { timestamp: at(5, 9), project: 'a', sessionId: 's1' },
    ]);
    expect(activity.days.map((d) => d.date)).toEqual(['2026-09-01', '2026-09-05']);
  });

  it('answers a null last prompt for an empty history', () => {
    expect(summariseActivity([]).lastAt).toBeNull();
  });

  it('puts every hour in a 24-slot array even when nothing happened', () => {
    expect(summariseActivity([]).hours).toHaveLength(24);
  });
});

describe('recentDays', () => {
  const days = [
    { date: '2026-09-01', prompts: 1, sessions: 1 },
    { date: '2026-09-02', prompts: 2, sessions: 1 },
    { date: '2026-09-03', prompts: 3, sessions: 1 },
  ];

  it('takes the last few, in order', () => {
    expect(recentDays(days, 2).map((d) => d.date)).toEqual(['2026-09-02', '2026-09-03']);
  });

  it('returns everything when there is less than asked for', () => {
    expect(recentDays(days, 10)).toHaveLength(3);
  });
});

describe('parseStatsCache', () => {
  it('answers null for a shape it does not recognise, which is not the same as zero usage', () => {
    // An absent cache means Claude Code has not written one; a summary of zeroes would read as "you
    // have never used it". Same distinction as `no-runs` against `idle`.
    expect(parseStatsCache(null)).toBeNull();
    expect(parseStatsCache({})).toBeNull();
    expect(parseStatsCache('nope')).toBeNull();
  });

  it('reads the real shape and sorts the models by total tokens', () => {
    const stats = parseStatsCache({
      lastComputedDate: '2026-08-09',
      totalSessions: 286,
      totalMessages: 40930,
      firstSessionDate: '2026-03-24T17:41:10.995Z',
      modelUsage: {
        small: { inputTokens: 10, outputTokens: 10 },
        big: { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 20, costUSD: 0 },
      },
    });
    expect(stats?.models.map((m) => m.model)).toEqual(['big', 'small']);
    expect(stats?.models[0]?.cacheRead).toBe(20);
    expect(stats?.totalSessions).toBe(286);
  });

  it('reads a missing token field as zero rather than NaN', () => {
    const stats = parseStatsCache({ modelUsage: { m: {} } });
    expect(stats?.models[0]).toEqual({
      model: 'm',
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
    });
  });
});

describe('statsAgeDays', () => {
  const now = new Date(2026, 8, 25, 14, 0, 0);

  it('measures the real lag that made this tab necessary', () => {
    // Measured on the machine this was built for: the cache said 2026-08-09 on 2026-09-25.
    expect(statsAgeDays('2026-08-09', now)).toBe(47);
  });

  it('is zero for today and never negative for a cache from the future', () => {
    expect(statsAgeDays('2026-09-25', now)).toBe(0);
    expect(statsAgeDays('2026-09-30', now)).toBe(0);
  });

  it('answers null when the cache does not say', () => {
    expect(statsAgeDays('', now)).toBeNull();
    expect(statsAgeDays('last tuesday', now)).toBeNull();
  });

  it('says so in words, and names the day once it is not recent', () => {
    expect(describeStatsAge('2026-09-25', now)).toBe('Computed by Claude Code today');
    expect(describeStatsAge('2026-09-24', now)).toBe('Computed by Claude Code yesterday');
    expect(describeStatsAge('2026-08-09', now)).toContain('47 days ago, on 2026-08-09');
    expect(describeStatsAge('', now)).toContain('has not said');
  });
});

describe('priceFor', () => {
  it('matches an id carrying a date suffix', () => {
    expect(priceFor('claude-haiku-4-5-20251001')).toEqual(MODEL_PRICES['claude-haiku-4-5']);
  });

  it('has NO price for a model it does not know, and invents none', () => {
    // The decision this whole module turns on. The app this idea came from falls through a
    // substring chain onto a default, so an unpriced model is billed at another model's rate and
    // nothing on screen says so.
    expect(priceFor('claude-opus-5')).toBeNull();
    expect(priceFor('claude-sonnet-5')).toBeNull();
    expect(priceFor('claude-fable-5')).toBeNull();
    expect(priceFor('something-else-entirely')).toBeNull();
  });
});

describe('estimateTotal', () => {
  const model = (over: Partial<ModelTokens>): ModelTokens => ({
    model: 'claude-sonnet-4-6',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    ...over,
  });

  it('prices what it can and names what it cannot', () => {
    const estimate = estimateTotal([
      model({ input: 1_000_000 }),
      model({ model: 'claude-opus-5', input: 1_000_000 }),
    ]);
    expect(estimate.total).toBe(3);
    expect(estimate.unpricedModels).toEqual(['claude-opus-5']);
  });

  it('prefers the figure Claude Code recorded over our own table', () => {
    // A number the vendor computed beats one derived from a price list in a source file.
    const estimate = estimateTotal([model({ input: 1_000_000, costUsd: 99 })]);
    expect(estimate.total).toBe(99);
  });

  it('does not report an unpriced model that used nothing', () => {
    // Every model Claude Code has ever seen is in that cache, including ones with zero tokens.
    // Listing them as "missing a price" would be a warning about nothing.
    expect(estimateTotal([model({ model: 'claude-opus-5' })]).unpriced).toBe(0);
  });

  it('is zero over no models at all', () => {
    expect(estimateTotal([])).toEqual({ total: 0, unpriced: 0, unpricedModels: [] });
  });
});

describe('formatTokens', () => {
  it('reads for order of magnitude, never digit by digit', () => {
    expect(formatTokens(912)).toBe('912');
    expect(formatTokens(847_000)).toBe('847k');
    expect(formatTokens(12_300_000)).toBe('12.3M');
  });
});
