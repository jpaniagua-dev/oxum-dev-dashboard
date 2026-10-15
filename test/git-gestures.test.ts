import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  checkoutBranch,
  checkoutRemoteBranch,
  planMerge,
  readRefs,
  readSequencer,
  resolveSequencer,
  undoLastCommit,
} from '../src/main/git/git-commands.js';
import { stopSpawnPool } from '../src/main/spawn/spawn-pool.js';

/*
 * The three gestures the graph added: undo the last commit, check out a remote branch, merge a
 * dropped branch. Each one against a real repository with a real origin, rebuilt for every test:
 * they all move HEAD, and a test inheriting the previous one's HEAD would be testing the order.
 */

let root = '';
let repo = '';
let origin = '';

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
}

function commit(file: string, content: string, subject: string): void {
  writeFileSync(join(repo, file), content, 'utf8');
  git('add', '.');
  git('commit', '-m', subject);
}

beforeEach(() => {
  if (root !== '') {
    rmSync(root, { recursive: true, force: true });
  }
  root = mkdtempSync(join(tmpdir(), 'oxum-gestures-'));
  origin = join(root, 'origin.git');
  repo = join(root, 'web-app');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { windowsHide: true });
  execFileSync('git', ['clone', origin, repo], { windowsHide: true, stdio: 'pipe' });
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  commit('a.ts', 'const a = 1;\n', 'root');
  commit('b.ts', 'const b = 1;\n', 'base');
  git('push', '-u', 'origin', 'main');
});

afterAll(async () => {
  await stopSpawnPool();
  rmSync(root, { recursive: true, force: true });
});

describe('undoLastCommit', () => {
  it('takes a local commit back, its changes staged and its files untouched', async () => {
    commit('c.ts', 'const c = 1;\n', 'local work');

    const result = await undoLastCommit(repo);

    expect(result.ok).toBe(true);
    expect(git('log', '-1', '--format=%s')).toBe('base');
    expect(git('diff', '--cached', '--name-only')).toBe('c.ts');
  });

  it('refuses a commit already on a remote branch', async () => {
    // `base` is on origin/main: nothing to undo that nobody else has.
    const result = await undoLastCommit(repo);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('origin/main');
    expect(git('log', '-1', '--format=%s')).toBe('base');
  });

  it('refuses a commit pushed with another branch than the one checked out', async () => {
    commit('c.ts', 'const c = 1;\n', 'shared');
    git('push', 'origin', 'HEAD:refs/heads/someone-else');

    expect((await undoLastCommit(repo)).ok).toBe(false);
  });

  it('refuses a merge, whose first parent is only half of what it joined', async () => {
    git('checkout', '-b', 'feat');
    commit('f.ts', 'const f = 1;\n', 'feat');
    git('checkout', 'main');
    commit('m.ts', 'const m = 1;\n', 'main work');
    git('merge', '--no-edit', 'feat');

    const result = await undoLastCommit(repo);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('merge');
  });

  it('refuses the first commit of a repository', async () => {
    const lone = mkdtempSync(join(tmpdir(), 'oxum-gestures-lone-'));
    try {
      execFileSync('git', ['init', '-b', 'main', lone], { windowsHide: true, stdio: 'pipe' });
      execFileSync(
        'git',
        [
          '-C',
          lone,
          '-c',
          'user.email=d@e',
          '-c',
          'user.name=D',
          'commit',
          '--allow-empty',
          '-m',
          'first',
        ],
        {
          windowsHide: true,
          stdio: 'pipe',
        },
      );

      expect((await undoLastCommit(lone)).ok).toBe(false);
    } finally {
      rmSync(lone, { recursive: true, force: true });
    }
  });

  it('refuses while git has an operation half-done', async () => {
    commit('c.ts', 'const c = 1;\n', 'local work');
    writeFileSync(join(repo, '.git', 'MERGE_HEAD'), `${git('rev-parse', 'HEAD')}\n`, 'utf8');

    const result = await undoLastCommit(repo);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('merge');
  });
});

describe('checkoutRemoteBranch', () => {
  it('creates the local branch following a remote one', async () => {
    git('push', 'origin', 'HEAD:refs/heads/feat/remote-only');
    git('fetch', 'origin');

    const result = await checkoutRemoteBranch(repo, 'refs/remotes/origin/feat/remote-only');

    expect(result.ok).toBe(true);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/remote-only');
    expect(git('rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feat/remote-only');
  });

  it('switches to the local branch when it already exists, without moving it', async () => {
    git('checkout', '-b', 'side');
    git('checkout', 'main');

    expect((await checkoutRemoteBranch(repo, 'refs/remotes/origin/main')).ok).toBe(true);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('refuses a remote branch that is not there any more', async () => {
    expect((await checkoutRemoteBranch(repo, 'refs/remotes/origin/gone')).ok).toBe(false);
  });
});

describe('checkoutBranch', () => {
  it('switches branch even when a file of the same name exists', async () => {
    git('checkout', '-b', 'notes');
    git('checkout', 'main');
    // A file named like the branch: without the trailing `--`, git would hesitate between the two.
    writeFileSync(join(repo, 'notes'), 'scratch\n', 'utf8');

    expect((await checkoutBranch(repo, 'notes')).ok).toBe(true);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('notes');
  });

  it('refuses a name that would be read as an option', async () => {
    expect((await checkoutBranch(repo, '--orphan')).ok).toBe(false);
  });
});

describe('planMerge', () => {
  /** Runs a plan the way the merge tab would, minus the pty. */
  function run(args: readonly string[]): void {
    execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'pipe' });
  }

  it('fast-forwards onto a branch that only went ahead', async () => {
    git('checkout', '-b', 'feat');
    commit('f.ts', 'const f = 1;\n', 'feat');
    git('checkout', 'main');

    const plan = await planMerge(repo, 'refs/heads/feat', 'ff-only');
    expect('args' in plan).toBe(true);
    run('args' in plan ? plan.args : []);

    expect(git('log', '-1', '--format=%s')).toBe('feat');
  });

  it("writes git's usual message from the full ref name, for a remote branch too", async () => {
    git('checkout', '-b', 'feat');
    commit('f.ts', 'const f = 1;\n', 'feat');
    git('push', 'origin', 'feat');
    git('checkout', 'main');
    commit('m.ts', 'const m = 1;\n', 'main work');

    const plan = await planMerge(repo, 'refs/remotes/origin/feat', 'merge');
    run('args' in plan ? plan.args : []);

    expect(git('log', '-1', '--format=%s')).toBe("Merge remote-tracking branch 'origin/feat'");
    expect(git('rev-list', '--parents', '-n1', 'HEAD').split(' ')).toHaveLength(3);
  });

  it('creates a merge commit under no-ff even when a fast-forward was possible', async () => {
    git('checkout', '-b', 'feat');
    commit('f.ts', 'const f = 1;\n', 'feat');
    git('checkout', 'main');

    const plan = await planMerge(repo, 'refs/heads/feat', 'no-ff');
    run('args' in plan ? plan.args : []);

    expect(git('log', '-1', '--format=%s')).toBe("Merge branch 'feat'");
  });

  it('leaves a conflict as a merge in progress, which the sequencer reads and aborts', async () => {
    git('checkout', '-b', 'feat');
    commit('b.ts', 'const b = "feat";\n', 'feat changes b');
    git('checkout', 'main');
    commit('b.ts', 'const b = "main";\n', 'main changes b');

    const plan = await planMerge(repo, 'refs/heads/feat', 'merge');
    expect(() => run('args' in plan ? plan.args : [])).toThrow();

    expect(readSequencer(repo)).toBe('merge');
    expect((await resolveSequencer(repo, 'merge', 'abort')).ok).toBe(true);
    expect(readSequencer(repo)).toBe('none');
    expect(git('log', '-1', '--format=%s')).toBe('main changes b');
  });

  it('refuses the branch checked out, a branch that is gone, and a detached HEAD', async () => {
    expect((await planMerge(repo, 'refs/heads/main', 'merge')).ok).toBe(false);
    expect((await planMerge(repo, 'refs/heads/nowhere', 'merge')).ok).toBe(false);

    git('checkout', '--detach', 'HEAD');
    const refs = await readRefs(repo);
    expect(refs.some((ref) => ref.current)).toBe(false);
    expect((await planMerge(repo, 'refs/remotes/origin/main', 'merge')).ok).toBe(false);
  });

  it('refuses a branch whose name a tag also has, which git would resolve to the tag', async () => {
    git('checkout', '-b', 'feat');
    commit('f.ts', 'const f = 1;\n', 'feat');
    git('tag', 'feat', 'HEAD~1');
    git('checkout', 'main');

    const plan = await planMerge(repo, 'refs/heads/feat', 'merge');

    expect(plan.ok).toBe(false);
    expect('message' in plan ? plan.message : '').toContain('ambiguous');
  });

  it('refuses a tag, which is not a branch to merge from this menu', async () => {
    git('tag', 'v1');
    git('checkout', '-b', 'other');

    expect((await planMerge(repo, 'refs/tags/v1', 'merge')).ok).toBe(false);
  });
});
