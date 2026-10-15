import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTag,
  deleteLocalTag,
  parseLsRemoteTags,
  pushTag,
  pushTagPlan,
  readRemoteTags,
  tagRemote,
} from '../src/main/git/git-tags.js';
import { stopSpawnPool } from '../src/main/spawn/spawn-pool.js';

/*
 * Tags against a real repository with a real origin, rebuilt for every test: what is checked is what
 * git and a remote actually answer, and a pushed tag cannot be taken back from one test to the next.
 */

let root = '';
let repo = '';

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  if (root !== '') {
    rmSync(root, { recursive: true, force: true });
  }
  root = mkdtempSync(join(tmpdir(), 'oxum-tags-'));
  const origin = join(root, 'origin.git');
  repo = join(root, 'web-app');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { windowsHide: true });
  execFileSync('git', ['clone', origin, repo], { windowsHide: true, stdio: 'pipe' });
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  writeFileSync(join(repo, 'a.ts'), 'const a = 1;\n', 'utf8');
  git('add', '.');
  git('commit', '-m', 'first');
  git('push', '-u', 'origin', 'main');
});

afterAll(async () => {
  await stopSpawnPool();
  rmSync(root, { recursive: true, force: true });
});

describe('createTag', () => {
  it('creates an annotated tag, its message defaulting to its name', async () => {
    const result = await createTag(repo, 'v1.0.0', git('rev-parse', 'HEAD'), '');

    expect(result.ok).toBe(true);
    expect(git('cat-file', '-t', 'v1.0.0')).toBe('tag');
    expect(git('tag', '-l', '--format=%(contents:subject)', 'v1.0.0')).toBe('v1.0.0');
  });

  it('refuses an invalid name, a name already taken, and a value that is not a sha', async () => {
    const sha = git('rev-parse', 'HEAD');
    await createTag(repo, 'v1', sha, 'first');

    expect((await createTag(repo, 'bad..name', sha, '')).ok).toBe(false);
    expect((await createTag(repo, '--force', sha, '')).ok).toBe(false);
    expect((await createTag(repo, 'v1', sha, '')).message).toContain('already exists');
    expect((await createTag(repo, 'v2', 'HEAD~1', '')).ok).toBe(false);
  });
});

describe('pushing a tag', () => {
  it('pushes the tag it is given and nothing else, and the remote then reports it', async () => {
    const sha = git('rev-parse', 'HEAD');
    await createTag(repo, 'v1.0.0', sha, 'release');
    await createTag(repo, 'experiment', sha, 'kept local');

    const plan = await pushTagPlan(repo, 'v1.0.0');
    expect(plan).toMatchObject({ ok: true, remote: 'origin', sha, subject: 'first' });
    expect((await pushTag(repo, 'origin', 'v1.0.0')).ok).toBe(true);

    // Never `--tags`: the experiment stays local.
    expect(await readRemoteTags(repo)).toEqual({ remote: 'origin', tags: ['v1.0.0'], error: null });
  });

  it('pushes the tag even when a branch has the same name', async () => {
    const sha = git('rev-parse', 'HEAD');
    git('branch', 'same');
    await createTag(repo, 'same', sha, 'tag');

    expect((await pushTag(repo, 'origin', 'same')).ok).toBe(true);
    expect((await readRemoteTags(repo)).tags).toEqual(['same']);
  });

  it('refuses a tag that is not there any more', async () => {
    expect(await pushTagPlan(repo, 'gone')).toMatchObject({ ok: false });
  });
});

describe('tagRemote', () => {
  it("prefers the current branch's remote over origin", async () => {
    const other = join(root, 'other.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', other], { windowsHide: true });
    git('remote', 'add', 'upstream', other);
    git('push', '-u', 'upstream', 'main');

    expect(await tagRemote(repo)).toBe('upstream');
  });
});

describe('deleteLocalTag', () => {
  it('deletes a tag the remote does not have', async () => {
    await createTag(repo, 'scratch', git('rev-parse', 'HEAD'), '');

    expect((await deleteLocalTag(repo, 'scratch')).ok).toBe(true);
    expect(git('tag', '-l', 'scratch')).toBe('');
  });

  it('refuses a tag the remote has, which the next fetch would bring back', async () => {
    await createTag(repo, 'v1', git('rev-parse', 'HEAD'), '');
    await pushTag(repo, 'origin', 'v1');

    const result = await deleteLocalTag(repo, 'v1');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('origin');
    expect(git('tag', '-l', 'v1')).toBe('v1');
  });
});

describe('parseLsRemoteTags', () => {
  it('names each tag once, the peeled line of an annotated tag included', () => {
    const out = [
      `${'a'.repeat(40)}\trefs/tags/v2`,
      `${'b'.repeat(40)}\trefs/tags/v2^{}`,
      `${'c'.repeat(40)}\trefs/tags/v1`,
      `${'d'.repeat(40)}\trefs/heads/main`,
    ].join('\n');

    expect(parseLsRemoteTags(out)).toEqual(['v1', 'v2']);
  });
});
