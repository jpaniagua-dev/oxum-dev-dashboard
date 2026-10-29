import { CONVERSATION_ID_PATTERN } from './agent-profile.js';
import type { SessionAgent, TerminalGroup, TerminalSession } from './contracts.js';

/**
 * The agent sessions to reopen after a restart.
 *
 * Added on 2026-10-13, on request: closing the app killed every terminal, and every coding agent had
 * to be started again by hand with its conversation lost. Agents only, by decision: a shell is
 * cheap to reopen and a dev server is the project row's business, while an agent carries a
 * conversation that is the actual work.
 *
 * Pure, so the rules that decide what comes back are tested without a pty or a disk: which sessions
 * are recorded (a live agent with a conversation id), in which order (the tabs'), and which records
 * may be reopened (see `restorable`).
 */

/** One agent tab, as it is reopened. */
export interface AgentSessionRecord {
  readonly title: string;
  readonly renamed: boolean;
  readonly cwd: string;
  /** The project a handoff or a rule tab belongs to, null for an agent opened on its own. */
  readonly projectId: string | null;
  /** The reserved action id of a handoff or rule tab, which keeps it exempt from `reconcile`. */
  readonly actionId: string | null;
  readonly profileId: string | null;
  /** The agent as captured at the first spawn, conversation included. */
  readonly agent: SessionAgent & {
    readonly conversation: NonNullable<SessionAgent['conversation']>;
  };
  readonly note: string | null;
}

/**
 * The records for the sessions as they stand: every live agent with a conversation, in tab order.
 *
 * Live only, and that is what makes a closed tab and an agent ended with `/exit` leave the list on
 * their own: nothing has to be told to forget them. The tab order is the layout's, then any session
 * the layout does not name yet (a spawn is announced before the layout follows it).
 */
export function agentRecordsFrom(
  sessions: readonly TerminalSession[],
  groups: readonly TerminalGroup[],
): AgentSessionRecord[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const order = [
    ...new Set([
      ...groups.flatMap((group) => group.tabs),
      ...sessions.map((session) => session.id),
    ]),
  ];
  const records: AgentSessionRecord[] = [];
  for (const id of order) {
    const session = byId.get(id);
    const conversation = session?.agent?.conversation;
    if (
      session === undefined ||
      !session.running ||
      session.agent === null ||
      conversation === undefined
    ) {
      continue;
    }
    records.push({
      title: session.title,
      renamed: session.renamed,
      cwd: session.cwd,
      projectId: session.projectId,
      actionId: session.actionId,
      profileId: session.profileId,
      agent: { ...session.agent, conversation },
      note: session.note?.text ?? null,
    });
  }
  return records;
}

/**
 * A record read off disk, or null when it cannot be reopened as written.
 *
 * Strict on the conversation id, which lands in a shell command line, and on the folder, which a
 * pty is spawned in. Everything else falls back to something harmless.
 */
export function readAgentRecord(value: unknown): AgentSessionRecord | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const agent = row['agent'];
  if (typeof agent !== 'object' || agent === null) {
    return null;
  }
  const raw = agent as Record<string, unknown>;
  const conversation = raw['conversation'];
  if (typeof conversation !== 'object' || conversation === null) {
    return null;
  }
  const id = (conversation as Record<string, unknown>)['id'];
  const cwd = text(row['cwd']);
  if (typeof id !== 'string' || !CONVERSATION_ID_PATTERN.test(id) || cwd.length === 0) {
    return null;
  }
  const title = text(row['title']);
  return {
    title: title.length > 0 ? title : text(raw['label']) || 'Agent',
    renamed: row['renamed'] === true,
    cwd,
    projectId: optionalText(row['projectId']),
    actionId: optionalText(row['actionId']),
    profileId: optionalText(row['profileId']),
    agent: {
      label: text(raw['label']),
      model: text(raw['model']),
      instructionFile: text(raw['instructionFile']),
      startedAt: text(raw['startedAt']),
      // `=== true`: plan mode keeps the permission prompts, so a value that merely failed to be
      // `false` must not drop them on the way back.
      conversation: {
        id,
        plan: (conversation as Record<string, unknown>)['plan'] === true,
        ...((conversation as Record<string, unknown>)['provider'] === 'codex'
          ? { provider: 'codex' as const }
          : {}),
      },
    },
    note: optionalText(row['note']),
  };
}

/** What the restore may ask of the machine, so the choice stays testable. */
export interface RestoreChecks {
  /** Whether the folder a session ran in is still there. */
  readonly folderExists: (path: string) => boolean;
  /**
   * Whether the agent kept a conversation under this id, or `null` when that cannot be known.
   *
   * A session opened and never spoken to has nothing to resume, and reopening it would start a tab
   * on an error. `null` is an agent whose storage this app does not know, which is reopened and left
   * to say so itself.
   */
  readonly conversationExists: (id: string) => boolean | null;
  /** Whether the agent profile can reopen a conversation at all. */
  readonly canResume: boolean;
}

/** The records split into those to reopen and those to drop, each dropped one with its reason. */
export function restorable(
  records: readonly AgentSessionRecord[],
  checks: RestoreChecks,
): { keep: AgentSessionRecord[]; dropped: { record: AgentSessionRecord; reason: string }[] } {
  const keep: AgentSessionRecord[] = [];
  const dropped: { record: AgentSessionRecord; reason: string }[] = [];
  for (const record of records) {
    const reason = !checks.canResume
      ? 'the agent profile has no resume arguments'
      : !checks.folderExists(record.cwd)
        ? `${record.cwd} no longer exists`
        : checks.conversationExists(record.agent.conversation.id) === false
          ? 'the conversation was never started'
          : null;
    if (reason === null) {
      keep.push(record);
    } else {
      dropped.push({ record, reason });
    }
  }
  return { keep, dropped };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalText(value: unknown): string | null {
  const read = text(value);
  return read.length > 0 ? read : null;
}
