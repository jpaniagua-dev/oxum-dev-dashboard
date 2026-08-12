import type { NoteId, NotesState } from '@shared/contracts.js';
import { clearChildren, createElement, hitsInteractive } from './dom.js';
import { describeAge } from './pull-list.js';

export interface NotesListActions {
  onSelect: (id: NoteId) => void;
  onDelete: (id: NoteId) => void;
}

/**
 * Renders the note list.
 *
 * Same grammar as the pull request repository list: selectable rows, an active state, one control per
 * row. **No import-time side effect** in this module, deliberately: `context-menu.ts` broke two
 * DOM-free test files by registering listeners at module scope, and that is a mistake worth making
 * once.
 */
export function renderNotesList(
  host: HTMLElement,
  state: NotesState,
  selectedId: NoteId | null,
  actions: NotesListActions,
): void {
  clearChildren(host);

  if (state.error !== null) {
    host.append(createElement('p', { className: 'notes__error', text: state.error }));
    return;
  }

  if (state.notes.length === 0) {
    host.append(
      createElement('p', { className: 'notes__empty', text: 'No note. Click "+ Note".' }),
    );
    return;
  }

  for (const note of state.notes) {
    const row = createElement('div', {
      className: note.id === selectedId ? 'note-row note-row--active' : 'note-row',
      title: note.title,
    });
    row.append(createElement('span', { className: 'note-row__title', text: note.title }));
    row.append(createElement('span', { className: 'note-row__age', text: describeAge(note.updatedAt) }));

    // A real button rather than a nested clickable: a `<button>` inside a `<button>` is invalid HTML
    // and browsers silently rearrange it, which is why the row itself is a `div`.
    const remove = createElement('button', {
      className: 'note-row__delete',
      text: '×',
      title: 'Delete this note',
    });
    remove.type = 'button';
    remove.setAttribute('aria-label', `Delete ${note.title}`);
    remove.addEventListener('click', () => actions.onDelete(note.id));
    row.append(remove);

    row.addEventListener('click', (event) => {
      // Without this the delete button would also select the note on its way out of the list.
      if (hitsInteractive(event)) {
        return;
      }
      actions.onSelect(note.id);
    });
    host.append(row);
  }
}
