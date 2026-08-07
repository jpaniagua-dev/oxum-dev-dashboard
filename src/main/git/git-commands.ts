import type {
  GitBranch,
  GitChange,
  GitCommit,
  GitDiff,
  GitDiffTarget,
  GitRepoState,
  GitResult,
  GitSyncOp,
  Project,
} from '@shared/contracts.js';
import { readUpstream } from './git-service.js';
import {
  FIELD_SEPARATOR as SEP,
  parseBranchLines,
  parseLogLines,
  parseStatusZ,
  parseUnifiedDiff,
} from './git-parse.js';
import {
  GIT_NETWORK_TIMEOUT_MS,
  describeGitError,
  git,
  gitDiffOutput,
  tryGit,
} from './run-git.js';

/**
 * How many commits the history column shows.
 *
 * A window, not the whole log: the column is a few hundred pixels tall and reading ten thousand
 * commits to display forty of them is work nobody asked for. Raising it costs one number.
 */
const LOG_LIMIT = 60;

/* ------------------------------------------------------------------ reads */

/**
 * Everything the Git tab shows for one repository, in a single pass.
 *
 * The four reads run concurrently because none depends on another and they are all local: doing them
 * in sequence would make the tab's refresh four round trips long for no benefit.
 *
 * A failure of the whole thing degrades to a state carrying the message rather than throwing. The
 * folder may simply not be a repository, which is a normal row in this app, not an exception.
 */
export async function readRepoState(project: Project): Promise<GitRepoState> {
  const empty = {
    projectId: project.id,
    label: project.label,
    path: project.path,
    branches: [] as GitBranch[],
    changes: [] as GitChange[],
    commits: [] as GitCommit[],
  };

  try {
    const [branches, changes, commits, upstream] = await Promise.all([
      readBranches(project.path),
      readChanges(project.path),
      readCommits(project.path),
      readUpstream(project.path),
    ]);

    const current = branches.find((branch) => branch.current);
    return {
      ...empty,
      branches,
      changes,
      commits,
      // The current branch comes from the branch list when there is one, and from HEAD otherwise:
      // a detached HEAD matches no entry in `refs/heads`, and reporting an empty name there would
      // make the tab look broken rather than detached.
      branch: current?.name ?? (await readHead(project.path)),
      ahead: upstream.ahead,
      behind: upstream.behind,
      hasUpstream: upstream.hasUpstream,
      checkedAt: new Date().toISOString(),
      error: null,
    };
  } catch (error) {
    return {
      ...empty,
      branch: '?',
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      checkedAt: null,
      error: describeGitError(error),
    };
  }
}

/** Local branches, most recently committed first. */
export async function readBranches(repoPath: string): Promise<GitBranch[]> {
  const format = [
    '%(refname:short)',
    '%(HEAD)',
    '%(upstream:short)',
    '%(upstream:track)',
    '%(committerdate:iso-strict)',
  ].join(SEP);
  // Sorted by git rather than by us: `-committerdate` is exactly "the branches I have touched
  // lately", which is the order a branch list is actually searched in.
  const out = await git(repoPath, [
    'for-each-ref',
    '--sort=-committerdate',
    `--format=${format}`,
    'refs/heads',
  ]);
  return parseBranchLines(out);
}

/** Changed files, staged and unstaged alike. */
export async function readChanges(repoPath: string): Promise<GitChange[]> {
  // `-z` for raw paths, `-uall` so a new folder lists its files instead of collapsing to `folder/`:
  // a single untracked entry that cannot be diffed or staged individually is not actionable.
  const out = await git(repoPath, ['status', '--porcelain', '-z', '-uall']);
  return parseStatusZ(out);
}

/** The last commits of the current branch. */
export async function readCommits(repoPath: string): Promise<GitCommit[]> {
  const format = ['%h', '%an', '%aI', '%D', '%s'].join(SEP);
  const out = await git(repoPath, ['log', `-n${LOG_LIMIT}`, `--format=${format}`]);
  return parseLogLines(out);
}

/**
 * Reads the diff the tab is asking for.
 *
 * The three cases are genuinely different commands, which is why the target is a union rather than
 * a set of optional flags:
 * - a **staged** file is `--cached`, the index against HEAD;
 * - an **untracked** file has no diff at all, so it is compared against `/dev/null` with
 *   `--no-index`, which is the only way to see the contents of a file git does not know yet;
 * - a **commit** is `git show`, its own message stripped so the column shows changes and not prose.
 */
export async function readDiff(repoPath: string, target: GitDiffTarget): Promise<GitDiff> {
  try {
    if (target.kind === 'commit') {
      const out = await gitDiffOutput(repoPath, [
        'show',
        '--format=',
        '--no-color',
        target.sha,
      ]);
      return buildDiff(target.sha, out);
    }

    if (target.staged) {
      const out = await gitDiffOutput(repoPath, [
        'diff',
        '--cached',
        '--no-color',
        '--',
        target.path,
      ]);
      return buildDiff(target.path, out);
    }

    const out = await gitDiffOutput(repoPath, ['diff', '--no-color', '--', target.path]);
    if (out.trim().length > 0) {
      return buildDiff(target.path, out);
    }
    // Empty means one of two things: nothing changed, or git has never heard of this file. Only the
    // second is worth another call, and `--no-index` is what makes an untracked file readable.
    return buildDiff(target.path, await readUntrackedDiff(repoPath, target.path));
  } catch (error) {
    return { title: describeTarget(target), lines: [], note: describeGitError(error) };
  }
}

/**
 * Diffs an untracked file against nothing.
 *
 * `git diff --no-index` **exits 1 whenever it finds a difference**, which is its documented
 * behaviour and not a failure: it is meant to be used as a test. Letting the thrown error through
 * would report every untracked file as an error, so the output is taken off the rejection instead.
 */
async function readUntrackedDiff(repoPath: string, path: string): Promise<string> {
  try {
    return await gitDiffOutput(repoPath, [
      'diff',
      '--no-index',
      '--no-color',
      '--',
      '/dev/null',
      path,
    ]);
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    return typeof stdout === 'string' ? stdout : '';
  }
}

/* ----------------------------------------------------------------- writes */

/**
 * Creates a branch, and switches to it unless told otherwise.
 *
 * The name is validated by `git check-ref-format` rather than by a pattern of ours. git's rules are
 * more subtle than they look (no `..`, no trailing `.lock`, no `@{`, no leading dash) and a regex
 * that approximates them either rejects a legal name or lets git fail later with a message about
 * something else.
 */
export async function createBranch(
  repoPath: string,
  name: string,
  checkout: boolean,
): Promise<GitResult> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'Nom de branche vide' };
  }

  const valid = await tryGit(repoPath, ['check-ref-format', '--branch', trimmed]);
  if (!valid.ok) {
    return { ok: false, message: `Nom de branche invalide : ${trimmed}` };
  }

  const result = checkout
    ? await tryGit(repoPath, ['checkout', '-b', trimmed])
    : await tryGit(repoPath, ['branch', trimmed]);
  return {
    ok: result.ok,
    message: result.ok ? `Branche ${trimmed} créée` : result.message,
  };
}

/**
 * Switches branch.
 *
 * Nothing is stashed and nothing is forced. A checkout that would overwrite local changes fails, and
 * git's own message says which files are in the way — which is the honest outcome for a tab that has
 * no conflict resolution to offer. The alternative, an automatic stash, moves work somewhere the
 * user did not ask for and did not watch.
 */
export async function checkoutBranch(repoPath: string, name: string): Promise<GitResult> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'Aucune branche indiquée' };
  }
  const result = await tryGit(repoPath, ['checkout', trimmed]);
  return { ok: result.ok, message: result.ok ? `Sur la branche ${trimmed}` : result.message };
}

/**
 * Stages or unstages paths.
 *
 * `--` before the paths is not decoration: without it a file literally named `-f`, or a path that
 * happens to match a branch name, is read by git as an option or a revision. The separator is what
 * makes a path always a path.
 */
export async function stagePaths(
  repoPath: string,
  paths: readonly string[],
  staged: boolean,
): Promise<GitResult> {
  if (paths.length === 0) {
    return { ok: false, message: 'Aucun fichier sélectionné' };
  }

  const result = staged
    ? await tryGit(repoPath, ['add', '--', ...paths])
    : await tryGit(repoPath, ['restore', '--staged', '--', ...paths]);

  const count = paths.length;
  return {
    ok: result.ok,
    message: result.ok
      ? `${count} fichier${count > 1 ? 's' : ''} ${staged ? 'ajouté' : 'retiré'}${count > 1 ? 's' : ''}`
      : result.message,
  };
}

/**
 * Runs one of the three network operations.
 *
 * They share a handler because they share everything that matters: a long timeout, an outcome that
 * is only knowable from git's own message, and no state of ours to update beyond re-reading.
 *
 * `pull` is deliberately `--ff-only`. A merge or a rebase can stop halfway on a conflict, and this
 * tab has nothing to offer someone standing in a half-finished rebase; refusing to start one is the
 * only outcome it can honestly explain. Diverged branches are a terminal's business.
 *
 * `push` gains `-u origin <branch>` when the branch has no upstream, which is the first push of any
 * new branch and the one case where a bare `push` fails with advice instead of doing the obvious.
 */
export async function sync(
  repoPath: string,
  op: GitSyncOp,
  branch: string,
  hasUpstream: boolean,
): Promise<GitResult> {
  const options = { timeoutMs: GIT_NETWORK_TIMEOUT_MS };

  if (op === 'fetch') {
    const result = await tryGit(repoPath, ['fetch', '--prune'], options);
    return { ok: result.ok, message: result.ok ? 'Fetch terminé' : result.message };
  }

  if (op === 'pull') {
    const result = await tryGit(repoPath, ['pull', '--ff-only'], options);
    return { ok: result.ok, message: result.message };
  }

  const args = hasUpstream ? ['push'] : ['push', '-u', 'origin', branch];
  const result = await tryGit(repoPath, args, options);
  return { ok: result.ok, message: result.message };
}

/* ------------------------------------------------------------------ inner */

/** The branch HEAD points at, or a short sha when it points at no branch. */
async function readHead(repoPath: string): Promise<string> {
  const out = (await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (out !== 'HEAD') {
    return out;
  }
  return `detached@${(await git(repoPath, ['rev-parse', '--short', 'HEAD'])).trim()}`;
}

function buildDiff(title: string, out: string): GitDiff {
  const lines = parseUnifiedDiff(out);
  const content = lines.some((line) => line.kind === 'add' || line.kind === 'del');

  if (out.includes('Binary files ')) {
    return { title, lines: [], note: 'Fichier binaire, pas de diff à afficher.' };
  }
  if (!content && lines.length === 0) {
    return { title, lines: [], note: 'Aucune modification à afficher.' };
  }
  return { title, lines, note: null };
}

function describeTarget(target: GitDiffTarget): string {
  return target.kind === 'commit' ? target.sha : target.path;
}
