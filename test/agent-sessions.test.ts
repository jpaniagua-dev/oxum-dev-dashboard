import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { restoreAgentSessions } from '../src/main/terminal/agent-restore.js';
import type { TerminalManager } from '../src/main/terminal/terminal-manager.js';
import {
  agentRecordsFrom,
  namesItsSession,
  readAgentRecord,
  restorable,
  type AgentSessionRecord,
} from '../src/shared/agent-sessions.js';
import {
  CLAUDE_CODE_PROFILE,
  conversationArgs,
  readProfile,
  safeSessionName,
  SESSION_NAME_MAX,
  sessionNameArgs,
} from '../src/shared/agent-profile.js';
import type { SessionAgent, TerminalSession } from '../src/shared/contracts.js';
import {
  buildInteractiveCommand,
  buildPlanCommand,
  buildWorkCommand,
  launchArgs,
  newConversation,
} from '../src/main/triage/work-command.js';

const ID_A = '0d4f1c3e-8a2b-4c6d-9e1f-2a3b4c5d6e7f';
const ID_B = '1e5a2d4f-9b3c-4d7e-8f2a-3b4c5d6e7f80';

function agent(id: string | null, plan = false): SessionAgent {
  return {
    label: 'Claude Code',
    model: 'opus',
    instructionFile: 'CLAUDE.md',
    startedAt: '2026-10-13T08:00:00.000Z',
    ...(id === null ? {} : { conversation: { id, plan } }),
  };
}

function session(id: string, patch: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id,
    title: id,
    kind: 'shell',
    projectId: null,
    actionId: null,
    role: null,
    profileId: 'git-bash',
    cwd: 'C:/work',
    note: null,
    running: true,
    exitCode: null,
    stoppedOnPurpose: false,
    closable: true,
    renamed: false,
    agent: null,
    ...patch,
  };
}

describe('which sessions are recorded', () => {
  it('records the live agents with a conversation, and nothing else', () => {
    const records = agentRecordsFrom(
      [
        session('shell-1'),
        session('shell-2', { agent: agent(ID_A), title: 'Fiscal year', renamed: true }),
        session('shell-3', { agent: agent(null) }),
        session('shell-4', { agent: agent(ID_B), running: false }),
      ],
      [],
    );
    expect(records.map((record) => record.agent.conversation?.id)).toEqual([ID_A]);
    expect(records[0]).toMatchObject({ title: 'Fiscal year', renamed: true, cwd: 'C:/work' });
  });

  it('keeps the tab order of the layout, then the sessions it does not name yet', () => {
    const sessions = [
      session('shell-1', { agent: agent(ID_A) }),
      session('shell-2', { agent: agent(ID_B) }),
    ];
    const ordered = agentRecordsFrom(sessions, [{ tabs: ['shell-2'], active: 'shell-2' }]);
    expect(ordered.map((record) => record.agent.conversation?.id)).toEqual([ID_B, ID_A]);
  });

  it('carries the note text, the project and the reserved action of a handoff tab', () => {
    const [record] = agentRecordsFrom(
      [
        session('project-1', {
          kind: 'project',
          projectId: 'web-app',
          actionId: 'git:triage-work:PROJ-123',
          agent: agent(ID_A, true),
          note: { text: 'Fix the date picker', writtenAt: '2026-10-13T08:00:00.000Z' },
        }),
      ],
      [],
    );
    expect(record).toMatchObject({
      projectId: 'web-app',
      actionId: 'git:triage-work:PROJ-123',
      note: 'Fix the date picker',
      agent: { conversation: { id: ID_A, plan: true } },
    });
  });

  it('records an agent its profile could not name, so the next launch can say it did not come back', () => {
    const records = agentRecordsFrom(
      [
        // A Codex profile: no session arguments, so no conversation, but the spawn wanted one.
        session('shell-1', { agent: { ...agent(null), label: 'Codex', unresumable: true } }),
        // The feedback pass or a routine: excluded on purpose, nobody expects it back.
        session('shell-2', { agent: agent(null) }),
      ],
      [],
    );
    expect(records.map((record) => record.agent.label)).toEqual(['Codex']);
    expect(records[0]?.agent.conversation).toBeUndefined();
  });
});

describe('reading a record back', () => {
  const stored = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(agentRecordsFrom([session('shell-1', { agent: agent(ID_A) })], [])[0])) as Record<
      string,
      unknown
    >;

  it('reads back what it wrote', () => {
    expect(readAgentRecord(stored())?.agent.conversation).toEqual({ id: ID_A, plan: false });
  });

  it('refuses an id that is not one the app would generate, since it lands in a shell', () => {
    const row = stored();
    row['agent'] = { ...(row['agent'] as object), conversation: { id: '$(whoami)', plan: false } };
    expect(readAgentRecord(row)).toBeNull();
  });

  it('reads back an agent marked unresumable, and nothing else without a conversation', () => {
    const marked = agentRecordsFrom(
      [session('shell-1', { agent: { ...agent(null), label: 'Codex', unresumable: true } })],
      [],
    )[0];
    const row = JSON.parse(JSON.stringify(marked)) as Record<string, unknown>;
    expect(readAgentRecord(row)?.agent).toMatchObject({ label: 'Codex', unresumable: true });
    row['agent'] = { ...(row['agent'] as object), unresumable: false };
    expect(readAgentRecord(row)).toBeNull();
  });

  it('refuses a record with no folder, and reads plan mode only from an explicit true', () => {
    expect(readAgentRecord({ ...stored(), cwd: '' })).toBeNull();
    const row = stored();
    row['agent'] = { ...(row['agent'] as object), conversation: { id: ID_A, plan: 'yes' } };
    expect(readAgentRecord(row)?.agent.conversation?.plan).toBe(false);
    expect(readAgentRecord('nonsense')).toBeNull();
  });
});

describe('which records are reopened', () => {
  const records = agentRecordsFrom(
    [session('shell-1', { agent: agent(ID_A) }), session('shell-2', { agent: agent(ID_B), cwd: 'C:/gone' })],
    [],
  );
  const checks = {
    folderExists: (path: string) => path !== 'C:/gone',
    conversationExists: () => true as boolean | null,
    canResume: true,
  };
  const ids = (list: readonly AgentSessionRecord[]): (string | undefined)[] =>
    list.map((record) => record.agent.conversation?.id);

  it('drops a session whose folder is gone, and says why', () => {
    const { keep, dropped } = restorable(records, checks);
    expect(ids(keep)).toEqual([ID_A]);
    expect(dropped[0]?.reason).toContain('C:/gone');
  });

  it('drops a conversation that was never started, but not one it cannot know about', () => {
    expect(restorable(records, { ...checks, conversationExists: () => false }).keep).toEqual([]);
    expect(ids(restorable(records, { ...checks, conversationExists: () => null }).keep)).toEqual([ID_A]);
  });

  it('reopens nothing for an agent that cannot resume', () => {
    expect(restorable(records, { ...checks, canResume: false }).keep).toEqual([]);
  });

  it('drops an agent its profile could not name, and says which agent and why', () => {
    const codex = agentRecordsFrom(
      [session('shell-3', { title: 'Review', agent: { ...agent(null), label: 'Codex', unresumable: true } })],
      [],
    );
    const { keep, dropped } = restorable(codex, checks);
    expect(keep).toEqual([]);
    expect(dropped[0]?.record.title).toBe('Review');
    expect(dropped[0]?.reason).toBe(
      'Codex cannot reopen a conversation: the agent profile has no session or resume arguments',
    );
  });

  it('says in plain words why a conversation never started is not reopened', () => {
    expect(restorable(records, { ...checks, conversationExists: () => false }).dropped[0]?.reason).toBe(
      'nothing was ever sent in it, so there is no conversation to resume',
    );
  });
});

describe('the conversation on the command line', () => {
  const session = `--session-id ${ID_A}`;

  it('gives a new session its id before the prompt, in every builder', () => {
    expect(buildInteractiveCommand(CLAUDE_CODE_PROFILE, '', session)).toBe(
      `claude --dangerously-skip-permissions ${session}`,
    );
    expect(buildPlanCommand(CLAUDE_CODE_PROFILE, '', session)).toBe(
      `claude --permission-mode plan --allow-dangerously-skip-permissions ${session}`,
    );
    expect(buildWorkCommand(['PROJ-1'], 'web-app', '', CLAUDE_CODE_PROFILE, 'ask', { skill: '/ticket', notes: '' }, session)).toBe(
      `claude --dangerously-skip-permissions ${session} "/ticket PROJ-1 in the web-app repository"`,
    );
  });

  it('leaves the command as it was without one', () => {
    expect(buildInteractiveCommand(CLAUDE_CODE_PROFILE)).toBe('claude --dangerously-skip-permissions');
  });

  it('fills a template only with an id the app would generate', () => {
    expect(conversationArgs('--resume {session}', ID_A)).toBe(`--resume ${ID_A}`);
    expect(conversationArgs('--resume {session}', 'x; rm -rf')).toBe('');
    expect(conversationArgs('', ID_A)).toBe('');
  });

  it('names a new conversation only for a profile that can resume it', () => {
    const fresh = newConversation(CLAUDE_CODE_PROFILE, true);
    expect(fresh?.args).toBe(`--session-id ${fresh?.id ?? ''}`);
    expect(fresh?.plan).toBe(true);
    expect(newConversation({ ...CLAUDE_CODE_PROFILE, resumeArgs: '' }, false)).toBeNull();
  });

  it('gives a stored profile the session arguments only when it runs the same program', () => {
    const stored = { ...CLAUDE_CODE_PROFILE } as Record<string, unknown>;
    delete stored['sessionArgs'];
    delete stored['resumeArgs'];
    delete stored['nameArgs'];
    expect(readProfile(stored).resumeArgs).toBe(CLAUDE_CODE_PROFILE.resumeArgs);
    expect(readProfile(stored).sessionArgs).toBe(CLAUDE_CODE_PROFILE.sessionArgs);
    expect(readProfile(stored).nameArgs).toBe('--name {name}');
    expect(readProfile({ ...stored, interactive: 'codex {model}' }).resumeArgs).toBe('');
    expect(readProfile({ ...stored, interactive: 'codex {model}' }).nameArgs).toBe('');
  });
});

describe('the session name on the command line', () => {
  it('keeps letters, accents and the title separator, and drops what a shell reads', () => {
    expect(safeSessionName('web-app · PROJ-123')).toBe('web-app · PROJ-123');
    expect(safeSessionName('Réponse à Léa')).toBe('Réponse à Léa');
    expect(safeSessionName('PROJ-1 & PROJ-2 "quoted" $(rm) `x` %PATH% !a! ^b; c|d<e>f\\g')).toBe(
      'PROJ-1 PROJ-2 quoted (rm) x PATH a b c d e f g',
    );
    expect(safeSessionName('  --version  ')).toBe('version');
    expect(safeSessionName('a\nb\tc')).toBe('a b c');
    expect(safeSessionName('x'.repeat(SESSION_NAME_MAX + 20))).toHaveLength(SESSION_NAME_MAX);
  });

  it('quotes the name into the template, and passes nothing when there is none', () => {
    expect(sessionNameArgs(CLAUDE_CODE_PROFILE, 'web-app · PROJ-123')).toBe(
      '--name "web-app · PROJ-123"',
    );
    expect(sessionNameArgs(CLAUDE_CODE_PROFILE, ' $ ')).toBe('');
    expect(sessionNameArgs({ ...CLAUDE_CODE_PROFILE, nameArgs: '' }, 'Demo')).toBe('');
  });

  it('never names a Codex session on its command line, even with a template left from Claude Code', () => {
    expect(sessionNameArgs({ ...CLAUDE_CODE_PROFILE, interactive: 'codex {model}' }, 'Demo')).toBe(
      '',
    );
  });

  it('follows the conversation arguments in every builder', () => {
    const args = launchArgs(`--session-id ${ID_A}`, CLAUDE_CODE_PROFILE, 'web-app · PROJ-1');
    expect(args).toBe(`--session-id ${ID_A} --name "web-app · PROJ-1"`);
    expect(
      buildWorkCommand(
        ['PROJ-1'],
        'web-app',
        '',
        CLAUDE_CODE_PROFILE,
        'plan',
        { skill: '/ticket', notes: '' },
        args,
      ),
    ).toBe(
      `claude --permission-mode plan --allow-dangerously-skip-permissions ${args} "/ticket PROJ-1 in the web-app repository"`,
    );
    expect(launchArgs(undefined, CLAUDE_CODE_PROFILE, '')).toBe('');
  });

  it('names a reopened session after a ticket or rule tab, or a tab renamed by hand, only', () => {
    expect(namesItsSession({ renamed: true, actionId: null })).toBe(true);
    expect(namesItsSession({ renamed: false, actionId: '__oxum:work:PROJ-1' })).toBe(true);
    expect(namesItsSession({ renamed: false, actionId: null })).toBe(false);
  });

  it('passes the name again on the resume, so a tab renamed here renames its session', () => {
    // Another program than `claude`, so the restore asks nothing of this machine's Claude storage.
    const profile = { ...CLAUDE_CODE_PROFILE, interactive: 'agent {model}', planArgs: '' };
    const records = agentRecordsFrom(
      [
        session('shell-1', {
          title: 'Fiscal year dropdown',
          renamed: true,
          agent: agent(ID_A),
          cwd: tmpdir(),
        }),
        session('shell-2', { title: 'Claude Code', agent: agent(ID_B), cwd: tmpdir() }),
      ],
      [],
    );
    const restoreAgent = vi.fn<TerminalManager['restoreAgent']>(() => 'restored');
    const shell = {
      id: 'git-bash',
      label: 'Git Bash',
      file: 'bash.exe',
      args: [],
      cwd: 'C:/work',
      detected: true,
    };
    restoreAgentSessions({
      records,
      terminals: { restoreAgent },
      profile,
      shells: [shell],
      defaultShell: shell,
      projects: [],
      size: { cols: 80, rows: 24 },
    });
    const lines = restoreAgent.mock.calls.map(([call]) => call.args.join(' '));
    expect(lines[0]).toContain(`--resume ${ID_A} --name "Fiscal year dropdown"`);
    expect(lines[1]).toContain(`--resume ${ID_B}`);
    expect(lines[1]).not.toContain('--name');
  });
});
