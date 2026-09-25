import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { UsageState } from '@shared/contracts.js';
import { parseHistory, parseStatsCache, summariseActivity } from '@shared/usage.js';

/**
 * Reads what Claude Code has written about itself, and never writes a byte back.
 *
 * Same standing rule as `claudeProjectKey` in `agent-context.ts`: this app reads that folder to say
 * what an agent has been doing and must never put anything in it. Nothing here is a contract either,
 * so a missing file is "nothing to show" and never an error.
 *
 * Async and not `readFileSync`, unlike the agent context reader next door, and the difference is the
 * size: an instruction file is a page, `history.jsonl` was 1.35 MB on the machine this was written
 * for and only grows. The main loop is the one thread that must not stop, which the performance
 * section of this repo's notes spends its length on.
 */

/** Where Claude Code keeps them. Resolved per call so a test can point somewhere else. */
export function usagePaths(home: string = homedir()): {
  history: string;
  statsCache: string;
} {
  return {
    history: join(home, '.claude', 'history.jsonl'),
    statsCache: join(home, '.claude', 'stats-cache.json'),
  };
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    // Missing, unreadable, or a directory: all the same answer here, which is that there is nothing
    // to show. A permission error on a file in the user's own home is not something this tab can act
    // on, and an error banner over an empty panel says less than the empty panel does.
    return null;
  }
}

/**
 * Both halves, read together.
 *
 * They are gathered in one call rather than two channels because the panel's first job is to say how
 * far apart they are: the history is live and the cache is not, and a reader comparing two panels
 * refreshed at different moments cannot see that.
 */
export async function readUsage(home: string = homedir()): Promise<UsageState> {
  const paths = usagePaths(home);
  const [history, statsText] = await Promise.all([
    readMaybe(paths.history),
    readMaybe(paths.statsCache),
  ]);

  let stats = null;
  if (statsText !== null) {
    try {
      stats = parseStatsCache(JSON.parse(statsText));
    } catch {
      // A cache half-written by another process parses as nothing, which is the same as absent.
      stats = null;
    }
  }

  return {
    activity: history === null ? null : summariseActivity(parseHistory(history)),
    stats,
    readAt: new Date().toISOString(),
  };
}
