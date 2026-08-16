import { readFile } from 'node:fs/promises';
import type { TriageResult } from '@shared/contracts.js';
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
  return {
    sprintId: record['sprintId'],
    sprintName: typeof record['sprintName'] === 'string' ? record['sprintName'] : '',
    analysedAt: typeof record['analysedAt'] === 'string' ? record['analysedAt'] : '',
    error: typeof record['error'] === 'string' ? record['error'] : null,
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
          assignee: typeof entry['assignee'] === 'string' ? entry['assignee'] : '',
        },
      ];
    }),
  };
}
