import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexConfigArgs,
  createCodexThread,
  prepareConversation,
  stopCodexPreparations,
  type CodexThreadOptions,
} from '../src/main/terminal/codex-conversation.js';
import {
  CLAUDE_CODE_PROFILE,
  CONVERSATION_ID_PATTERN,
  isCodexProfile,
  resumeArguments,
  type AgentProfile,
} from '../src/shared/agent-profile.js';
import { agentRecordsFrom, readAgentRecord } from '../src/shared/agent-sessions.js';
import { restoreAgentSessions } from '../src/main/terminal/agent-restore.js';
import type { TerminalSession } from '../src/shared/contracts.js';
import type { TerminalManager } from '../src/main/terminal/terminal-manager.js';
import { AutomationRunner } from '../src/main/automation/automation-runner.js';
import { AutomationStore, parseRule } from '../src/main/automation/automation-store.js';

const CODEX: AgentProfile = {
  ...CLAUDE_CODE_PROFILE,
  label: 'My agent',
  interactive: 'codex --ask-for-approval on-request {model}',
  instructionFile: 'AGENTS.md',
  sessionArgs: '',
  resumeArgs: '',
  planArgs: '',
};

// A local protocol peer, not an agent: no credentials, repositories or network are accessed.
const PEER = String.raw`
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const lines = createInterface({ input: process.stdin });
process.stdout.write('null\nnot-json\n');
lines.on('close', () => {
  if (process.env.CODEX_TEST_CLOSE_DELAY) setTimeout(() => {}, 1000);
});
const send = (message) => {
  const data = JSON.stringify(message) + '\r\n';
  process.stdout.write(data.slice(0, 9));
  setTimeout(() => process.stdout.write(data.slice(9)), 5);
};
lines.on('line', (line) => {
  const message = JSON.parse(line);
  appendFileSync(process.env.CODEX_TEST_LOG, JSON.stringify(message) + '\n');
  if (message.method === 'initialize') send({ id: 0, result: { userAgent: 'fixture' } });
  if (message.method === 'thread/start') {
    if (message.params.model === 'timeout') return;
    if (message.params.model === 'exit') { process.exit(1); return; }
    if (message.params.model === 'error') { send({ id: 1, error: { message: 'Unsupported local API' } }); return; }
    const id = message.params.model === 'invalid' ? '$(invalid)' : randomUUID();
    setTimeout(() => send({ id: 1, result: { thread: { id } } }), message.params.model === 'slow' ? 75 : 0);
  }
  if (message.method === 'thread/name/set') send({ id: 2, result: {} });
});
`;

let folder: string;
let peer: string;
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'dashboard-codex-test-'));
  peer = join(folder, 'protocol peer.cjs');
  await writeFile(peer, PEER);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

function options(model = '', title = 'Demo agent'): CodexThreadOptions {
  return {
    target: { file: process.execPath, viaCmd: false },
    configArgs: [peer],
    cwd: folder,
    model,
    title,
    env: { CODEX_TEST_LOG: join(folder, `${model || 'default'}.jsonl`) },
    timeoutMs: 5_000,
  };
}

describe('Codex launch configuration', () => {
  it('identifies the executable independently of its label', () => {
    expect(isCodexProfile(CODEX)).toBe(true);
    expect(isCodexProfile({ ...CODEX, interactive: '"C:\\tools\\codex.cmd" {model}' })).toBe(true);
    expect(isCodexProfile({ ...CODEX, interactive: 'other --label codex', label: 'Codex' })).toBe(
      false,
    );
    expect(resumeArguments(CODEX)).toBe('resume {session}');
    expect(resumeArguments(CLAUDE_CODE_PROFILE)).toBe('--resume {session}');
  });

  it('preserves configuration overrides without sending TUI-only permission flags to app-server', () => {
    expect(
      codexConfigArgs({
        ...CODEX,
        interactive: `codex -c 'model_provider="offline"' --enable hooks -a never --no-daemon {model}`,
      }),
    ).toEqual(['-c', 'model_provider="offline"', '--enable', 'hooks']);
    expect(() =>
      codexConfigArgs({ ...CODEX, interactive: 'codex --remote ws://localhost:1234' }),
    ).toThrow('local Codex');
    expect(() => codexConfigArgs({ ...CODEX, interactive: 'codex -p demo' })).toThrow(
      'does not support --profile',
    );
  });

  it('keeps the existing caller-supplied id path for Claude Code', async () => {
    const result = await prepareConversation(CLAUDE_CODE_PROFILE, true, folder, '', 'Demo');
    expect(result?.conversation).toMatchObject({
      id: expect.stringMatching(CONVERSATION_ID_PATTERN),
      plan: true,
    });
    expect(result?.args).toBe(`--session-id ${result?.conversation.id}`);
    expect(
      await prepareConversation(
        { ...CLAUDE_CODE_PROFILE, resumeArgs: '' },
        false,
        folder,
        '',
        'Demo',
      ),
    ).toBeNull();
  });
});

describe('local Codex protocol', () => {
  it('creates and names a persistent thread without submitting a model turn', async () => {
    const id = await createCodexThread(options());
    expect(id).toMatch(CONVERSATION_ID_PATTERN);
    const calls = (await readFile(join(folder, 'default.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string; params: unknown });
    expect(calls.map((call) => call.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'thread/name/set',
    ]);
    expect(calls[2]?.params).toEqual({ cwd: folder, ephemeral: false });
    expect(calls[3]?.params).toEqual({ threadId: id, name: 'Demo agent' });
  });

  it('keeps simultaneous agents in the same directory associated with their own ids', async () => {
    const [slow, fast] = await Promise.all([
      createCodexThread(options('slow', 'First')),
      createCodexThread(options('fast', 'Second')),
    ]);
    expect(slow).not.toBe(fast);
    for (const [model, id, name] of [
      ['slow', slow, 'First'],
      ['fast', fast, 'Second'],
    ]) {
      const log = await readFile(join(folder, `${model}.jsonl`), 'utf8');
      expect(log).toContain(JSON.stringify({ threadId: id, name }));
    }
  });

  it('reports protocol errors, an invalid id and an exited process instead of recording an unusable session', async () => {
    await expect(createCodexThread(options('error'))).rejects.toThrow('Unsupported local API');
    await expect(createCodexThread(options('invalid'))).rejects.toThrow('invalid conversation id');
    await expect(createCodexThread(options('exit'))).rejects.toThrow('closed before creating');
  });

  it('bounds a stalled local API and cleans up its child process', async () => {
    await expect(createCodexThread({ ...options('timeout'), timeoutMs: 400 })).rejects.toThrow(
      'timed out',
    );
  });

  it.runIf(process.platform === 'win32')(
    'runs an npm-style command shim from a directory with spaces',
    async () => {
      const shim = join(folder, 'codex fixture.cmd');
      await writeFile(shim, `@"${process.execPath}" "${peer}" %*\r\n`);
      const id = await createCodexThread({
        ...options(),
        target: { file: shim, viaCmd: true },
        configArgs: [],
      });
      expect(id).toMatch(CONVERSATION_ID_PATTERN);
    },
  );
});

describe('saving and reopening Codex tabs', () => {
  it('retains ids, renamed titles, notes and order across serialization and a new launch', async () => {
    const ids = await Promise.all([
      createCodexThread(options('first')),
      createCodexThread(options('second')),
    ]);
    const sessions: TerminalSession[] = ids.map((id, index) => ({
      id: `shell-${index}`,
      title: `Task ${index}`,
      renamed: true,
      cwd: folder,
      kind: 'shell',
      projectId: null,
      actionId: null,
      role: null,
      profileId: 'cmd',
      note: { text: `Keep note ${index}`, writtenAt: '2026-01-01T00:00:00Z' },
      running: true,
      closable: true,
      exitCode: null,
      stoppedOnPurpose: false,
      agent: {
        label: 'Codex',
        model: '',
        instructionFile: 'AGENTS.md',
        startedAt: '2026-01-01T00:00:00Z',
        conversation: { id: id ?? '', plan: false, provider: 'codex' },
      },
    }));
    const records = agentRecordsFrom(sessions, [
      { tabs: ['shell-1', 'shell-0'], active: 'shell-0' },
    ]);
    const file = join(folder, 'agent-sessions.json');
    await writeFile(file, JSON.stringify(records));
    const loaded = (JSON.parse(await readFile(file, 'utf8')) as unknown[]).flatMap((value) => {
      const record = readAgentRecord(value);
      return record === null ? [] : [record];
    });
    const restore = vi.fn<TerminalManager['restoreAgent']>(() => 'restored');
    const shell = {
      id: 'cmd',
      label: 'CMD',
      file: 'cmd.exe',
      args: [],
      cwd: folder,
      detected: true,
    };
    const init = {
      records: loaded,
      profile: CODEX,
      terminals: { restoreAgent: restore },
      shells: [shell],
      defaultShell: shell,
      projects: [],
      size: { cols: 80, rows: 24 },
    };
    expect(restoreAgentSessions(init)).toBe(2);
    expect(restore.mock.calls.map(([call]) => call.title)).toEqual(['Task 1', 'Task 0']);
    expect(restore.mock.calls[0]?.[0]).toMatchObject({
      note: 'Keep note 1',
      renamed: true,
      cwd: folder,
    });
    expect(restore.mock.calls[0]?.[0].args.join(' ')).toContain(`resume ${ids[1]}`);
    expect(restore.mock.calls[1]?.[0].args.join(' ')).toContain(`resume ${ids[0]}`);
    expect(restore.mock.calls[0]?.[0].args.join(' ')).not.toContain('--session-id');

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    restore.mockClear();
    expect(restoreAgentSessions({ ...init, profile: CLAUDE_CODE_PROFILE })).toBe(0);
    expect(restore).not.toHaveBeenCalled();
  });
});

describe('asynchronous automation launches', () => {
  it('reports a failed asynchronous preparation as a refusal and does not fire again', async () => {
    const rule = parseRule({
      id: 'demo',
      name: 'Demo agent',
      trigger: 'schedule',
      everyMinutes: 5,
      enabled: true,
      action: { kind: 'agent', text: 'Demo work' },
    });
    if (rule === null) throw new Error('Invalid test fixture');
    const store = new AutomationStore(join(folder, 'automations.json'));
    await store.save({ rules: [rule], ledger: {}, lastRun: {} });
    const runAgent = vi.fn(async () => false);
    const runner = new AutomationRunner(store, () => ({ enabled: true, shellEnabled: false }), {
      runAgent,
      runShell: () => false,
      notify: () => {},
      now: () => new Date('2026-01-01T12:00:00Z'),
    });
    const result = await runner.tickSchedule();
    expect(result.ran).toEqual([]);
    expect(result.refusals).toEqual(['Could not start an agent on Demo agent']);
    expect((await runner.tickSchedule()).refusals).toEqual([]);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });
});

describe('shutdown while preparing a session', () => {
  it('cancels pending requests before allowing quit and refuses further launches', async () => {
    const init = options('after-reply');
    const result = createCodexThread({
      ...init,
      env: { ...init.env, CODEX_TEST_CLOSE_DELAY: '1' },
    });
    const rejected = expect(result).rejects.toThrow('cancelled');
    const queued = expect(createCodexThread(options('queued'))).rejects.toThrow('cancelled');
    // Cancel after the peer received the naming request: an id has already been allocated.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const log = await readFile(join(folder, 'after-reply.jsonl'), 'utf8').catch(() => '');
      if (log.includes('thread/name/set')) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await stopCodexPreparations();
    await rejected;
    await queued;
    await expect(createCodexThread(options())).rejects.toThrow('cancelled');
  });
});
