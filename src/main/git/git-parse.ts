import type {
  GitChange,
  GitCommit,
  GitCommitFile,
  GitDiffLine,
  GitRef,
  GitRefKind,
  GitStash,
} from '@shared/contracts.js';

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

/** The three namespaces the graph shows, with the prefix each one strips for display. */
const REF_NAMESPACES: readonly (readonly [GitRefKind, string])[] = [
  ['local', 'refs/heads/'],
  ['remote', 'refs/remotes/'],
  ['tag', 'refs/tags/'],
];

/**
 * Reads the `for-each-ref` format used by `readRefs`.
 *
 * Fields: full name, HEAD marker, upstream, track, date, object, peeled object. The track field is
 * git's own `[ahead 2, behind 1]` prose, parsed with two independent searches rather than one
 * pattern: it can carry either half alone, both, or `[gone]`, and a single regex covering all four
 * shapes is a good way to silently return zeros for a branch that is in fact behind.
 *
 * - **The display name is the full name minus its namespace**, not `%(refname:short)`: git shortens
 *   to `heads/x` as soon as a tag of the same name exists, and to `origin` for `origin/HEAD`, so
 *   its short form depends on what else is in the repository.
 * - **`<remote>/HEAD` is dropped.** It is a pointer to another remote branch, not a branch, and
 *   listing it would put a second `origin/main` chip on the same commit under another name.
 * - **An annotated tag is peeled**: `%(objectname)` is the tag object, which no commit of the graph
 *   carries; `%(*objectname)` is the commit it points to, and is empty on everything else.
 */
export function parseRefLines(stdout: string): GitRef[] {
  const refs: GitRef[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    const [ref, head, upstream, track, date, object, peeled] = line.split(FIELD_SEPARATOR);
    if (ref === undefined || ref.length === 0) {
      continue;
    }
    const namespace = REF_NAMESPACES.find(([, prefix]) => ref.startsWith(prefix));
    if (namespace === undefined) {
      continue;
    }
    const [kind, prefix] = namespace;
    if (kind === 'remote' && ref.endsWith('/HEAD')) {
      continue;
    }
    const marks = track ?? '';
    refs.push({
      ref,
      name: ref.slice(prefix.length),
      kind,
      sha: peeled !== undefined && peeled.length > 0 ? peeled : (object ?? ''),
      current: head === '*',
      upstream: upstream !== undefined && upstream.length > 0 ? upstream : null,
      ahead: readCount(/ahead (\d+)/.exec(marks)),
      behind: readCount(/behind (\d+)/.exec(marks)),
      gone: marks.includes('gone'),
      updatedAt: date ?? '',
    });
  }

  return refs;
}

/**
 * Reads the `git log --format` output used by `readCommits`.
 *
 * Fields: sha, parents, author, date, refs, subject. The subject comes **last** on purpose: it is the
 * only field a user writes freely, so putting it at the end means a stray separator inside it can
 * only damage itself, never shift a date or a sha into the wrong column. `%P` is space-separated and
 * empty on a root commit, which has to become an empty list and not `['']`: a lane waiting for a
 * parent called `''` would never close.
 */
export function parseGraphLines(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    const [sha, parents, author, date, refs, ...rest] = line.split(FIELD_SEPARATOR);
    if (sha === undefined || sha.length === 0) {
      continue;
    }
    commits.push({
      sha,
      parents: (parents ?? '').split(' ').filter((parent) => parent.length > 0),
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
 * Reads `git show --format= -z --name-status`.
 *
 * Same reason for `-z` as `parseStatusZ`: raw paths, no quoting to undo. Each record is a status
 * then a path, and a rename or a copy carries a **score** in its status (`R087`) and **two** paths,
 * the old one first. Failing to consume the second one would add a phantom file and pair every
 * following status with the wrong path. A status is trimmed on the left because `git show` may
 * open its output with the blank line that separates an (empty) header from the file list.
 */
export function parseCommitFilesZ(stdout: string): GitCommitFile[] {
  const parts = stdout.split('\0');
  const files: GitCommitFile[] = [];

  for (let i = 0; i < parts.length; i += 1) {
    const status = parts[i]?.trimStart();
    if (status === undefined || status.length === 0) {
      continue;
    }
    const letter = status[0] ?? '';
    if (letter === 'R' || letter === 'C') {
      const from = parts[i + 1];
      const path = parts[i + 2];
      i += 2;
      if (from !== undefined && path !== undefined) {
        files.push({ path, status: letter, from });
      }
      continue;
    }
    const path = parts[i + 1];
    i += 1;
    if (path !== undefined && path.length > 0) {
      files.push({ path, status: letter, from: null });
    }
  }

  return files;
}

/**
 * Reads the `git stash list --format` output used by `readStashes`.
 *
 * Fields: ref (`%gd`), sha (`%H`), date (`%cI`), message (`%gs`). The message comes **last** for the
 * reason `parseLogLines` puts the subject there: it is the only field a user writes freely, so a
 * stray separator inside it can only damage itself.
 *
 * There is no branch field to ask for — git records where a stash was taken in the reflog message and
 * nowhere else — so it is read out of the message by `describeStash`.
 */
export function parseStashLines(stdout: string): GitStash[] {
  const stashes: GitStash[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    const [ref, sha, date, ...rest] = line.split(FIELD_SEPARATOR);
    if (ref === undefined || ref.length === 0 || sha === undefined || sha.length === 0) {
      continue;
    }
    const { branch, subject } = describeStash(rest.join(FIELD_SEPARATOR));
    stashes.push({ ref, sha, date: date ?? '', branch, subject });
  }

  return stashes;
}

/**
 * Splits a stash's reflog message into the branch it was taken from and what it is about.
 *
 * Two shapes, both real and both produced by git itself: `WIP on <branch>: <sha> <subject>` for a
 * bare `git stash`, and `On <branch>: <message>` for one given a message. A pattern matching only the
 * first loses the branch of every named stash, which is the half people actually type.
 *
 * The prefix is **removed** from the subject rather than left in it: the branch is shown in its own
 * column, and repeating it inside every line is how a narrow list stops being readable. A message
 * that matches neither shape is passed through whole, with no branch — that is what a stash created
 * by a tool other than git's own porcelain looks like, and inventing a branch for it would be worse
 * than admitting there is none.
 */
export function describeStash(message: string): { branch: string; subject: string } {
  const wip = /^WIP on ([^:]+): [0-9a-f]{4,40} (.*)$/s.exec(message);
  if (wip !== null) {
    return { branch: wip[1] ?? '', subject: wip[2] ?? '' };
  }
  const named = /^On ([^:]+): (.*)$/s.exec(message);
  if (named !== null) {
    return { branch: named[1] ?? '', subject: named[2] ?? '' };
  }
  return { branch: '', subject: message };
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
