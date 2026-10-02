import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorktree, removeWorktree, renameWorktree } from '../src/main/git/native-worktree.js';
import { stopSpawnPool } from '../src/main/spawn/spawn-pool.js';

/*
 * Against a real repository with a real origin, on a temp tree: what is under test is what git and
 * the file system do, and the one property that matters most is that removing a worktree never
 * touches the shared node_modules its junction points at.
 */

let root: string;
let clone: string;
let worktrees: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'native-wt-'));
  const origin = join(root, 'origin.git');
  clone = join(root, 'code', 'web-app');
  worktrees = join(root, 'code', 'worktrees');
  git(root, 'init', '--bare', '--initial-branch=main', origin);
  git(root, 'clone', origin, clone);
  git(clone, 'config', 'user.email', 'dev@example.com');
  git(clone, 'config', 'user.name', 'Dev');
  writeFileSync(join(clone, 'README.md'), 'hello\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-m', 'init');
  git(clone, 'push', 'origin', 'main');
  git(clone, 'remote', 'set-head', 'origin', 'main');
  mkdirSync(join(clone, 'node_modules', 'some-package'), { recursive: true });
  writeFileSync(join(clone, 'node_modules', 'some-package', 'index.js'), 'module.exports = 1;\n');
});

afterAll(async () => {
  await stopSpawnPool();
  rmSync(root, { recursive: true, force: true });
});

describe('native worktrees', () => {
  it('creates, renames and removes a worktree, and leaves the shared node_modules alone', async () => {
    const created = await createWorktree(clone, worktrees, 'notes page', '');
    expect(created.ok).toBe(true);
    const first = join(worktrees, 'wip-notes-page-web-app');
    expect(created.path).toBe(first);
    expect(git(first, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('wip/notes-page');
    expect(lstatSync(join(first, 'node_modules')).isSymbolicLink()).toBe(true);

    const renamed = await renameWorktree(clone, { path: first, branch: 'wip/notes-page' }, worktrees, 'PROJ-5');
    expect(renamed.ok).toBe(true);
    const second = join(worktrees, 'PROJ-5-web-app');
    expect(existsSync(second)).toBe(true);
    expect(git(second, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('PROJ-5-notes-page');

    const removed = await removeWorktree(
      clone,
      { path: second, branch: 'PROJ-5-notes-page' },
      { discardChanges: false, deleteBranch: true },
    );
    expect(removed.ok).toBe(true);
    expect(existsSync(second)).toBe(false);
    expect(existsSync(join(clone, 'node_modules', 'some-package', 'index.js'))).toBe(true);
    expect(git(clone, 'branch', '--list', 'PROJ-5-notes-page').trim()).toBe('');
  }, 60_000);

  it('refuses a ticket worktree without a description, and an existing folder', async () => {
    expect((await createWorktree(clone, worktrees, 'PROJ-6', '')).ok).toBe(false);
    const made = await createWorktree(clone, worktrees, 'PROJ-6', 'first');
    expect(made.ok).toBe(true);
    const again = await createWorktree(clone, worktrees, 'PROJ-6', 'second');
    expect(again).toMatchObject({ ok: false, message: expect.stringContaining('already exists') as unknown as string });
  }, 60_000);
});
