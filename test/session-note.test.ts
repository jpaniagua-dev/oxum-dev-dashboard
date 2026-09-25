import { describe, expect, it } from 'vitest';
import type { TriagedTicket } from '../src/shared/contracts.js';
import {
  NOTE_LIMIT,
  noteFromTicket,
  trimNote,
} from '../src/shared/session-note.js';

/**
 * The one field on a session that a human wrote.
 *
 * Two properties carry the feature and both are tested by name: clearing a note IS deleting it, so
 * there is never a stored blank; and a note that says nothing is never seeded, so a card never
 * carries an empty box.
 */

const TICKET: TriagedTicket = {
  key: 'PROJ-123',
  summary: 'Add the fiscal year selector',
  verdict: 'ready',
  domain: 'front-end',
  claimsAutonomy: false,
  reason: 'The endpoint is live and the mockup is approved.',
  question: '',
  next: '',
  estimate: 3,
  status: 'To Do',
  assignee: '',
  description: 'Long description',
  analysedAt: '2026-09-25T08:00:00.000Z',
};

describe('trimNote', () => {
  it('reads an empty note as no note, which is how one is deleted', () => {
    // There is no separate delete channel, so this is the whole removal path. A stored blank would
    // be a second way to say "no note" and the two would drift.
    expect(trimNote('')).toBeNull();
    expect(trimNote('   \n  ')).toBeNull();
  });

  it('keeps the line breaks inside a note', () => {
    expect(trimNote('  first line\nsecond  ')).toBe('first line\nsecond');
  });

  it('caps a note at the limit, and trims again after cutting', () => {
    // Cutting mid-sentence can leave a trailing space, and a note ending in whitespace would differ from
    // the same note typed without it, so the comparison that skips a pointless broadcast would fail.
    const long = `${'a'.repeat(NOTE_LIMIT - 1)}   tail`;
    const note = trimNote(long);
    expect(note).not.toBeNull();
    expect((note ?? '').length).toBeLessThanOrEqual(NOTE_LIMIT);
    expect(note).toBe('a'.repeat(NOTE_LIMIT - 1));
  });
});

describe('noteFromTicket', () => {
  it('names the ticket and the repository, then says why', () => {
    expect(noteFromTicket(TICKET, 'web-app')).toBe(
      'PROJ-123 in web-app\nThe endpoint is live and the mockup is approved.',
    );
  });

  it('seeds nothing for a ticket that was never analysed', () => {
    // A handoff on a ticket with no stored verdict is normal: `Work on this` accepts any verdict,
    // and a ticket can be started from the Jira tab without a triage ever having run.
    expect(noteFromTicket(undefined, 'web-app')).toBeNull();
  });

  it('still names the ticket when the analysis gave no reason', () => {
    expect(noteFromTicket({ ...TICKET, reason: '   ' }, 'web-app')).toBe('PROJ-123 in web-app');
  });

  it('leaves the repository out rather than writing "in "', () => {
    expect(noteFromTicket(TICKET, '')).toBe(
      'PROJ-123\nThe endpoint is live and the mockup is approved.',
    );
  });
});
