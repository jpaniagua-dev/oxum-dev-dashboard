import type { EditorView } from '@codemirror/view';
import type { NoteId, NotesState, ResolvedTheme } from '@shared/contracts.js';
import {
  applyEditorTheme,
  createEditor,
  loadDocument,
  type EditorOptions,
} from '../editor/create-editor.js';
import { createAppKeymap } from '../editor/keymap.js';
import { mountFormatBar } from './format-bar.js';
import { renderNotesList } from './notes-list.js';

export interface NotesPanelActions {
  /** Fire-and-forget: the debounce and the durability live in the main process. */
  onText: (id: NoteId, text: string) => void;
  onCreate: () => Promise<NoteId | null>;
  onOpen: (id: NoteId) => Promise<string | null>;
  onDelete: (id: NoteId) => Promise<boolean>;
}

/**
 * The notes side panel: a list on top, a markdown editor below.
 *
 * Owns the single `EditorView` for the whole panel. It is created once and re-pointed at a different
 * document when the selection changes, never rebuilt: an editor is expensive, and more importantly
 * rebuilding it would drop the caret and the scroll position on every click in the list.
 */
export class NotesPanel {
  private view: EditorView | null = null;
  private selected: NoteId | null = null;
  private state: NotesState;
  private theme: ResolvedTheme;

  constructor(
    private readonly hosts: {
      list: HTMLElement;
      formatBar: HTMLElement;
      surface: HTMLElement;
      status: HTMLElement;
      newButton: HTMLElement;
      panel: HTMLElement;
    },
    private readonly actions: NotesPanelActions,
    initial: NotesState,
    theme: ResolvedTheme,
  ) {
    this.state = initial;
    this.theme = theme;

    mountFormatBar(this.hosts.formatBar, () => this.view);
    this.hosts.newButton.addEventListener('click', () => void this.create());

    /*
     * Escape lives here, on the panel, in the bubble phase.
     *
     * Not in the CodeMirror keymap: that one runs at `Prec.highest`, so it would beat the search
     * extension's own Escape and close the panel while leaving the find bar open behind it. Checking
     * for an open panel first means the first Escape closes the find bar and the second closes the
     * notes.
     */
    this.hosts.panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || this.hosts.panel.querySelector('.cm-panels') !== null) {
        return;
      }
      this.hosts.panel.dispatchEvent(new CustomEvent('notes-escape', { bubbles: true }));
    });

    this.renderList();
    this.renderStatus();
  }

  /**
   * Applies a pushed list.
   *
   * Safe to call while the user is typing, and that is structural rather than careful: `NotesState`
   * carries no note body, so there is nothing in this payload that could overwrite the editor.
   */
  apply(state: NotesState): void {
    this.state = state;
    if (this.selected !== null && !state.notes.some((note) => note.id === this.selected)) {
      this.selected = null;
      this.showText('');
    }
    this.renderList();
    this.renderStatus();
  }

  setTheme(theme: ResolvedTheme): void {
    this.theme = theme;
    if (this.view !== null) {
      applyEditorTheme(this.view, theme === 'dark');
    }
  }

  /** Opens the most recent note, used when the panel is shown with nothing selected. */
  async openFirst(): Promise<void> {
    const first = this.state.notes[0];
    if (this.selected === null && first !== undefined) {
      await this.select(first.id);
    }
  }

  focus(): void {
    this.view?.focus();
  }

  async create(): Promise<void> {
    const id = await this.actions.onCreate();
    if (id === null) {
      return;
    }
    this.selected = id;
    this.showText('');
    this.renderList();
    this.view?.focus();
  }

  private async select(id: NoteId): Promise<void> {
    const text = await this.actions.onOpen(id);
    if (text === null) {
      return;
    }
    this.selected = id;
    this.showText(text);
    this.renderList();
    this.renderStatus();
    this.view?.focus();
  }

  private async remove(id: NoteId): Promise<void> {
    const deleted = await this.actions.onDelete(id);
    if (deleted && this.selected === id) {
      this.selected = null;
      this.showText('');
    }
  }

  /** Puts text in the editor, creating it on first use. */
  private showText(text: string): void {
    const options: EditorOptions = {
      parent: this.hosts.surface,
      initialText: text,
      dark: this.theme === 'dark',
      appKeymap: createAppKeymap({ newNote: () => void this.create() }),
      callbacks: {
        onChange: (next) => {
          if (this.selected !== null) {
            this.actions.onText(this.selected, next);
          }
        },
      },
    };

    if (this.view === null) {
      this.view = createEditor(options);
      return;
    }
    loadDocument(this.view, options, text);
  }

  private renderList(): void {
    renderNotesList(this.hosts.list, this.state, this.selected, {
      onSelect: (id) => void this.select(id),
      onDelete: (id) => void this.remove(id),
    });
  }

  private renderStatus(): void {
    const count = this.state.notes.length;
    this.hosts.status.textContent =
      count === 0 ? this.state.folder : `${count} note${count > 1 ? 's' : ''} · ${this.state.folder}`;
  }
}
