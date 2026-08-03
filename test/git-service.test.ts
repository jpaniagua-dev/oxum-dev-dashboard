import { describe, expect, it } from 'vitest';
import { parseAheadBehind, parsePorcelain } from '../src/main/git/git-service.js';

describe('parsePorcelain', () => {
  it('counts nothing for a clean tree', () => {
    expect(parsePorcelain('')).toEqual({ modified: 0, staged: 0, untracked: 0 });
  });

  it('separates staged, unstaged and untracked', () => {
    const stdout = [
      'M  src/staged.ts', // staged only
      ' M src/dirty.ts', // working tree only
      '?? src/new.ts', // untracked
      'A  src/added.ts', // staged addition
    ].join('\n');

    expect(parsePorcelain(stdout)).toEqual({ modified: 1, staged: 2, untracked: 1 });
  });

  it('counts a file staged and modified again on both sides', () => {
    // This is a real state and it matters: the file has something to commit AND something not yet
    // staged, so collapsing the two columns into one number would hide half the truth.
    expect(parsePorcelain('MM src/both.ts')).toEqual({ modified: 1, staged: 1, untracked: 0 });
  });

  it('handles renames and deletions', () => {
    const stdout = ['R  old.ts -> new.ts', ' D gone.ts', 'D  removed.ts'].join('\n');
    expect(parsePorcelain(stdout)).toEqual({ modified: 1, staged: 2, untracked: 0 });
  });

  it('ignores blank and truncated lines', () => {
    expect(parsePorcelain('\n\nM\n \n M ok.ts\n')).toEqual({
      modified: 1,
      staged: 0,
      untracked: 0,
    });
  });

  it('tolerates CRLF output', () => {
    expect(parsePorcelain(' M a.ts\r\n?? b.ts\r\n')).toEqual({
      modified: 1,
      staged: 0,
      untracked: 1,
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
