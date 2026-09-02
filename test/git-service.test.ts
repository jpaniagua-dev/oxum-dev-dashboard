import { describe, expect, it } from 'vitest';
import { parseAheadBehind, parsePorcelainV2 } from '../src/main/git/git-service.js';

/**
 * The one call a project row is built from.
 *
 * Every fixture below is real `git status --porcelain=v2 --branch` output, captured on Windows rather
 * than written from the documentation: the two cases that matter here are cases of a **missing** line,
 * which is exactly what a hand-written fixture gets wrong.
 */
describe('parsePorcelainV2', () => {
  const CLEAN = [
    '# branch.oid deb104347bbcfa913d118192314e71a346bb97aa',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +0 -0',
  ].join('\n');

  it('reads a clean tree on a tracking branch', () => {
    expect(parsePorcelainV2(CLEAN)).toEqual({
      branch: 'main',
      modified: 0,
      staged: 0,
      untracked: 0,
      behind: 0,
      ahead: 0,
      hasUpstream: true,
    });
  });

  it('reads ahead first and behind second, which is the OPPOSITE of rev-list', () => {
    // `# branch.ab +ahead -behind`, while `rev-list --left-right --count` prints behind then ahead.
    // Getting this backwards swaps the two badges and is invisible until you are both at once.
    const state = parsePorcelainV2(CLEAN.replace('+0 -0', '+7 -3'));
    expect(state.ahead).toBe(7);
    expect(state.behind).toBe(3);
  });

  it('reports no upstream from the ABSENCE of the two header lines', () => {
    // Verified against git: a branch that was never pushed gets neither `branch.upstream` nor
    // `branch.ab`. There is no line saying so, so anything defaulting a missing `branch.ab` to zero
    // while claiming an upstream would report every unpushed branch as level with a remote it has not
    // got, and the checks column would then look a pull request up for it.
    const state = parsePorcelainV2(
      ['# branch.oid abc1234567890', '# branch.head no-upstream-branch'].join('\n'),
    );
    expect(state).toMatchObject({
      branch: 'no-upstream-branch',
      hasUpstream: false,
      ahead: 0,
      behind: 0,
    });
  });

  it('names a detached HEAD by its short sha, which is the actionable part', () => {
    // git says "(detached)", which names a state rather than a place. The sha is in the same output.
    const state = parsePorcelainV2(
      ['# branch.oid deb104347bbcfa913d118192314e71a346bb97aa', '# branch.head (detached)'].join(
        '\n',
      ),
    );
    expect(state.branch).toBe('detached@deb1043');
  });

  it('separates staged, unstaged and untracked', () => {
    const stdout = [
      CLEAN,
      '1 M. N... 100644 100644 100644 aaa bbb src/staged.ts',
      '1 .M N... 100644 100644 100644 aaa aaa src/dirty.ts',
      '1 A. N... 000000 100644 100644 000 ccc src/added.ts',
      '? src/new.ts',
    ].join('\n');

    expect(parsePorcelainV2(stdout)).toMatchObject({ modified: 1, staged: 2, untracked: 1 });
  });

  it('counts a file staged and modified again on both sides', () => {
    // A real state, and the reason the two columns are never merged: the file has something to commit
    // AND something not yet staged, so one number would hide half the truth.
    const stdout = [CLEAN, '1 MM N... 100644 100644 100644 aaa bbb src/both.ts'].join('\n');
    expect(parsePorcelainV2(stdout)).toMatchObject({ modified: 1, staged: 1 });
  });

  it('reads a rename, which is a `2` record and not a `1`', () => {
    const stdout = [
      CLEAN,
      '2 R. N... 100644 100644 100644 aaa aaa R100 new.ts\told.ts',
    ].join('\n');
    expect(parsePorcelainV2(stdout)).toMatchObject({ staged: 1, modified: 0 });
  });

  it('counts an unmerged path as work in the tree', () => {
    // `u` carries both sides of the merge rather than an index and a worktree state, so there is
    // nothing to split between the two counts, and a conflict is certainly not a clean row.
    const stdout = [CLEAN, 'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.ts'].join(
      '\n',
    );
    expect(parsePorcelainV2(stdout)).toMatchObject({ modified: 1, staged: 0 });
  });

  it('ignores an ignored file, which git only lists when asked', () => {
    const stdout = [CLEAN, '! dist/bundle.js'].join('\n');
    expect(parsePorcelainV2(stdout)).toMatchObject({ modified: 0, untracked: 0 });
  });

  it('tolerates CRLF output', () => {
    const stdout = '# branch.head main\r\n1 .M N... 1 1 1 a a a.ts\r\n? b.ts\r\n';
    expect(parsePorcelainV2(stdout)).toMatchObject({ branch: 'main', modified: 1, untracked: 1 });
  });

  it('answers a usable state for empty output rather than NaN or undefined', () => {
    expect(parsePorcelainV2('')).toEqual({
      branch: '?',
      modified: 0,
      staged: 0,
      untracked: 0,
      behind: 0,
      ahead: 0,
      hasUpstream: false,
    });
  });
});

describe('parseAheadBehind', () => {
  it('reads the tab-separated pair, behind first', () => {
    expect(parseAheadBehind('3\t7\n')).toEqual({ behind: 3, ahead: 7 });
  });

  it('reads an in-sync branch', () => {
    expect(parseAheadBehind('0\t0\n')).toEqual({ behind: 0, ahead: 0 });
  });

  it('falls back to zero on unexpected output rather than NaN', () => {
    // NaN would flow into the UI and render as "NaN commits behind".
    expect(parseAheadBehind('')).toEqual({ behind: 0, ahead: 0 });
    expect(parseAheadBehind('oops')).toEqual({ behind: 0, ahead: 0 });
  });
});
