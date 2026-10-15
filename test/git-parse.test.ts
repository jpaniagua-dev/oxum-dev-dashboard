import { describe, expect, it } from 'vitest';
import {
  FIELD_SEPARATOR as SEP,
  describeStash,
  parseCommitFilesZ,
  parseGraphLines,
  parseRefLines,
  parseStashLines,
  parseStatusZ,
  parseUnifiedDiff,
} from '../src/main/git/git-parse.js';
import {
  hasStagedChanges,
  hasWorktreeChange,
  isDeletedOnDisk,
  isStaged,
} from '../src/shared/git-changes.js';

describe('parseStatusZ', () => {
  it('keeps the index and worktree columns apart', () => {
    // `MM` is the case a single state would flatten: staged, then edited again.
    const changes = parseStatusZ('MM src/a.ts\0 M src/b.ts\0M  src/c.ts\0');

    expect(changes.map((change) => [change.path, change.index, change.worktree])).toEqual([
      ['src/a.ts', 'M', 'M'],
      ['src/b.ts', ' ', 'M'],
      ['src/c.ts', 'M', ' '],
    ]);
  });

  it('marks untracked files without calling them staged', () => {
    const [change] = parseStatusZ('?? src/new.ts\0');

    expect(change?.untracked).toBe(true);
    // The trap `index !== ' '` falls into: `?` is not a space, but nothing is staged.
    expect(isStaged(change!)).toBe(false);
  });

  it('consumes the second field of a rename instead of listing it as a file', () => {
    const changes = parseStatusZ('R  src/new.ts\0src/old.ts\0 M src/other.ts\0');

    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ path: 'src/new.ts', from: 'src/old.ts' });
    // Without the extra increment, `src/old.ts` would become a phantom row and shift everything.
    expect(changes[1]?.path).toBe('src/other.ts');
  });

  it('reads a path with accents untouched, which is why -z is used', () => {
    const [change] = parseStatusZ(' M src/données/créé.ts\0');

    expect(change?.path).toBe('src/données/créé.ts');
  });

  it('survives an empty status', () => {
    expect(parseStatusZ('')).toEqual([]);
    expect(parseStatusZ('\0')).toEqual([]);
  });
});

describe('parseRefLines', () => {
  const line = (fields: string[]): string => fields.join(SEP);
  const SHA = 'a'.repeat(40);

  it('reads the current branch, its upstream and its distance', () => {
    const refs = parseRefLines(
      [
        line([
          'refs/heads/main',
          '*',
          'origin/main',
          '[ahead 2, behind 1]',
          '2026-08-07T10:00:00+02:00',
          SHA,
          '',
        ]),
        line(['refs/heads/PROJ-1601', ' ', '', '', '2026-08-01T09:00:00+02:00', SHA, '']),
      ].join('\n'),
    );

    expect(refs[0]).toMatchObject({
      ref: 'refs/heads/main',
      name: 'main',
      kind: 'local',
      sha: SHA,
      current: true,
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      gone: false,
    });
    expect(refs[1]).toMatchObject({ name: 'PROJ-1601', current: false, upstream: null });
  });

  it('reads each half of the track field on its own', () => {
    // The reason the two counts are searched separately: git prints either half alone.
    const [ahead] = parseRefLines(line(['refs/heads/a', ' ', 'origin/a', '[ahead 3]', '', SHA]));
    const [behind] = parseRefLines(line(['refs/heads/b', ' ', 'origin/b', '[behind 4]', '', SHA]));

    expect([ahead?.ahead, ahead?.behind]).toEqual([3, 0]);
    expect([behind?.ahead, behind?.behind]).toEqual([0, 4]);
  });

  it('flags an upstream that no longer exists', () => {
    const [branch] = parseRefLines(line(['refs/heads/old', ' ', 'origin/old', '[gone]', '', SHA]));

    expect(branch?.gone).toBe(true);
  });

  it('names each kind without its namespace, whatever else the repository holds', () => {
    // `%(refname:short)` would print `heads/v1` here, a tag of the same name existing.
    const refs = parseRefLines(
      [
        line(['refs/heads/v1', ' ', '', '', '', SHA, '']),
        line(['refs/remotes/origin/feat/x', ' ', '', '', '', SHA, '']),
        line(['refs/tags/v1', ' ', '', '', '', SHA, '']),
      ].join('\n'),
    );

    expect(refs.map((ref) => [ref.kind, ref.name])).toEqual([
      ['local', 'v1'],
      ['remote', 'origin/feat/x'],
      ['tag', 'v1'],
    ]);
  });

  it('drops a remote HEAD, which is a pointer and not a branch', () => {
    const refs = parseRefLines(line(['refs/remotes/origin/HEAD', ' ', '', '', '', SHA, '']));

    expect(refs).toEqual([]);
  });

  it('peels an annotated tag to the commit it points to', () => {
    const commit = 'c'.repeat(40);
    const [tag] = parseRefLines(line(['refs/tags/v2', ' ', '', '', '', 't'.repeat(40), commit]));

    expect(tag?.sha).toBe(commit);
  });
});

describe('parseGraphLines', () => {
  const PARENT = 'b'.repeat(40);
  const OTHER = 'c'.repeat(40);

  it('reads the fields of a commit, parents first parent first', () => {
    const [commit] = parseGraphLines(
      [
        'a'.repeat(40),
        `${PARENT} ${OTHER}`,
        'Sam',
        '2026-08-07T10:00:00+02:00',
        'HEAD -> main',
        'Merge branch feat',
      ].join(SEP),
    );

    expect(commit).toEqual({
      sha: 'a'.repeat(40),
      parents: [PARENT, OTHER],
      author: 'Sam',
      date: '2026-08-07T10:00:00+02:00',
      refs: 'HEAD -> main',
      subject: 'Merge branch feat',
    });
  });

  it('gives a root commit no parent at all, not an empty one', () => {
    // A lane waiting for a parent named '' would never close.
    const [commit] = parseGraphLines(['a'.repeat(40), '', 'Sam', '', '', 'init'].join(SEP));

    expect(commit?.parents).toEqual([]);
  });

  it('keeps a subject containing the separator whole', () => {
    // Why the subject is the last field and is rejoined rather than taken as `rest[0]`.
    const [commit] = parseGraphLines(
      ['a'.repeat(40), PARENT, 'Sam', '', '', `fix: remove one${SEP}character`].join(SEP),
    );

    expect(commit?.subject).toBe(`fix: remove one${SEP}character`);
  });
});

describe('parseCommitFilesZ', () => {
  it('pairs every status with its path', () => {
    expect(parseCommitFilesZ('M\0src/a.ts\0A\0src/b.ts\0D\0old.ts\0')).toEqual([
      { path: 'src/a.ts', status: 'M', from: null },
      { path: 'src/b.ts', status: 'A', from: null },
      { path: 'old.ts', status: 'D', from: null },
    ]);
  });

  it('consumes both paths of a rename and drops its score', () => {
    // Missing the second path would pair `M` with `src/new.ts` and invent a phantom file.
    expect(parseCommitFilesZ('R087\0src/old.ts\0src/new.ts\0M\0b.ts\0')).toEqual([
      { path: 'src/new.ts', status: 'R', from: 'src/old.ts' },
      { path: 'b.ts', status: 'M', from: null },
    ]);
  });

  it('keeps a path with spaces and accents raw', () => {
    expect(parseCommitFilesZ('A\0docs/cr\u00e9ation finale.md\0')).toEqual([
      { path: 'docs/cr\u00e9ation finale.md', status: 'A', from: null },
    ]);
  });
});

describe('parseUnifiedDiff', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,3 +10,4 @@ export function a() {',
    ' const kept = 1;',
    '-const removed = 2;',
    '+const added = 2;',
    '+const alsoAdded = 3;',
  ].join('\n');

  it('classifies headers before markers', () => {
    const lines = parseUnifiedDiff(diff);

    // `---` and `+++` start with the removal and addition markers: read as content, they would
    // consume two line numbers and push every following line off by one.
    expect(lines.slice(0, 4).map((line) => line.kind)).toEqual(['meta', 'meta', 'meta', 'meta']);
  });

  it('numbers both sides from the hunk header', () => {
    const content = parseUnifiedDiff(diff).filter(
      (line) => line.kind === 'context' || line.kind === 'add' || line.kind === 'del',
    );

    expect(content.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ['context', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
    ]);
  });

  it('starts the second hunk where its header says, not where the first ended', () => {
    const lines = parseUnifiedDiff(
      ['@@ -1,1 +1,1 @@', ' first', '@@ -80,1 +90,1 @@', ' second'].join('\n'),
    );
    const contexts = lines.filter((line) => line.kind === 'context');

    expect(contexts[0]).toMatchObject({ oldLine: 1, newLine: 1 });
    expect(contexts[1]).toMatchObject({ oldLine: 80, newLine: 90 });
  });

  it('treats a bare --- in content as a removed line, not a header', () => {
    // A Markdown horizontal rule being deleted. `--- ` is matched with its trailing space precisely
    // so this stays a change instead of vanishing into the headers.
    const lines = parseUnifiedDiff(['@@ -1,1 +1,0 @@', '----'].join('\n'));

    expect(lines[1]).toMatchObject({ kind: 'del', oldLine: 1 });
  });

  it('does not let "no newline at end of file" advance a counter', () => {
    const lines = parseUnifiedDiff(
      ['@@ -1,2 +1,2 @@', '-old', '\\ No newline at end of file', '+new'].join('\n'),
    );

    expect(lines[2]).toMatchObject({ kind: 'meta' });
    expect(lines[3]).toMatchObject({ kind: 'add', newLine: 1 });
  });
});

describe('git-changes', () => {
  const change = (index: string, worktree: string): Parameters<typeof isStaged>[0] => ({
    path: 'x.ts',
    index,
    worktree,
    untracked: index === '?' && worktree === '?',
    from: null,
  });

  it('reads a file that is staged and dirty as both', () => {
    expect(isStaged(change('M', 'M'))).toBe(true);
    expect(hasWorktreeChange(change('M', 'M'))).toBe(true);
  });

  it('never counts an untracked file as staged', () => {
    expect(isStaged(change('?', '?'))).toBe(false);
    expect(hasWorktreeChange(change('?', '?'))).toBe(false);
  });

  it('answers whether a commit would contain anything', () => {
    expect(hasStagedChanges([change(' ', 'M'), change('?', '?')])).toBe(false);
    expect(hasStagedChanges([change(' ', 'M'), change('A', ' ')])).toBe(true);
  });

  it('knows which files have nothing left on disk to open', () => {
    for (const [index, worktree] of [[' ', 'D'], ['M', 'D'], ['D', ' '], ['D', 'D']] as const) {
      expect(isDeletedOnDisk(change(index, worktree))).toBe(true);
    }
    // A conflict where one side deleted the file leaves the other side's version on disk.
    for (const [index, worktree] of [[' ', 'M'], ['A', ' '], ['?', '?'], ['R', 'M'], ['U', 'D'], ['D', 'U'], ['U', 'U']] as const) {
      expect(isDeletedOnDisk(change(index, worktree))).toBe(false);
    }
  });
});

describe('describeStash', () => {
  it('reads the branch out of both messages git writes', () => {
    // Two shapes, both produced by git itself, and a pattern matching only the first loses the branch
    // of every *named* stash — which is the half people actually type.
    expect(describeStash('WIP on main: 1a2b3c4 feat: quelque chose')).toEqual({
      branch: 'main',
      subject: 'feat: quelque chose',
    });
    expect(describeStash('On PROJ-1601-essai: mon brouillon')).toEqual({
      branch: 'PROJ-1601-essai',
      subject: 'mon brouillon',
    });
  });

  it('passes an unrecognised message through whole rather than inventing a branch', () => {
    expect(describeStash('something odd')).toEqual({
      branch: '',
      subject: 'something odd',
    });
  });

  it('does not mistake a colon inside a subject for the branch separator', () => {
    // `[^:]+` before the first colon is what keeps `feat: x` from being read as the branch name.
    expect(describeStash('On main: feat: deux points').branch).toBe('main');
    expect(describeStash('On main: feat: deux points').subject).toBe('feat: deux points');
  });
});

describe('parseStashLines', () => {
  const line = (ref: string, sha: string, date: string, message: string): string =>
    [ref, sha, date, message].join(SEP);

  it('reads the ref, the sha and the message', () => {
    const stashes = parseStashLines(
      [
        line('stash@{0}', 'a'.repeat(40), '2026-08-12T09:00:00+02:00', 'On main: work in progress'),
        line('stash@{1}', 'b'.repeat(40), '2026-08-11T09:00:00+02:00', 'WIP on main: 1a2b3c4 feat: x'),
      ].join('\n'),
    );

    expect(stashes).toEqual([
      {
        ref: 'stash@{0}',
        sha: 'a'.repeat(40),
        date: '2026-08-12T09:00:00+02:00',
        branch: 'main',
        subject: 'work in progress',
      },
      {
        ref: 'stash@{1}',
        sha: 'b'.repeat(40),
        date: '2026-08-11T09:00:00+02:00',
        branch: 'main',
        subject: 'feat: x',
      },
    ]);
  });

  it('keeps a message containing the separator whole', () => {
    // Same reason the commit subject is the last field: it is the one a user writes freely, so a stray
    // separator inside it can only damage itself.
    const stashes = parseStashLines(
      line('stash@{0}', 'c'.repeat(40), '2026-08-12T09:00:00+02:00', `On main: a${SEP}b`),
    );
    expect(stashes[0]?.subject).toBe(`a${SEP}b`);
  });

  it('drops a line with no ref or no sha rather than emitting an unusable entry', () => {
    // Without a sha there is nothing to resolve a write against, so such an entry could only produce a
    // button that acts on the wrong stash.
    expect(parseStashLines(`${SEP}${SEP}${SEP}On main: x`)).toEqual([]);
    expect(parseStashLines(`stash@{0}${SEP}${SEP}${SEP}On main: x`)).toEqual([]);
    expect(parseStashLines('')).toEqual([]);
  });
});
