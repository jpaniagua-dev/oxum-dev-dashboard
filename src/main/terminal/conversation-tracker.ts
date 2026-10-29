import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  followConversations,
  readLiveSession,
  type LiveClaudeSession,
} from '@shared/claude-sessions.js';
import type { TerminalSession } from '@shared/contracts.js';

/** How often the registry is read. A `/resume` typed in a tab is followed within this long. */
const TRACK_INTERVAL_MS = 10_000;

/**
 * Keeps each agent tab pointed at the conversation its Claude Code process is writing.
 *
 * Reads `~/.claude/sessions/*.json`, a handful of small files, every ten seconds: file reads and no
 * spawn, so nothing here can block the main loop the way a process creation does (see the
 * performance section of CLAUDE.md). The pid of each tab's process is learnt once and followed after,
 * the rules being `followConversations`'. A folder that does not exist (another agent, or a Claude
 * Code that keeps no registry) is no information, and the ids the app handed in stand.
 */
export class ConversationTracker {
  private readonly bound = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly ports: {
      readonly sessions: () => readonly TerminalSession[];
      readonly setConversation: (terminalId: string, conversationId: string) => void;
    },
    private readonly folder: string = join(homedir(), '.claude', 'sessions'),
  ) {}

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), TRACK_INTERVAL_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One pass. Never throws: it rides a timer, and a bad file is simply skipped. */
  async tick(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      const agents = this.ports
        .sessions()
        .filter(
          (session) =>
            session.running &&
            session.agent?.conversation !== undefined &&
            session.agent.conversation.provider !== 'codex',
        )
        .map((session) => ({
          terminalId: session.id,
          conversationId: session.agent?.conversation?.id ?? '',
        }));
      // Tabs that are gone or ended drop their binding, so a reused pid can never be followed.
      const live = new Set(agents.map((agent) => agent.terminalId));
      for (const terminalId of [...this.bound.keys()]) {
        if (!live.has(terminalId)) {
          this.bound.delete(terminalId);
        }
      }
      if (agents.length === 0) {
        return;
      }
      const moves = followConversations(agents, this.bound, await this.readRegistry());
      for (const { terminalId, pid } of moves.bind) {
        this.bound.set(terminalId, pid);
      }
      for (const terminalId of moves.unbind) {
        this.bound.delete(terminalId);
      }
      for (const { terminalId, conversationId } of moves.update) {
        this.ports.setConversation(terminalId, conversationId);
      }
    } catch (error) {
      console.warn(`Could not follow the agent conversations: ${String(error)}`);
    } finally {
      this.busy = false;
    }
  }

  private async readRegistry(): Promise<LiveClaudeSession[]> {
    let names: string[];
    try {
      names = await readdir(this.folder);
    } catch {
      return [];
    }
    const sessions: LiveClaudeSession[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      try {
        const session = readLiveSession(
          JSON.parse(await readFile(join(this.folder, name), 'utf8')),
        );
        if (session !== null) {
          sessions.push(session);
        }
      } catch {
        // Being rewritten as we read it, or not one of Claude Code's: the next pass reads it again.
      }
    }
    return sessions;
  }
}
