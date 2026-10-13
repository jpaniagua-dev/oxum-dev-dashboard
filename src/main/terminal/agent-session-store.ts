import { readFile } from 'node:fs/promises';
import { readAgentRecord, type AgentSessionRecord } from '@shared/agent-sessions.js';
import { atomicWriteFile } from '../store/atomic-write.js';
import { AppPaths } from '../store/paths.js';

/**
 * The agent sessions to reopen at the next launch, kept on disk.
 *
 * Fed by ONE derivation rather than a hook per event: every time the session list or the layout is
 * pushed, the records are recomputed from what is on screen (`agentRecordsFrom`) and written only if
 * they changed. A rename, a note, a tab moved, an agent closed or ended all reach the file that way,
 * and a crash leaves the last state written, which is the right one.
 *
 * ⚠️ **Frozen before the quit kills the sessions.** `stopAll` brings every process down, each exit
 * pushes a session list in which that agent is no longer live, and the derivation would empty the
 * file at the very moment it has to survive. `freeze` is called first in `before-quit`.
 */
export class AgentSessionStore {
  private last = '[]';
  private frozen = false;
  /** Writes in sequence, so two pushes in one tick cannot land on disk in the wrong order. */
  private queue: Promise<void> = Promise.resolve();

  /** The records left by the previous run, each read through `readAgentRecord`. */
  async load(): Promise<AgentSessionRecord[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(AppPaths.agentSessions(), 'utf8'));
      const records = Array.isArray(parsed)
        ? parsed.map(readAgentRecord).filter((record): record is AgentSessionRecord => record !== null)
        : [];
      this.last = JSON.stringify(records);
      return records;
    } catch {
      // No file yet, or one left unreadable: nothing to reopen, which is how every launch used to be.
      return [];
    }
  }

  /** Records the agents as they stand now, when they differ from what is on disk. */
  track(records: readonly AgentSessionRecord[]): void {
    if (this.frozen) {
      return;
    }
    const next = JSON.stringify(records);
    if (next === this.last) {
      return;
    }
    this.last = next;
    this.queue = this.queue
      .then(() => atomicWriteFile(AppPaths.agentSessions(), `${JSON.stringify(records, null, 2)}\n`))
      .catch((error: unknown) => {
        console.warn(`Could not record the agent sessions: ${String(error)}`);
      });
  }

  /** Stops recording, for the quit: what is on disk now is what the next launch reopens. */
  freeze(): void {
    this.frozen = true;
  }
}
