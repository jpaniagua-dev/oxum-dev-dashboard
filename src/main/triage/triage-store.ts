import { readFile } from 'node:fs/promises';
import type { TriagedTicket, TriageResult } from '@shared/contracts.js';
import { nearestStoryPoints } from '../jira/jira-start.js';
import { atomicWriteFile } from '../store/atomic-write.js';
import { AppPaths } from '../store/paths.js';

/**
 * The last triage of each sprint, kept on disk.
 *
 * The whole point of the tab is that a result stays on screen until it is asked for again: an
 * analysis costs a minute and tokens, so losing it on quit would make the tab something you rerun
 * rather than something you consult. Keyed by sprint id, which is stable across renames.
 */
export class TriageStore {
  private results = new Map<number, TriageResult>();

  async load(): Promise<void> {
    try {
      const raw = await readFile(AppPaths.triage(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) {
        return;
      }
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const result = readResult(value);
        const id = Number(key);
        if (result !== null && Number.isFinite(id)) {
          this.results.set(id, result);
        }
      }
    } catch {
      // No file yet, or one left unreadable: an empty history is the correct starting state, and
      // refusing to start over a corrupt cache would be worse than losing it.
    }
  }

  get(sprintId: number): TriageResult | undefined {
    return this.results.get(sprintId);
  }

  /**
   * Finds one ticket by key, across every sprint analysed.
   *
   * What makes the handoff able to carry an estimate while the channel still passes nothing but keys:
   * the analysis is on disk, so the main process goes and reads it rather than being handed a copy that
   * would be stale from the moment it was made. The most recent analysis wins, a key being able to
   * appear in two sprints once a ticket is carried over, and the fresher verdict is the one that read
   * the ticket as it stands today.
   */
  findTicket(key: string): TriagedTicket | undefined {
    const wanted = key.toUpperCase();
    let best: { ticket: TriagedTicket; analysedAt: string } | undefined;
    for (const result of this.results.values()) {
      const ticket = result.tickets.find((entry) => entry.key.toUpperCase() === wanted);
      if (ticket !== undefined && (best === undefined || result.analysedAt > best.analysedAt)) {
        best = { ticket, analysedAt: result.analysedAt };
      }
    }
    return best?.ticket;
  }

  /** Plain object keyed by sprint id, the shape the renderer receives. */
  snapshot(): Record<string, TriageResult> {
    const entries: Record<string, TriageResult> = {};
    for (const [id, result] of this.results) {
      entries[String(id)] = result;
    }
    return entries;
  }

  async save(result: TriageResult): Promise<void> {
    this.results.set(result.sprintId, result);
    await this.write();
  }

  /**
   * Drops one ticket from one sprint's analysis.
   *
   * The row and nothing else: the ticket stays in Jira, the sprint stays analysed, and the next run
   * brings the row back. That is what makes this the one deletion in the app that needs no
   * confirmation, unlike a stash `drop` or a discarded change: nothing is lost that a minute of
   * compute cannot produce again.
   *
   * The empty result is **kept** rather than deleted with its last ticket. `analysedAt` is what the
   * tab reads to say a sprint was looked at, and removing the entry would make a sprint you cleared
   * look like one nobody ever ran.
   *
   * Returns whether anything moved, so dismissing a key twice does not rewrite the file.
   */
  remove(sprintId: number, key: string): boolean {
    const result = this.results.get(sprintId);
    if (result === undefined) {
      return false;
    }
    const wanted = key.toUpperCase();
    const tickets = result.tickets.filter((ticket) => ticket.key.toUpperCase() !== wanted);
    if (tickets.length === result.tickets.length) {
      return false;
    }
    this.results.set(sprintId, { ...result, tickets });
    return true;
  }

  /** Every key held, across every sprint analysed, so the live fields can be re-read in one query. */
  keys(): string[] {
    const keys = new Set<string>();
    for (const result of this.results.values()) {
      for (const ticket of result.tickets) {
        keys.add(ticket.key);
      }
    }
    return [...keys];
  }

  /**
   * Refreshes the fields that describe the ticket **now**, leaving the analysis alone.
   *
   * `status` and `assignee` were captured when the sprint was analysed, and an analysis is not re-run
   * just because a ticket moved. Left as they were, the tab kept showing a ticket in `Ready` after
   * `Work on this` had moved it to in progress, and long after it was done: the one column that has to
   * be current was the only one that never changed.
   *
   * The verdict, the reason, the question and the estimate are **not** touched. Those are what the run
   * concluded from the ticket as it read it; silently mixing a fresh status into an old verdict is
   * honest, silently editing the verdict would not be.
   *
   * A key absent from the answer keeps what it had rather than being blanked: a ticket that left the
   * search is not a ticket whose status is now empty.
   *
   * Returns whether anything moved, so a refresh that changed nothing does not rewrite the file.
   */
  applyLiveFields(live: ReadonlyMap<string, { status: string; assignee: string }>): boolean {
    let changed = false;
    for (const [sprintId, result] of this.results) {
      let touched = false;
      const tickets = result.tickets.map((ticket) => {
        const fresh = live.get(ticket.key.toUpperCase());
        if (
          fresh === undefined ||
          (fresh.status === ticket.status && fresh.assignee === ticket.assignee)
        ) {
          return ticket;
        }
        touched = true;
        return { ...ticket, status: fresh.status, assignee: fresh.assignee };
      });
      if (touched) {
        changed = true;
        this.results.set(sprintId, { ...result, tickets });
      }
    }
    return changed;
  }

  /** Persists whatever is held. Public so a live-field refresh can save without pretending to analyse. */
  async write(): Promise<void> {
    await atomicWriteFile(AppPaths.triage(), `${JSON.stringify(this.snapshot(), null, 2)}\n`);
  }
}

/**
 * Validates one stored result.
 *
 * Read defensively because this file survives version changes: a result whose shape no longer
 * matches is dropped rather than rendered, since a half-read verdict would show a ticket under a
 * heading nobody computed.
 */
function readResult(value: unknown): TriageResult | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record['sprintId'] !== 'number' || !Array.isArray(record['tickets'])) {
    return null;
  }
  const skipped = readRecord(record['skipped']);
  return {
    sprintId: record['sprintId'],
    sprintName: typeof record['sprintName'] === 'string' ? record['sprintName'] : '',
    analysedAt: typeof record['analysedAt'] === 'string' ? record['analysedAt'] : '',
    error: typeof record['error'] === 'string' ? record['error'] : null,
    // A `scope` and a `notMine` count sit in every file written before 5.8.1, when the `mine` scope was
    // removed. They are simply not read: an unknown key is dropped here like anywhere else, so an old
    // analysis loses the two fields and keeps everything a reader acts on.
    skipped: {
      inProgress: readCount(skipped['inProgress']),
    },
    tickets: record['tickets'].flatMap((ticket) => {
      const entry = ticket as Record<string, unknown>;
      if (typeof entry['key'] !== 'string' || typeof entry['verdict'] !== 'string') {
        return [];
      }
      return [
        {
          key: entry['key'],
          summary: typeof entry['summary'] === 'string' ? entry['summary'] : '',
          verdict: entry['verdict'] as TriageResult['tickets'][number]['verdict'],
          reason: typeof entry['reason'] === 'string' ? entry['reason'] : '',
          question: typeof entry['question'] === 'string' ? entry['question'] : '',
          next: typeof entry['next'] === 'string' ? entry['next'] : '',
          // Through the same rounding as a fresh answer, so a file written before the scale existed, or
          // hand-edited, cannot put a value off it on screen and then into a ticket.
          estimate: nearestStoryPoints(entry['estimate']),
          assignee: typeof entry['assignee'] === 'string' ? entry['assignee'] : '',
          status: typeof entry['status'] === 'string' ? entry['status'] : '',
          description: typeof entry['description'] === 'string' ? entry['description'] : '',
        },
      ];
    }),
  };
}

/** A nested object, or an empty one. Same defensive reading as `readResult`, one level down. */
function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * A count read off disk.
 *
 * Clamped rather than trusted: these numbers are printed in a sentence about what a run left out, and
 * a negative or fractional one would put "-1 already in progress" on screen from a hand-edited file.
 */
function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
