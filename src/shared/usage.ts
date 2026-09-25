/**
 * What the coding agent on this machine has actually been doing.
 *
 * Read from Claude Code's own files and from nowhere else: no API key, no network call, no vendor
 * CLI. Two files, and the split between them is the whole design of this tab, because **they do not
 * agree about what "now" means**.
 *
 * - `~/.claude/history.jsonl` is appended on every prompt, so it is live to the second. It carries
 *   the timestamp, the project path and the session id, which is enough for activity by day, by
 *   hour and by project. It carries **no tokens**.
 * - `~/.claude/stats-cache.json` is the only place per-model token counts exist, and it is a CACHE
 *   that Claude Code recomputes on its own schedule. Measured on the machine this was written for:
 *   `lastComputedDate` was six weeks behind the day it was read. A tab presenting those totals as
 *   current would be confidently and invisibly wrong, which is why `describeStatsAge` exists and
 *   why the panel leads with it.
 *
 * Deliberately NOT read: the message bodies under `~/.claude/projects/`. They hold per-message usage
 * and reading them means parsing every transcript on the machine on every glance at a tab, which is
 * the cost this app refuses everywhere else. If tokens ever need to be current, that is the source,
 * and the price is a cache of our own.
 */

/* ------------------------------------------------------------------ *
 * The live half: history.jsonl
 * ------------------------------------------------------------------ */

/** One prompt, as the history log records it. */
export interface HistoryEntry {
  readonly timestamp: number;
  readonly project: string;
  readonly sessionId: string;
}

/**
 * Reads the history log, dropping what it cannot use.
 *
 * Line-delimited JSON written by another program, so a line is dropped rather than repaired: the
 * house rule, and here the stakes are low because a dropped line is one prompt missing from a
 * count. A record with no usable timestamp is the one that must go, since it would land on the
 * epoch and put a bar in 1970 on every chart.
 */
export function parseHistory(text: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof payload !== 'object' || payload === null) {
      continue;
    }
    const record = payload as Record<string, unknown>;
    const timestamp = record['timestamp'];
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
      continue;
    }
    entries.push({
      timestamp,
      project: typeof record['project'] === 'string' ? record['project'] : '',
      sessionId: typeof record['sessionId'] === 'string' ? record['sessionId'] : '',
    });
  }
  return entries;
}

/** Prompts and distinct sessions on one calendar day, local time. */
export interface UsageDay {
  /** `YYYY-MM-DD`, in the reader's own timezone. */
  readonly date: string;
  readonly prompts: number;
  readonly sessions: number;
}

/** How many prompts a project took, and when it was last touched. */
export interface UsageProject {
  readonly path: string;
  readonly prompts: number;
  readonly sessions: number;
  readonly lastAt: number;
}

export interface UsageActivity {
  /** Oldest first, one entry per day that has anything in it. Days with nothing are absent. */
  readonly days: readonly UsageDay[];
  /** 24 counts, index 0 to 23, in local time. */
  readonly hours: readonly number[];
  /** Busiest first. */
  readonly projects: readonly UsageProject[];
  readonly prompts: number;
  readonly sessions: number;
  /** The most recent prompt, which is what says whether this half is live. */
  readonly lastAt: number | null;
}

/**
 * A local calendar day, as `YYYY-MM-DD`.
 *
 * Local and not UTC, deliberately: the question is "what did I do yesterday", and yesterday is a
 * day in the reader's own timezone. `toISOString` would move every evening after 01:00 CEST into
 * the next day, which is most of an evening's work.
 */
export function localDay(timestamp: number): string {
  const at = new Date(timestamp);
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${String(at.getFullYear())}-${month}-${day}`;
}

/**
 * Rolls the history up into what the panel draws.
 *
 * One pass, and the sessions are counted with a `Set` per bucket rather than by comparing
 * consecutive records: a session is resumed, so its prompts are not contiguous in the log, and
 * counting transitions would report one session as several.
 */
export function summariseActivity(entries: readonly HistoryEntry[]): UsageActivity {
  const days = new Map<string, { prompts: number; sessions: Set<string> }>();
  const projects = new Map<string, { prompts: number; sessions: Set<string>; lastAt: number }>();
  const hours = new Array<number>(24).fill(0);
  const sessions = new Set<string>();
  let lastAt: number | null = null;

  for (const entry of entries) {
    const key = localDay(entry.timestamp);
    const day = days.get(key) ?? { prompts: 0, sessions: new Set<string>() };
    day.prompts += 1;
    if (entry.sessionId.length > 0) {
      day.sessions.add(entry.sessionId);
      sessions.add(entry.sessionId);
    }
    days.set(key, day);

    const hour = new Date(entry.timestamp).getHours();
    hours[hour] = (hours[hour] ?? 0) + 1;

    if (entry.project.length > 0) {
      const project = projects.get(entry.project) ?? {
        prompts: 0,
        sessions: new Set<string>(),
        lastAt: 0,
      };
      project.prompts += 1;
      project.lastAt = Math.max(project.lastAt, entry.timestamp);
      if (entry.sessionId.length > 0) {
        project.sessions.add(entry.sessionId);
      }
      projects.set(entry.project, project);
    }

    lastAt = lastAt === null ? entry.timestamp : Math.max(lastAt, entry.timestamp);
  }

  return {
    days: [...days.entries()]
      .map(([date, value]) => ({ date, prompts: value.prompts, sessions: value.sessions.size }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    hours,
    projects: [...projects.entries()]
      .map(([path, value]) => ({
        path,
        prompts: value.prompts,
        sessions: value.sessions.size,
        lastAt: value.lastAt,
      }))
      .sort((a, b) => b.prompts - a.prompts),
    prompts: entries.length,
    sessions: sessions.size,
    lastAt,
  };
}

/** The last `count` days that hold anything, oldest first. */
export function recentDays(days: readonly UsageDay[], count: number): readonly UsageDay[] {
  return count <= 0 ? [] : days.slice(Math.max(0, days.length - count));
}

/* ------------------------------------------------------------------ *
 * The cached half: stats-cache.json
 * ------------------------------------------------------------------ */

export interface ModelTokens {
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /**
   * What Claude Code itself recorded, which is `0` for a subscription.
   *
   * Kept apart from our estimate rather than merged into it: a real figure and a computed one are
   * two different claims, and the panel says which it is showing.
   */
  readonly costUsd: number;
}

export interface UsageStats {
  /** `YYYY-MM-DD`, the day Claude Code last rebuilt this cache. */
  readonly lastComputedDate: string;
  readonly models: readonly ModelTokens[];
  readonly totalSessions: number;
  readonly totalMessages: number;
  readonly firstSessionDate: string;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Reads the stats cache, and answers `null` for a shape it does not recognise.
 *
 * `null` rather than an empty summary, because the two mean different things to the reader: an
 * absent cache is "Claude Code has not written one", and a summary of zeroes would read as "you
 * have never used it". Same distinction the Workflows column draws between `no-runs` and `idle`.
 */
export function parseStatsCache(payload: unknown): UsageStats | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const usage = record['modelUsage'];
  if (typeof usage !== 'object' || usage === null) {
    return null;
  }
  const models: ModelTokens[] = [];
  for (const [model, value] of Object.entries(usage as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const entry = value as Record<string, unknown>;
    models.push({
      model,
      input: asCount(entry['inputTokens']),
      output: asCount(entry['outputTokens']),
      cacheRead: asCount(entry['cacheReadInputTokens']),
      cacheWrite: asCount(entry['cacheCreationInputTokens']),
      costUsd: asCount(entry['costUSD']),
    });
  }
  return {
    lastComputedDate:
      typeof record['lastComputedDate'] === 'string' ? record['lastComputedDate'] : '',
    models: models.sort((a, b) => totalTokens(b) - totalTokens(a)),
    totalSessions: asCount(record['totalSessions']),
    totalMessages: asCount(record['totalMessages']),
    firstSessionDate:
      typeof record['firstSessionDate'] === 'string' ? record['firstSessionDate'] : '',
  };
}

export function totalTokens(model: ModelTokens): number {
  return model.input + model.output + model.cacheRead + model.cacheWrite;
}

/**
 * How far behind the cache is, in days, or `null` when it does not say.
 *
 * The most important number on this tab, and the reason is measured rather than theoretical: on the
 * machine this was built for the cache was 47 days behind on the day it was read, so every token
 * count and every cost below it described a month and a half ago.
 */
export function statsAgeDays(lastComputedDate: string, now: Date): number | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lastComputedDate);
  if (parts === null) {
    return null;
  }
  const at = new Date(
    Number(parts[1]),
    Number(parts[2]) - 1,
    Number(parts[3]),
  ).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.max(0, Math.round((today - at) / 86_400_000));
}

/** The sentence the panel puts above the token counts. */
export function describeStatsAge(lastComputedDate: string, now: Date): string {
  const days = statsAgeDays(lastComputedDate, now);
  if (days === null) {
    return 'Claude Code has not said when it last computed these';
  }
  if (days === 0) {
    return 'Computed by Claude Code today';
  }
  if (days === 1) {
    return 'Computed by Claude Code yesterday';
  }
  return `Computed by Claude Code ${String(days)} days ago, on ${lastComputedDate}`;
}

/**
 * Past this, the token counts are old enough that the panel says so in the warning colour.
 *
 * Two days rather than one: the cache is rebuilt on Claude Code's own schedule and a day's lag is
 * normal, while a week's lag means it has stopped.
 */
export const STATS_STALE_AFTER_DAYS = 2;

/* ------------------------------------------------------------------ *
 * Cost, which is an estimate and is labelled as one
 * ------------------------------------------------------------------ */

export interface ModelPrice {
  /** US dollars per million tokens. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/**
 * The published list price per million tokens, as of the date below.
 *
 * ⚠️ **A price table in source is a fact that goes stale without telling anybody**, which is why
 * `PRICES_AS_OF` sits next to it and is printed in the panel. The app this idea came from carries
 * the same table and has already fallen behind: its newest entry is a generation old, and every
 * model it does not know falls through a substring chain onto a default price, so it reports a
 * confident wrong number rather than no number.
 *
 * This one does the opposite, and that is the one design decision here: **an unknown model has no
 * price and is said to have none.** A total that silently priced Opus at Sonnet's rate would be
 * worse than a total that excludes it and says how many are excluded.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

/** The day the table above was checked, shown in the panel beside every figure it produces. */
export const PRICES_AS_OF = '2026-09-25';

/**
 * The price for a model id, or `null` when the table does not know it.
 *
 * Matched on the id with the date suffix removed (`claude-haiku-4-5-20251001` is
 * `claude-haiku-4-5`), and on nothing else. No substring chain and no family default: those turn
 * "I do not know this model" into a wrong number nobody can see is wrong.
 */
export function priceFor(model: string): ModelPrice | null {
  const direct = MODEL_PRICES[model];
  if (direct !== undefined) {
    return direct;
  }
  const undated = /^(.*?)-\d{8}$/.exec(model);
  const base = undated?.[1];
  return base === undefined ? null : (MODEL_PRICES[base] ?? null);
}

/** What one model's tokens would cost at list price, or `null` when it has no price. */
export function estimateCost(model: ModelTokens): number | null {
  const price = priceFor(model.model);
  if (price === null) {
    return null;
  }
  return (
    (model.input * price.input +
      model.output * price.output +
      model.cacheRead * price.cacheRead +
      model.cacheWrite * price.cacheWrite) /
    1_000_000
  );
}

export interface CostEstimate {
  /** Dollars, over the models the table knows. */
  readonly total: number;
  /** How many models were left out for want of a price, which the panel states. */
  readonly unpriced: number;
  /** Their names, so the reader can see what is missing rather than only how much. */
  readonly unpricedModels: readonly string[];
}

/**
 * The bill, over the models that have a price, plus an honest count of the ones that do not.
 *
 * `costUsd` wins when Claude Code recorded one, which it does for API usage and not for a
 * subscription: a figure the vendor computed beats one we derived from a table in a source file.
 */
export function estimateTotal(models: readonly ModelTokens[]): CostEstimate {
  let total = 0;
  const unpricedModels: string[] = [];
  for (const model of models) {
    if (model.costUsd > 0) {
      total += model.costUsd;
      continue;
    }
    const estimate = estimateCost(model);
    if (estimate === null) {
      if (totalTokens(model) > 0) {
        unpricedModels.push(model.model);
      }
      continue;
    }
    total += estimate;
  }
  return { total, unpriced: unpricedModels.length, unpricedModels };
}

/** `12.3M`, `847k`, `912`. A token count is read for its order of magnitude, never digit by digit. */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${Math.round(count / 1_000).toString()}k`;
  }
  return String(count);
}
