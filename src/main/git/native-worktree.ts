import { lstat, mkdir, rmdir, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { branchNameFor } from '@shared/branch-name.js';
import type { GitResult } from '@shared/contracts.js';
import { spawnOffThread } from '../spawn/spawn-pool.js';
import { GIT_NETWORK_TIMEOUT_MS, tryGit } from './run-git.js';
import { isTicketLabel, sanitizeDescription } from './worktree-command.js';

/**
 * Worktrees made by the app itself, for a machine without the author's `wt` shell helper.
 *
 * The rules are the helper's, ported rather than reinvented, because they are what makes a
 * worktree cheap and safe: a branch from the remote's default branch, a `<LABEL>-<repo>` folder,
 * `node_modules` as a junction to the main checkout (seconds instead of an `npm install`), and on
 * removal the junction taken out **before** `git worktree remove`, which otherwise leaves it behind
 * or, through a recursive delete, empties the shared `node_modules` it points at. The helper stays
 * available behind the `worktreeHelper` setting; this is what everybody else gets.
 *
 * Unlike the helper this runs no terminal tab: each step is a git call with an argument array, and
 * the outcome is one line in the strip, the rule the Git tab follows for a quick write.
 */

/** Where the worktrees of a repository go: the setting, or a `worktrees` folder beside the clone. */
export function worktreesRootFor(configured: string, repoPath: string): string {
  const root = configured.trim();
  return root.length > 0 ? root : join(dirname(resolve(repoPath)), 'worktrees');
}

function kebab(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The folder and branch a label stands for, or why there are none.
 *
 * A ticket key (`PROJ-123`) names the folder `PROJ-123-<repo>` and the branch
 * `PROJ-123-<description>`, and needs the description. Anything else is a slug: folder
 * `wip-<slug>-<repo>`, branch `wip/<slug>`, renamed once a ticket number exists.
 */
export function planWorktree(
  label: string,
  description: string,
  repoFolder: string,
): { folder: string; branch: string } | { error: string } {
  const trimmed = label.trim();
  if (isTicketLabel(trimmed)) {
    const key = trimmed.toUpperCase();
    const text = sanitizeDescription(description);
    if (kebab(text).length === 0) {
      return { error: `A ticket worktree needs a description: ${key} <what it is about>` };
    }
    return { folder: `${key}-${repoFolder}`, branch: branchNameFor(key, text) };
  }
  const slug = kebab(trimmed);
  if (slug.length === 0) {
    return { error: 'That label leaves nothing to name a branch with' };
  }
  return { folder: `wip-${slug}-${repoFolder}`, branch: `wip/${slug}` };
}

/** The folder a renamed worktree moves to, and the branch it takes when a ticket number arrives. */
export function planRename(
  newLabel: string,
  repoFolder: string,
  currentBranch: string,
): { folder: string; branch: string | null } | { error: string } {
  const trimmed = newLabel.trim();
  if (isTicketLabel(trimmed)) {
    const key = trimmed.toUpperCase();
    return {
      folder: `${key}-${repoFolder}`,
      branch: currentBranch.startsWith('wip/') ? `${key}-${currentBranch.slice('wip/'.length)}` : null,
    };
  }
  const slug = kebab(trimmed);
  return slug.length === 0 ? { error: 'That label leaves nothing to name with' } : { folder: `wip-${slug}-${repoFolder}`, branch: null };
}

/**
 * Whether a removal failed on a lock rather than on work.
 *
 * Two failures with opposite answers: uncommitted work is what discarding exists for, a file held
 * open by an editor or a dev server is not, and discarding cannot release a handle anyway.
 */
export function isLockFailure(message: string): boolean {
  return /permission denied|failed to delete|device or resource busy|another process/i.test(message);
}

/** The remote's default branch, as `origin/<name>`. */
async function defaultRef(repoPath: string): Promise<string> {
  const head = await tryGit(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.stdout.trim().length > 0) {
    return head.stdout.trim();
  }
  const main = await tryGit(repoPath, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
  return main.ok ? 'origin/main' : 'origin/master';
}

async function isLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Links the main checkout's `node_modules` into a worktree. Says so when there is none to link. */
async function linkNodeModules(repoPath: string, worktree: string): Promise<string> {
  const source = join(repoPath, 'node_modules');
  const target = join(worktree, 'node_modules');
  if (!(await exists(source))) {
    return '';
  }
  if (await exists(target)) {
    return '';
  }
  try {
    await symlink(source, target, 'junction');
    return ', node_modules linked';
  } catch {
    return ', node_modules could not be linked';
  }
}

/** Takes the junction out, never its target. A real folder is left alone. */
async function unlinkNodeModules(worktree: string): Promise<void> {
  const target = join(worktree, 'node_modules');
  if (await isLink(target)) {
    await unlink(target).catch(() => rmdir(target));
  }
}

export async function createWorktree(
  repoPath: string,
  root: string,
  label: string,
  description: string,
): Promise<GitResult & { path?: string }> {
  const plan = planWorktree(label, description, basename(repoPath));
  if ('error' in plan) {
    return { ok: false, message: plan.error };
  }
  const target = join(root, plan.folder);
  if (await exists(target)) {
    return { ok: false, message: `${target} already exists` };
  }
  await mkdir(root, { recursive: true });
  await tryGit(repoPath, ['fetch', 'origin', '--quiet'], { timeoutMs: GIT_NETWORK_TIMEOUT_MS });
  const base = await defaultRef(repoPath);
  const added = await tryGit(repoPath, ['worktree', 'add', target, '-b', plan.branch, base], {
    timeoutMs: GIT_NETWORK_TIMEOUT_MS,
  });
  if (!added.ok) {
    return { ok: false, message: added.message };
  }
  const linked = await linkNodeModules(repoPath, target);
  return { ok: true, message: `${plan.folder} created on ${plan.branch} from ${base}${linked}`, path: target };
}

/**
 * Checks a pull request out beside the clone, to look at it.
 *
 * Three cases, the helper's: a fork's pull request has no branch on origin, so it is fetched from
 * `refs/pull/<n>/head` and checked out detached; a branch that already exists locally is checked
 * out detached at `origin/<branch>` so nobody's local work is moved; otherwise a tracking branch.
 */
export async function pullWorktree(
  repoPath: string,
  root: string,
  number: number,
): Promise<GitResult & { path?: string }> {
  const folder = `pr-${number}-${basename(repoPath)}`;
  const target = join(root, folder);
  if (await exists(target)) {
    return { ok: true, message: `${folder} already exists`, path: target };
  }
  let meta: { headRefName?: unknown; isCrossRepository?: unknown };
  try {
    const { stdout } = await spawnOffThread({
      file: 'gh',
      args: ['pr', 'view', String(number), '--json', 'headRefName,isCrossRepository'],
      cwd: repoPath,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    meta = JSON.parse(stdout) as typeof meta;
  } catch {
    return { ok: false, message: `gh could not read pull request #${number}. Is gh signed in?` };
  }
  const branch = typeof meta.headRefName === 'string' ? meta.headRefName : '';
  if (branch.length === 0) {
    return { ok: false, message: `Pull request #${number} has no head branch to check out` };
  }
  await mkdir(root, { recursive: true });
  const options = { timeoutMs: GIT_NETWORK_TIMEOUT_MS };
  let added;
  if (meta.isCrossRepository === true) {
    const fetched = await tryGit(repoPath, ['fetch', 'origin', `refs/pull/${number}/head`, '--quiet'], options);
    if (!fetched.ok) {
      return { ok: false, message: fetched.message };
    }
    added = await tryGit(repoPath, ['worktree', 'add', '--detach', target, 'FETCH_HEAD'], options);
  } else {
    const fetched = await tryGit(repoPath, ['fetch', 'origin', branch, '--quiet'], options);
    if (!fetched.ok) {
      return { ok: false, message: fetched.message };
    }
    const local = await tryGit(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    added = local.ok
      ? await tryGit(repoPath, ['worktree', 'add', '--detach', target, `origin/${branch}`], options)
      : await tryGit(repoPath, ['worktree', 'add', target, '-b', branch, `origin/${branch}`], options);
  }
  if (!added.ok) {
    return { ok: false, message: added.message };
  }
  const linked = await linkNodeModules(repoPath, target);
  return { ok: true, message: `${folder} checked out${linked}`, path: target };
}

export async function renameWorktree(
  repoPath: string,
  worktree: { path: string; branch: string },
  root: string,
  newLabel: string,
): Promise<GitResult> {
  const plan = planRename(newLabel, basename(repoPath), worktree.branch);
  if ('error' in plan) {
    return { ok: false, message: plan.error };
  }
  const target = join(root, plan.folder);
  if (await exists(target)) {
    return { ok: false, message: `${target} already exists` };
  }
  await mkdir(root, { recursive: true });
  await unlinkNodeModules(worktree.path);
  const moved = await tryGit(repoPath, ['worktree', 'move', worktree.path, target]);
  if (!moved.ok) {
    await linkNodeModules(repoPath, worktree.path);
    return {
      ok: false,
      message: `${moved.message}. Close editors or terminals holding the folder, then retry`,
    };
  }
  let renamed = '';
  if (plan.branch !== null) {
    const branch = await tryGit(repoPath, ['branch', '-m', worktree.branch, plan.branch]);
    renamed = branch.ok ? `, branch ${plan.branch}` : `, branch rename failed: ${branch.message}`;
  }
  await linkNodeModules(repoPath, target);
  return { ok: true, message: `Moved to ${plan.folder}${renamed}` };
}

export async function removeWorktree(
  repoPath: string,
  worktree: { path: string; branch: string },
  options: { discardChanges: boolean; deleteBranch: boolean },
): Promise<GitResult> {
  // Order matters: `git worktree remove` would leave the junction behind, and a recursive delete
  // would walk into it and empty the shared `node_modules`.
  await unlinkNodeModules(worktree.path);
  const removed = await tryGit(repoPath, [
    'worktree',
    'remove',
    ...(options.discardChanges ? ['--force'] : []),
    worktree.path,
  ]);
  if (!removed.ok) {
    await linkNodeModules(repoPath, worktree.path);
    return {
      ok: false,
      message: isLockFailure(removed.message)
        ? 'The folder is locked, not dirty: close whatever holds it (an editor, a terminal, a dev server), then retry'
        : `${removed.message}. Check the work in it, then remove it again discarding the changes`,
    };
  }
  await tryGit(repoPath, ['worktree', 'prune']);
  let branch = '';
  if (options.deleteBranch && worktree.branch.length > 0 && worktree.branch !== 'HEAD') {
    const deleted = await tryGit(repoPath, ['branch', '-d', worktree.branch]);
    branch = deleted.ok ? `, branch ${worktree.branch} deleted` : `, branch ${worktree.branch} kept: not merged`;
  }
  return { ok: true, message: `Removed ${basename(worktree.path)}${branch}` };
}
