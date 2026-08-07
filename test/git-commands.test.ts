import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeCommitMessage } from '../src/main/git/commit-message.js';
import {
  checkoutBranch,
  createBranch,
  readBranches,
  readChanges,
  readCommits,
  readDiff,
  readRepoState,
  stagePaths,
} from '../src/main/git/git-commands.js';
import type { Project } from '../src/shared/contracts.js';

/**
 * These run against a **real repository**, unlike the parser tests next door.
 *
 * The parsers are checked on fixed strings, which proves they read the format correctly but proves
 * nothing about whether that is the format git actually prints. Every bug this file has caught so far
 * was of the second kind: a `--format` placeholder that does not exist, an exit code that means
 * something other than failure. A temporary repository is cheap and it is the only thing that can
 * tell the two apart.
 */

let repo = '';

function run(args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'pipe' });
}

function write(name: string, content: string): void {
  writeFileSync(join(repo, name), content, 'utf8');
}

function project(): Project {
  return { id: 'fixture', label: 'Fixture', path: repo, actions: [], kind: 'server', expectedPort: null };
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'oxum-git-'));
  execFileSync('git', ['init', '-b', 'main', repo], { windowsHide: true, stdio: 'pipe' });
  // Set locally rather than relying on the machine's config: a CI runner has no identity, and
  // `commit` refuses to run without one.
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);

  write('kept.ts', 'const kept = 1;\n');
  run(['add', '.']);
  run(['commit', '-m', 'feat: premier commit']);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('readRepoState', () => {
  it('reads the branch, the history and a clean working tree', async () => {
    const state = await readRepoState(project());

    expect(state.error).toBeNull();
    expect(state.branch).toBe('main');
    expect(state.changes).toEqual([]);
    expect(state.commits[0]?.subject).toBe('feat: premier commit');
    // No remote in a fresh repository, which must read as a normal state and not as a failure.
    expect(state.hasUpstream).toBe(false);
  });

  it('degrades to an error state on a folder that is not a repository', async () => {
    const state = await readRepoState({ ...project(), path: tmpdir() });

    expect(state.error).not.toBeNull();
    expect(state.branch).toBe('?');
  });
});

describe('readChanges and staging', () => {
  it('separates what is staged from what is only on disk', async () => {
    write('kept.ts', 'const kept = 2;\n');
    write('added.ts', 'const added = 1;\n');

    const before = await readChanges(repo);
    expect(before.find((change) => change.path === 'kept.ts')).toMatchObject({
      index: ' ',
      worktree: 'M',
    });
    expect(before.find((change) => change.path === 'added.ts')?.untracked).toBe(true);

    expect(await stagePaths(repo, ['kept.ts'], true)).toMatchObject({ ok: true });

    const after = await readChanges(repo);
    expect(after.find((change) => change.path === 'kept.ts')).toMatchObject({
      index: 'M',
      worktree: ' ',
    });
  });

  it('unstages what it staged', async () => {
    expect(await stagePaths(repo, ['kept.ts'], false)).toMatchObject({ ok: true });
    expect((await readChanges(repo)).find((change) => change.path === 'kept.ts')).toMatchObject({
      index: ' ',
    });
  });

  it('refuses an empty selection rather than staging everything', async () => {
    // `git add --` with no path is not an error for git, so the guard has to be ours.
    expect(await stagePaths(repo, [], true)).toMatchObject({ ok: false });
  });
});

describe('readDiff', () => {
  it('reads a modified tracked file', async () => {
    const diff = await readDiff(repo, { kind: 'file', path: 'kept.ts', staged: false });

    expect(diff.note).toBeNull();
    expect(diff.lines.some((line) => line.kind === 'add' && line.text.includes('const kept = 2'))).toBe(
      true,
    );
  });

  it('reads an untracked file, whose diff exits non-zero by design', async () => {
    // `git diff --no-index` exits 1 as soon as it finds a difference. Treated as a failure, every new
    // file in the tab would show an error instead of its contents.
    const diff = await readDiff(repo, { kind: 'file', path: 'added.ts', staged: false });

    expect(diff.note).toBeNull();
    expect(diff.lines.some((line) => line.kind === 'add' && line.text.includes('const added'))).toBe(
      true,
    );
  });

  it('reads a whole commit', async () => {
    const [commit] = await readCommits(repo);
    const diff = await readDiff(repo, { kind: 'commit', sha: commit?.sha ?? '' });

    expect(diff.lines.some((line) => line.text.includes('const kept = 1'))).toBe(true);
    // `--format=` strips the message: the column shows changes, and the subject is already in the row.
    expect(diff.lines.some((line) => line.text.includes('feat: premier commit'))).toBe(false);
  });

  it('says why there is nothing rather than showing an empty pane', async () => {
    const diff = await readDiff(repo, { kind: 'file', path: 'kept.ts', staged: true });

    expect(diff.lines).toEqual([]);
    expect(diff.note).not.toBeNull();
  });
});

describe('the commit path', () => {
  /*
   * The commit itself runs in a terminal tab, so no test can drive the button. What *can* be proven,
   * and is where the risk actually is, is that the argv the tab is handed produces the intended
   * commit: the message reaching git as bytes on disk rather than as a command-line argument is the
   * whole reason for the file, and encoding and `--cleanup` are exactly what a `-m` flag would have
   * got wrong.
   */
  it('commits a multi-line message written by writeCommitMessage', async () => {
    write('committed.ts', 'const x = 1;\n');
    run(['add', 'committed.ts']);

    const message = 'feat: accentué et multi-ligne\n\nUn corps avec un « détail ».\n\n\n';
    const file = await writeCommitMessage(join(repo, '.messages'), 'fixture', message);

    execFileSync('git', ['-C', repo, 'commit', '--cleanup=strip', '-F', file], {
      windowsHide: true,
      stdio: 'pipe',
    });

    const [commit] = await readCommits(repo);
    // Accents survive: the file is UTF-8 with no BOM, which is what git assumes for a message.
    expect(commit?.subject).toBe('feat: accentué et multi-ligne');

    const body = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%b'], {
      windowsHide: true,
      encoding: 'utf8',
    });
    expect(body).toContain('Un corps avec un « détail ».');
    // `--cleanup=strip` plus the store's own trim: no trailing blank lines survive.
    expect(body.endsWith('\n\n\n')).toBe(false);
  });

  it('accepts a subject starting with a dash, which -m could not', async () => {
    // The reason a file is used rather than an argument: git would read this as an option.
    write('dashed.ts', 'const y = 1;\n');
    run(['add', 'dashed.ts']);

    const file = await writeCommitMessage(join(repo, '.messages'), 'fixture', '--force is not a flag');
    execFileSync('git', ['-C', repo, 'commit', '--cleanup=strip', '-F', file], {
      windowsHide: true,
      stdio: 'pipe',
    });

    expect((await readCommits(repo))[0]?.subject).toBe('--force is not a flag');
  });

  it('keeps a project id from walking out of the folder', async () => {
    const file = await writeCommitMessage(join(repo, '.messages'), '../../escaped', 'x');

    expect(file.includes('..')).toBe(false);
  });
});

describe('branches', () => {
  it('creates a branch and switches to it', async () => {
    expect(await createBranch(repo, 'PROJ-1234-essai', true)).toMatchObject({ ok: true });

    const branches = await readBranches(repo);
    expect(branches.find((branch) => branch.current)?.name).toBe('PROJ-1234-essai');
    // No remote, so no upstream: the state a branch is in before its first push.
    expect(branches.find((branch) => branch.current)?.upstream).toBeNull();
  });

  it('rejects a name git itself considers invalid', async () => {
    // Validation is delegated to `check-ref-format` rather than to a pattern of ours: `..` is illegal
    // in a ref and a hand-written regex is the kind of thing that lets it through.
    expect(await createBranch(repo, 'mauvais..nom', true)).toMatchObject({ ok: false });
    expect(await createBranch(repo, '   ', true)).toMatchObject({ ok: false });
  });

  it('switches back and reports the failure of a branch that does not exist', async () => {
    expect(await checkoutBranch(repo, 'main')).toMatchObject({ ok: true });
    expect((await readBranches(repo)).find((branch) => branch.current)?.name).toBe('main');

    const missing = await checkoutBranch(repo, 'jamais-creee');
    expect(missing.ok).toBe(false);
    // git's own words, not ours: they say what to do next.
    expect(missing.message.length).toBeGreaterThan(0);
  });
});
