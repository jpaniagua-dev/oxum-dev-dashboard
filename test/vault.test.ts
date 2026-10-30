import { describe, expect, it } from 'vitest';
import {
  type VaultFileCard,
  assignedNames,
  cardsOf,
  describeFileState,
  expiredFiles,
  expiryFrom,
  fileExpired,
  parseVault,
  sanitizeLifetime,
  sanitizeVaultFileBinding,
  sanitizeVaultText,
  sanitizeVaultVariableName,
  secretConflict,
} from '../src/shared/vault.js';

/**
 * The vault's pure half.
 *
 * Four properties carry it, and each would fail in silence: a secret never rides on the shape the
 * renderer is handed, a file whose stamp is unreadable is NOT removed, one bad entry does not take
 * the others with it, and a vault written in the earlier format is migrated rather than lost.
 */

const NOW = new Date('2026-09-26T12:00:00.000Z');
const BINDING = { kind: 'dotenv', projectId: 'web-app', path: '.env.local' } as const;

function card(over: Partial<VaultFileCard> = {}): VaultFileCard {
  return {
    id: 'f1',
    binding: BINDING,
    createdAt: '2026-09-26T11:00:00.000Z',
    lifetimeMinutes: 30,
    generatedAt: null,
    expiresAt: null,
    secrets: ['API_KEY'],
    text: '',
    ...over,
  };
}

function stored(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...card(), values: { API_KEY: 'k-123' }, ...over };
}

describe('dotenv file metadata', () => {
  it('accepts variable names agents can reference without quoting', () => {
    expect(sanitizeVaultVariableName(' DATABASE_URL ')).toBe('DATABASE_URL');
    expect(sanitizeVaultVariableName('stripe-key')).toBe('');
    expect(sanitizeVaultVariableName('2FA_TOKEN')).toBe('');
  });

  it('keeps a relative project file and rejects traversal or .git internals', () => {
    expect(
      sanitizeVaultFileBinding({ kind: 'dotenv', projectId: 'web-app', path: '.env.local' }),
    ).toEqual({ kind: 'dotenv', projectId: 'web-app', path: '.env.local' });
    expect(
      sanitizeVaultFileBinding({ kind: 'dotenv', projectId: 'web-app', path: '../.env' }),
    ).toBeNull();
    expect(
      sanitizeVaultFileBinding({ kind: 'dotenv', projectId: 'web-app', path: '.git/config' }),
    ).toBeNull();
    expect(
      sanitizeVaultFileBinding({ kind: 'dotenv', projectId: 'web-app', path: 'config/NUL.env' }),
    ).toBeNull();
  });

  it('only accepts a lifetime the form offers', () => {
    expect(sanitizeLifetime(30)).toBe(30);
    expect(sanitizeLifetime(null)).toBeNull();
    expect(sanitizeLifetime(31)).toBeUndefined();
    expect(sanitizeLifetime('30')).toBeUndefined();
  });
});

describe('the free text', () => {
  it('normalises line endings and refuses what a file cannot carry', () => {
    expect(sanitizeVaultText('A=1\r\nB=2')).toBe('A=1\nB=2');
    expect(sanitizeVaultText('tab\tkept')).toBe('tab\tkept');
    expect(sanitizeVaultText('bell\u0007')).toBeNull();
    expect(sanitizeVaultText(42)).toBeNull();
    expect(sanitizeVaultText('x'.repeat(16 * 1024 + 1))).toBeNull();
  });

  it('lists the names it assigns, comments aside', () => {
    expect(
      assignedNames('# HIDDEN=1\nEMAIL=me@example.com\nexport USER = me\nnot an assignment'),
    ).toEqual(['EMAIL', 'USER']);
  });
});

describe('secretConflict', () => {
  it('refuses a name given twice, case ignored', () => {
    expect(secretConflict({ secrets: ['API_KEY', 'api_key'], text: '' })).toBe(
      'api_key appears twice',
    );
  });

  it('refuses a secret the text also sets, which would put two values in the file', () => {
    expect(secretConflict({ secrets: ['API_KEY'], text: 'api_key=plain' })).toBe(
      'api_key is a secret and is also set in the text',
    );
  });

  it('accepts distinct names', () => {
    expect(secretConflict({ secrets: ['API_KEY'], text: 'EMAIL=me@example.com' })).toBeNull();
  });
});

describe('expiryFrom', () => {
  it('turns a duration into the instant it lands on', () => {
    expect(expiryFrom('2026-09-26T12:00:00.000Z', 30)).toBe('2026-09-26T12:30:00.000Z');
  });

  it('answers null for "never" and for a nonsense duration', () => {
    expect(expiryFrom('2026-09-26T12:00:00.000Z', null)).toBeNull();
    expect(expiryFrom('2026-09-26T12:00:00.000Z', -5)).toBeNull();
  });

  it('answers null rather than an invalid date when the starting stamp is unreadable', () => {
    expect(expiryFrom('not a date', 30)).toBeNull();
  });
});

describe('fileExpired', () => {
  const generated = { generatedAt: '2026-09-26T11:30:00.000Z' };

  it('is true once the instant has passed, and on the instant itself', () => {
    expect(fileExpired(card({ ...generated, expiresAt: '2026-09-26T11:59:00.000Z' }), NOW)).toBe(
      true,
    );
    expect(fileExpired(card({ ...generated, expiresAt: NOW.toISOString() }), NOW)).toBe(true);
  });

  it('is false before, for a file kept until removed, and for one never generated', () => {
    expect(fileExpired(card({ ...generated, expiresAt: '2026-09-26T12:01:00.000Z' }), NOW)).toBe(
      false,
    );
    expect(fileExpired(card({ ...generated, expiresAt: null }), NOW)).toBe(false);
    expect(fileExpired(card({ expiresAt: '2026-09-26T11:00:00.000Z' }), NOW)).toBe(false);
  });

  it('reads an UNREADABLE stamp as not expired, which is the direction to be wrong in', () => {
    // The other reading deletes a file because a byte in the vault was mangled.
    expect(fileExpired(card({ ...generated, expiresAt: 'garbage' }), NOW)).toBe(false);
  });

  it('lists only the cards whose file is due', () => {
    const due = card({ id: 'due', ...generated, expiresAt: '2026-09-26T11:59:00.000Z' });
    expect(expiredFiles([due, card({ id: 'quiet' })], NOW).map((entry) => entry.id)).toEqual([
      'due',
    ]);
  });
});

describe('describeFileState', () => {
  it('says whether the file is on disk, and for how long', () => {
    expect(describeFileState(card(), NOW)).toBe('Not generated');
    expect(
      describeFileState(
        card({ generatedAt: NOW.toISOString(), expiresAt: '2026-09-26T12:12:00.000Z' }),
        NOW,
      ),
    ).toBe('Generated, removed in 12 min');
    expect(
      describeFileState(
        card({ generatedAt: NOW.toISOString(), expiresAt: '2026-09-26T16:00:00.000Z' }),
        NOW,
      ),
    ).toBe('Generated, removed in 4h');
    expect(describeFileState(card({ generatedAt: NOW.toISOString() }), NOW)).toBe(
      'Generated, kept until removed',
    );
  });
});

describe('parseVault', () => {
  it('reads a well-formed file card', () => {
    const { entries, migrated } = parseVault(
      { version: 2, files: [stored({ text: 'EMAIL=me@example.com' })] },
      NOW,
    );
    expect(migrated).toBe(false);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.card.secrets).toEqual(['API_KEY']);
    expect(entries[0]?.card.text).toBe('EMAIL=me@example.com');
    expect(entries[0]?.values).toEqual({ API_KEY: 'k-123' });
  });

  it('drops ONE bad entry without taking the others with it', () => {
    const { entries } = parseVault(
      {
        version: 2,
        files: [
          stored(),
          { id: 'broken' },
          stored({ id: 'f2', binding: { ...BINDING, path: '.env' } }),
        ],
      },
      NOW,
    );
    expect(entries.map((entry) => entry.card.id)).toEqual(['f1', 'f2']);
  });

  it('keeps the FIRST of two cards sharing an id or a file', () => {
    const { entries } = parseVault(
      {
        version: 2,
        files: [stored(), stored({ values: { API_KEY: 'second' } }), stored({ id: 'f3' })],
      },
      NOW,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.values['API_KEY']).toBe('k-123');
  });

  it('drops a secret with no value, but keeps the card', () => {
    const { entries } = parseVault(
      { version: 2, files: [stored({ secrets: ['API_KEY', 'TOKEN'] })] },
      NOW,
    );
    expect(entries[0]?.card.secrets).toEqual(['API_KEY']);
  });

  it('falls back to the default lifetime rather than losing the secrets over a mangled one', () => {
    const { entries } = parseVault(
      { version: 2, files: [stored({ lifetimeMinutes: 'soon' })] },
      NOW,
    );
    expect(entries[0]?.card.lifetimeMinutes).toBe(30);
  });

  it('reads anything it does not recognise as an empty vault', () => {
    expect(parseVault('nope', NOW).entries).toEqual([]);
    expect(parseVault({ version: 3, files: [stored()] }, NOW).entries).toEqual([]);
    expect(parseVault(null, NOW).entries).toEqual([]);
  });
});

describe('parseVault migrating the earlier format, one entry per variable', () => {
  const variable = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'v1',
    name: 'API_KEY',
    hint: '',
    value: 'k-123',
    createdAt: '2026-09-20T10:00:00.000Z',
    expiresAt: null,
    file: BINDING,
    capability: null,
    ...over,
  });

  it('groups the variables of one file into one card, in order', () => {
    const { entries, migrated } = parseVault(
      [
        variable(),
        variable({ id: 'v2', name: 'TOKEN', value: 't-1' }),
        variable({ id: 'v3', name: 'OTHER', file: { ...BINDING, path: '.env' } }),
      ],
      NOW,
    );
    expect(migrated).toBe(true);
    expect(entries.map((entry) => entry.card.secrets)).toEqual([['API_KEY', 'TOKEN'], ['OTHER']]);
    expect(entries[0]?.values).toEqual({ API_KEY: 'k-123', TOKEN: 't-1' });
  });

  it('turns a note into a comment of the text, where the file already printed it', () => {
    const { entries } = parseVault([variable({ hint: 'sandbox\nonly' })], NOW);
    expect(entries[0]?.card.text).toBe('# API_KEY: sandbox only');
  });

  it('drops a variable bound to no file, and one whose own expiry has passed', () => {
    const { entries } = parseVault(
      [
        variable({ id: 'loose', name: 'Loose key', file: null }),
        variable({ id: 'dead', name: 'DEAD', expiresAt: '2026-09-26T11:00:00.000Z' }),
        variable({ id: 'alive', name: 'ALIVE', expiresAt: '2026-09-26T13:00:00.000Z' }),
      ],
      NOW,
    );
    expect(entries.map((entry) => entry.card.secrets)).toEqual([['ALIVE']]);
  });

  it('keeps the first of two variables sharing a name, case ignored', () => {
    const { entries } = parseVault(
      [variable(), variable({ id: 'v2', name: 'api_key', value: 'second' })],
      NOW,
    );
    expect(entries[0]?.values).toEqual({ API_KEY: 'k-123' });
  });

  it('counts every migrated file as generated now, so an old file on disk is removed in time', () => {
    const { entries } = parseVault([variable()], NOW);
    expect(entries[0]?.card.generatedAt).toBe(NOW.toISOString());
    expect(entries[0]?.card.expiresAt).toBe('2026-09-26T12:30:00.000Z');
    expect(entries[0]?.card.lifetimeMinutes).toBe(30);
  });
});

describe('cardsOf', () => {
  it('carries NO value, which is the whole contract with the renderer', () => {
    // Asserted on the object and not on the type: a spread can carry a field no type mentions.
    const { entries } = parseVault({ version: 2, files: [stored()] }, NOW);
    const cards = cardsOf(entries);
    expect(JSON.stringify(cards)).not.toContain('k-123');
    expect(Object.keys(cards[0] ?? {})).not.toContain('values');
  });
});
