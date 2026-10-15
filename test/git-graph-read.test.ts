import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findHeadSha,
  readCommitDetail,
  readCommits,
  readDiff,
  readRefs,
  readRepoState,
} from '../src/main/git/git-commands.js';
import { stopSpawnPool } from '../src/main/spawn/spawn-pool.js';
import type { GitCommit, Project } from '../src/shared/contracts.js';

/*
 * The graph's reads, against a real repository with a real origin.
 *
 * The parsers next door prove the format is read correctly; only git can prove it is the format git
 * prints, and three of the things read here are easy to get wrong in a way no fixed string would
 * show: a merge's file list (empty without `-m`), a root commit's (empty without `--root`) and the
 * remote `HEAD` pointer (a second label on a commit that already has one).
 *
 * Shape of the fixture, oldest first:
 *
 *   root ── base ─────────── merge (main, HEAD, origin/main)
 *               \            /
 *                feat ── feat2 (feat, origin/feat, tag v1)
 */

let root = '';
let repo = '';

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
}

function put(name: string, content: string): void {
  writeFileSync(join(repo, name), content, 'utf8');
}

function project(): Project {
  return {
    id: 'graph',
    label: 'Graph',
    path: repo,
    actions: [],
    kind: 'server',
    expectedPort: null,
    tags: [],
  };
}

function bySubject(commits: readonly GitCommit[], subject: string): GitCommit {
  const commit = commits.find((candidate) => candidate.subject === subject);
  if (commit === undefined) {
    throw new Error(`No commit "${subject}"`);
  }
  return commit;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'oxum-graph-'));
  const origin = join(root, 'origin.git');
  repo = join(root, 'web-app');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { windowsHide: true });
  execFileSync('git', ['clone', origin, repo], { windowsHide: true, stdio: 'pipe' });
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');

  put('a.ts', 'const a = 1;\n');
  git('add', '.');
  git('commit', '-m', 'root');
  put('b.ts', 'const b = 1;\n');
  git('add', '.');
  git('commit', '-m', 'base');

  git('checkout', '-b', 'feat');
  put('feat.ts', 'const feat = 1;\n');
  git('add', '.');
  git('commit', '-m', 'feat');
  put('feat.ts', 'const feat = 2;\n');
  git('add', '.');
  git('commit', '-m', 'feat2');
  git('tag', '-a', 'v1', '-m', 'first release');

  git('checkout', 'main');
  put('main.ts', 'const main = 1;\n');
  git('add', '.');
  git('commit', '-m', 'main work');
  git('merge', '--no-ff', '--no-edit', 'feat');

  git('push', 'origin', 'main', 'feat');
  git('remote', 'set-head', 'origin', 'main');
});

afterAll(async () => {
  await stopSpawnPool();
  rmSync(root, { recursive: true, force: true });
});

describe('readCommits', () => {
  it('reads every branch, in an order where a child always precedes its parents', async () => {
    const commits = await readCommits(repo);
    const position = new Map(commits.map((commit, index) => [commit.sha, index]));

    expect(commits.map((commit) => commit.subject).sort()).toEqual(
      ["Merge branch 'feat'", 'base', 'feat', 'feat2', 'main work', 'root'].sort(),
    );
    for (const [index, commit] of commits.entries()) {
      for (const parent of commit.parents) {
        expect(position.get(parent)).toBeGreaterThan(index);
      }
    }
  });

  it('gives full shas, two parents to the merge and none to the root', async () => {
    const commits = await readCommits(repo);
    const merge = bySubject(commits, "Merge branch 'feat'");

    expect(merge.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(merge.parents).toEqual([
      bySubject(commits, 'main work').sha,
      bySubject(commits, 'feat2').sha,
    ]);
    expect(bySubject(commits, 'root').parents).toEqual([]);
  });

  it('reads an empty graph, not an error, in a repository with no commit yet', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'oxum-graph-empty-'));
    execFileSync('git', ['init', '-b', 'main', empty], { windowsHide: true, stdio: 'pipe' });
    try {
      expect(await readCommits(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('readRefs', () => {
  it('reads the three kinds, peels the annotated tag and drops the remote HEAD', async () => {
    const refs = await readRefs(repo);
    const commits = await readCommits(repo);
    const feat2 = bySubject(commits, 'feat2').sha;

    expect(refs.map((ref) => `${ref.kind}:${ref.name}`).sort()).toEqual(
      ['local:feat', 'local:main', 'remote:origin/feat', 'remote:origin/main', 'tag:v1'].sort(),
    );
    // A tag object's own sha is on no row of the graph: the chip has to land on the commit.
    expect(refs.find((ref) => ref.kind === 'tag')?.sha).toBe(feat2);
    expect(refs.find((ref) => ref.name === 'main')).toMatchObject({
      ref: 'refs/heads/main',
      current: true,
      upstream: 'origin/main',
    });
  });
});

describe('readRepoState', () => {
  it('names HEAD by its sha, on a branch and detached', async () => {
    const onBranch = await readRepoState(project());
    expect(onBranch.headSha).toBe(git('rev-parse', 'HEAD'));

    git('checkout', '--detach', 'feat');
    try {
      const detached = await readRepoState(project());
      expect(detached.headSha).toBe(git('rev-parse', 'HEAD'));
      expect(findHeadSha(detached.commits)).toBe(git('rev-parse', 'HEAD'));
    } finally {
      git('checkout', 'main');
    }
  });
});

describe('readCommitDetail', () => {
  it('lists what a merge brought in, against its first parent', async () => {
    const merge = bySubject(await readCommits(repo), "Merge branch 'feat'");
    const detail = await readCommitDetail(repo, merge.sha);

    expect(detail.error).toBeNull();
    expect(detail.message).toBe("Merge branch 'feat'");
    expect(detail.files).toEqual([{ path: 'feat.ts', status: 'A', from: null }]);
  });

  it('lists the files of the root commit, which has no parent to compare with', async () => {
    const rootCommit = bySubject(await readCommits(repo), 'root');

    expect((await readCommitDetail(repo, rootCommit.sha)).files).toEqual([
      { path: 'a.ts', status: 'A', from: null },
    ]);
  });

  it('refuses anything that is not a sha', async () => {
    expect((await readCommitDetail(repo, '--all')).error).not.toBeNull();
  });
});

describe('readDiff on a commit', () => {
  it('shows one file of a merge against its first parent', async () => {
    const merge = bySubject(await readCommits(repo), "Merge branch 'feat'");
    const diff = await readDiff(repo, { kind: 'commit-file', sha: merge.sha, path: 'feat.ts' });

    expect(diff.lines.some((line) => line.kind === 'add' && line.text.includes('feat = 2'))).toBe(
      true,
    );
  });

  it('shows nothing for a file the merge did not bring in, being already on the first parent', async () => {
    // `main.ts` only differs from the SECOND parent: a diff against both would list it.
    const merge = bySubject(await readCommits(repo), "Merge branch 'feat'");
    const diff = await readDiff(repo, { kind: 'commit-file', sha: merge.sha, path: 'main.ts' });

    expect(diff.lines).toEqual([]);
  });

  it('shows a whole merge instead of nothing', async () => {
    // `git show` on a merge prints no diff at all unless told which parent to compare with.
    const merge = bySubject(await readCommits(repo), "Merge branch 'feat'");
    const diff = await readDiff(repo, { kind: 'commit', sha: merge.sha });

    expect(diff.lines.length).toBeGreaterThan(0);
  });
});
