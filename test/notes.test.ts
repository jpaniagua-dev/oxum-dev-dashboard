import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isNoteId,
  makeNoteId,
  noteFileName,
  noteIdFromFileName,
} from '../src/main/notes/note-id.js';
import { deriveNoteTitle, sortNotes } from '../src/main/notes/note-title.js';
import { NotesStore, type NotesFolder } from '../src/main/notes/notes-store.js';
import type { Note, NotesState } from '../src/shared/contracts.js';

describe('deriveNoteTitle', () => {
  it('takes the first meaningful line', () => {
    expect(deriveNoteTitle('Product meeting\nthe rest of the body')).toBe('Product meeting');
  });

  it('strips markdown heading markers, one to six', () => {
    expect(deriveNoteTitle('# Titre')).toBe('Titre');
    expect(deriveNoteTitle('###### Titre')).toBe('Titre');
    // Seven hashes is not a heading, so the text is the title as written.
    expect(deriveNoteTitle('####### Titre')).toBe('# Titre');
  });

  it('skips leading blank lines', () => {
    expect(deriveNoteTitle('\n\n   \n## Enfin\n')).toBe('Enfin');
  });

  it('truncates past the limit and marks it', () => {
    const title = deriveNoteTitle(`${'a'.repeat(120)}\nsuite`);
    expect(title).toHaveLength(81);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back to (vide) for an empty or blank body', () => {
    // This is what a freshly created note shows, so it is user-visible copy.
    expect(deriveNoteTitle('')).toBe('(vide)');
    expect(deriveNoteTitle('   \n\t\n')).toBe('(vide)');
    expect(deriveNoteTitle('###   ')).toBe('(vide)');
  });
});

describe('note ids', () => {
  it('builds a sortable id from the creation date', () => {
    expect(makeNoteId(new Date('2026-08-06T14:30:12.123Z'))).toBe('20260806T143012123');
  });

  it('suffixes a collision rather than overwriting the earlier note', () => {
    const date = new Date('2026-08-06T14:30:12.123Z');
    const first = makeNoteId(date);
    const second = makeNoteId(date, [first]);
    const third = makeNoteId(date, [first, second]);
    expect(second).toBe('20260806T143012123-2');
    expect(third).toBe('20260806T143012123-3');
  });

  it('keeps ids in chronological order when compared as plain strings', () => {
    const older = makeNoteId(new Date('2026-08-06T09:00:00.000Z'));
    const newer = makeNoteId(new Date('2026-08-06T09:00:00.001Z'));
    expect(older < newer).toBe(true);
  });

  it('rejects anything that could escape the notes folder', () => {
    // This is the path-traversal boundary: every entry point validates before joining.
    expect(isNoteId('../settings')).toBe(false);
    expect(isNoteId('notes/../../x')).toBe(false);
    expect(isNoteId('C:\\evil')).toBe(false);
    expect(isNoteId('20260806T143012123.md')).toBe(false);
    expect(isNoteId('')).toBe(false);
    expect(isNoteId(42)).toBe(false);
    expect(isNoteId('20260806T143012123')).toBe(true);
  });

  it('recognises note files and ignores everything else in the folder', () => {
    expect(noteIdFromFileName('20260806T143012123.md')).toBe('20260806T143012123');
    expect(noteIdFromFileName('20260806T143012123-2.md')).toBe('20260806T143012123-2');
    expect(noteIdFromFileName('README.md')).toBeNull();
    expect(noteIdFromFileName('20260806T143012123.txt')).toBeNull();
    // atomicWriteFile leaves one of these in the folder during every save: an unfiltered listing
    // would flash a garbage row into the list on each keystroke.
    expect(noteIdFromFileName('.a1b2c3d4.1234.7.tmp')).toBeNull();
  });
});

describe('sortNotes', () => {
  const note = (id: string, updatedAt: string): Note => ({ id, title: id, updatedAt, size: 0 });

  it('puts the most recently updated first', () => {
    const sorted = sortNotes([
      note('a', '2026-08-01T10:00:00.000Z'),
      note('b', '2026-08-06T10:00:00.000Z'),
      note('c', '2026-08-03T10:00:00.000Z'),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks a tie on the id, newest first, and does not mutate its input', () => {
    const input = [note('20260101T000000000', 'x'), note('20260202T000000000', 'x')];
    expect(sortNotes(input).map((entry) => entry.id)).toEqual([
      '20260202T000000000',
      '20260101T000000000',
    ]);
    expect(input[0]?.id).toBe('20260101T000000000');
  });
});

describe('NotesStore', () => {
  let folder = '';
  let states: NotesState[] = [];
  let store: NotesStore;

  const target = (): NotesFolder => ({ path: folder, mayCreate: true });

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'oxum-notes-'));
    states = [];
    store = new NotesStore(target, (state) => states.push(state));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('creates, writes, lists and deletes', async () => {
    const id = await store.create();
    expect(id).not.toBeNull();
    if (id === null) return;

    store.update(id, '# Product meeting\nthe body');
    await store.flush();

    expect(await readFile(join(folder, noteFileName(id)), 'utf8')).toBe(
      '# Product meeting\nthe body',
    );
    expect(store.state().notes[0]?.title).toBe('Product meeting');

    await store.delete(id);
    expect(store.state().notes).toHaveLength(0);
    expect(await readdir(folder)).not.toContain(noteFileName(id));
  });

  it('reads a note back through open, flushing first', async () => {
    const id = await store.create();
    if (id === null) throw new Error('could not create');

    // No flush here on purpose: `open` has to do it, or a note switch inside the debounce window
    // would read the previous content.
    store.update(id, 'text not written yet');
    expect(store.hasPending()).toBe(true);

    expect(await store.open(id)).toEqual({ id, text: 'text not written yet' });
    expect(store.hasPending()).toBe(false);
  });

  it('does not resurrect a note deleted right after a keystroke', async () => {
    // The race this store is most likely to lose: a debounced write landing after the unlink.
    const id = await store.create();
    if (id === null) throw new Error('could not create');

    store.update(id, 'text that must not come back');
    await store.delete(id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await store.flush();

    expect(await readdir(folder)).not.toContain(noteFileName(id));
    expect(store.state().notes).toHaveLength(0);
  });

  it('indexes existing files and ignores foreign ones', async () => {
    await writeFile(join(folder, '20260806T143012123.md'), '# A note', 'utf8');
    await writeFile(join(folder, 'README.md'), 'not a note', 'utf8');
    await writeFile(join(folder, '.abc.1.2.tmp'), 'write in flight', 'utf8');

    const state = await store.refresh();
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0]?.title).toBe('A note');
    expect(state.error).toBeNull();
  });

  it('reports a missing folder instead of creating one it does not own', async () => {
    const missing = join(folder, 'disparu');
    const guarded = new NotesStore(
      () => ({ path: missing, mayCreate: false }),
      () => undefined,
    );

    const state = await guarded.refresh();
    expect(state.notes).toHaveLength(0);
    expect(state.error).toContain('not found');
    expect(await readdir(folder)).not.toContain('disparu');
  });

  it('pushes a state on every change so the renderer never polls', async () => {
    const id = await store.create();
    if (id === null) throw new Error('could not create');
    store.update(id, 'a');
    await store.flush();

    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states[states.length - 1]?.notes[0]?.title).toBe('a');
  });

  it('skips a write when the text has not changed', async () => {
    const id = await store.create();
    if (id === null) throw new Error('could not create');
    store.update(id, 'stable');
    await store.flush();
    const before = states.length;

    store.update(id, 'stable');
    await store.flush();
    expect(states.length).toBe(before);
  });
});
