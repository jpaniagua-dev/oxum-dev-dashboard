import { readFile } from 'node:fs/promises';
import type { IssueStage, TriagedTicket, TriageResult } from '@shared/contracts.js';
import { nearestStoryPoints } from '../jira/jira-start.js';
import { toAutonomous, toDomain, toVerdict } from './triage-parse.js';
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

  /**
   * The keys one sprint's stored analysis already covers, upper-cased.
   *
   * What an incremental run subtracts. Scoped to the sprint rather than read across the file, and that
   * is the load-bearing half: a ticket carried over from the last sprint has a verdict under the sprint
   * it was analysed in, and a global lookup would leave it out of the new sprint's list for good, with
   * nothing on screen to say why. Per sprint, it is analysed once there and then skipped, which is the
   * behaviour the button promises.
   *
   * A dismissed row is **not** here, having been removed from the result: the next run brings it back,
   * exactly as the dismissal says it will, and an incremental run is a run.
   */
  analysedKeys(sprintId: number): Set<string> {
    const result = this.results.get(sprintId);
    return new Set(result?.tickets.map((ticket) => ticket.key.toUpperCase()) ?? []);
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
   * search is not a ticket whose status is now empty. That asymmetry is deliberate and it is what
   * keeps the removal below safe: only an explicit `done` drops a row, never a key the search failed
   * to return, which can be a capped query or a permissions blip.
   *
   * **A finished ticket is removed, not updated.** It is the one live change that makes the row
   * meaningless rather than stale: the tab answers "what can I start", and a closed ticket has no
   * answer left to give, so leaving it in with a fresh status would keep it in the counts, in
   * `readyKeys` and inside an unattended batch. The verdict rule is not broken by this, since nothing
   * is rewritten: the row leaves. If the ticket is reopened it comes back through the next analysis,
   * the sprint search returning it and no stored verdict covering it any more.
   *
   * Returns whether anything moved, so a refresh that changed nothing does not rewrite the file.
   */
  applyLiveFields(live: ReadonlyMap<string, LiveFields>): boolean {
    let changed = false;
    for (const [sprintId, result] of this.results) {
      const tickets = applyLiveToTickets(result.tickets, live);
      if (tickets !== null) {
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

/** What a live refresh knows about a ticket: two fields to update, and one that can remove the row. */
export interface LiveFields {
  readonly status: string;
  readonly assignee: string;
  readonly stage: IssueStage;
}

/**
 * One sprint's rows after a live refresh, or `null` when nothing moved.
 *
 * Pure and exported for the reason `selectIssues` lives in its own file: the store cannot be imported
 * into a test without Electron behind it, and this is where a mistake is silent. A row wrongly kept
 * is a finished ticket sitting in the batch button; a row wrongly dropped is a paid verdict gone.
 *
 * `null` rather than an unchanged array so the caller can tell "nothing moved" from "everything was
 * rewritten to the same thing", which is what stops a refresh rewriting the file every time the tab
 * is shown.
 */
export function applyLiveToTickets(
  tickets: readonly TriagedTicket[],
  live: ReadonlyMap<string, LiveFields>,
): TriagedTicket[] | null {
  let touched = false;
  const kept: TriagedTicket[] = [];
  for (const ticket of tickets) {
    const fresh = live.get(ticket.key.toUpperCase());
    if (fresh?.stage === 'done') {
      touched = true;
      continue;
    }
    if (
      fresh === undefined ||
      (fresh.status === ticket.status && fresh.assignee === ticket.assignee)
    ) {
      kept.push(ticket);
      continue;
    }
    touched = true;
    kept.push({ ...ticket, status: fresh.status, assignee: fresh.assignee });
  }
  return touched ? kept : null;
}

/**
 * Validates one stored result.
 *
 * Read defensively because this file survives version changes: a result whose shape no longer
 * matches is dropped rather than rendered, since a half-read verdict would show a ticket under a
 * heading nobody computed.
 *
 * Exported for its test. It is a pure function of `unknown` and the only door a stale shape comes
 * through, `carried` in an incremental run reading a store that nothing else fills, so the claim in
 * the paragraph above is worth holding by test rather than by eye.
 */
export function readResult(value: unknown): TriageResult | null {
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
      // Absent from every file written before the rule existed, and read as zero: a run that never
      // counted its finished tickets did not skip none of them, it skipped an unknown number, and
      // zero is what the sentence then leaves unsaid rather than what it claims.
      done: readCount(skipped['done']),
      inProgress: readCount(skipped['inProgress']),
      alreadyAnalysed: readCount(skipped['alreadyAnalysed']),
    },
    tickets: record['tickets'].flatMap((ticket) => {
      const entry = ticket as Record<string, unknown>;
      // Only a missing key still drops the row. A row with no verdict used to go with it, which meant
      // a hand-edited file lost tickets in silence; it now reads `unclear`, the same answer the parse
      // gives a ticket the model forgot, and for the same reason.
      if (typeof entry['key'] !== 'string') {
        return [];
      }
      return [
        {
          key: entry['key'],
          summary: typeof entry['summary'] === 'string' ? entry['summary'] : '',
          // Through the same three normalisers a fresh answer goes through, the rule `nearestStoryPoints`
          // had already set a few lines down: disk and model answer are the same untrusted string, and
          // validating them differently is how one of the two starts lying. This is also the whole
          // migration of the `backend` verdict, which 5.12.0 split into a verdict and a domain: it is
          // now a verdict nobody defines, so it lands on `unclear` by the rule that already catches
          // one, with its `reason` ("No API for the field X") surviving intact, which is where the
          // information actually was. Mapping it to `ready` would claim a judgement no run ever made
          // and drop those rows straight into the batch button; mapping it to `blocked` would be right
          // for the half of the population that was a blocker and invented for the half that was
          // server work, and nothing on disk tells the two apart.
          verdict: toVerdict(entry['verdict']),
          domain: toDomain(entry['domain']),
          // `claimsAutonomy` and not `autonomous`: the model answers the second, the store round-trips
          // a `TriagedTicket`, which carries the first. Reading the model's spelling here would have
          // read `undefined` off every file this app itself wrote.
          claimsAutonomy: toAutonomous(entry['claimsAutonomy']),
          reason: typeof entry['reason'] === 'string' ? entry['reason'] : '',
          question: typeof entry['question'] === 'string' ? entry['question'] : '',
          next: typeof entry['next'] === 'string' ? entry['next'] : '',
          // Through the same rounding as a fresh answer, so a file written before the scale existed, or
          // hand-edited, cannot put a value off it on screen and then into a ticket.
          estimate: nearestStoryPoints(entry['estimate']),
          assignee: typeof entry['assignee'] === 'string' ? entry['assignee'] : '',
          status: typeof entry['status'] === 'string' ? entry['status'] : '',
          description: typeof entry['description'] === 'string' ? entry['description'] : '',
          // Empty in every file written before 5.11.0, and read as "unknown" rather than backfilled
          // from the result: stamping those rows with the run they were merged into would be inventing
          // the very fact this field exists to keep honest.
          analysedAt: typeof entry['analysedAt'] === 'string' ? entry['analysedAt'] : '',
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
