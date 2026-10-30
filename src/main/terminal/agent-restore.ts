import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_CODE_PROFILE,
  conversationArgs,
  splitCommand,
  isCodexProfile,
  resumeArguments,
  type AgentProfile,
} from '@shared/agent-profile.js';
import { restorable, type AgentSessionRecord } from '@shared/agent-sessions.js';
import { holdsConversation } from '@shared/claude-sessions.js';
import type { AgentNotReopened, Project, ShellProfile, TerminalSize } from '@shared/contracts.js';
import { buildInteractiveCommand, buildPlanCommand } from '../triage/work-command.js';
import { resolveShellCommand, type TerminalManager } from './terminal-manager.js';

/**
 * Whether Claude Code kept a conversation under this id, or null for another agent.
 *
 * Looked up by FILE NAME across `~/.claude/projects`, never through `claudeProjectKey`: that
 * folder encoding is inferred and lossy, while a transcript is named after its conversation id
 * whatever folder it sits in. A conversation that was opened and never spoken to has no file, and
 * reopening it would only show an error in a fresh tab. Read-only, like everything this app does in
 * Claude Code's storage.
 */
export function claudeConversationExists(id: string, profile: AgentProfile): boolean | null {
  const program = (template: string): string => (splitCommand(template)[0] ?? '').toLowerCase();
  if (program(profile.interactive) !== program(CLAUDE_CODE_PROFILE.interactive)) {
    return null;
  }
  const root = join(homedir(), '.claude', 'projects');
  try {
    // A file is not enough: Claude Code writes a one-line bookkeeping file for a session id that never
    // held a conversation (one the person `/resume`d away from), and `--resume` on it fails with "No
    // conversation found". The head of the file has to show a message.
    return readdirSync(root, { withFileTypes: true }).some((entry) => {
      const file = join(root, entry.name, `${id}.jsonl`);
      return entry.isDirectory() && existsSync(file) && holdsConversation(readHead(file));
    });
  } catch {
    // No storage to look in: say nothing rather than drop every session on a guess.
    return null;
  }
}

/** The first 256 KiB of a file, which is where a conversation's first message is. */
function readHead(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Reopens the agent tabs of the previous run, each on its conversation, and says what came back and
 * what did not, with why: the second list is shown in the top bar, the console of an installed build
 * being somewhere nobody looks.
 *
 * Run once, in the main process, before the dashboard window exists: the renderer then receives
 * these sessions in its bootstrap like any others, and does not open its default shell over them.
 * The command is today's profile with the stored model, plus the resume arguments; a session opened
 * in plan mode resumes through the plan arguments, so it keeps the prompts it was opened to keep.
 * Nothing runs by itself: a resumed conversation waits for its next message.
 */
export function restoreAgentSessions(options: {
  records: readonly AgentSessionRecord[];
  terminals: Pick<TerminalManager, 'restoreAgent'>;
  profile: AgentProfile;
  shells: readonly ShellProfile[];
  defaultShell: ShellProfile | undefined;
  projects: readonly Project[];
  size: TerminalSize;
}): { reopened: number; notReopened: AgentNotReopened[] } {
  const codex = isCodexProfile(options.profile);
  const notReopened: AgentNotReopened[] = [];
  const records = options.records.filter((record) => {
    const conversation = record.agent.conversation;
    const compatible = conversation === undefined || (conversation.provider === 'codex') === codex;
    if (!compatible) {
      notReopened.push({ title: record.title, reason: 'the configured agent has changed' });
    }
    return compatible;
  });
  const { keep, dropped } = restorable(records, {
    folderExists: (path) => existsSync(path),
    conversationExists: (id) => claudeConversationExists(id, options.profile),
    canResume: resumeArguments(options.profile).length > 0,
  });
  notReopened.push(
    ...dropped.map(({ record, reason }) => ({
      title: record.title,
      reason,
    })),
  );

  let reopened = 0;
  for (const record of keep) {
    const shell =
      options.shells.find((entry) => entry.id === record.profileId) ?? options.defaultShell;
    if (shell === undefined) {
      notReopened.push({ title: record.title, reason: 'no shell profile to run it in' });
      continue;
    }
    const { id, plan } = record.agent.conversation;
    const resume = conversationArgs(resumeArguments(options.profile), id);
    const command = plan
      ? buildPlanCommand(options.profile, record.agent.model, resume)
      : buildInteractiveCommand(options.profile, record.agent.model, resume);
    if (command.length === 0) {
      notReopened.push({
        title: record.title,
        reason: 'it was opened in plan mode, and the agent profile has no plan mode any more',
      });
      continue;
    }
    const resolved = resolveShellCommand(shell, command);
    const terminalId = options.terminals.restoreAgent({
      title: record.title,
      renamed: record.renamed,
      project: options.projects.find((project) => project.id === record.projectId) ?? null,
      actionId: record.actionId,
      file: resolved.file,
      args: resolved.args,
      cwd: record.cwd,
      size: options.size,
      profileId: shell.id,
      agent: record.agent,
      note: record.note,
    });
    if (terminalId !== null) {
      reopened += 1;
    }
  }
  for (const { title, reason } of notReopened) {
    console.warn(`Not reopening "${title}": ${reason}`);
  }
  return { reopened, notReopened };
}
