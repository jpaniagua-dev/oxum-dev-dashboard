import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isLockFailure,
  planRename,
  planWorktree,
  worktreesRootFor,
} from '../src/main/git/native-worktree.js';
import { existingFolder, runFolder } from '../src/main/projects/run-folder.js';

describe('planWorktree', () => {
  it('names a ticket worktree after the key and the description', () => {
    expect(planWorktree('proj-12', 'Documents list', 'web-app')).toEqual({
      folder: 'PROJ-12-web-app',
      branch: 'PROJ-12-documents-list',
    });
  });

  it('refuses a ticket worktree without a description', () => {
    expect(planWorktree('PROJ-12', '  ', 'web-app')).toEqual({
      error: expect.stringContaining('needs a description') as unknown as string,
    });
  });

  it('makes a wip worktree from any other label, accents and all', () => {
    expect(planWorktree('Toast zone escapé', '', 'web-app')).toEqual({
      folder: 'wip-toast-zone-escape-web-app',
      branch: 'wip/toast-zone-escape',
    });
    expect(planWorktree('!!!', '', 'web-app')).toHaveProperty('error');
  });
});

describe('planRename', () => {
  it('brings a wip branch in line once a ticket number arrives', () => {
    expect(planRename('PROJ-9', 'web-app', 'wip/toast')).toEqual({
      folder: 'PROJ-9-web-app',
      branch: 'PROJ-9-toast',
    });
  });

  it('moves the folder alone otherwise', () => {
    expect(planRename('PROJ-9', 'web-app', 'PROJ-8-other')).toEqual({ folder: 'PROJ-9-web-app', branch: null });
    expect(planRename('new idea', 'web-app', 'wip/x')).toEqual({ folder: 'wip-new-idea-web-app', branch: null });
  });
});

describe('where worktrees and runs go', () => {
  it('puts worktrees beside the repository unless a folder is set', () => {
    expect(worktreesRootFor('', join('C:', 'code', 'web-app'))).toBe(join('C:', 'code', 'worktrees'));
    expect(worktreesRootFor(' D:/wt ', 'C:/code/web-app')).toBe('D:/wt');
  });

  it('tells a locked folder from one holding work', () => {
    expect(isLockFailure("error: failed to delete 'x': Permission denied")).toBe(true);
    expect(isLockFailure('fatal: contains modified or untracked files, use --force')).toBe(false);
  });

  it('starts a run in the configured folder only when it exists', () => {
    const exists = (path: string): boolean => path === 'C:/code';
    expect(runFolder('C:/code', exists)).toBe('C:/code');
    expect(runFolder('C:/gone', exists)).toBe(homedir());
    expect(runFolder('', exists)).toBe(homedir());
    expect(existingFolder('C:/gone', exists)).toBe('');
  });
});
