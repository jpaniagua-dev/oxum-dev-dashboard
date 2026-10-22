import { describe, expect, it } from 'vitest';
import type { JiraIssue, JiraState } from '../src/shared/contracts.js';
import type { DigestEvent } from '../src/shared/today.js';
import { layoutDay, nowOffset, sprintBreakdown } from '../src/renderer/ui/today-charts.js';

function meeting(start: string, end: string, patch: Partial<DigestEvent> = {}): DigestEvent {
  return {
    subject: 'Sync',
    start: `2026-03-10T${start}`,
    end: `2026-03-10T${end}`,
    timeZone: 'UTC',
    isAllDay: false,
    isCancelled: false,
    showAs: 'busy',
    location: '',
    url: '',
    ...patch,
  };
}

describe('layoutDay', () => {
  it('places meetings on an 8:00 to 18:00 axis, in percent', () => {
    const layout = layoutDay([meeting('09:00', '10:00')]);
    expect(layout.fromHour).toBe(8);
    expect(layout.toHour).toBe(18);
    expect(layout.placed[0]).toMatchObject({ left: 10, width: 10, lane: 0 });
  });

  it('widens the axis to a meeting outside working hours', () => {
    const layout = layoutDay([meeting('07:30', '08:00'), meeting('18:00', '19:15')]);
    expect([layout.fromHour, layout.toHour]).toEqual([7, 20]);
  });

  it('puts overlapping meetings on separate rows and reuses a row once it is free', () => {
    const layout = layoutDay([
      meeting('09:00', '10:00'),
      meeting('09:30', '10:30'),
      meeting('10:00', '11:00'),
    ]);
    expect(layout.placed.map((entry) => entry.lane)).toEqual([0, 1, 0]);
    expect(layout.lanes).toBe(2);
  });

  it('keeps all-day events apart and leaves cancelled meetings off the axis', () => {
    const layout = layoutDay([
      meeting('00:00', '00:00', { isAllDay: true, subject: 'Holiday' }),
      meeting('09:00', '10:00', { isCancelled: true }),
    ]);
    expect(layout.allDay.map((event) => event.subject)).toEqual(['Holiday']);
    expect(layout.placed).toEqual([]);
    expect(layout.lanes).toBe(1);
  });
});

describe('nowOffset', () => {
  it('places now on the axis, and nowhere outside it', () => {
    const layout = layoutDay([]);
    expect(nowOffset(layout, new Date(2026, 2, 10, 13, 0))).toBe(50);
    expect(nowOffset(layout, new Date(2026, 2, 10, 6, 0))).toBeNull();
  });
});

describe('sprintBreakdown', () => {
  const issue = (stage: JiraIssue['stage'], isMine: boolean): JiraIssue => ({
    key: 'PROJ-1',
    summary: '',
    status: '',
    stage,
    type: 'Story',
    assignee: '',
    isMine,
    url: '',
    updatedAt: '',
    source: 'jira',
  });

  it('counts mine and the whole sprint by stage, finished work included', () => {
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
            issue('done', true),
            issue('in-progress', true),
            issue('todo', false),
            issue('unknown', false),
          ],
        },
      ],
    };
    expect(sprintBreakdown(state)).toEqual({
      mine: { todo: 0, inProgress: 1, done: 1 },
      team: { todo: 2, inProgress: 1, done: 1 },
    });
    expect(sprintBreakdown(null)).toBeNull();
  });
});
