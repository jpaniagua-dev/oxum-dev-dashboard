import { describe, expect, it } from 'vitest';
import type { JiraIssue, JiraState, PullRequest, RepoPulls } from '../src/shared/contracts.js';
import type { DigestEvent } from '../src/shared/today.js';
import { DEFAULT_TODAY_CHANNELS } from '../src/shared/today.js';
import {
  describeElapsed,
  describeEventTime,
  describeWhen,
  eventMoment,
  shownChannels,
  statTiles,
  todayPulls,
  todayTickets,
} from '../src/renderer/ui/today-panel.js';

function pull(patch: Partial<PullRequest>): PullRequest {
  return {
    number: 1,
    title: 'Add the thing',
    url: 'https://github.com/example-org/web-app/pull/1',
    branch: 'PROJ-123-add-the-thing',
    authorLogin: 'dev',
    isDraft: false,
    review: 'review-required',
    checks: 'passing',
    passed: 3,
    failed: 0,
    pending: 0,
    isAuthor: true,
    isReviewer: false,
    updatedAt: '2026-03-10T08:00:00Z',
    headSha: '',
    changedFiles: 2,
    ...patch,
  };
}

function repo(pulls: PullRequest[]): RepoPulls {
  return {
    projectId: 'web-app',
    label: 'web-app',
    slug: 'example-org/web-app',
    pulls,
    checkedAt: '2026-03-10T08:00:00Z',
    error: null,
  };
}

function issue(patch: Partial<JiraIssue>): JiraIssue {
  return {
    key: 'PROJ-1',
    summary: 'Do it',
    status: 'To do',
    stage: 'todo',
    type: 'Story',
    assignee: 'Dana Dev',
    isMine: true,
    url: 'https://example.atlassian.net/browse/PROJ-1',
    updatedAt: '2026-03-10T08:00:00Z',
    source: 'jira',
    ...patch,
  };
}

describe('todayPulls', () => {
  it('lists what needs me first: my review, then changes asked of me, then what waits on others', () => {
    const items = todayPulls([
      repo([
        pull({ number: 1, review: 'approved' }),
        pull({ number: 2, isDraft: true }),
        pull({ number: 3, isAuthor: false, isReviewer: true }),
        pull({ number: 4, review: 'changes-requested' }),
        pull({ number: 5 }),
        pull({ number: 6, isAuthor: false }),
      ]),
    ]);
    expect(items.map((item) => [item.pull.number, item.need])).toEqual([
      [3, 'review'],
      [4, 'changes'],
      [1, 'approved'],
      [5, 'waiting'],
      [2, 'draft'],
    ]);
  });
});

describe('todayTickets', () => {
  it('lists my open tickets once, the ones in progress first', () => {
    const state: JiraState = {
      configured: true,
      views: [
        {
          id: 'sprint',
          label: 'Sprint',
          checkedAt: null,
          error: null,
          truncated: false,
          issues: [
            issue({ key: 'PROJ-1' }),
            issue({ key: 'PROJ-2', stage: 'in-progress' }),
            issue({ key: 'PROJ-3', stage: 'done' }),
            issue({ key: 'PROJ-4', isMine: false }),
          ],
        },
        {
          id: 'mine',
          label: 'Mine',
          checkedAt: null,
          error: null,
          truncated: false,
          issues: [issue({ key: 'PROJ-1' })],
        },
      ],
    };
    expect(todayTickets(state).map((entry) => entry.key)).toEqual(['PROJ-2', 'PROJ-1']);
    expect(todayTickets(null)).toEqual([]);
  });
});

describe('the calendar card', () => {
  const meeting: DigestEvent = {
    subject: 'Sprint review',
    start: '2026-03-10T09:30',
    end: '2026-03-10T10:00',
    timeZone: 'W. Europe Standard Time',
    isAllDay: false,
    isCancelled: false,
    showAs: 'busy',
    location: '',
    url: '',
  };

  it('tells a meeting over from one under way and one to come, in local time', () => {
    expect(eventMoment(meeting, new Date(2026, 2, 10, 9, 0).getTime())).toBe('later');
    expect(eventMoment(meeting, new Date(2026, 2, 10, 9, 45).getTime())).toBe('now');
    expect(eventMoment(meeting, new Date(2026, 2, 10, 10, 0).getTime())).toBe('past');
  });

  it('writes the wall-clock range, or All day', () => {
    expect(describeEventTime(meeting)).toBe('09:30-10:00');
    expect(describeEventTime({ ...meeting, isAllDay: true })).toBe('All day');
  });
});

describe('describeWhen', () => {
  const now = new Date(2026, 2, 10, 15, 0).getTime();

  it('gives the time alone today, and names the day otherwise', () => {
    expect(describeWhen(new Date(2026, 2, 10, 9, 5).toISOString(), now)).toBe('09:05');
    expect(describeWhen(new Date(2026, 2, 9, 18, 0).toISOString(), now)).toBe('Yesterday 18:00');
    expect(describeWhen(new Date(2026, 2, 6, 8, 0).toISOString(), now)).toMatch(/^Fri 08:00$/);
    expect(describeWhen('not a date', now)).toBe('');
  });
});

describe('describeElapsed', () => {
  it('counts minutes and seconds since the run started', () => {
    expect(
      describeElapsed('2026-03-10T12:00:00.000Z', Date.parse('2026-03-10T12:01:07.000Z')),
    ).toBe('1:07');
    expect(describeElapsed(null, 0)).toBe('');
  });
});

describe('shownChannels', () => {
  it('draws the cards switched on, in display order', () => {
    expect(shownChannels({ ...DEFAULT_TODAY_CHANNELS, tipee: true, pulls: false })).toEqual([
      'tickets',
      'tipee',
    ]);
  });
});

describe('statTiles', () => {
  const base = {
    pulls: [
      repo([
        pull({ number: 1, isAuthor: false, isReviewer: true }),
        pull({ number: 2, review: 'approved' }),
      ]),
    ],
    tickets: null,
    digest: { digest: null, running: false, startedAt: null, error: null },
    tipee: { configured: false, status: null, checkedAt: null, error: null },
    tipeeUrl: '',
    now: new Date(2026, 2, 10, 9, 0).getTime(),
  };

  it('leads with the first card switched on, and counts what needs me', () => {
    const tiles = statTiles({ ...base, channels: DEFAULT_TODAY_CHANNELS });
    expect(tiles[0]).toMatchObject({ label: 'PRs need you', value: '1', hero: true });
    expect(tiles[0]?.detail).toBe('1 approved · 2 open');
    expect(tiles[1]).toMatchObject({ label: 'In progress', value: '…' });
  });

  it('says ? for a digest never read, and … while it is being read, never 0', () => {
    const channels = { ...DEFAULT_TODAY_CHANNELS, pulls: false, tickets: false, mail: true };
    expect(statTiles({ ...base, channels })[0]?.value).toBe('?');
    const running = { ...base.digest, running: true };
    expect(statTiles({ ...base, channels, digest: running })[0]?.value).toBe('…');
  });
});
