import type { GitBranch, GitChange, GitCommit, GitDiffLine } from '@shared/contracts.js';

/**
 * Field separator asked of `git log --format`.
 *
 * A control character rather than a tab or a pipe: an author name or a commit subject can contain
 * both of those, and a subject with a tab in it would silently shift every field after it.
 */
export const FIELD_SEPARATOR = '\u001f';

/**
 * Reads `git status --porcelain -z`.
 *
 * `-z` is the reason this is parseable at all. Without it git *quotes* any path that is not plain
 * ASCII (`"src/cr\303\251ation.ts"`), applying `core.quotepath` escaping we would then have to undo,
 * and it separates records with newlines that a path may legitimately contain. With `-z`, records are
 * NUL-separated and paths are raw bytes: nothing to unescape, nothing to guess.
 *
 * A rename or a copy occupies **two** fields, the new path then the old one, which is why the loop
 * consumes a second entry rather than mapping one-to-one.
 */
export function parseStatusZ(stdout: string): GitChange[] {
  const parts = stdout.split('\0');
  const changes: GitChange[] = [];

  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    // "XY p" is the shortest possible record: two status columns, a space, a one-character path.
    if (entry === undefined || entry.length < 4) {
      continue;
    }
    const index = entry[0] ?? ' ';
    const worktree = entry[1] ?? ' ';
    const path = entry.slice(3);

    let from: string | null = null;
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      from = parts[i + 1] ?? null;
      i += 1;
    }

    changes.push({
      path,
      index,
      worktree,
      untracked: index === '?' && worktree === '?',
      from,
    });
  }

  return changes;
}

/**
 * Reads the `for-each-ref` format used by `readBranches`.
 *
 * Fields: name, HEAD marker, upstream, track, committer date. The track field is git's own
 * `[ahead 2, behind 1]` prose, parsed with two independent searches rather than one pattern: it can
 * carry either half alone, both, or `[gone]`, and a single regex covering all four shapes is a good
 * way to silently return zeros for a branch that is in fact behind.
 */
export function parseBranchLines(stdout: string): GitBranch[] {
  const branches: GitBranch[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    const [name, head, upstream, track, date] = line.split(FIELD_SEPARATOR);
    if (name === undefined || name.length === 0) {
      continue;
    }
    const marks = track ?? '';
    branches.push({
      name,
      current: head === '*',
      upstream: upstream !== undefined && upstream.length > 0 ? upstream : null,
      ahead: readCount(/ahead (\d+)/.exec(marks)),
      behind: readCount(/behind (\d+)/.exec(marks)),
      gone: marks.includes('gone'),
      updatedAt: date ?? '',
    });
  }

  return branches;
}

/**
 * Reads the `git log --format` output used by `readCommits`.
 *
 * Fields: sha, author, date, refs, subject. The subject comes **last** on purpose: it is the only
 * field a user writes freely, so putting it at the end means a stray separator inside it can only
 * damage itself, never shift a date or a sha into the wrong column.
 */
export function parseLogLines(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    const [sha, author, date, refs, ...rest] = line.split(FIELD_SEPARATOR);
    if (sha === undefined || sha.length === 0) {
      continue;
    }
    commits.push({
      sha,
      author: author ?? '',
      date: date ?? '',
      refs: refs ?? '',
      // Rejoined rather than taken as `rest[0]`: a subject containing the separator must survive
      // whole instead of being truncated at its first occurrence.
      subject: rest.join(FIELD_SEPARATOR),
    });
  }

  return commits;
}

/**
 * Turns a unified diff into numbered lines.
 *
 * Order of the tests is the whole subtlety: `---` and `+++` are file headers that *start with* the
 * removal and addition markers, so checking for `-` and `+` first would count both as content and
 * push every subsequent line number off by one. Headers are therefore matched before markers.
 *
 * Line numbers are counted from the hunk header rather than from the top of the file, because a diff
 * only ever contains fragments: the `@@ -12,7 +12,9 @@` is the only statement of where the fragment
 * sits, and a counter that ignored it would number the second hunk as if it followed the first.
 */
export function parseUnifiedDiff(text: string): GitDiffLine[] {
  const lines: GitDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of text.split(/\r?\n/)) {
    if (raw.length === 0) {
      continue;
    }

    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk !== null) {
      oldLine = Number.parseInt(hunk[1] ?? '1', 10);
      newLine = Number.parseInt(hunk[2] ?? '1', 10);
      lines.push({ kind: 'hunk', text: raw, oldLine: null, newLine: null });
      continue;
    }

    if (isDiffHeader(raw)) {
      lines.push({ kind: 'meta', text: raw, oldLine: null, newLine: null });
      continue;
    }

    if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw, oldLine: null, newLine });
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      lines.push({ kind: 'del', text: raw, oldLine, newLine: null });
      oldLine += 1;
      continue;
    }
    if (raw.startsWith('\\')) {
      // "\ No newline at end of file" belongs to the line above and advances no counter.
      lines.push({ kind: 'meta', text: raw, oldLine: null, newLine: null });
      continue;
    }

    lines.push({ kind: 'context', text: raw, oldLine, newLine });
    oldLine += 1;
    newLine += 1;
  }

  return lines;
}

/**
 * Whether a diff line is one of git's headers rather than content.
 *
 * `--- ` and `+++ ` are matched **with their trailing space**, which is what tells them apart from a
 * removed line reading `---` in a Markdown file or an added `+++` in a test fixture. Both exist in
 * real repositories, and mistaking one for a header drops a genuine change from the view.
 */
function isDiffHeader(line: string): boolean {
  return (
    line.startsWith('diff --git ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line === '--- /dev/null' ||
    line === '+++ /dev/null' ||
    line.startsWith('old mode ') ||
    line.startsWith('new mode ') ||
    line.startsWith('new file mode ') ||
    line.startsWith('deleted file mode ') ||
    line.startsWith('similarity index ') ||
    line.startsWith('dissimilarity index ') ||
    line.startsWith('rename from ') ||
    line.startsWith('rename to ') ||
    line.startsWith('copy from ') ||
    line.startsWith('copy to ') ||
    line.startsWith('Binary files ')
  );
}

function readCount(match: RegExpExecArray | null): number {
  const parsed = Number.parseInt(match?.[1] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
