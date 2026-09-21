import { readFile } from 'node:fs/promises';
import type { AutoRunRecord, FeedbackPhase, ProjectId } from '@shared/contracts.js';
import { FEEDBACK_PHASES } from '@shared/contracts.js';
import { atomicWriteFile } from '../store/atomic-write.js';
import { AppPaths } from '../store/paths.js';

/**
 * What the app remembers about each ticket handed to an unattended run, kept on disk.
 *
 * Keyed by **ticket key** and not by `owner/repo#12`, unlike `pull-reviews.json`: this record is born
 * when the run starts, which is before the pull request exists. Keying it on the pull request would
 * leave the window that matters most, the one where nothing has been opened yet, with no name to file
 * anything under. `byPull` covers the reverse lookup the watcher needs.
 *
 * Read back defensively row by row, like the two stores before it, and here the stakes are different
 * again: `feedbackPhase` is what stops an agent being started twice on one pull request, so a row that
 * reads back wrong does not show a stale sentence, it re-arms a run.
 */
/**
 * What a reader of these records may do with them.
 *
 * An interface beside the class, and not decoration: `AutoRunStore` holds a private field, so a test
 * cannot hand a stand-in to anything typed on the class itself. The watcher depends on this instead,
 * which is what lets a test assert "this tick wrote nothing and launched nothing" without Electron
 * behind it.
 */
export interface AutoRunRecords {
  get(ticketKey: string): AutoRunRecord | undefined;
  byPull(slug: string, number: number): AutoRunRecord | undefined;
  all(): AutoRunRecord[];
  set(record: AutoRunRecord): void;
  remove(ticketKey: string): boolean;
  write(): Promise<void>;
}

export class AutoRunStore implements AutoRunRecords {
  private runs = new Map<string, AutoRunRecord>();

  async load(): Promise<void> {
    try {
      const raw = await readFile(AppPaths.autoRuns(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) {
        return;
      }
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        const record = readRecord(value);
        if (record !== null) {
          this.runs.set(record.ticketKey.toUpperCase(), record);
        }
      }
    } catch {
      // No file yet, or one left unreadable. An empty history is the correct starting state: every
      // record it would have held describes a run whose pull request is still on GitHub to be read.
    }
  }

  get(ticketKey: string): AutoRunRecord | undefined {
    return this.runs.get(ticketKey.toUpperCase());
  }

  /** The record a pull request belongs to, for the watcher, which starts from the poll payload. */
  byPull(slug: string, number: number): AutoRunRecord | undefined {
    for (const record of this.runs.values()) {
      if (record.slug === slug && record.prNumber === number) {
        return record;
      }
    }
    return undefined;
  }

  all(): AutoRunRecord[] {
    return [...this.runs.values()];
  }

  set(record: AutoRunRecord): void {
    this.runs.set(record.ticketKey.toUpperCase(), record);
  }

  remove(ticketKey: string): boolean {
    return this.runs.delete(ticketKey.toUpperCase());
  }

  snapshot(): Record<string, AutoRunRecord> {
    return Object.fromEntries([...this.runs].map(([key, record]) => [key, record]));
  }

  async write(): Promise<void> {
    await atomicWriteFile(AppPaths.autoRuns(), `${JSON.stringify(this.snapshot(), null, 2)}\n`);
  }
}

/**
 * Validates one stored record.
 *
 * Exported for its test, like `readResult`: it is a pure function of `unknown` and the only door a
 * stale shape comes through, and what it decides is whether an agent may start.
 *
 * Only a missing ticket key drops the row. Everything else has a safe reading, and dropping instead
 * would be the worse outcome twice over: the merge watcher would lose its port and its branch, and the
 * pull request would go untracked until the branch join re-created it in `watching`, which is a
 * corrupt byte re-arming a pass.
 */
export function readRecord(value: unknown): AutoRunRecord | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const ticketKey = text(entry['ticketKey']);
  if (ticketKey.length === 0) {
    return null;
  }
  return {
    ticketKey,
    projectId: text(entry['projectId']) as ProjectId,
    slug: text(entry['slug']),
    branch: text(entry['branch']),
    port: positive(entry['port']),
    prNumber: positive(entry['prNumber']),
    prMatchedAt: optionalText(entry['prMatchedAt']),
    feedbackPhase: readPhase(entry['feedbackPhase']),
    lastSeenCommentId: count(entry['lastSeenCommentId']),
    feedbackStartedAt: optionalText(entry['feedbackStartedAt']),
    feedbackFinishedAt: optionalText(entry['feedbackFinishedAt']),
    pendingCount: count(entry['pendingCount']),
    notice: optionalText(entry['notice']),
    lastRefusal: optionalText(entry['lastRefusal']),
  };
}

/**
 * A phase nobody defines reads `done`, which is the one value that starts nothing.
 *
 * The opposite of the house rule everywhere else, and deliberately. `unclear` is the safe reading of
 * an unknown triage verdict because a verdict only describes; a phase **authorises**, so its safe
 * reading is the one that authorises least. `watching` would let a hand-edited or half-written byte
 * launch an agent, which is the single outcome this field exists to prevent.
 */
function readPhase(value: unknown): FeedbackPhase {
  const found = FEEDBACK_PHASES.find((phase) => phase === value);
  return found ?? 'done';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalText(value: unknown): string | null {
  const read = text(value);
  return read.length > 0 ? read : null;
}

/** A positive whole number, or `null`. Used where absent and zero are different answers. */
function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * A count read off disk, floored at zero.
 *
 * Safe only because the phase is what gates starting: a watermark that read back as 0 would make every
 * comment look new, and on its own that would relaunch a pass. The two defaults are coupled, and the
 * test says so.
 */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
