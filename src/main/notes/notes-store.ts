import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Note, NoteContent, NoteId, NotesState } from '@shared/contracts.js';
import { atomicWriteFile, ensureDirectory } from '../store/atomic-write.js';
import { isNoteId, makeNoteId, noteFileName, noteIdFromFileName } from './note-id.js';
import { deriveNoteTitle, sortNotes } from './note-title.js';

/**
 * Milliseconds between the last keystroke and the write.
 *
 * The same 300 ms the prompt editor settled on: short enough that "I typed it, it is saved" holds
 * even for an abrupt kill, long enough that a fast typist produces a handful of writes rather than
 * one per character.
 */
const WRITE_DEBOUNCE_MS = 300;

/** Beyond this, the body is not read to build the list. Notes are prose; anything larger is not one. */
const MAX_INDEXED_BYTES = 2 * 1024 * 1024;

export interface NotesFolder {
  readonly path: string;
  /**
   * Whether the store may create this folder when it is missing.
   *
   * True only for the app's own default folder. A folder the user picked and then deleted is not
   * ours to silently re-create somewhere else on their disk.
   */
  readonly mayCreate: boolean;
}

/**
 * Owns the notes on disk.
 *
 * **Imports no Electron**, which is what lets the round-trip test run against a real temp folder in
 * the plain node test environment. The folder arrives as a thunk for the same reason `profiles()` is
 * one in `index.ts`: it is re-read on each use, so a settings change takes effect without a restart.
 *
 * The debounce lives here rather than in the renderer because the renderer dies routinely, several
 * times a minute under `electron-vite dev --watch`. With the timer on this side, a renderer crash
 * mid-sentence still loses nothing, and quit has a single authoritative buffer to flush.
 */
export class NotesStore {
  private index = new Map<NoteId, Note>();
  private error: string | null = null;
  /** Text typed but not yet on disk, keyed by note. */
  private pending = new Map<NoteId, string>();
  /** Last text actually written, so an unchanged buffer does not cause a write. */
  private lastWritten = new Map<NoteId, string>();
  private timer: NodeJS.Timeout | null = null;
  /** Serialises writes: two overlapping drains would race on the same files. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly folder: () => NotesFolder,
    private readonly onChanged: (state: NotesState) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  state(): NotesState {
    return {
      folder: this.folder().path,
      notes: sortNotes([...this.index.values()]),
      error: this.error,
    };
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** Rebuilds the index from disk. */
  async refresh(): Promise<NotesState> {
    const { path, mayCreate } = this.folder();
    this.index = new Map();
    this.error = null;

    try {
      if (mayCreate) {
        await ensureDirectory(path);
      }
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        const id = noteIdFromFileName(entry.name);
        if (id === null) {
          continue;
        }
        const note = await this.readNote(path, id);
        if (note !== null) {
          this.index.set(id, note);
        }
      }
    } catch (error) {
      this.error = describeFolderError(error, path);
    }

    const state = this.state();
    this.onChanged(state);
    return state;
  }

  /**
   * Reads one note.
   *
   * Flushes first: switching notes inside the debounce window would otherwise read the previous
   * content of the note being opened, or leave the one being left unsaved. Callers cannot get the
   * order wrong because there is only one call.
   */
  async open(id: NoteId): Promise<NoteContent | null> {
    if (!isNoteId(id)) {
      return null;
    }
    await this.flush();
    try {
      const text = await readFile(join(this.folder().path, noteFileName(id)), 'utf8');
      return { id, text };
    } catch {
      return null;
    }
  }

  /** Creates an empty note and returns its id, or null when the folder cannot be written. */
  async create(): Promise<NoteId | null> {
    const { path, mayCreate } = this.folder();
    const id = makeNoteId(this.now(), [...this.index.keys()]);
    try {
      if (mayCreate) {
        await ensureDirectory(path);
      }
      // Written immediately rather than on first keystroke: a note that exists in the list but not on
      // disk would be a second kind of note, and every read path would have to know about it.
      await atomicWriteFile(join(path, noteFileName(id)), '');
    } catch (error) {
      this.error = describeFolderError(error, path);
      this.onChanged(this.state());
      return null;
    }

    this.lastWritten.set(id, '');
    this.index.set(id, this.buildNote(id, ''));
    this.error = null;
    this.onChanged(this.state());
    return id;
  }

  /** Records typed text and arms the debounce. Never touches the disk itself. */
  update(id: NoteId, text: string): void {
    if (!isNoteId(id) || !this.index.has(id)) {
      return;
    }
    this.pending.set(id, text);
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, WRITE_DEBOUNCE_MS);
    }
  }

  /** Writes everything pending. Resolves once the bytes are on disk. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.writeChain = this.writeChain.then(() => this.drain());
    return this.writeChain;
  }

  /**
   * Deletes a note.
   *
   * The pending buffer is dropped **first**. Getting that order wrong lets a debounced write land a
   * few hundred milliseconds later and resurrect the file, which is the single most likely bug in
   * this store and the reason it has its own test.
   */
  async delete(id: NoteId): Promise<boolean> {
    if (!isNoteId(id)) {
      return false;
    }
    this.pending.delete(id);
    this.lastWritten.delete(id);
    this.index.delete(id);

    try {
      await unlink(join(this.folder().path, noteFileName(id)));
    } catch (error) {
      // Already gone is a success: the caller wanted it absent, and it is.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.error = describeFolderError(error, this.folder().path);
      }
    }
    this.onChanged(this.state());
    return true;
  }

  /**
   * Applies a folder change.
   *
   * Flushes before rebuilding, and the order matters: the pending writes carry paths resolved at
   * write time, so flushing first is what makes the last keystrokes land in the folder they were
   * typed in rather than following the user to the new one.
   */
  async reopen(): Promise<NotesState> {
    await this.flush();
    this.pending.clear();
    this.lastWritten.clear();
    return this.refresh();
  }

  private async drain(): Promise<void> {
    if (this.pending.size === 0) {
      return;
    }
    const batch = [...this.pending.entries()];
    this.pending.clear();
    const { path } = this.folder();
    let touched = false;

    for (const [id, text] of batch) {
      if (this.lastWritten.get(id) === text) {
        continue;
      }
      try {
        await atomicWriteFile(join(path, noteFileName(id)), text);
        this.lastWritten.set(id, text);
        this.index.set(id, this.buildNote(id, text));
        touched = true;
      } catch (error) {
        // `lastWritten` is deliberately left untouched, so the next tick retries this note.
        this.error = describeFolderError(error, path);
        touched = true;
      }
    }

    if (touched) {
      this.onChanged(this.state());
    }
  }

  /** Builds a list entry from text already in memory, with no disk read. */
  private buildNote(id: NoteId, text: string): Note {
    return {
      id,
      title: deriveNoteTitle(text),
      updatedAt: this.now().toISOString(),
      size: Buffer.byteLength(text, 'utf8'),
    };
  }

  private async readNote(folder: string, id: NoteId): Promise<Note | null> {
    const file = join(folder, noteFileName(id));
    try {
      const info = await stat(file);
      if (info.size > MAX_INDEXED_BYTES) {
        return { id, title: '(file too large)', updatedAt: info.mtime.toISOString(), size: info.size };
      }
      const text = await readFile(file, 'utf8');
      return { id, title: deriveNoteTitle(text), updatedAt: info.mtime.toISOString(), size: info.size };
    } catch {
      // One unreadable file drops out of the list rather than emptying it.
      return null;
    }
  }
}

/** Turns a filesystem failure into something the panel can display. */
function describeFolderError(error: unknown, path: string): string {
  const code = (error as NodeJS.ErrnoException).code ?? '';
  if (code === 'ENOENT') {
    return `Notes folder not found: ${path}`;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `Notes folder not readable: ${path}`;
  }
  return `Could not read the notes: ${error instanceof Error ? error.message : String(error)}`;
}
