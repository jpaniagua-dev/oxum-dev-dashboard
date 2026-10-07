import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { Project, ProjectId, TerminalSize } from '@shared/contracts.js';
import {
  childPath,
  compileExclusions,
  EXPLORER_LIST_LIMIT,
  isExcluded,
  sortEntries,
  type ExclusionRule,
  type ExplorerEntry,
  type ExplorerFiles,
  type ExplorerListing,
  type ExplorerOpenResult,
  type ExplorerTarget,
} from '@shared/explorer.js';
import type { EditorRequest } from '../editor/editor-process.js';
import { tryGit } from '../git/run-git.js';
import { cmdLine, resolveCommand, type ResolvedCommand } from '../spawn/command-resolve.js';

/** What the service needs from the app, injected so a test can hand it a temporary project. */
export interface ExplorerDependencies {
  readonly projects: () => readonly Project[];
  /** The exclusions setting, read at each call so a change in Settings applies at once. */
  readonly exclusions: () => readonly string[];
  /** The editor setting: a name found on PATH or a full path. */
  readonly editorCommand: () => string;
  /** Finds the executable a command names. `resolveCommand` in the app. */
  readonly resolve?: (command: string) => Promise<ResolvedCommand | null>;
  /** Opens the editor on one file, in the tab's panel or in a window of its own. */
  readonly openEditor: (
    request: EditorRequest,
    target: ExplorerTarget,
    size: TerminalSize,
  ) => ExplorerOpenResult;
}

/** Large enough for the file list of a big monorepo, which is several megabytes of paths. */
const LS_FILES_BUFFER = 64 * 1024 * 1024;

/**
 * The Explorer tab's reads, and the one write it allows: opening a file in the editor.
 *
 * Every method takes a project id and a path **relative** to that project, already shaped by
 * `sanitizeExplorerPath` at the IPC boundary, and resolves it here against the real disk: a symbolic
 * link or a junction that leads out of the project is refused, since following it would turn "browse
 * this repository" into "browse the machine". That check is the reason the renderer never sends an
 * absolute path, the same rule the rest of the app keeps.
 */
export class ExplorerService {
  /** The project-wide file list, per project, until the tab is shown again or Settings change. */
  private readonly files = new Map<ProjectId, ExplorerFiles>();
  /** The exclusions the rules and the cached file lists were built from, as one string. */
  private rulesKey = '';
  private rules: ExclusionRule[] = [];

  constructor(private readonly deps: ExplorerDependencies) {}

  /** Forgets the cached file lists. Called when the tab is shown, so a new file is found. */
  invalidate(): void {
    this.files.clear();
  }

  async list(projectId: ProjectId, path: string): Promise<ExplorerListing> {
    const project = this.project(projectId);
    if (project === undefined) {
      return { ok: false, path, message: 'This project is no longer configured' };
    }
    const folder = await resolveInside(project.path, path);
    if (folder === null) {
      return { ok: false, path, message: 'This folder does not exist or leads outside the project' };
    }
    let dirents;
    try {
      dirents = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      return { ok: false, path, message: describe(error) };
    }
    const visible = dirents.filter((dirent) => dirent.name.toLowerCase() !== '.git');
    const truncated = visible.length > EXPLORER_LIST_LIMIT;
    const [ignored, entries] = await Promise.all([
      ignoredChildren(project.path, path),
      Promise.all(
        visible.slice(0, EXPLORER_LIST_LIMIT).map(async (dirent) => {
          const link = dirent.isSymbolicLink();
          let isDir = dirent.isDirectory();
          let size: number | null = null;
          try {
            // `stat` follows a link, so a junction to a folder lists as a folder.
            const info = await stat(join(folder, dirent.name));
            isDir = info.isDirectory();
            size = isDir ? null : info.size;
          } catch {
            // A dangling link: listed, and opening it will say why it cannot be read.
          }
          return { name: dirent.name, isDir, size, link };
        }),
      ),
    ]);
    const rules = this.exclusionRules();
    const rows: ExplorerEntry[] = entries.map((entry) => {
      const relative = childPath(path, entry.name);
      return {
        name: entry.name,
        kind: entry.isDir ? 'dir' : 'file',
        size: entry.size,
        link: entry.link,
        dimmed: ignored.has(entry.name.toLowerCase()) || isExcluded(relative, rules),
      };
    });
    return { ok: true, path, entries: sortEntries(rows), truncated };
  }

  /**
   * Every file the search may return: tracked, plus untracked ones git does not ignore, minus the
   * exclusions. git's own list rather than a walk, because the walk would have to re-implement
   * `.gitignore` to keep `node_modules` out, and git already did that work.
   */
  async projectFiles(projectId: ProjectId): Promise<ExplorerFiles> {
    const rules = this.exclusionRules();
    const cached = this.files.get(projectId);
    if (cached !== undefined) {
      return cached;
    }
    const project = this.project(projectId);
    if (project === undefined) {
      return { ok: false, message: 'This project is no longer configured' };
    }
    const answer = await tryGit(
      project.path,
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { maxBuffer: LS_FILES_BUFFER, timeoutMs: 20_000 },
    );
    let result: ExplorerFiles;
    if (!answer.ok) {
      result = { ok: false, message: 'Searching the whole project needs it to be a git repository' };
    } else {
      const seen = new Set<string>();
      const paths: string[] = [];
      for (const path of answer.stdout.split('\0')) {
        // `--cached` lists a conflicted file once per stage; the set keeps one.
        if (path.length > 0 && !seen.has(path) && !isExcluded(path, rules)) {
          seen.add(path);
          paths.push(path);
        }
      }
      result = { ok: true, paths: await dropLinked(project.path, paths) };
    }
    this.files.set(projectId, result);
    return result;
  }

  /** Opens a file in the editor, after checking it is a file of this project. */
  async open(
    projectId: ProjectId,
    path: string,
    target: ExplorerTarget,
    size: TerminalSize,
    line: number | null = null,
  ): Promise<ExplorerOpenResult> {
    const project = this.project(projectId);
    if (project === undefined || path.length === 0) {
      return { ok: false, message: 'Nothing to open' };
    }
    const file = await resolveInside(project.path, path);
    if (file === null) {
      return { ok: false, message: 'This file does not exist or leads outside the project' };
    }
    try {
      if (!(await stat(file)).isFile()) {
        return { ok: false, message: 'Only a file opens in the editor' };
      }
    } catch (error) {
      return { ok: false, message: describe(error) };
    }

    const command = this.deps.editorCommand().trim();
    const resolved = await (this.deps.resolve ?? resolveCommand)(command);
    if (resolved === null) {
      return {
        ok: false,
        message: `${command.length > 0 ? command : 'The editor'} was not found. Set its path in Settings → General`,
      };
    }
    // Relative to the project, which is where the editor starts: its status bar then shows
    // `src/app/app.ts` rather than a drive letter and the whole way down to it.
    const argument = path.split('/').join(sep);
    // `+LINE` BEFORE the file: micro reads it on either side (measured on 2.0.15), and nano and emacs
    // apply it to the file that follows, so this order is the one every editor that takes it reads.
    const argv = line === null ? [argument] : [`+${line}`, argument];
    let launch: Pick<EditorRequest, 'file' | 'args'>;
    if (resolved.viaCmd) {
      const command = cmdLine(resolved.file, argv);
      if (command === null) {
        return { ok: false, message: 'This file name cannot be passed to a batch file safely' };
      }
      launch = { file: 'cmd.exe', args: `/d /s /c ${command}` };
    } else {
      launch = { file: resolved.file, args: argv };
    }
    return this.deps.openEditor(
      {
        key: `${project.id}\0${path}`,
        projectId: project.id,
        path,
        title: `${path} - ${project.label}`,
        line,
        cwd: project.path,
        ...launch,
      },
      target,
      size,
    );
  }

  private project(projectId: ProjectId): Project | undefined {
    return this.deps.projects().find((project) => project.id === projectId);
  }

  /**
   * Compiled once per change of the setting rather than once per row. A change also drops the cached
   * file lists, which were filtered with the previous patterns: an exclusion added in Settings has to
   * leave the search at once, not after the tab is shown again.
   */
  private exclusionRules(): ExclusionRule[] {
    const source = this.deps.exclusions();
    const key = source.join('\n');
    if (key !== this.rulesKey) {
      this.rulesKey = key;
      this.rules = compileExclusions(source);
      this.files.clear();
    }
    return this.rules;
  }
}

/**
 * The absolute path of a project-relative one, or null when it does not exist or resolves outside
 * the project.
 *
 * Both sides go through `realpath`, so a junction is judged by where it leads and the project's own
 * path may itself be a junction (the fronts are reached through one on the author's machine). Case
 * is folded on Windows, where `C:\Repo` and `c:\repo` are the same folder.
 */
export async function resolveInside(root: string, path: string): Promise<string | null> {
  try {
    const base = await realpath(root);
    const target = await realpath(path.length === 0 ? base : join(base, ...path.split('/')));
    const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);
    const inside = fold(target) === fold(base) || fold(target).startsWith(fold(base.endsWith(sep) ? base : base + sep));
    return inside ? target : null;
  } catch {
    return null;
  }
}

/**
 * The paths that do not go through a symbolic link or a junction on their way down.
 *
 * Found by a test, not by theory: git for Windows walks into a junction as if it were a folder, so
 * `ls-files --others` listed a file that lives outside the project, and the search offered it.
 * Opening it was already refused by `resolveInside`; a result that cannot be opened is still a lie,
 * so the list drops it. Each folder is checked once, whatever the number of files under it.
 */
async function dropLinked(root: string, paths: readonly string[]): Promise<string[]> {
  const folders = new Set<string>();
  for (const path of paths) {
    let at = path.indexOf('/');
    while (at !== -1) {
      folders.add(path.slice(0, at));
      at = path.indexOf('/', at + 1);
    }
  }
  const linked = new Set<string>();
  const pending = [...folders];
  for (let start = 0; start < pending.length; start += 256) {
    await Promise.all(
      pending.slice(start, start + 256).map(async (folder) => {
        try {
          if ((await lstat(join(root, ...folder.split('/')))).isSymbolicLink()) {
            linked.add(folder);
          }
        } catch {
          // Gone since git listed it: the file under it will fail to open and say why.
        }
      }),
    );
  }
  if (linked.size === 0) {
    return [...paths];
  }
  return paths.filter((path) => {
    let at = path.indexOf('/');
    while (at !== -1) {
      if (linked.has(path.slice(0, at))) {
        return false;
      }
      at = path.indexOf('/', at + 1);
    }
    return true;
  });
}

/**
 * The names, lower-cased, of a folder's children that git ignores.
 *
 * `--directory` reports an ignored folder once instead of every file in it, which is what keeps this
 * cheap at the root of a repository with a `node_modules`. Anything deeper is dropped here. Outside a
 * git repository the answer is an empty set: nothing is greyed, and that is not an error.
 */
async function ignoredChildren(root: string, path: string): Promise<Set<string>> {
  const answer = await tryGit(root, [
    'ls-files',
    '-z',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '--',
    path.length === 0 ? '.' : path,
  ]);
  const names = new Set<string>();
  if (!answer.ok) {
    return names;
  }
  const prefix = path.length === 0 ? '' : `${path}/`;
  for (const raw of answer.stdout.split('\0')) {
    const entry = raw.replace(/\/$/, '');
    if (entry.length === 0 || !entry.startsWith(prefix)) {
      continue;
    }
    const rest = entry.slice(prefix.length);
    if (rest.length > 0 && !rest.includes('/')) {
      names.add(rest.toLowerCase());
    }
  }
  return names;
}

function describe(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOENT') {
    return 'It no longer exists';
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return 'Access is denied';
  }
  return error instanceof Error ? error.message : String(error);
}
