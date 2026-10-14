import { CONVERSATION_ID_PATTERN } from './agent-profile.js';

/**
 * Which conversation a running Claude Code process is writing, read off Claude Code's own registry.
 *
 * Found on 2026-10-14, from a restore that failed with "No conversation found with session ID": the
 * id the app hands in with `--session-id` names the conversation only until the person types
 * `/resume` (or `/clear`) in that tab. From then on the process writes another conversation, and the
 * file named after the first id holds a single bookkeeping line. Claude Code itself keeps
 * `~/.claude/sessions/<pid>.json`, whose `sessionId` is the conversation the process is writing NOW,
 * so the app follows that instead of trusting its own id.
 *
 * A pid is learnt once, from the file that still shows the id the app handed in, then that pid is
 * followed. Matching by working folder or start time instead would be ambiguous: every agent the app
 * opens starts in the same workspace, several at once when a launch restores them.
 *
 * The registry is Claude Code's and nothing promises its shape, so anything unreadable is simply no
 * information: the app keeps the id it had.
 */

/** One running Claude Code process, as its registry file describes it. */
export interface LiveClaudeSession {
  readonly pid: number;
  readonly sessionId: string;
}

/** A registry file's content, or null when it is not one this app can read. */
export function readLiveSession(value: unknown): LiveClaudeSession | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const pid = row['pid'];
  const sessionId = row['sessionId'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (typeof sessionId !== 'string' || !CONVERSATION_ID_PATTERN.test(sessionId)) {
    return null;
  }
  return { pid, sessionId };
}

/** An agent tab and the conversation the app believes it holds. */
export interface TrackedAgent {
  readonly terminalId: string;
  readonly conversationId: string;
}

export interface ConversationMoves {
  /** Tabs whose process was just recognised, with that process's pid. */
  readonly bind: readonly { terminalId: string; pid: number }[];
  /** Tabs whose process now writes another conversation. */
  readonly update: readonly { terminalId: string; conversationId: string }[];
  /** Tabs whose process is gone from the registry, so its pid must not be followed any more. */
  readonly unbind: readonly string[];
}

/**
 * What the registry says about the agent tabs.
 *
 * A bound tab follows its pid: a new `sessionId` there is an update, a missing pid an unbind (the
 * process ended, and a pid can be reused). An unbound tab is bound to the process whose `sessionId`
 * is still the one the app handed in, and to none that another tab already follows.
 */
export function followConversations(
  agents: readonly TrackedAgent[],
  bound: ReadonlyMap<string, number>,
  live: readonly LiveClaudeSession[],
): ConversationMoves {
  const byPid = new Map(live.map((session) => [session.pid, session]));
  const taken = new Set(bound.values());
  const bind: { terminalId: string; pid: number }[] = [];
  const update: { terminalId: string; conversationId: string }[] = [];
  const unbind: string[] = [];

  for (const agent of agents) {
    const pid = bound.get(agent.terminalId);
    if (pid !== undefined) {
      const session = byPid.get(pid);
      if (session === undefined) {
        unbind.push(agent.terminalId);
      } else if (session.sessionId !== agent.conversationId) {
        update.push({ terminalId: agent.terminalId, conversationId: session.sessionId });
      }
      continue;
    }
    const match = live.find((session) => session.sessionId === agent.conversationId && !taken.has(session.pid));
    if (match !== undefined) {
      taken.add(match.pid);
      bind.push({ terminalId: agent.terminalId, pid: match.pid });
    }
  }
  return { bind, update, unbind };
}

/**
 * Whether a transcript holds a conversation, rather than only the bookkeeping line Claude Code writes
 * for a session id that was never spoken in. `--resume` on such a file fails with "No conversation
 * found", so the restore treats it as a conversation that does not exist.
 */
export function holdsConversation(head: string): boolean {
  return /"type":"(user|assistant)"/.test(head);
}
