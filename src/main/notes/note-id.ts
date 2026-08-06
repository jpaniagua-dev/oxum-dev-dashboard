import { NOTE_ID_PATTERN, type NoteId } from '@shared/contracts.js';

/**
 * Note identity, derived from the creation date.
 *
 * Imports nothing but a type and a regular expression, on purpose: like `projects/project-id.ts`, this
 * module has to stay loadable from anywhere, including a test with no Electron and no filesystem.
 */

/** Extension every note file carries. */
const NOTE_EXTENSION = '.md';

/**
 * Turns a date into `20260806T143012123`.
 *
 * Compact and separator-free so the string sorts chronologically as plain text, which is what makes
 * a directory listing usable without parsing anything. The `T` is **kept**: it is part of
 * `NOTE_ID_PATTERN`, so stripping it makes every id fail validation, `update()` return early and
 * every keystroke vanish without a word.
 */
function toCompactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.Z]/g, '').slice(0, 18);
}

/**
 * Builds an id that is not already taken.
 *
 * The date is injected rather than read from the clock so the result is testable. Two notes created
 * inside the same millisecond get a `-2`, `-3` suffix; without it the second creation would silently
 * overwrite the first.
 */
export function makeNoteId(createdAt: Date, taken: readonly NoteId[] = []): NoteId {
  const base = toCompactTimestamp(createdAt);
  if (!taken.includes(base)) {
    return base;
  }
  let suffix = 2;
  while (taken.includes(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

/**
 * Whether a string is a well-formed id.
 *
 * This is the path-traversal boundary: every entry point validates before joining the id to the notes
 * folder, so `../settings` or an absolute path can never reach the filesystem.
 */
export function isNoteId(value: unknown): value is NoteId {
  return typeof value === 'string' && NOTE_ID_PATTERN.test(value);
}

export function noteFileName(id: NoteId): string {
  return `${id}${NOTE_EXTENSION}`;
}

/**
 * Reads an id back out of a file name, or null when the file is not a note.
 *
 * The null case matters more than it looks: `atomicWriteFile` leaves a temporary file in the folder
 * for the duration of every save, so an unfiltered directory listing would flash a garbage row into
 * the list on each keystroke.
 */
export function noteIdFromFileName(fileName: string): NoteId | null {
  if (!fileName.endsWith(NOTE_EXTENSION)) {
    return null;
  }
  const stem = fileName.slice(0, -NOTE_EXTENSION.length);
  return isNoteId(stem) ? stem : null;
}
