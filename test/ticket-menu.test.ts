import { describe, expect, it } from 'vitest';
import {
  analyseTicketItem,
  ticketCopies,
  ticketFullName,
  verdictMessage,
  workOnTicketItem,
} from '../src/renderer/ui/ticket-menu.js';

describe('ticketFullName', () => {
  it('joins the key and the title with a dash', () => {
    expect(ticketFullName('PROJ-123', 'Fix the login timeout')).toBe(
      'PROJ-123 - Fix the login timeout',
    );
  });

  it('trims the title, and falls back to the key when there is none', () => {
    expect(ticketFullName('PROJ-123', '  Fix the login timeout ')).toBe(
      'PROJ-123 - Fix the login timeout',
    );
    expect(ticketFullName('LOC-12', '   ')).toBe('LOC-12');
  });
});

describe('ticketCopies', () => {
  it('copies the key, the title, and both, each with its confirmation', () => {
    expect(ticketCopies({ key: 'PROJ-123', summary: 'Fix the login timeout' })).toEqual([
      { label: 'Copy the ID', text: 'PROJ-123', message: 'Copied PROJ-123' },
      {
        label: 'Copy the title',
        text: 'Fix the login timeout',
        message: 'Copied the title of PROJ-123',
      },
      {
        label: 'Copy ID and title',
        text: 'PROJ-123 - Fix the login timeout',
        message: 'Copied PROJ-123 - Fix the login timeout',
      },
    ]);
  });
});

describe('workOnTicketItem', () => {
  it('hands a Jira ticket over', () => {
    expect(workOnTicketItem({ key: 'PROJ-123', source: 'jira' })).toEqual({
      label: 'Work on this...',
      hint: 'Starts the agent on PROJ-123 in the project you pick',
      disabled: false,
    });
  });

  it('greys the entry on a local ticket and says why', () => {
    const item = workOnTicketItem({ key: 'LOC-12', source: 'local' });
    expect(item.disabled).toBe(true);
    expect(item.hint).toMatch(/reads Jira/);
  });

  it('hands a Jira ticket over in plan mode', () => {
    expect(workOnTicketItem({ key: 'PROJ-123', source: 'jira' }, 'plan', true)).toEqual({
      label: 'Work on this in plan mode...',
      hint: 'Starts the agent in plan mode on PROJ-123 in the project you pick',
      disabled: false,
    });
  });

  it('greys plan mode on a local ticket, and when the agent has no plan mode arguments', () => {
    expect(workOnTicketItem({ key: 'LOC-12', source: 'local' }, 'plan', true).disabled).toBe(true);
    const unset = workOnTicketItem({ key: 'PROJ-123', source: 'jira' }, 'plan', false);
    expect(unset.disabled).toBe(true);
    expect(unset.hint).toMatch(/Plan mode arguments/);
  });
});

describe('analyseTicketItem', () => {
  const jira = { key: 'PROJ-123', source: 'jira' as const };

  it('analyses a Jira ticket still to start, or already in progress', () => {
    expect(analyseTicketItem({ ...jira, stage: 'todo' }, false)).toEqual({
      label: 'Analyse this ticket',
      hint: 'Runs the Triage analysis on PROJ-123 alone; the verdict lands in the Triage tab, under its sprint',
      disabled: false,
    });
    expect(analyseTicketItem({ ...jira, stage: 'in-progress' }, false).disabled).toBe(false);
  });

  it('greys a finished ticket, a local one, and any ticket while an analysis runs', () => {
    expect(analyseTicketItem({ ...jira, stage: 'done' }, false)).toMatchObject({
      disabled: true,
      hint: 'PROJ-123 is done: there is nothing left to analyse',
    });
    expect(
      analyseTicketItem({ key: 'LOC-12', source: 'local', stage: 'todo' }, false).hint,
    ).toMatch(/reads Jira/);
    expect(analyseTicketItem({ ...jira, stage: 'todo' }, true)).toMatchObject({
      disabled: true,
      hint: 'An analysis is already running',
    });
  });
});

describe('verdictMessage', () => {
  it('names the verdict with its estimate', () => {
    expect(verdictMessage({ key: 'PROJ-123', verdict: 'ready', estimate: 2 })).toBe(
      'PROJ-123: Ready to build, 2 points',
    );
    expect(verdictMessage({ key: 'PROJ-123', verdict: 'ready', estimate: 1 })).toBe(
      'PROJ-123: Ready to build, 1 point',
    );
  });

  it('says no number when the analysis gave none', () => {
    expect(verdictMessage({ key: 'PROJ-123', verdict: 'needs-decision', estimate: null })).toBe(
      'PROJ-123: Waiting on a decision',
    );
  });
});
