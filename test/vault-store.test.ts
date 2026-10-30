import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaultStore } from '../src/main/vault/vault-store.js';
import type { VaultFileCard } from '../src/shared/vault.js';

/*
 * `safeStorage` replaced by a reversible encoding (Vitest hoists the mock above the imports). What
 * is tested is everything around the encryption: which value a save keeps, which dates the store
 * owns, and that a migrated vault is written back. The encryption itself is the OS's.
 */
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, 'utf8'),
    decryptString: (cipher: Buffer) => cipher.toString('utf8'),
  },
}));

const NOW = new Date('2026-09-26T12:00:00.000Z');
const BINDING = { kind: 'dotenv', projectId: 'web-app', path: '.env.local' } as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

async function store(): Promise<{ vault: InstanceType<typeof VaultStore>; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'oxum-vault-store-'));
  roots.push(root);
  const file = join(root, 'vault.bin');
  const vault = new VaultStore(file);
  await vault.load(NOW);
  return { vault, file };
}

function card(over: Partial<VaultFileCard> = {}): VaultFileCard {
  return {
    id: 'f1',
    binding: BINDING,
    createdAt: NOW.toISOString(),
    lifetimeMinutes: 30,
    generatedAt: null,
    expiresAt: null,
    secrets: [],
    text: '',
    ...over,
  };
}

describe('VaultStore.save', () => {
  it('keeps the stored value when an existing secret is sent empty', async () => {
    const { vault } = await store();
    await vault.save(card(), [{ name: 'API_KEY', value: 'k-1', from: null }]);
    expect(await vault.save(card(), [{ name: 'API_KEY', value: '', from: 'API_KEY' }])).toEqual({
      ok: true,
      message: 'File card saved',
    });
    expect(vault.valueOf('f1', 'API_KEY')).toBe('k-1');
  });

  it('replaces a value that is typed, and renames a secret without retyping it', async () => {
    const { vault } = await store();
    await vault.save(card(), [
      { name: 'API_KEY', value: 'k-1', from: null },
      { name: 'TOKEN', value: 't-1', from: null },
    ]);
    await vault.save(card(), [
      { name: 'API_KEY', value: 'k-2', from: 'API_KEY' },
      { name: 'ACCESS_TOKEN', value: '', from: 'TOKEN' },
    ]);
    expect(vault.valueOf('f1', 'API_KEY')).toBe('k-2');
    expect(vault.valueOf('f1', 'ACCESS_TOKEN')).toBe('t-1');
    expect(vault.valueOf('f1', 'TOKEN')).toBeNull();
  });

  it('forgets a secret left out of the save', async () => {
    const { vault } = await store();
    await vault.save(card(), [
      { name: 'API_KEY', value: 'k-1', from: null },
      { name: 'TOKEN', value: 't-1', from: null },
    ]);
    await vault.save(card(), [{ name: 'API_KEY', value: '', from: 'API_KEY' }]);
    expect(vault.state().cards[0]?.secrets).toEqual(['API_KEY']);
    expect(vault.valueOf('f1', 'TOKEN')).toBeNull();
  });

  it('refuses a new secret with no value, a second card on one file, and an empty card', async () => {
    const { vault } = await store();
    expect((await vault.save(card(), [{ name: 'API_KEY', value: '', from: null }])).message).toBe(
      'API_KEY needs a value',
    );
    await vault.save(card(), [{ name: 'API_KEY', value: 'k-1', from: null }]);
    expect(
      (await vault.save(card({ id: 'f2' }), [{ name: 'OTHER', value: 'o', from: null }])).message,
    ).toBe('.env.local already has a card in that project');
    expect(
      (await vault.save(card({ id: 'f3', binding: { ...BINDING, path: '.env' } }), [])).message,
    ).toBe('Add a secret or some text');
  });

  it('owns the dates: a payload cannot claim a file is on disk', async () => {
    const { vault } = await store();
    await vault.save(
      card({ generatedAt: NOW.toISOString(), expiresAt: '2030-01-01T00:00:00.000Z' }),
      [{ name: 'API_KEY', value: 'k-1', from: null }],
    );
    expect(vault.state().cards[0]?.generatedAt).toBeNull();
    expect(vault.state().cards[0]?.expiresAt).toBeNull();
  });

  it('starts the lifetime on generation, follows a new lifetime, and forgets it on a move', async () => {
    const { vault } = await store();
    await vault.save(card(), [{ name: 'API_KEY', value: 'k-1', from: null }]);
    await vault.markGenerated('f1', NOW);
    expect(vault.state().cards[0]?.expiresAt).toBe('2026-09-26T12:30:00.000Z');

    await vault.save(card({ lifetimeMinutes: 60 }), [
      { name: 'API_KEY', value: '', from: 'API_KEY' },
    ]);
    expect(vault.state().cards[0]?.expiresAt).toBe('2026-09-26T13:00:00.000Z');

    await vault.save(card({ binding: { ...BINDING, path: '.env' } }), [
      { name: 'API_KEY', value: '', from: 'API_KEY' },
    ]);
    expect(vault.state().cards[0]?.generatedAt).toBeNull();
  });
});

describe('VaultStore.load', () => {
  it('migrates a vault of variables and writes it back as files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oxum-vault-store-'));
    roots.push(root);
    const file = join(root, 'vault.bin');
    const earlier = [
      {
        id: 'v1',
        name: 'API_KEY',
        hint: '',
        value: 'k-1',
        createdAt: NOW.toISOString(),
        expiresAt: null,
        file: BINDING,
      },
      {
        id: 'v2',
        name: 'Loose',
        hint: '',
        value: 'x',
        createdAt: NOW.toISOString(),
        expiresAt: null,
        file: null,
      },
    ];
    await writeFile(file, Buffer.from(JSON.stringify(earlier), 'utf8').toString('base64'), 'utf8');

    const vault = new VaultStore(file);
    await vault.load(NOW);
    expect(vault.state().cards.map((entry) => entry.secrets)).toEqual([['API_KEY']]);
    const rewritten = JSON.parse(
      Buffer.from(await readFile(file, 'utf8'), 'base64').toString('utf8'),
    ) as { version: number; files: unknown[] };
    expect(rewritten.version).toBe(2);
    expect(rewritten.files).toHaveLength(1);
  });
});
