import type { Note } from '@shared/contracts.js';

/** Longest title kept, in characters. Beyond this a list row stops being scannable. */
const MAX_TITLE = 80;

/** Shown for a note whose body holds nothing readable yet. */
const EMPTY_TITLE = '(vide)';

/**
 * Derives a note's title from its body.
 *
 * The title is never stored: it is the first meaningful line, recomputed on read. That is what makes
 * retitling a pure content edit, with no file rename and none of the Windows rename races that would
 * come with one.
 *
 * Named `deriveNoteTitle` rather than the prompt editor's `firstMeaningfulLine`, because
 * `projects/output-parser.ts` already has a private function under that name with a different
 * contract, and two same-named helpers that disagree is how a wrong one gets imported.
 */
export function deriveNoteTitle(text: string, maxLength = MAX_TITLE): string {
  for (const line of text.split('\n')) {
    // Markdown heading markers are formatting, not part of the title the user reads.
    const cleaned = line.replace(/^\s*#{1,6}\s*/, '').trim();
    if (cleaned.length === 0) {
      continue;
    }
    return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength).trimEnd()}…` : cleaned;
  }
  return EMPTY_TITLE;
}

/**
 * Orders notes for the list: most recently touched first.
 *
 * The panel is a work surface, not an archive, so the note just edited is the one to come back to.
 * Sorts a copy: the caller's array is state held elsewhere.
 */
export function sortNotes(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) {
      return a.updatedAt < b.updatedAt ? 1 : -1;
    }
    // Ids are chronological, so this keeps the order total and stable when two files share an mtime.
    return a.id < b.id ? 1 : -1;
  });
}
