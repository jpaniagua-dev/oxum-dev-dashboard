import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  GitState,
  Project,
  ProjectId,
  RepoWorktrees,
  Worktree,
} from '../src/shared/contracts.js';
import { basename, parseWorktreeList, readRepoWorktrees } from '../src/main/git/git-worktrees.js';
import {
  flattenWorktrees,
  summarizeWorktrees,
  worktreeMenuEntries,
} from '../src/renderer/ui/worktree-list.js';

/** The shape git prints, main checkout first, records separated by a blank line. */
const PORCELAIN = [
  'worktree C:/repos/web-app',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree C:/worktrees/PROJ-123-web-app',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/PROJ-123-thousands-separator',
  '',
  'worktree C:/worktrees/PROJ-99-web-app',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
].join('\n');

describe('parseWorktreeList', () => {
  it('lists the linked worktrees and leaves out the main checkout', () => {
    const entries = parseWorktreeList(PORCELAIN, 'C:/repos/web-app');

    expect(entries.map((entry) => entry.name)).toEqual([
      'PROJ-123-web-app',
      'PROJ-99-web-app',
    ]);
    expect(entries[0]?.branch).toBe('PROJ-123-thousands-separator');
    expect(entries[0]?.path).toBe('C:/worktrees/PROJ-123-web-app');
  });

  it('excludes the main checkout across separator and case differences', () => {
    /*
     * The load-bearing case, and the one that would look like a feature rather than a bug: git prints
     * `C:/repos/web-app` while the settings store the path as `C:\repos\web-app`, so a raw comparison
     * never matches and **every** project grows a phantom worktree row that is really its own clone.
     * The drive letter's case is git's to spell, hence the fold.
     */
    expect(parseWorktreeList(PORCELAIN, 'c:\\repos\\web-app\\')).toHaveLength(2);
  });

  it('spells a detached HEAD like the project rows do', () => {
    const entries = parseWorktreeList(PORCELAIN, 'C:/repos/web-app');
    expect(entries[1]?.branch).toBe('detached@3333333');
  });

  it('reads the last record even with no trailing blank line', () => {
    // A record is closed by the next `worktree` line or by the end of the output, never by the blank
    // line alone: trusting the separator drops the last worktree of an output that does not end in one.
    const entries = parseWorktreeList(
      ['worktree C:/repos/web-app', 'branch refs/heads/main', '', 'worktree C:/worktrees/x-web-app', 'branch refs/heads/x'].join(
        '\n',
      ),
      'C:/repos/web-app',
    );
    expect(entries.map((entry) => entry.name)).toEqual(['x-web-app']);
  });

  it('treats a bare `locked` as locked, with no reason', () => {
    // git accepts a lock without a reason, so reading only `locked <reason>` would report a locked
    // worktree as unlocked: the opposite of what it is, on the one row a removal will refuse.
    const entries = parseWorktreeList(
      [
        'worktree C:/repos/web-app',
        'branch refs/heads/main',
        '',
        'worktree C:/worktrees/PROJ-1-web-app',
        'branch refs/heads/PROJ-1',
        'locked',
        '',
        'worktree C:/worktrees/PROJ-2-web-app',
        'branch refs/heads/PROJ-2',
        'locked on a removable drive',
      ].join('\n'),
      'C:/repos/web-app',
    );
    expect(entries[0]?.locked).toBe('');
    expect(entries[1]?.locked).toBe('on a removable drive');
  });

  it('carries git\'s own reason for a prunable worktree', () => {
    const entries = parseWorktreeList(
      [
        'worktree C:/repos/web-app',
        'branch refs/heads/main',
        '',
        'worktree C:/worktrees/PROJ-3-web-app',
        'branch refs/heads/PROJ-3',
        'prunable gitdir file points to non-existent location',
      ].join('\n'),
      'C:/repos/web-app',
    );
    expect(entries[0]?.prunable).toBe('gitdir file points to non-existent location');
    expect(entries[0]?.locked).toBeNull();
  });

  it('skips a bare repository and ignores attributes it does not know', () => {
    const entries = parseWorktreeList(
      [
        'worktree C:/repos/web-app.git',
        'bare',
        '',
        'worktree C:/worktrees/PROJ-4-web-app',
        'HEAD 4444444444444444444444444444444444444444',
        'branch refs/heads/PROJ-4',
        'something-git-added-later yes',
      ].join('\n'),
      'C:/repos/web-app.git',
    );
    expect(entries.map((entry) => entry.name)).toEqual(['PROJ-4-web-app']);
    expect(entries[0]?.branch).toBe('PROJ-4');
  });

  it('answers an empty list rather than throwing on empty output', () => {
    expect(parseWorktreeList('', 'C:/repos/web-app')).toEqual([]);
  });
});

describe('basename', () => {
  it('reads the folder name whichever separator was used', () => {
    expect(basename('C:/worktrees/PROJ-123-web-app')).toBe('PROJ-123-web-app');
    expect(basename('C:\\worktrees\\PROJ-123-web-app\\')).toBe('PROJ-123-web-app');
  });
});

const CLEAN: GitState = {
  branch: 'PROJ-1',
  modified: 0,
  staged: 0,
  untracked: 0,
  behind: 0,
  ahead: 0,
  hasUpstream: true,
  error: null,
};

function worktree(name: string): Worktree {
  return {
    name,
    path: `C:/worktrees/${name}`,
    branch: name,
    locked: null,
    prunable: null,
    git: CLEAN,
  };
}

function repo(id: string, label: string, names: string[]): RepoWorktrees {
  return {
    projectId: id as ProjectId,
    label,
    path: `C:/repos/${id}`,
    worktrees: names.map(worktree),
    error: null,
  };
}

describe('flattenWorktrees', () => {
  it('keeps the configured project order and sorts each project by name', () => {
    const rows = flattenWorktrees([
      repo('web-app', 'Web', ['PROJ-20-web-app', 'PROJ-3-web-app']),
      repo('admin-front', 'Admin', ['wip-toast-admin-front']),
    ]);

    expect(rows.map((row) => `${row.projectLabel}/${row.worktree.name}`)).toEqual([
      'Web/PROJ-3-web-app',
      'Web/PROJ-20-web-app',
      'Admin/wip-toast-admin-front',
    ]);
  });

  it('orders names by their number and not as text', () => {
    /*
     * Plain text ordering puts `PROJ-1000-web-app` before `PROJ-999-web-app`, the counter being read as
     * a string. Invisible until a project passes a power of ten, which any long-lived one has. The
     * Jira tab's `compareIssueKeys` cannot serve here: it anchors the number at the **end** of the key,
     * and a worktree's name carries the repository after it.
     */
    const rows = flattenWorktrees([
      repo('web-app', 'Web', ['PROJ-1000-web-app', 'PROJ-999-web-app', 'PROJ-99-web-app']),
    ]);
    expect(rows.map((row) => row.worktree.name)).toEqual([
      'PROJ-99-web-app',
      'PROJ-999-web-app',
      'PROJ-1000-web-app',
    ]);
  });

  it('leaves out nothing and invents nothing for a project with no worktree', () => {
    expect(flattenWorktrees([repo('design-system', 'Design', [])])).toEqual([]);
  });
});

describe('summarizeWorktrees', () => {
  it('counts the worktrees and the projects that hold them', () => {
    const summary = summarizeWorktrees([
      repo('web-app', 'Web', ['PROJ-1-web-app', 'PROJ-2-web-app']),
      repo('admin-front', 'Admin', ['PROJ-3-admin-front']),
      repo('design-system', 'Design', []),
    ]);
    expect(summary).toBe('3 worktrees across 2 of 3 projects');
  });

  it('says so when there is none, rather than counting to zero', () => {
    expect(summarizeWorktrees([repo('web-app', 'Web', [])])).toBe('No worktree');
  });

  it('reports an unreadable project apart from the total', () => {
    // A project whose `git worktree list` failed is one this tab knows nothing about, so folding it
    // into the count would state a total that is not one.
    const broken: RepoWorktrees = {
      projectId: 'notes' as ProjectId,
      label: 'Notes',
      path: 'C:/repos/notes',
      worktrees: [],
      error: 'not a git repository',
    };
    expect(summarizeWorktrees([repo('web-app', 'Web', ['PROJ-1-web-app']), broken])).toBe(
      '1 worktree across 1 of 2 projects, 1 unreadable',
    );
  });
});

/**
 * Which life-cycle entries a row is allowed to offer.
 *
 * The reason these gestures moved out of the terminal and into the list is that the list already knows
 * the state: it has just read whether the folder is there and whether it holds uncommitted work. So the
 * destructive entry is on the menu of a row that has something to destroy, and nowhere else. That
 * derivation is four fields wide, invisible until it is wrong, and its failure is a menu offering to
 * delete work.
 */
describe('worktreeMenuEntries', () => {
  const labels = (entries: ReturnType<typeof worktreeMenuEntries>): string[] =>
    entries.map((entry) => entry.label);

  it('offers a plain removal, a removal with the branch, and a rename on a clean row', () => {
    expect(labels(worktreeMenuEntries(worktree('PROJ-1-web-app')))).toEqual([
      'Remove',
      'Remove and delete the branch',
      'Rename…',
    ]);
  });

  it('keeps -f off a clean row entirely', () => {
    // Not disabled, absent. An entry that discards uncommitted work on a row with none is a permanently
    // armed control offering nothing the plain removal does not already do.
    const entries = worktreeMenuEntries(worktree('PROJ-1-web-app'));
    expect(entries.some((entry) => entry.command?.kind === 'remove' && entry.command.discardChanges)).toBe(
      false,
    );
  });

  it('offers -f on a dirty row, and counts what it will throw away', () => {
    const dirty: Worktree = {
      ...worktree('PROJ-1-web-app'),
      git: { ...CLEAN, modified: 2, untracked: 1 },
    };
    const entries = worktreeMenuEntries(dirty);
    expect(labels(entries)).toContain('Remove, discarding 3 changes');
    const forced = entries.find((entry) => entry.label.startsWith('Remove, discarding'));
    expect(forced?.command).toEqual({
      kind: 'remove',
      label: 'PROJ-1-web-app',
      discardChanges: true,
      deleteBranch: false,
    });
  });

  it('says "1 change" rather than "1 changes"', () => {
    const dirty: Worktree = { ...worktree('PROJ-1-web-app'), git: { ...CLEAN, staged: 1 } };
    expect(labels(worktreeMenuEntries(dirty))).toContain('Remove, discarding 1 change');
  });

  it('gives a prunable row one entry, and it is not a deletion', () => {
    // Its folder is gone: there is nothing to rename, nothing to discard, and what is left is a
    // registration git is waiting to be told to drop. Offering the full menu would promise gestures
    // that have nothing to act on.
    const stale: Worktree = {
      ...worktree('PROJ-1-web-app'),
      prunable: 'gitdir file points to non-existent location',
      git: null,
    };
    const entries = worktreeMenuEntries(stale);
    expect(labels(entries)).toEqual(['Prune the stale registration']);
    expect(entries[0]?.command).toEqual({
      kind: 'remove',
      label: 'PROJ-1-web-app',
      discardChanges: false,
      deleteBranch: false,
    });
  });

  it('warns in the hint that git refuses a locked worktree', () => {
    const locked: Worktree = { ...worktree('PROJ-1-web-app'), locked: 'release build' };
    expect(worktreeMenuEntries(locked)[0]?.hint).toContain('locked');
  });

  it('reads a row whose git state failed as not dirty rather than as clean-and-forceable', () => {
    // `git status` failing says nothing about what is in the folder. Offering `--force` on the strength
    // of an error would be inventing the one fact that makes the gesture safe.
    const broken: Worktree = {
      ...worktree('PROJ-1-web-app'),
      git: { ...CLEAN, modified: 4, error: 'not a git repository' },
    };
    expect(labels(worktreeMenuEntries(broken))).not.toContain('Remove, discarding 4 changes');
  });

  it('addresses every worktree by its folder name, which is the only identity the helper takes', () => {
    for (const entry of worktreeMenuEntries(worktree('PROJ-1-web-app'))) {
      if (entry.command !== null) {
        expect(entry.command.label).toBe('PROJ-1-web-app');
      }
    }
  });
});

/**
 * Against a **real repository**, like `git-commands.test.ts` next door and for the same reason.
 *
 * The parser tests above prove the format is read correctly; they prove nothing about whether that is
 * the format git prints. This block is also the only place the main-checkout exclusion is exercised on
 * paths nobody wrote by hand: `mkdtempSync` hands back `C:\...\Temp\oxum-wt-x` while git answers
 * `C:/.../Temp/oxum-wt-x`, which is exactly the mismatch that would put every clone in its own list.
 */
describe('readRepoWorktrees, against a real repository', () => {
  let repo = '';
  let linked = '';

  function run(args: string[]): void {
    execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'pipe' });
  }

  function project(): Project {
    return {
      id: 'fixture' as ProjectId,
      label: 'Fixture',
      path: repo,
      actions: [],
      kind: 'server',
      expectedPort: null,
      tags: [],
    };
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'oxum-wt-'));
    linked = join(repo, '..', `${basename(repo)}-linked`);
    execFileSync('git', ['init', '-b', 'main', repo], { windowsHide: true, stdio: 'pipe' });
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'kept.ts'), 'const kept = 1;\n', 'utf8');
    run(['add', '.']);
    run(['commit', '-m', 'feat: first commit']);
    run(['worktree', 'add', '-b', 'PROJ-7-fixture', linked]);
  });

  afterAll(() => {
    rmSync(linked, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('lists the linked worktree and not the clone it was made from', async () => {
    const state = await readRepoWorktrees(project());

    expect(state.error).toBeNull();
    expect(state.worktrees).toHaveLength(1);
    expect(state.worktrees[0]?.branch).toBe('PROJ-7-fixture');
    expect(state.worktrees[0]?.name).toBe(basename(linked));
  });

  it('reads the working tree of the worktree, not of the clone', async () => {
    // The failure this catches is a status read in the wrong directory: both are the same repository,
    // so a wrong `-C` still answers, and it answers about the other checkout's files.
    writeFileSync(join(linked, 'draft.ts'), 'const draft = 1;\n', 'utf8');

    const state = await readRepoWorktrees(project());
    expect(state.worktrees[0]?.git?.untracked).toBe(1);
    expect(state.worktrees[0]?.git?.hasUpstream).toBe(false);
    expect(state.worktrees[0]?.git?.error).toBeNull();
  });

  it('excludes the main checkout when the project is registered through a junction', async () => {
    // git resolves the path it is handed before printing it, so a project registered through a
    // junction, or living under a TEMP whose owner has an 8.3 alias, is compared against a spelling
    // it can never equal: the main checkout survives the filter and the project grows a worktree row
    // that is itself. Both vectors verified on Windows, and the second is what a CI runner hands you.
    const link = join(repo, '..', `${basename(repo)}-junction`);
    symlinkSync(repo, link, 'junction');
    try {
      const state = await readRepoWorktrees({ ...project(), path: link });

      expect(state.error).toBeNull();
      expect(state.worktrees).toHaveLength(1);
      expect(state.worktrees[0]?.branch).toBe('PROJ-7-fixture');
    } finally {
      // Removes the junction only: verified that the target and its files survive.
      rmSync(link, { recursive: true, force: true });
    }
  });

  it('reports a folder that is not a repository instead of calling it empty', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'oxum-nowt-'));
    try {
      const state = await readRepoWorktrees({ ...project(), path: empty });
      expect(state.error).not.toBeNull();
      expect(state.worktrees).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
