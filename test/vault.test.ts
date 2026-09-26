import { describe, expect, it } from 'vitest';
import {
  type VaultCard,
  cardsOf,
  describeExpiry,
  expiryFrom,
  isExpired,
  parseVault,
  sanitizeHint,
  sanitizeName,
  sweepExpired,
} from '../src/shared/vault.js';

/**
 * The vault's pure half.
 *
 * Three properties carry it, and each would fail in silence: a secret never rides on the shape the
 * renderer is handed, a card whose stamp is unreadable is NOT destroyed, and one bad entry in the
 * file does not take the others with it.
 */

const NOW = new Date('2026-09-26T12:00:00.000Z');

function card(over: Partial<VaultCard> = {}): VaultCard {
  return {
    id: 'c1',
    name: 'Stripe test key',
    hint: 'sandbox only',
    createdAt: '2026-09-26T11:00:00.000Z',
    expiresAt: null,
    ...over,
  };
}

describe('sanitizeName and sanitizeHint', () => {
  it('folds line breaks out, because both are drawn on one line', () => {
    // A name holding a newline is a card whose height depends on what was pasted into it.
    expect(sanitizeName('  two\nlines  ')).toBe('two lines');
    expect(sanitizeHint('a\t\tb')).toBe('a b');
  });

  it('caps, then trims again after the cut', () => {
    // Cutting mid-word can leave a trailing space, and a name ending in one differs from the same
    // name typed without it for every comparison that follows.
    expect(sanitizeName(`${'a'.repeat(39)}   tail`)).toBe('a'.repeat(39));
  });

  it('reads anything that is not a string as empty', () => {
    expect(sanitizeName(42)).toBe('');
    expect(sanitizeName(null)).toBe('');
  });
});

describe('expiryFrom', () => {
  it('turns a duration into the instant it lands on', () => {
    expect(expiryFrom('2026-09-26T12:00:00.000Z', 30)).toBe('2026-09-26T12:30:00.000Z');
  });

  it('answers null for "no expiry" and for a nonsense duration', () => {
    expect(expiryFrom('2026-09-26T12:00:00.000Z', null)).toBeNull();
    expect(expiryFrom('2026-09-26T12:00:00.000Z', 0)).toBeNull();
    expect(expiryFrom('2026-09-26T12:00:00.000Z', -5)).toBeNull();
  });

  it('answers null rather than an invalid date when the creation stamp is unreadable', () => {
    expect(expiryFrom('not a date', 30)).toBeNull();
  });
});

describe('isExpired', () => {
  it('is true once the instant has passed, and on the instant itself', () => {
    expect(isExpired(card({ expiresAt: '2026-09-26T11:59:00.000Z' }), NOW)).toBe(true);
    expect(isExpired(card({ expiresAt: NOW.toISOString() }), NOW)).toBe(true);
  });

  it('is false before, and false for a card with no expiry', () => {
    expect(isExpired(card({ expiresAt: '2026-09-26T12:01:00.000Z' }), NOW)).toBe(false);
    expect(isExpired(card(), NOW)).toBe(false);
  });

  it('reads an UNREADABLE stamp as not expired, which is the direction to be wrong in', () => {
    // The other reading deletes a secret because a byte in a file was mangled, and nothing brings
    // it back. Being wrong towards "keep it" costs a card that outstays its welcome.
    expect(isExpired(card({ expiresAt: 'soon' }), NOW)).toBe(false);
  });
});

describe('sweepExpired', () => {
  it('returns BOTH halves, because both are used', () => {
    // One is written back to the file, the other is what the panel reports. Returning only the
    // survivors would make a card vanish with nothing saying why.
    const alive = card({ id: 'alive', expiresAt: '2026-09-26T13:00:00.000Z' });
    const dead = card({ id: 'dead', expiresAt: '2026-09-26T11:00:00.000Z' });
    const sweep = sweepExpired([alive, dead], NOW);
    expect(sweep.kept.map((entry) => entry.id)).toEqual(['alive']);
    expect(sweep.dropped.map((entry) => entry.id)).toEqual(['dead']);
  });

  it('keeps a card that never expires, however old', () => {
    const old = card({ createdAt: '2020-01-01T00:00:00.000Z', expiresAt: null });
    expect(sweepExpired([old], NOW).kept).toHaveLength(1);
  });

  it('drops nothing on an empty vault', () => {
    expect(sweepExpired([], NOW)).toEqual({ kept: [], dropped: [] });
  });
});

describe('describeExpiry', () => {
  it('counts in the coarsest unit that is still true', () => {
    expect(describeExpiry(card({ expiresAt: '2026-09-26T12:20:00.000Z' }), NOW)).toBe(
      'Expires in 20 min',
    );
    expect(describeExpiry(card({ expiresAt: '2026-09-26T15:00:00.000Z' }), NOW)).toBe(
      'Expires in 3h',
    );
    expect(describeExpiry(card({ expiresAt: '2026-09-28T12:00:00.000Z' }), NOW)).toBe(
      'Expires in 2d',
    );
  });

  it('says so plainly for a card that does not expire', () => {
    expect(describeExpiry(card(), NOW)).toBe('No expiry');
  });

  it('says "no expiry" rather than a nonsense count for an unreadable stamp', () => {
    // Matches `isExpired`, which will not destroy that card either: the two must agree or the panel
    // counts down to a deletion that never comes.
    expect(describeExpiry(card({ expiresAt: 'soon' }), NOW)).toBe('No expiry');
  });
});

describe('parseVault', () => {
  const good = {
    id: 'c1',
    name: 'Key',
    hint: 'h',
    value: 'sk-secret',
    createdAt: '2026-09-26T11:00:00.000Z',
    expiresAt: null,
  };

  it('reads a well-formed entry', () => {
    const entries = parseVault([good]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toBe('sk-secret');
    expect(entries[0]?.card.name).toBe('Key');
  });

  it('drops ONE bad entry without taking the others with it', () => {
    // The property that matters in a file holding several secrets: a mangled byte in one costs one
    // card, never the vault.
    expect(parseVault([good, null, 'nope', { id: 'x' }])).toHaveLength(1);
  });

  it('drops an entry with no value, so no card offers a Send that types nothing', () => {
    expect(parseVault([{ ...good, value: '' }])).toEqual([]);
  });

  it('drops an entry with no name, since the name is how every gesture names it', () => {
    expect(parseVault([{ ...good, name: '   ' }])).toEqual([]);
  });

  it('keeps the FIRST of two entries sharing an id', () => {
    // Every gesture is "do this to the card with this id", so a duplicate would shadow the first
    // and make its secret unreachable while still occupying the file.
    const entries = parseVault([good, { ...good, value: 'other' }]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toBe('sk-secret');
  });

  it('reads anything that is not an array as an empty vault', () => {
    expect(parseVault(null)).toEqual([]);
    expect(parseVault({})).toEqual([]);
    expect(parseVault('')).toEqual([]);
  });

  it('replaces an unreadable creation stamp rather than dropping the entry', () => {
    // The stamp only feeds a label, unlike the name and the value: losing a secret over it would be
    // the cure being worse than the disease.
    const entries = parseVault([{ ...good, createdAt: 'whenever' }]);
    expect(entries).toHaveLength(1);
    expect(Number.isNaN(new Date(entries[0]?.card.createdAt ?? '').getTime())).toBe(false);
  });
});

describe('cardsOf', () => {
  it('carries NO value, which is the whole contract with the renderer', () => {
    // Asserted on the object itself rather than on the type: a type stops a mistake at compile
    // time and says nothing about an object built with a spread.
    const cards = cardsOf(parseVault([{ id: 'c1', name: 'Key', value: 'sk-secret' }]));
    expect(JSON.stringify(cards)).not.toContain('sk-secret');
    expect(Object.keys(cards[0] ?? {})).not.toContain('value');
  });
});
