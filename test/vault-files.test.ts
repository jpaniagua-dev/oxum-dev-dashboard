import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { Project } from '../src/shared/contracts.js';
import type { VaultEntry, VaultFileBinding } from '../src/shared/vault.js';
import { VaultFiles, renderDotenv } from '../src/main/vault/vault-files.js';
import { git } from '../src/main/git/run-git.js';

const roots: string[] = [];
const binding: VaultFileBinding = {
  kind: 'dotenv',
  projectId: 'dashboard',
  path: '.env.local',
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function setup(entries: VaultEntry[], ignored = true, tracked = false): Promise<{
  root: string;
  files: VaultFiles;
}> {
  const root = await mkdtemp(join(tmpdir(), 'oxum-vault-files-'));
  roots.push(root);
  const project: Project = {
    id: 'dashboard',
    label: 'Dashboard',
    path: root,
    actions: [],
    kind: 'watch',
    expectedPort: null,
    tags: [],
  };
  return {
    root,
    files: new VaultFiles({
      vault: {
        entriesForFile: async () => entries,
      },
      projects: () => [project],
      ignored: async () => ignored,
      tracked: async () => tracked,
    }),
  };
}

function entry(name: string, value: string, hint = ''): VaultEntry {
  return {
    card: {
      id: name,
      name,
      hint,
      createdAt: '2026-09-26T12:00:00.000Z',
      expiresAt: null,
      file: binding,
      capability: null,
    },
    value,
  };
}

describe('renderDotenv', () => {
  it('quotes values and keeps notes as comments', () => {
    const output = renderDotenv([entry('API_KEY', 'a"b\\c\nnext', 'Used by the API')]);
    expect(output).toContain('# Used by the API\n');
    expect(output).toContain('API_KEY="a\\"b\\\\c\\nnext"\n');
  });
});

describe('VaultFiles', () => {
  it('generates a marked dotenv file without exposing values in the result', async () => {
    const { root, files } = await setup([entry('API_KEY', 'secret-value')]);
    const result = await files.generate(binding);
    expect(result).toEqual({ ok: true, message: 'Generated .env.local with 1 variable.' });
    expect(result.message).not.toContain('secret-value');
    expect(await readFile(join(root, '.env.local'), 'utf8')).toContain(
      'API_KEY="secret-value"',
    );
  });

  it('refuses to generate a file Git does not ignore', async () => {
    const { root, files } = await setup([entry('API_KEY', 'secret-value')], false);
    expect(await files.generate(binding)).toEqual({
      ok: false,
      message: '.env.local is not ignored by Git. Add it to .gitignore first.',
    });
    await expect(readFile(join(root, '.env.local'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to put secrets in a file already tracked by Git', async () => {
    const { root, files } = await setup([entry('API_KEY', 'secret-value')], true, true);
    expect(await files.generate(binding)).toEqual({
      ok: false,
      message: '.env.local is already tracked by Git and was not touched.',
    });
    await expect(readFile(join(root, '.env.local'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never overwrites or removes a file it does not own', async () => {
    const { root, files } = await setup([entry('API_KEY', 'secret-value')]);
    await writeFile(join(root, '.env.local'), 'HAND_WRITTEN=yes\n', 'utf8');
    expect((await files.generate(binding)).ok).toBe(false);
    expect((await files.remove(binding)).ok).toBe(false);
    expect(await readFile(join(root, '.env.local'), 'utf8')).toBe('HAND_WRITTEN=yes\n');
  });

  it('rejects duplicate variable names even when only their case differs', async () => {
    const { files } = await setup([
      entry('API_KEY', 'first'),
      entry('api_key', 'second'),
    ]);
    expect(await files.generate(binding)).toEqual({
      ok: false,
      message: 'api_key appears more than once in this file.',
    });
  });

  it('removes an already generated file when its last variable disappears', async () => {
    const entries = [entry('API_KEY', 'secret-value')];
    const { root, files } = await setup(entries);
    expect((await files.generate(binding)).ok).toBe(true);
    entries.length = 0;
    await files.sync([binding]);
    await expect(readFile(join(root, '.env.local'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses Git itself to require an ignored, untracked target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oxum-vault-files-git-'));
    roots.push(root);
    await git(root, ['init', '--quiet']);
    await writeFile(join(root, '.gitignore'), '.env.local\n', 'utf8');
    const project: Project = {
      id: 'dashboard',
      label: 'Dashboard',
      path: root,
      actions: [],
      kind: 'watch',
      expectedPort: null,
      tags: [],
    };
    const files = new VaultFiles({
      vault: { entriesForFile: async () => [entry('API_KEY', 'secret-value')] },
      projects: () => [project],
    });
    expect((await files.generate(binding)).ok).toBe(true);

    await git(root, ['add', '--force', '--', '.env.local']);
    expect(await files.generate(binding)).toEqual({
      ok: false,
      message: '.env.local is already tracked by Git and was not touched.',
    });
  });
});
