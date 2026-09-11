import { realpathSync } from 'node:fs';
import type { Project, RepoWorktrees, Worktree } from '@shared/contracts.js';
import { POLL_CONCURRENCY, mapWithLimit } from '../concurrency.js';
import { readGitState } from './git-service.js';
import { describeGitError, git } from './run-git.js';

/**
 * A worktree as its **registration** describes it, before any working tree has been read.
 *
 * Split from `Worktree` because these five fields are the ones `git worktree list` answers for every
 * state, including the states where there is nothing on disk left to read.
 */
export interface WorktreeEntry {
  readonly name: string;
  readonly path: string;
  readonly branch: string;
  readonly locked: string | null;
  readonly prunable: string | null;
}

/**
 * Parses `git worktree list --porcelain` and drops the main checkout.
 *
 * Pure and exported for testing, because two of its three rules are the kind that fail in silence:
 *
 * 1. **The main checkout is excluded by comparing paths**, and the comparison has to be normalised.
 *    git prints `C:/Users/x/projects/repo` with forward slashes while a configured project carries
 *    `C:\Users\x\projects\repo`: compared raw, no path ever matches its own repository and every
 *    project grows a phantom worktree row that is really itself. Case is folded too, this being a
 *    Windows-only app whose drive letter git spells as it was stored. Separators and case are all
 *    this function folds: resolving an alias needs the disk, so `mainPath` arrives already
 *    canonical from {@link canonicalPath}.
 * 2. **A record is one attribute per line, terminated by a blank line.** Only `worktree` opens a new
 *    record, so an unknown attribute is ignored rather than mistaken for the start of the next one.
 * 3. **`locked` and `prunable` come with or without a reason.** `locked` alone is a locked worktree,
 *    and reading only the reason would report it as unlocked, which is the opposite of what it is.
 */
export function parseWorktreeList(stdout: string, mainPath: string): WorktreeEntry[] {
  const main = normalizePath(mainPath);
  const entries: WorktreeEntry[] = [];

  let path = '';
  let head = '';
  let branch = '';
  let detached = false;
  let bare = false;
  let locked: string | null = null;
  let prunable: string | null = null;

  const flush = (): void => {
    if (path.length > 0 && !bare && normalizePath(path) !== main) {
      entries.push({
        name: basename(path),
        path,
        branch: presentEntryBranch(branch, detached, head),
        locked,
        prunable,
      });
    }
    path = '';
    head = '';
    branch = '';
    detached = false;
    bare = false;
    locked = null;
    prunable = null;
  };

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('worktree ')) {
      // A new record: whatever was being read is complete, blank line or not. Trusting the blank
      // line alone would drop the last worktree of an output that does not end with one.
      flush();
      path = line.slice('worktree '.length);
    } else if (line.startsWith('HEAD ')) {
      head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      detached = true;
    } else if (line === 'bare') {
      bare = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      locked = line === 'locked' ? '' : line.slice('locked '.length);
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      prunable = line === 'prunable' ? '' : line.slice('prunable '.length);
    }
  }
  flush();

  return entries;
}

/**
 * How a worktree's HEAD is spelled in the list.
 *
 * `detached@<sha>` is the spelling `readGitState` already uses for the project rows, so a detached
 * worktree reads the same in both tabs. Seven characters because that is git's own short length; the
 * full sha stays available in the row's tooltip, where a value nobody scans has room to be complete.
 */
function presentEntryBranch(branch: string, detached: boolean, head: string): string {
  if (branch.length > 0) {
    return branch;
  }
  if (detached && head.length > 0) {
    return `detached@${head.slice(0, 7)}`;
  }
  return detached ? 'detached' : '';
}

/** Folder name of a path, whichever separator git or the settings happened to use. */
export function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * The form two paths can be compared in.
 *
 * Lower-cased and slash-normalised: git prints its own separators and its own idea of the drive
 * letter's case, and neither has to match what the user typed into the settings.
 */
/**
 * The physical spelling of a path, the one git answers with.
 *
 * git resolves the path it is handed before printing it. So a project registered through a junction
 * is compared against its target, and one living under a TEMP whose owner has an 8.3 alias
 * (`C:\Users\RUNNER~1\...`) against the long form. Neither can equal what was stored, the main
 * checkout therefore survives the filter in {@link parseWorktreeList}, and the project grows a
 * worktree row that is itself. Both vectors verified on Windows, the second being what a CI runner
 * hands you and how this was found. Folding separators and case cannot cover it, and no string rule
 * can: only the filesystem knows what an alias points at.
 *
 * A path that cannot be resolved is returned as it came. A folder that is gone is not this helper's
 * to report, and the git call that follows reports it anyway.
 */
function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** The registrations of one project, or the error that stopped them being read. */
interface Listing {
  readonly project: Project;
  readonly entries: readonly WorktreeEntry[];
  readonly error: string | null;
}

/** Lists one project's registrations. One child process, and it cannot fail the whole read. */
async function listWorktrees(project: Project): Promise<Listing> {
  try {
    return {
      project,
      entries: parseWorktreeList(
        await git(project.path, ['worktree', 'list', '--porcelain']),
        canonicalPath(project.path),
      ),
      error: null,
    };
  } catch (error) {
    // A folder that is not a repository is a normal row here, exactly as it is in the project table:
    // reported, so it cannot be read as "this project has no worktree".
    return { project, entries: [], error: describeGitError(error) };
  }
}

/**
 * Reads one project's linked worktrees, with the working tree of each.
 *
 * The state comes from `readGitState`, the very function the project table's rows are built from,
 * rather than from a narrower read of its own. That is deliberate and it costs a git call per
 * worktree: the alternative is a second definition of "modified", "clean" and "ahead" living next to
 * the first, which is the failure this codebase has already paid for with `verdictFor` and `isStaged`.
 *
 * A `prunable` worktree is **not** read: its folder is gone, so every call would fail and report an
 * error that says nothing the `prunable` badge does not already say better.
 *
 * Kept as the single-project entry point, and it delegates to {@link readAllWorktrees} rather than
 * the other way round: the pool has to see every spawn of the read to be worth anything, so the
 * pooling belongs to the plural function and this one is the list of length one.
 */
export async function readRepoWorktrees(project: Project): Promise<RepoWorktrees> {
  const [only] = await readAllWorktrees([project]);
  // Non-null: `readAllWorktrees` maps its input, so a list of one answers with one.
  return only as RepoWorktrees;
}

/**
 * Reads every watched project's worktrees, in the configured order.
 *
 * **One pool for the whole read, in two passes**, and that is the point of the shape. It used to be
 * a `Promise.all` over the projects with a pool of four *inside* each of them, which bounds nothing:
 * on eleven projects, eleven `worktree list` processes started in the same tick and up to forty-four
 * status reads followed. Measured on 2026-09-09, that shape blocked the main process for **2343 ms**
 * in one go, against about 430 ms once every spawn of the read shares a single pool of four. Neither
 * figure is the cost of git working: `uv_spawn` calls `CreateProcessW` on the event loop thread, and
 * on this machine roughly one spawn in thirteen is held there for over 100 ms by the endpoint
 * scanner. A blocked main process is a frozen terminal, so the count and the width of this read are
 * a latency budget, not a throughput one. See `main/concurrency.ts`.
 *
 * The two passes are forced by the data: the second pass's items are the registrations the first
 * pass discovers, so they cannot be queued until it has answered. Flattening them into one list
 * before reading any of them is what keeps the second pass at four in flight across all projects
 * instead of four per project.
 *
 * Projects with no worktree are kept in the payload rather than filtered out. The view needs them to
 * say "eight worktrees across two of seven projects", and a project silently absent from a list is
 * indistinguishable from a project the tab forgot to look at.
 */
export async function readAllWorktrees(
  projects: readonly Project[],
): Promise<RepoWorktrees[]> {
  const listings = await mapWithLimit(projects, POLL_CONCURRENCY, listWorktrees);

  // A `prunable` registration is not read, so it must not take a slot in the pool either.
  const pending = listings.flatMap((listing) =>
    listing.entries.filter((entry) => entry.prunable === null),
  );
  const states = await mapWithLimit(pending, POLL_CONCURRENCY, (entry) => readGitState(entry.path));
  const readByPath = new Map(pending.map((entry, index) => [entry.path, states[index] ?? null]));

  return listings.map(({ project, entries, error }) => ({
    projectId: project.id,
    label: project.label,
    path: project.path,
    worktrees: entries.map(
      (entry): Worktree => ({
        ...entry,
        git: entry.prunable === null ? (readByPath.get(entry.path) ?? null) : null,
      }),
    ),
    error,
  }));
}
