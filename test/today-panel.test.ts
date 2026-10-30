import { describe, expect, it } from 'vitest';
import type { JiraIssue, JiraState, PullRequest, RepoPulls } from '../src/shared/contracts.js';
import { DEFAULT_TODAY_CHANNELS } from '../src/shared/today.js';
import {
  describeElapsed,
  describeWhen,
  shownChannels,
  todayPulls,
  todayTiles,
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
    createdAt: '2026-03-09T08:00:00Z',
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

  it('puts the oldest first within one need, since the chart is read for what has waited longest', () => {
    const items = todayPulls([
      repo([
        pull({ number: 7, createdAt: '2026-03-08T08:00:00Z' }),
        pull({ number: 8, createdAt: '2026-03-01T08:00:00Z' }),
      ]),
    ]);
    expect(items.map((item) => item.pull.number)).toEqual([8, 7]);
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

describe('todayTiles', () => {
  const sprint: JiraState = {
    configured: true,
    views: [
      {
        id: 'sprint',
        label: 'Sprint',
        checkedAt: null,
        error: null,
        truncated: false,
        issues: [
          issue({ key: 'PROJ-1', stage: 'in-progress' }),
          issue({ key: 'PROJ-2', stage: 'todo' }),
          issue({ key: 'PROJ-3', stage: 'todo' }),
          issue({ key: 'PROJ-4', stage: 'done' }),
          issue({ key: 'PROJ-5', stage: 'done', isMine: false }),
        ],
      },
    ],
  };
  const base = {
    channels: { ...DEFAULT_TODAY_CHANNELS, mail: true, teams: true, tipee: true },
    pulls: [
      repo([
        pull({ number: 1, isAuthor: false, isReviewer: true }),
        pull({ number: 2, review: 'changes-requested' }),
        pull({ number: 3 }),
        pull({ number: 4, review: 'approved' }),
        pull({ number: 5, isDraft: true }),
      ]),
    ],
    tickets: sprint,
    digest: { digest: null, running: false, startedAt: null, error: null },
    tipee: { configured: false, status: null, checkedAt: null, error: null },
    tipeeUrl: '',
    now: new Date(2026, 2, 10, 9, 0).getTime(),
  };

  it('counts what needs me, mine waiting and mine approved, drafts in none of them', () => {
    expect(todayTiles(base).pulls.map((tile) => [tile.label, tile.value])).toEqual([
      ['PRs need you', '2'],
      ['Mine, waiting', '1'],
      ['Mine, approved', '1'],
    ]);
  });

  it('counts my tickets of the sprint by stage, and only mine', () => {
    expect(todayTiles(base).tickets.map((tile) => [tile.label, tile.value])).toEqual([
      ['In progress', '1'],
      ['To do', '2'],
      ['Done', '1'],
    ]);
  });

  it('says ? for mail and Teams never read, and … while they are being read, never 0', () => {
    expect(todayTiles(base).day.map((tile) => tile.value)).toEqual(['?', '?', '?']);
    const running = { ...base, digest: { ...base.digest, running: true } };
    expect(
      todayTiles(running)
        .day.slice(0, 2)
        .map((tile) => tile.value),
    ).toEqual(['…', '…']);
  });

  it('says ? for time tracking that is not configured, never a time', () => {
    expect(todayTiles(base).day[2]).toMatchObject({
      label: 'Clocked since',
      value: '?',
      detail: 'not configured',
      ok: false,
    });
  });
});
