import { describe, expect, it } from 'vitest';
import type { GitCommit, GitRef, GitRepoState } from '../src/shared/contracts.js';
import {
  initialsOf,
  isPublished,
  presentTrack,
  refChipsBySha,
  refSections,
  undoStateFor,
} from '../src/renderer/ui/presenters.js';
import { scrollToReveal, visibleWindow } from '../src/renderer/ui/virtual-window.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function ref(kind: GitRef['kind'], name: string, sha: string, extra: Partial<GitRef> = {}): GitRef {
  const namespace = { local: 'refs/heads/', remote: 'refs/remotes/', tag: 'refs/tags/' }[kind];
  return {
    ref: `${namespace}${name}`,
    name,
    kind,
    sha,
    current: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    gone: false,
    updatedAt: '',
    ...extra,
  };
}

function commit(sha: string, parents: string[], subject = 'work'): GitCommit {
  return { sha, parents, subject, author: 'Sam Doe', date: '', refs: '' };
}

function repo(extra: Partial<GitRepoState>): GitRepoState {
  return {
    projectId: 'p',
    label: 'P',
    path: '/p',
    branch: 'main',
    headSha: C,
    refs: [],
    changes: [],
    commits: [commit(C, [B]), commit(B, [A]), commit(A, [])],
    stashes: [],
    headMessage: '',
    sequencer: 'none',
    ahead: 0,
    behind: 0,
    hasUpstream: false,
    checkedAt: null,
    error: null,
    ...extra,
  };
}

describe('refChipsBySha', () => {
  it('folds a local branch and its remote twin on the same commit into one chip', () => {
    const chips = refChipsBySha(
      [ref('local', 'main', A, { current: true }), ref('remote', 'origin/main', A)],
      A,
    );

    expect(chips.get(A)).toHaveLength(1);
    expect(chips.get(A)?.[0]).toMatchObject({ label: 'main', current: true });
    expect(chips.get(A)?.[0]?.remotes.map((remote) => remote.name)).toEqual(['origin/main']);
  });

  it('gives a remote branch its own chip once it has moved away from the local one', () => {
    const chips = refChipsBySha(
      [ref('local', 'main', A, { current: true }), ref('remote', 'origin/main', B)],
      A,
    );

    expect(chips.get(A)?.map((chip) => chip.label)).toEqual(['main']);
    expect(chips.get(B)?.map((chip) => chip.label)).toEqual(['origin/main']);
  });

  it('orders the checked-out branch first and tags last', () => {
    const chips = refChipsBySha(
      [
        ref('tag', 'v1', A),
        ref('local', 'alpha', A),
        ref('remote', 'origin/other', A),
        ref('local', 'main', A, { current: true }),
      ],
      A,
    );

    expect(chips.get(A)?.map((chip) => chip.label)).toEqual([
      'main',
      'alpha',
      'origin/other',
      'v1',
    ]);
  });

  it('marks a detached HEAD, which no branch can stand for', () => {
    const chips = refChipsBySha([ref('local', 'main', A)], B);

    expect(chips.get(B)?.map((chip) => `${chip.kind}:${chip.label}`)).toEqual(['head:HEAD']);
  });
});

describe('refSections', () => {
  it('sorts branches by name, groups remotes, and puts the newest tag first', () => {
    const sections = refSections([
      ref('local', 'zeta', A),
      ref('local', 'alpha', A),
      ref('remote', 'upstream/main', A),
      ref('remote', 'origin/feat', A),
      ref('remote', 'origin/b-fix', A),
      ref('tag', 'v1', A, { updatedAt: '2026-01-01T00:00:00Z' }),
      ref('tag', 'v2', A, { updatedAt: '2026-06-01T00:00:00Z' }),
    ]);

    expect(sections.local.map((branch) => branch.name)).toEqual(['alpha', 'zeta']);
    expect(
      sections.remotes.map((group) => [group.remote, group.refs.map((branch) => branch.name)]),
    ).toEqual([
      ['origin', ['origin/b-fix', 'origin/feat']],
      ['upstream', ['upstream/main']],
    ]);
    expect(sections.tags.map((tag) => tag.name)).toEqual(['v2', 'v1']);
  });
});

describe('initialsOf', () => {
  it('takes the first and last words, upper-cased', () => {
    expect(initialsOf('Sam Doe')).toBe('SD');
    expect(initialsOf('sam van der doe')).toBe('SD');
    expect(initialsOf('dependabot[bot]')).toBe('D');
    expect(initialsOf('')).toBe('?');
  });
});

describe('presentTrack', () => {
  it('says local for a branch never pushed, and nothing for one in sync', () => {
    expect(presentTrack(ref('local', 'x', A))).toBe('local');
    expect(presentTrack(ref('local', 'x', A, { upstream: 'origin/x' }))).toBe('');
    expect(presentTrack(ref('local', 'x', A, { upstream: 'origin/x', ahead: 2, behind: 1 }))).toBe(
      '↑2 ↓1',
    );
  });
});

describe('isPublished', () => {
  const commits = [commit(C, [B]), commit(B, [A]), commit(A, [])];

  it('finds a commit below a remote branch', () => {
    expect(isPublished(A, [ref('remote', 'origin/main', B)], commits)).toBe(true);
  });

  it('does not count a commit above every remote branch', () => {
    expect(isPublished(C, [ref('remote', 'origin/main', B)], commits)).toBe(false);
  });

  it('ignores local branches and tags, which nobody else fetches from', () => {
    expect(isPublished(C, [ref('local', 'main', C), ref('tag', 'v1', C)], commits)).toBe(false);
  });
});

describe('undoStateFor', () => {
  it('offers to undo a local commit, naming it', () => {
    const state = undoStateFor(repo({}));

    expect(state.enabled).toBe(true);
    expect(state.reason).toContain('ccccccc');
  });

  it('refuses a commit already on a remote branch', () => {
    expect(undoStateFor(repo({ refs: [ref('remote', 'origin/main', C)] })).enabled).toBe(false);
  });

  it('refuses a merge, the first commit, an empty repository and a half-done operation', () => {
    expect(undoStateFor(repo({ commits: [commit(C, [A, B])] })).enabled).toBe(false);
    expect(undoStateFor(repo({ commits: [commit(C, [])] })).enabled).toBe(false);
    expect(undoStateFor(repo({ headSha: null })).enabled).toBe(false);
    expect(undoStateFor(repo({ sequencer: 'cherry-pick' })).reason).toContain('cherry-pick');
  });
});

describe('visibleWindow', () => {
  it('builds the rows in view plus the margin either side', () => {
    expect(visibleWindow(0, 100, 20, 400, 3)).toEqual({ start: 0, end: 8 });
    expect(visibleWindow(200, 100, 20, 400, 3)).toEqual({ start: 7, end: 18 });
  });

  it('never runs past either end of the list', () => {
    expect(visibleWindow(7900, 100, 20, 400, 3)).toEqual({ start: 392, end: 400 });
    expect(visibleWindow(-50, 100, 20, 10, 3)).toEqual({ start: 0, end: 8 });
    expect(visibleWindow(0, 100, 20, 0, 3)).toEqual({ start: 0, end: 0 });
  });

  it('counts a row cut by the bottom edge as visible', () => {
    // 110 px of viewport shows five and a half rows: the half row has to be built.
    expect(visibleWindow(0, 110, 20, 400, 0)).toEqual({ start: 0, end: 6 });
  });
});

describe('scrollToReveal', () => {
  it('leaves a visible row where it is', () => {
    expect(scrollToReveal(100, 200, 20, 6)).toBe(100);
  });

  it('scrolls up to a row above, and just enough down to a row below', () => {
    expect(scrollToReveal(100, 200, 20, 2)).toBe(40);
    expect(scrollToReveal(100, 200, 20, 20)).toBe(220);
  });
});
