import { describe, expect, it } from 'vitest';
import {
  describeMinutes,
  parseIsoMinutes,
  parseTipeeStatus,
  readCsrfToken,
  sanitizeTipeeUrl,
} from '../src/shared/tipee.js';

describe('sanitizeTipeeUrl', () => {
  it('keeps the https origin and nothing else', () => {
    expect(sanitizeTipeeUrl(' https://example.tipee.net/app/ ')).toBe('https://example.tipee.net');
    expect(sanitizeTipeeUrl('http://example.tipee.net')).toBe('');
    expect(sanitizeTipeeUrl('example.tipee.net')).toBe('');
    expect(sanitizeTipeeUrl(42)).toBe('');
  });
});

describe('readCsrfToken', () => {
  it('reads the token whatever the attribute order', () => {
    expect(readCsrfToken('<input type="hidden" name="_csrf_token" value="abc123">')).toBe('abc123');
    expect(readCsrfToken('<input value="xyz" name="_csrf_token" />')).toBe('xyz');
    expect(readCsrfToken('<form></form>')).toBeNull();
  });
});

describe('parseIsoMinutes', () => {
  it('reads hours and minutes, and the negative form Tipee writes', () => {
    expect(parseIsoMinutes('PT8H')).toBe(480);
    expect(parseIsoMinutes('PT3H37M')).toBe(217);
    expect(parseIsoMinutes('PT-4H-23M')).toBe(-263);
    expect(parseIsoMinutes('-PT30M')).toBe(-30);
    expect(parseIsoMinutes(null)).toBe(0);
  });
});

describe('parseTipeeStatus', () => {
  const row = {
    resource: 'p1',
    worktimes: [{ date: '2026-03-10', due: 'PT8H', done: 'PT3H5M', balance: 'PT-4H-55M' }],
    timechecks: [
      { time_range: '2026-03-10T08:02:00+01:00/2026-03-10T11:45:00+01:00', type: 'device' },
      { time_range: '2026-03-10T12:30:00+01:00/-', type: 'device' },
      { time_range: '2026-03-09T17:00:00+01:00/2026-03-09T18:00:00+01:00', type: 'proposal' },
    ],
  };

  it('reads an open timecheck as clocked in, since its start', () => {
    const status = parseTipeeStatus({ clock: { next_action: 'out' } }, row, '2026-03-10');
    expect(status).toEqual({
      clockedIn: true,
      since: new Date('2026-03-10T12:30:00+01:00').toISOString(),
      dueMinutes: 480,
      doneMinutes: 185,
      balanceMinutes: -295,
      pending: 1,
    });
  });

  it('reads next action "in" as not clocked in, with no start', () => {
    const status = parseTipeeStatus({ clock: { next_action: 'in' } }, row, '2026-03-10');
    expect(status?.clockedIn).toBe(false);
    expect(status?.since).toBeNull();
  });

  it('refuses an answer without a clock status rather than guessing one', () => {
    expect(parseTipeeStatus({}, row, '2026-03-10')).toBeNull();
    expect(parseTipeeStatus({ clock: { next_action: 'maybe' } }, row, '2026-03-10')).toBeNull();
  });
});

describe('describeMinutes', () => {
  it('writes hours and two-digit minutes, signed', () => {
    expect(describeMinutes(185)).toBe('3 h 05');
    expect(describeMinutes(-30)).toBe('-0 h 30');
    expect(describeMinutes(0)).toBe('0 h 00');
  });
});
