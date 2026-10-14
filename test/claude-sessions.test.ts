import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { followConversations, holdsConversation, readLiveSession } from '../src/shared/claude-sessions.js';
import type { TerminalSession } from '../src/shared/contracts.js';
import { ConversationTracker } from '../src/main/terminal/conversation-tracker.js';

const HANDED_IN = '09c39600-0000-4000-8000-000000000001';
const RESUMED = 'e36a9500-0000-4000-8000-000000000002';
const OTHER = 'bf578b00-0000-4000-8000-000000000003';

describe('the registry of running Claude Code processes', () => {
  it('reads a pid and the conversation it is writing, and nothing it cannot trust', () => {
    expect(readLiveSession({ pid: 44272, sessionId: RESUMED, cwd: 'C:/work', status: 'busy' })).toEqual({
      pid: 44272,
      sessionId: RESUMED,
    });
    expect(readLiveSession({ pid: 44272, sessionId: 'x; rm -rf' })).toBeNull();
    expect(readLiveSession({ pid: -1, sessionId: RESUMED })).toBeNull();
    expect(readLiveSession('nonsense')).toBeNull();
  });
});

describe('following a tab to its conversation', () => {
  const agent = { terminalId: 'shell-1', conversationId: HANDED_IN };

  it('learns the pid from the process still writing the id the app handed in', () => {
    const moves = followConversations([agent], new Map(), [{ pid: 10, sessionId: HANDED_IN }]);
    expect(moves.bind).toEqual([{ terminalId: 'shell-1', pid: 10 }]);
    expect(moves.update).toEqual([]);
  });

  it('follows the pid once the person resumed another conversation in the tab', () => {
    const moves = followConversations([agent], new Map([['shell-1', 10]]), [{ pid: 10, sessionId: RESUMED }]);
    expect(moves.update).toEqual([{ terminalId: 'shell-1', conversationId: RESUMED }]);
  });

  it('lets go of a pid that left the registry, so a reused pid is never followed', () => {
    const moves = followConversations([agent], new Map([['shell-1', 10]]), [{ pid: 11, sessionId: OTHER }]);
    expect(moves.unbind).toEqual(['shell-1']);
  });

  it('never binds two tabs to one process', () => {
    const moves = followConversations(
      [agent, { terminalId: 'shell-2', conversationId: HANDED_IN }],
      new Map(),
      [{ pid: 10, sessionId: HANDED_IN }],
    );
    expect(moves.bind).toEqual([{ terminalId: 'shell-1', pid: 10 }]);
  });

  it('does nothing for a tab whose process it has not seen yet', () => {
    expect(followConversations([agent], new Map(), [{ pid: 10, sessionId: OTHER }])).toEqual({
      bind: [],
      update: [],
      unbind: [],
    });
  });
});

describe('a transcript that can be resumed', () => {
  it('holds a message, not only the bookkeeping line of a session nobody spoke in', () => {
    expect(holdsConversation('{"type":"bridge-session","sessionId":"x"}')).toBe(false);
    expect(holdsConversation('{"type":"bridge-session"}\n{"type":"user","message":{}}')).toBe(true);
  });
});

describe('ConversationTracker', () => {
  let folder = '';

  afterEach(async () => {
    if (folder.length > 0) {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('moves a tab onto the conversation its process switched to, across two passes', async () => {
    folder = await mkdtemp(join(tmpdir(), 'claude-sessions-'));
    const session = {
      id: 'shell-1',
      running: true,
      agent: { label: 'Claude Code', model: '', instructionFile: '', startedAt: '', conversation: { id: HANDED_IN, plan: false } },
    } as unknown as TerminalSession;
    const updates: [string, string][] = [];
    const tracker = new ConversationTracker(
      { sessions: () => [session], setConversation: (id, conversation) => updates.push([id, conversation]) },
      folder,
    );

    await writeFile(join(folder, '10.json'), JSON.stringify({ pid: 10, sessionId: HANDED_IN }));
    await tracker.tick();
    expect(updates).toEqual([]);

    await writeFile(join(folder, '10.json'), JSON.stringify({ pid: 10, sessionId: RESUMED }));
    await tracker.tick();
    expect(updates).toEqual([['shell-1', RESUMED]]);
  });

  it('reads a missing registry as no information', async () => {
    const tracker = new ConversationTracker(
      { sessions: () => [], setConversation: () => undefined },
      join(tmpdir(), 'no-such-registry-folder'),
    );
    await expect(tracker.tick()).resolves.toBeUndefined();
  });
});
