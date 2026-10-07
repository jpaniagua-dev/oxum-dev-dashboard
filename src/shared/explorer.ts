/**
 * The Explorer tab's vocabulary and every rule it can state without a disk.
 *
 * This tab is the first place the app reads arbitrary files and hands one to a program, so the rules
 * that bound it live here, pure and tested: which relative paths are acceptable at all, which files
 * the search may return, which ones are greyed. The main process resolves and checks the result
 * against the real filesystem; nothing here trusts a path to stay inside its project on its own.
 */

/** One row of a folder listing. */
export interface ExplorerEntry {
  readonly name: string;
  readonly kind: 'dir' | 'file';
  /** Bytes, for a file. Null for a folder, whose size would cost a walk. */
  readonly size: number | null;
  /** A symbolic link or a junction. Listed, followed only when it stays inside the project. */
  readonly link: boolean;
  /** Ignored by git or matched by the exclusions in Settings: listed, greyed. */
  readonly dimmed: boolean;
}

/** One folder of one project, as read now. */
export type ExplorerListing =
  | {
      readonly ok: true;
      readonly path: string;
      readonly entries: readonly ExplorerEntry[];
      /** More entries than `EXPLORER_LIST_LIMIT`: the rest are not shown. */
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly path: string; readonly message: string };

/** Every file the project-wide search may return, relative to the project root. */
export type ExplorerFiles =
  | { readonly ok: true; readonly paths: readonly string[] }
  | { readonly ok: false; readonly message: string };

/** Where a file opens: in the editor beside the list, or in a window of its own. */
export type ExplorerTarget = 'panel' | 'window';

/** The answer to "open this file in the editor". `message` is said to the user when not empty. */
export interface ExplorerOpenResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * The editor beside the list, as the dashboard draws it.
 *
 * `session` changes with every process started, which is how the page knows to clear the terminal
 * before the new file's first frame. `pending` names the file waiting for the current editor to
 * quit: the app asked it to, and it may be asking the user about unsaved changes.
 */
export interface PanelEditorState {
  readonly session: number | null;
  readonly projectId: string | null;
  readonly path: string | null;
  readonly title: string;
  readonly running: boolean;
  /** How the last editor ended, when it ended other than cleanly. */
  readonly exitCode: number | null;
  readonly pending: string | null;
  /** Why nothing started, when something failed. */
  readonly message: string;
}

export const IDLE_PANEL_EDITOR: PanelEditorState = {
  session: null,
  projectId: null,
  path: null,
  title: '',
  running: false,
  exitCode: null,
  pending: null,
  message: '',
};

/** Rows a folder listing carries at most. A folder past that is a build output, not a place to browse. */
export const EXPLORER_LIST_LIMIT = 2000;

/** Results the project-wide search shows at most. */
export const EXPLORER_SEARCH_LIMIT = 200;

/** Patterns, and characters per pattern, the exclusions setting keeps. */
export const EXPLORER_EXCLUSIONS_LIMIT = { count: 200, length: 200 } as const;

const PATH_LIMIT = 1024;

/**
 * A relative path inside a project, or null when it cannot be one.
 *
 * The empty string is the project root. Rejected rather than normalised, like
 * `sanitizeVaultFileBinding`: a backslash, an absolute path, a drive, `..` or `.` would each let the
 * same string mean two places, and the main process resolves what this returns against the disk.
 * `.git` is refused at any depth: nothing in it is meant to be read or edited by hand.
 */
export function sanitizeExplorerPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (value.length === 0) {
    return '';
  }
  if (
    value.length > PATH_LIMIT ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    value.includes(':') ||
    /[<>"|?*]/.test(value) ||
    /[\u0000-\u001f]/.test(value)
  ) {
    return null;
  }
  const parts = value.split('/');
  if (
    parts.some(
      (part) =>
        part.length === 0 || part === '.' || part === '..' || part.toLowerCase() === '.git',
    )
  ) {
    return null;
  }
  return value;
}

/**
 * Whether the editor on screen holds unsaved changes, read off its status line, or null when no
 * status line is recognised.
 *
 * micro's default status line reads `src/app.ts (12,4) | ft:typescript | …`, and `src/app.ts + (12,4)`
 * once the buffer is modified (`$(modified)`, then `$(overwrite)` which may add a word). Measured on
 * micro 2.0.15: the `+` appears on the first keystroke and goes on `Ctrl+S`. It is read from the
 * **rendered** screen, never from the output stream: micro redraws only the cells that change, so the
 * stream after a keystroke holds `+ ( ,2)` scattered among escape codes, never the whole line.
 *
 * Every status line counts (one per split): any modified one means unsaved work. Null for another
 * editor or a customised `statusformatl`, which the app then treats as nothing to warn about.
 */
export function editorModified(lines: readonly string[]): boolean | null {
  let found = false;
  for (const line of lines) {
    if (!line.includes('| ft:')) {
      continue;
    }
    found = true;
    if (/ \+ (?:\S+ )?\(\d+,\d+\)/.test(line)) {
      return true;
    }
  }
  return found ? false : null;
}

/** A child of a folder, both relative to the project root. */
export function childPath(dir: string, name: string): string {
  return dir.length === 0 ? name : `${dir}/${name}`;
}

/** The folder above, or null at the root. */
export function parentPath(path: string): string | null {
  if (path.length === 0) {
    return null;
  }
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

/** The last segment of a relative path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The breadcrumb of a folder: each ancestor's name and its path, the root first. */
export function breadcrumb(path: string): { name: string; path: string }[] {
  const crumbs: { name: string; path: string }[] = [];
  if (path.length === 0) {
    return crumbs;
  }
  let current = '';
  for (const part of path.split('/')) {
    current = childPath(current, part);
    crumbs.push({ name: part, path: current });
  }
  return crumbs;
}

/** Folders first, then by name, case-insensitively: the order every file explorer has taught. */
export function sortEntries(entries: readonly ExplorerEntry[]): ExplorerEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'dir' ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true });
  });
}

/** Whether a name matches what was typed in the filter. Case-insensitive substring. */
export function matchesName(name: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle.length === 0 || name.toLowerCase().includes(needle);
}

/**
 * The project files a query finds, best first.
 *
 * Ranked so typing a file's name finds it at the top: a name that starts with the query, then a name
 * that contains it, then a path that contains it (a folder name). Shorter paths win a tie, being
 * closer to the root. A substring rather than a fuzzy match, deliberately: a fuzzy ranker answers
 * every query with something, and in a monorepo "something" is mostly noise.
 */
export function matchFiles(paths: readonly string[], query: string, limit: number): string[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }
  const ranked: { path: string; rank: number }[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    const rank = name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : lower.includes(needle) ? 2 : -1;
    if (rank !== -1) {
      ranked.push({ path, rank });
    }
  }
  ranked.sort(
    (left, right) =>
      left.rank - right.rank ||
      left.path.length - right.path.length ||
      left.path.localeCompare(right.path),
  );
  return ranked.slice(0, limit).map((entry) => entry.path);
}

/** The row an arrow key lands on, held inside the list. -1 means nothing selected. */
export function moveSelection(index: number, delta: number, count: number): number {
  if (count === 0) {
    return -1;
  }
  if (index < 0) {
    return delta > 0 ? 0 : count - 1;
  }
  return Math.min(count - 1, Math.max(0, index + delta));
}

/** A byte count the way a file list shows it. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The exclusions setting, cleaned: trimmed, without blank lines or `#` comments, without duplicates,
 * bounded. Anything else becomes an empty list rather than an error, like every list in the settings.
 */
export function sanitizeExclusions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const kept: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') {
      continue;
    }
    const pattern = raw.trim();
    if (
      pattern.length === 0 ||
      pattern.startsWith('#') ||
      pattern.length > EXPLORER_EXCLUSIONS_LIMIT.length ||
      kept.includes(pattern)
    ) {
      continue;
    }
    kept.push(pattern);
    if (kept.length === EXPLORER_EXCLUSIONS_LIMIT.count) {
      break;
    }
  }
  return kept;
}

/** One compiled exclusion: a pattern for any single segment, or one anchored at the project root. */
export interface ExclusionRule {
  readonly anchored: boolean;
  readonly regex: RegExp;
}

/**
 * Compiles the exclusions setting into rules.
 *
 * A **simplified** gitignore, since that is the syntax a developer already writes without thinking:
 * a pattern without `/` matches any file or folder of that name at any depth (`node_modules`,
 * `*.lock`); a pattern with a `/` is anchored at the project root (`docs/generated`); `*` and `?` stay
 * inside a segment and `**` crosses them. A trailing `/` is accepted and ignored, and there is no
 * negation: an exclusion list that can un-exclude is one nobody can read at a glance. Case-insensitive,
 * because the file system it describes is.
 */
export function compileExclusions(patterns: readonly string[]): ExclusionRule[] {
  const rules: ExclusionRule[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (pattern.length === 0 || pattern.startsWith('#')) {
      continue;
    }
    const anchored = pattern.includes('/');
    const body = pattern.replace(/^\/+/, '');
    if (body.length === 0) {
      continue;
    }
    rules.push({ anchored, regex: new RegExp(`^${globToRegex(body)}$`, 'i') });
  }
  return rules;
}

/**
 * Whether a project path is excluded: the path itself or any folder above it matches a rule.
 *
 * Checking the ancestors is what makes `node_modules` exclude everything inside it, as it does in a
 * `.gitignore`, without the user having to write `node_modules/**`.
 */
export function isExcluded(path: string, rules: readonly ExclusionRule[]): boolean {
  if (rules.length === 0 || path.length === 0) {
    return false;
  }
  const parts = path.split('/');
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const segment = parts[depth - 1] ?? '';
    const prefix = parts.slice(0, depth).join('/');
    for (const rule of rules) {
      if (rule.regex.test(rule.anchored ? prefix : segment)) {
        return true;
      }
    }
  }
  return false;
}

function globToRegex(glob: string): string {
  let out = '';
  for (let at = 0; at < glob.length; at += 1) {
    const char = glob[at] ?? '';
    if (char === '*') {
      if (glob[at + 1] === '*') {
        // `**/` also matches no folder at all, so `src/**/x` finds `src/x`.
        if (glob[at + 2] === '/') {
          out += '(?:.*/)?';
          at += 2;
        } else {
          out += '.*';
          at += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}
