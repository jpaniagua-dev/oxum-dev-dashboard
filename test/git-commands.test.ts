import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeCommitMessage } from '../src/main/git/commit-message.js';
import {
  applyStash,
  checkoutBranch,
  cherryPick,
  createBranch,
  readBranches,
  readChanges,
  readCommits,
  readDiff,
  readHeadMessage,
  readRepoState,
  readSequencer,
  readStashes,
  resolveSequencer,
  stagePaths,
  stashPush,
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
    // The full HEAD message rides along, for the amend form to pre-fill.
    expect(state.headMessage).toBe('feat: premier commit');
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

    const message = 'feat: accented and multi-line\n\nA body with a « détail » in it.\n\n\n';
    const file = await writeCommitMessage(join(repo, '.messages'), 'fixture', message);

    execFileSync('git', ['-C', repo, 'commit', '--cleanup=strip', '-F', file], {
      windowsHide: true,
      stdio: 'pipe',
    });

    const [commit] = await readCommits(repo);
    // Accents survive: the file is UTF-8 with no BOM, which is what git assumes for a message.
    expect(commit?.subject).toBe('feat: accented and multi-line');

    const body = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%b'], {
      windowsHide: true,
      encoding: 'utf8',
    });
    expect(body).toContain('A body with a « détail » in it.');
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

  it('amends HEAD with the same file mechanism, folding the staged changes in', async () => {
    // The exact argv the Amend button hands to the terminal tab. Everything the plain commit test
    // proves about the file (encoding, --cleanup, dashed subjects) holds by construction; what an
    // amend adds is the rewrite itself, so that is what is asserted: same commit count, new
    // message, extra file folded into HEAD.
    write('amended.ts', 'const z = 1;\n');
    run(['add', 'amended.ts']);
    run(['commit', '-m', 'feat: before amend']);
    const countBefore = (await readCommits(repo)).length;

    write('folded.ts', 'const f = 1;\n');
    run(['add', 'folded.ts']);
    const message = 'feat: after amend\n\nThe body survives the round trip.\n';
    const file = await writeCommitMessage(join(repo, '.messages'), 'fixture', message);
    execFileSync('git', ['-C', repo, 'commit', '--amend', '--cleanup=strip', '-F', file], {
      windowsHide: true,
      stdio: 'pipe',
    });

    expect((await readCommits(repo)).length).toBe(countBefore);
    // `%B` carries subject and body: pre-filling with `commits[0].subject` alone would have lost
    // the body of the commit being amended.
    expect(await readHeadMessage(repo)).toBe(
      'feat: after amend\n\nThe body survives the round trip.',
    );
    const shown = execFileSync('git', ['-C', repo, 'show', '--stat', '--format=', 'HEAD'], {
      windowsHide: true,
      encoding: 'utf8',
    });
    expect(shown).toContain('amended.ts');
    expect(shown).toContain('folded.ts');
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

    const missing = await checkoutBranch(repo, 'never-created');
    expect(missing.ok).toBe(false);
    // git's own words, not ours: they say what to do next.
    expect(missing.message.length).toBeGreaterThan(0);
  });
});

/**
 * A repository of its own for each of the two blocks below.
 *
 * The shared fixture above is mutated in order by its own tests, and both stash and cherry-pick care
 * about whether the working tree is clean — coupling them to whatever the previous block left behind
 * would make a failure here mean "something changed upstairs" rather than "this is broken".
 */
function freshRepo(): string {
  const path = mkdtempSync(join(tmpdir(), 'oxum-git-'));
  execFileSync('git', ['init', '-b', 'main', path], { windowsHide: true, stdio: 'pipe' });
  const local = (args: string[]): void => {
    execFileSync('git', ['-C', path, ...args], { windowsHide: true, stdio: 'pipe' });
  };
  local(['config', 'user.email', 'test@example.com']);
  local(['config', 'user.name', 'Test']);
  writeFileSync(join(path, 'base.ts'), 'const base = 1;\n', 'utf8');
  local(['add', '.']);
  local(['commit', '-m', 'feat: base']);
  return path;
}

describe('stashes', () => {
  let sandbox = '';
  const local = (args: string[]): void => {
    execFileSync('git', ['-C', sandbox, ...args], { windowsHide: true, stdio: 'pipe' });
  };

  beforeAll(() => {
    sandbox = freshRepo();
  });
  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('has no stash ref at all on a fresh repository, and says so without failing', async () => {
    // `git stash list` on a repository that never stashed exits 0 with nothing, but the read is
    // wrapped anyway: this is the case that must never surface as an error in the view.
    expect(await readStashes(sandbox)).toEqual([]);
  });

  it('creates a named stash and leaves the working tree clean', async () => {
    writeFileSync(join(sandbox, 'base.ts'), 'const base = 2;\n', 'utf8');

    expect(await stashPush(sandbox, 'essai', false)).toMatchObject({ ok: true });
    expect(await readChanges(sandbox)).toEqual([]);

    const [entry] = await readStashes(sandbox);
    expect(entry?.ref).toBe('stash@{0}');
    // The branch is read out of git's own `On main: essai`, there being no placeholder for it.
    expect(entry?.branch).toBe('main');
    expect(entry?.subject).toBe('essai');
    // A real sha, which is what every write below resolves against.
    expect(entry?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reads a stash diff with `stash show`, which `git show` cannot do for a merge commit', async () => {
    const [entry] = await readStashes(sandbox);
    const diff = await readDiff(sandbox, {
      kind: 'stash',
      sha: entry?.sha ?? '',
      ref: entry?.ref ?? '',
    });

    expect(diff.note).toBeNull();
    expect(diff.lines.some((line) => line.kind === 'add' && line.text.includes('const base = 2'))).toBe(
      true,
    );
  });

  it('leaves untracked files behind unless asked, which is the whole point of the switch', async () => {
    // A tracked change *and* a new file, because that is the only pair that tells the two behaviours
    // apart: with untracked files alone, `git stash` saves nothing at all and still exits 0.
    writeFileSync(join(sandbox, 'base.ts'), 'const base = 3;\n', 'utf8');
    writeFileSync(join(sandbox, 'neuf.ts'), 'const neuf = 1;\n', 'utf8');

    await stashPush(sandbox, 'without the new ones', false);
    expect((await readChanges(sandbox)).map((change) => change.path)).toEqual(['neuf.ts']);

    await stashPush(sandbox, 'with the new ones', true);
    expect(await readChanges(sandbox)).toEqual([]);
  });

  it('applies a stash by sha even after the positions have shifted', async () => {
    /*
     * The regression this whole sha business exists for. Three stashes are on the list and the oldest
     * one — created first, so now `stash@{2}` — is applied by its sha. A code path trusting the ref it
     * was first read under (`stash@{0}`) would apply the newest instead, silently.
     */
    const stashes = await readStashes(sandbox);
    expect(stashes).toHaveLength(3);
    const oldest = stashes[stashes.length - 1];
    expect(oldest?.subject).toBe('essai');

    expect(await applyStash(sandbox, oldest?.sha ?? '', 'apply')).toMatchObject({ ok: true });
    // Its content is back, and `apply` kept the entry.
    expect((await readChanges(sandbox)).map((change) => change.path)).toEqual(['base.ts']);
    expect(await readStashes(sandbox)).toHaveLength(3);

    local(['checkout', '--', 'base.ts']);
  });

  it('refuses a sha that is no longer in the list rather than acting on a neighbour', async () => {
    // A list read before someone else dropped an entry is the realistic version of this, and the
    // wrong answer would be to drop whatever now sits at that position.
    const result = await applyStash(sandbox, '0'.repeat(40), 'drop');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('is gone');
  });

  it('pops and drops, each shortening the list by one', async () => {
    const before = await readStashes(sandbox);
    const top = before[0];

    expect(await applyStash(sandbox, top?.sha ?? '', 'pop')).toMatchObject({ ok: true });
    expect(await readStashes(sandbox)).toHaveLength(before.length - 1);

    local(['stash', 'push', '-m', 'jetable', '--include-untracked']);
    const [disposable] = await readStashes(sandbox);
    expect(await applyStash(sandbox, disposable?.sha ?? '', 'drop')).toMatchObject({ ok: true });
    expect(await readStashes(sandbox)).toHaveLength(before.length - 1);
  });
});

describe('cherry-pick', () => {
  let sandbox = '';
  const local = (args: string[]): void => {
    execFileSync('git', ['-C', sandbox, ...args], { windowsHide: true, stdio: 'pipe' });
  };

  beforeAll(() => {
    sandbox = freshRepo();
  });
  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('replays a commit from another branch onto the current one', async () => {
    local(['checkout', '-b', 'source']);
    writeFileSync(join(sandbox, 'apporte.ts'), 'const apporte = 1;\n', 'utf8');
    local(['add', '.']);
    local(['commit', '-m', 'feat: a reprendre']);
    const [source] = await readCommits(sandbox);
    local(['checkout', 'main']);

    expect(await cherryPick(sandbox, source?.sha ?? '', false)).toMatchObject({ ok: true });
    expect((await readCommits(sandbox))[0]?.subject).toBe('feat: a reprendre');
    expect(await readSequencer(sandbox)).toBe('none');
  });

  it('stages without committing under -n', async () => {
    local(['checkout', 'source']);
    writeFileSync(join(sandbox, 'apporte.ts'), 'const apporte = 2;\n', 'utf8');
    local(['add', '.']);
    local(['commit', '-m', 'feat: seconde passe']);
    const [source] = await readCommits(sandbox);
    local(['checkout', 'main']);

    expect(await cherryPick(sandbox, source?.sha ?? '', true)).toMatchObject({ ok: true });
    // In the index, and the branch tip has not moved.
    expect((await readChanges(sandbox)).map((change) => change.index)).toEqual(['M']);
    expect((await readCommits(sandbox))[0]?.subject).toBe('feat: a reprendre');

    /*
     * `-n` still records `CHERRY_PICK_HEAD`, so `git commit` can reuse the original message — which is
     * why the tab keeps reporting a cherry-pick in progress until you commit, and that is honest. The
     * marker is removed by hand rather than with `--quit`, whose behaviour with nothing in progress
     * varies by git version, and this cleanup must not be the thing that fails.
     */
    local(['reset', '--hard', 'HEAD']);
    rmSync(join(sandbox, '.git', 'CHERRY_PICK_HEAD'), { force: true });
  });

  it('refuses anything that is not a sha, having no `--` to hide behind', async () => {
    expect(await cherryPick(sandbox, '--help', false)).toMatchObject({ ok: false });
    expect(await cherryPick(sandbox, '', false)).toMatchObject({ ok: false });
  });

  it('reports a conflict as a state to get out of, and gets out of it', async () => {
    /*
     * The half of this feature that had to come with it. Two branches change the same line, so the
     * cherry-pick stops mid-flight: what matters is that the failure names the situation (rather than
     * repeating git's advice for a terminal), that the state is readable, and that `--abort` actually
     * puts the repository back.
     */
    local(['checkout', 'source']);
    writeFileSync(join(sandbox, 'base.ts'), 'const base = "source";\n', 'utf8');
    local(['add', '.']);
    local(['commit', '-m', 'feat: conflit']);
    const [conflicting] = await readCommits(sandbox);

    local(['checkout', 'main']);
    writeFileSync(join(sandbox, 'base.ts'), 'const base = "main";\n', 'utf8');
    local(['add', '.']);
    local(['commit', '-m', 'feat: divergence']);

    const result = await cherryPick(sandbox, conflicting?.sha ?? '', false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Conflict');
    expect(await readSequencer(sandbox)).toBe('cherry-pick');

    expect(await resolveSequencer(sandbox, 'cherry-pick', 'abort')).toMatchObject({ ok: true });
    expect(await readSequencer(sandbox)).toBe('none');
    expect(await readChanges(sandbox)).toEqual([]);
  });

  it('answers "nothing in progress" instead of running a --continue that would talk about something else', async () => {
    expect(await resolveSequencer(sandbox, 'none', 'continue')).toMatchObject({ ok: false });
  });

  it('finishes a conflicted cherry-pick without opening an editor', async () => {
    /*
     * `--continue` normally opens `core.editor` to confirm the message, and an editor opened by a
     * silent `execFile` never returns: the call would hang to its timeout with the repository still
     * mid-operation. `GIT_EDITOR=true` is what this asserts, and it can only be asserted by driving a
     * real conflict to its end.
     */
    // The very commit the previous test aborted, so the conflict is the same one and genuinely one:
    // `source` and `main` changed the same line from a shared ancestor.
    const conflicting = execFileSync('git', ['-C', sandbox, 'rev-parse', '--short', 'source'], {
      windowsHide: true,
      encoding: 'utf8',
    }).trim();

    expect(await cherryPick(sandbox, conflicting, false)).toMatchObject({ ok: false });
    expect(await readSequencer(sandbox)).toBe('cherry-pick');

    // Resolve it the way a user would, in the terminal this tab keeps sending them to.
    writeFileSync(join(sandbox, 'base.ts'), 'const base = "resolu";\n', 'utf8');
    local(['add', 'base.ts']);

    expect(await resolveSequencer(sandbox, 'cherry-pick', 'continue')).toMatchObject({ ok: true });
    expect(await readSequencer(sandbox)).toBe('none');
    expect(await readChanges(sandbox)).toEqual([]);
  });
});
