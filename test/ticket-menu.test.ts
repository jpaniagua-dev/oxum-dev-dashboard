import { describe, expect, it } from 'vitest';
import { ticketCopies, ticketFullName, workOnTicketItem } from '../src/renderer/ui/ticket-menu.js';

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
});
