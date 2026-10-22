import { describe, expect, it } from 'vitest';
import {
  DIGEST_TOOLS,
  digestArgs,
  digestPrompt,
  parseDigest,
  readStoredDigest,
  readToolCalls,
  sanitizeTodayChannels,
  wantsDigest,
  type TodayDigest,
  type ToolCall,
} from '../src/shared/today.js';

/** A `stream-json` transcript: one assistant turn of tool calls, then their results. */
function transcript(
  calls: readonly { name: string; result: unknown[] | string; isError?: boolean }[],
): string {
  const uses = calls.map((call, index) => ({
    type: 'tool_use',
    id: `toolu_${index}`,
    name: call.name,
    input: {},
  }));
  const results = calls.map((call, index) => ({
    type: 'tool_result',
    tool_use_id: `toolu_${index}`,
    ...(call.isError === true ? { is_error: true } : {}),
    content:
      typeof call.result === 'string'
        ? call.result
        : call.result.map((piece) => ({ type: 'text', text: JSON.stringify(piece) })),
  }));
  return [
    JSON.stringify({ type: 'system', subtype: 'init', tools: [] }),
    JSON.stringify({ type: 'assistant', message: { content: uses } }),
    'not json at all',
    JSON.stringify({ type: 'user', message: { content: results } }),
    JSON.stringify({ type: 'result', is_error: false, result: 'OK' }),
  ].join('\n');
}

const ME = { id: 'u1', displayName: 'Dana Dev', mail: 'dev@example.com' };

function event(patch: Record<string, unknown>): Record<string, unknown> {
  return {
    uri: 'calendar:///events/1',
    subject: 'Sprint review',
    start: { dateTime: '2026-03-10T09:30:00.0000000', timeZone: 'W. Europe Standard Time' },
    end: { dateTime: '2026-03-10T10:00:00.0000000', timeZone: 'W. Europe Standard Time' },
    isAllDay: false,
    isCancelled: false,
    showAs: 'busy',
    location: { displayName: 'Room 2' },
    webLink: 'https://outlook.example.com/event/1',
    ...patch,
  };
}

function message(patch: Record<string, unknown>): Record<string, unknown> {
  return {
    uri: 'teams:///chats/c1/messages/1',
    chatId: 'c1',
    summary: 'Can you look at PROJ-123?',
    createdDateTime: '2026-03-10T08:00:00.000Z',
    from: { displayName: 'Sam Ops', email: 'ops@example.com' },
    webUrl: 'https://teams.example.com/l/message/1',
    ...patch,
  };
}

function digestOf(calls: readonly ToolCall[]): TodayDigest {
  return parseDigest(calls, '2026-03-10T12:00:00.000Z', '2026-03-10');
}

describe('the Today channels', () => {
  it('keeps the two free cards on and the others off for a fresh install', () => {
    expect(sanitizeTodayChannels(undefined)).toEqual({
      pulls: true,
      tickets: true,
      calendar: false,
      mail: false,
      teams: false,
      tipee: false,
    });
  });

  it('turns a card that reaches an account on only for an explicit true', () => {
    const channels = sanitizeTodayChannels({ pulls: false, mail: 'yes', teams: true });
    expect(channels.pulls).toBe(false);
    expect(channels.mail).toBe(false);
    expect(channels.teams).toBe(true);
    expect(wantsDigest(channels)).toBe(true);
    expect(wantsDigest(sanitizeTodayChannels({ tipee: true }))).toBe(false);
  });
});

describe('the digest run', () => {
  it('allows the read tools and refuses the writing ones and the shell', () => {
    const args = digestArgs('prompt');
    const allowed = args.slice(
      args.indexOf('--allowedTools') + 1,
      args.indexOf('--disallowedTools'),
    );
    expect(allowed).toEqual(Object.values(DIGEST_TOOLS));
    expect(allowed.some((tool) => /send|delete|trash|forward/.test(tool))).toBe(false);
    expect(args).toContain('mcp__claude_ai_Microsoft_365__outlook_send_mail');
    expect(args).toContain('Bash');
  });

  it('makes the allow-list binding and keeps the user settings out', () => {
    const args = digestArgs('prompt');
    expect(
      args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2),
    ).toEqual(['--permission-mode', 'dontAsk']);
    expect(args).toContain('--setting-sources');
  });

  it('never uses a flag that hides the claude.ai connectors', () => {
    const args = digestArgs('prompt');
    for (const flag of ['--strict-mcp-config', '--restricted', '--tools']) {
      expect(args).not.toContain(flag);
    }
  });

  it('asks about local days, with no character cmd.exe refuses', () => {
    const prompt = digestPrompt(new Date(2026, 2, 1, 8, 0));
    expect(prompt).toContain('afterDateTime 2026-03-01T00:00:00');
    expect(prompt).toContain('beforeDateTime 2026-03-02T00:00:00');
    expect(prompt).toContain('afterDateTime 2026-02-28T00:00:00');
    expect(prompt).not.toMatch(/["%^&|<>!]/);
  });
});

describe('readToolCalls', () => {
  it('pairs each result with the tool that produced it, and skips what is not JSON', () => {
    const calls = readToolCalls(
      transcript([
        { name: DIGEST_TOOLS.me, result: [ME] },
        { name: DIGEST_TOOLS.mail, result: 'Authentication failed', isError: true },
      ]),
    );
    expect(calls).toEqual([
      { name: DIGEST_TOOLS.me, isError: false, pieces: [JSON.stringify(ME)] },
      { name: DIGEST_TOOLS.mail, isError: true, pieces: ['Authentication failed'] },
    ]);
  });

  it('finds nothing in a reply where the model only wrote a call as text', () => {
    const text = JSON.stringify({ type: 'result', result: '<invoke name="get_me"></invoke>' });
    expect(readToolCalls(text)).toEqual([]);
  });
});

describe('parseDigest', () => {
  it('keeps the events of the day and drops a whole-day event that ended this morning', () => {
    const digest = digestOf(
      readToolCalls(
        transcript([
          {
            name: DIGEST_TOOLS.calendar,
            result: [
              event({
                subject: 'Off yesterday',
                isAllDay: true,
                start: { dateTime: '2026-03-09T00:00:00.0000000', timeZone: 'UTC' },
                end: { dateTime: '2026-03-10T00:00:00.0000000', timeZone: 'UTC' },
              }),
              event({}),
              { offset: 2, totalResultCount: 2 },
            ],
          },
        ]),
      ),
    );
    expect(digest.events).toEqual([
      {
        subject: 'Sprint review',
        start: '2026-03-10T09:30',
        end: '2026-03-10T10:00',
        timeZone: 'W. Europe Standard Time',
        isAllDay: false,
        isCancelled: false,
        showAs: 'busy',
        location: 'Room 2',
        url: 'https://outlook.example.com/event/1',
      },
    ]);
    expect(digest.errors.calendar).toBeUndefined();
  });

  it('reads mail with its read state and the total the search matched', () => {
    const digest = digestOf(
      readToolCalls(
        transcript([
          {
            name: DIGEST_TOOLS.mail,
            result: [
              {
                uri: 'mail:///messages/1',
                subject: 'Release notes',
                sender: 'ops@example.com',
                receivedDateTime: '2026-03-10T07:00:00.000Z',
                isRead: false,
                importance: 'high',
                webLink: 'https://outlook.example.com/mail/1',
              },
              { moreResults: true, nextOffset: 1, totalResultCount: 40 },
            ],
          },
        ]),
      ),
    );
    expect(digest.mail).toEqual([
      {
        subject: 'Release notes',
        sender: 'ops@example.com',
        receivedAt: '2026-03-10T07:00:00.000Z',
        isRead: false,
        important: true,
        preview: '',
        url: 'https://outlook.example.com/mail/1',
      },
    ]);
    expect(digest.mailTotal).toBe(40);
  });

  it('keeps the conversations where somebody else wrote last, with what they wrote since my reply', () => {
    const mine = { displayName: 'Dana Dev', email: 'DEV@example.com' };
    const digest = digestOf(
      readToolCalls(
        transcript([
          { name: DIGEST_TOOLS.me, result: [ME] },
          {
            name: DIGEST_TOOLS.messages,
            result: [
              message({
                createdDateTime: '2026-03-10T09:00:00.000Z',
                summary: 'Any news?\n  Ping',
              }),
              message({
                createdDateTime: '2026-03-10T08:30:00.000Z',
                from: mine,
                summary: 'On it',
              }),
              message({ createdDateTime: '2026-03-10T08:00:00.000Z', summary: 'Can you look?' }),
              message({ chatId: 'c3', summary: 'Sam Ops Lunch?' }),
              message({ chatId: 'c3', createdDateTime: '2026-03-10T07:00:00.000Z', summary: '' }),
              message({ chatId: 'c2', from: mine, summary: 'Done' }),
            ],
          },
          {
            name: DIGEST_TOOLS.chats,
            result: [
              {
                id: 'c1',
                chatType: 'oneOnOne',
                topic: null,
                members: [
                  { displayName: 'Dana Dev', email: 'dev@example.com' },
                  { displayName: 'Sam Ops', email: 'ops@example.com' },
                ],
              },
            ],
          },
        ]),
      ),
    );
    expect(digest.chats.map((chat) => chat.chatId)).toEqual(['c1', 'c3']);
    expect(digest.chats[1]?.lines.map((line) => line.text)).toEqual([
      '(attachment or card)',
      'Lunch?',
    ]);
    expect(digest.chats.slice(0, 1)).toEqual([
      {
        chatId: 'c1',
        title: 'Sam Ops',
        count: 1,
        lastFrom: 'Sam Ops',
        lastAt: '2026-03-10T09:00:00.000Z',
        preview: 'Any news? Ping',
        url: 'https://teams.example.com/l/message/1',
        lines: [
          {
            from: 'Sam Ops',
            at: '2026-03-10T09:00:00.000Z',
            text: 'Any news? Ping',
            url: 'https://teams.example.com/l/message/1',
          },
        ],
      },
    ]);
  });

  it('counts a whole conversation as waiting when my reply is older than the window', () => {
    const digest = digestOf(
      readToolCalls(
        transcript([
          { name: DIGEST_TOOLS.me, result: [ME] },
          {
            name: DIGEST_TOOLS.messages,
            result: [1, 2, 3, 4, 5, 6].map((minute) =>
              message({
                createdDateTime: `2026-03-10T08:0${minute}:00.000Z`,
                summary: `m${minute}`,
              }),
            ),
          },
        ]),
      ),
    );
    expect(digest.chats[0]?.count).toBe(6);
    expect(digest.chats[0]?.lines.map((line) => line.text)).toEqual(['m3', 'm4', 'm5', 'm6']);
    expect(digest.chats[0]?.title).toBe('Sam Ops');
  });

  it('says per section what could not be read, and leaves the other sections standing', () => {
    const digest = digestOf(
      readToolCalls(
        transcript([
          { name: DIGEST_TOOLS.calendar, result: 'Calendar access denied', isError: true },
          { name: DIGEST_TOOLS.mail, result: 'No results found' },
        ]),
      ),
    );
    expect(digest.errors.calendar).toBe('Calendar access denied');
    expect(digest.errors.mail).toBeUndefined();
    expect(digest.errors.teams).toBe('Not read: the run did not make this call');
  });

  it('keeps only http links, since a row opens them in the browser', () => {
    const digest = digestOf(
      readToolCalls(
        transcript([
          { name: DIGEST_TOOLS.calendar, result: [event({ webLink: 'javascript:alert(1)' })] },
        ]),
      ),
    );
    expect(digest.events[0]?.url).toBe('');
  });
});

describe('readStoredDigest', () => {
  it('reads back what was stored', () => {
    const digest = digestOf(
      readToolCalls(transcript([{ name: DIGEST_TOOLS.calendar, result: [event({})] }])),
    );
    expect(readStoredDigest(JSON.parse(JSON.stringify(digest)))).toEqual(digest);
  });

  it('refuses a file that is not a digest, and drops rows that are not rows', () => {
    expect(readStoredDigest({ events: [] })).toBeNull();
    expect(
      readStoredDigest({ fetchedAt: '2026-03-10T12:00:00.000Z', day: '2026-03-10' }),
    ).toBeNull();
    const stored = readStoredDigest({
      version: 3,
      fetchedAt: '2026-03-10T12:00:00.000Z',
      day: '2026-03-10',
      events: [{ subject: 'no start' }],
      mail: 'nope',
      chats: [{ chatId: 'c1', lastAt: '2026-03-10T09:00:00.000Z', count: -3, url: 'file:///etc' }],
      errors: { mail: 'Refused', other: 'ignored' },
    });
    expect(stored?.events).toEqual([]);
    expect(stored?.mail).toEqual([]);
    expect(stored?.chats[0]).toMatchObject({ count: 1, url: '' });
    expect(stored?.errors).toEqual({ mail: 'Refused' });
  });
});
