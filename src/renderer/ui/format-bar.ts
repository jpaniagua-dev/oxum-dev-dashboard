import type { EditorView } from '@codemirror/view';
import { MarkdownCommands, type MarkdownCommandId } from '../editor/markdown-commands.js';
import { formatShortcutLabel } from '../editor/keymap.js';
import { createElement, createIcon } from './dom.js';

/*
 * Lifted from `oxum-prompt-editor`, body unchanged. The only edits are the two imports: the
 * dashboard's `dom.ts` is a strict superset of that app's, so there is one `dom.ts` here and not two,
 * and its `createIcon` replaces the private copy this file used to carry.
 */

/** How a button renders: a typographic glyph, or an inline SVG path. */
type Face = { kind: 'glyph'; text: string; modifier?: string } | { kind: 'icon'; path: string };

interface ButtonSpec {
  readonly command: MarkdownCommandId;
  readonly label: string;
  readonly face: Face;
}

/**
 * Buttons, grouped by what they do to the document.
 *
 * Glyphs beat icons for the inline marks: a bold **B** and an italic *I* are understood
 * instantly and need no legend, whereas an abstract stroke for "strikethrough" does not. Icons
 * are reserved for the structural actions, where there is no letter to lean on.
 */
const GROUPS: readonly (readonly ButtonSpec[])[] = [
  [
    { command: 'bold', label: 'Gras', face: { kind: 'glyph', text: 'B' } },
    { command: 'italic', label: 'Italique', face: { kind: 'glyph', text: 'I', modifier: 'italic' } },
    {
      command: 'strikethrough',
      label: 'Strikethrough',
      face: { kind: 'glyph', text: 'S', modifier: 'strike' },
    },
    {
      command: 'code',
      label: 'Code inline',
      face: { kind: 'glyph', text: '`', modifier: 'mono' },
    },
  ],
  [
    { command: 'h1', label: 'Titre 1', face: { kind: 'glyph', text: 'H1' } },
    { command: 'h2', label: 'Titre 2', face: { kind: 'glyph', text: 'H2' } },
    { command: 'h3', label: 'Titre 3', face: { kind: 'glyph', text: 'H3' } },
  ],
  [
    {
      command: 'bulletList',
      label: 'Bulleted list',
      face: {
        kind: 'icon',
        path: 'M3 4h.01M3 8h.01M3 12h.01M6.5 4H13M6.5 8H13M6.5 12H13',
      },
    },
    {
      command: 'orderedList',
      label: 'Numbered list',
      face: {
        kind: 'icon',
        path: 'M2 3.5h1V6M2 6h2M2 9.5h2v1.2L2 12h2M6.5 4H13M6.5 8H13M6.5 12H13',
      },
    },
    {
      command: 'taskList',
      label: 'Checkbox',
      face: {
        kind: 'icon',
        path: 'M2 3h3.4v3.4H2zM2.6 4.7l1 1 1.6-1.9M2 9.6h3.4V13H2M7.6 4.7H14M7.6 11.3H14',
      },
    },
  ],
  [
    {
      command: 'quote',
      label: 'Citation',
      face: { kind: 'icon', path: 'M3 3v10M6.5 5H13M6.5 8.5H13M6.5 12H10' },
    },
    {
      command: 'codeBlock',
      label: 'Code block',
      face: { kind: 'icon', path: 'M5.8 4.5L2.5 8l3.3 3.5M10.2 4.5L13.5 8l-3.3 3.5' },
    },
    {
      command: 'link',
      label: 'Lien',
      face: {
        kind: 'icon',
        path: 'M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.6 2.6 0 0 0-3.7-3.7l-.8.8M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.4 8.9a2.6 2.6 0 0 0 3.7 3.7l.8-.8',
      },
    },
  ],
];

/**
 * Builds the formatting bar.
 *
 * Buttons run the very same commands as the keyboard shortcuts, so there is one implementation
 * per action and no chance of the two paths drifting. After every click focus returns to the
 * editor: a formatting button that steals focus would break the next keystroke.
 */
export function mountFormatBar(container: HTMLElement, getView: () => EditorView | null): void {
  container.replaceChildren();

  GROUPS.forEach((group, index) => {
    if (index > 0) {
      container.append(createElement('span', { className: 'format-bar__separator' }));
    }

    const groupElement = createElement('div', { className: 'format-bar__group' });
    for (const spec of group) {
      groupElement.append(createButton(spec, getView));
    }
    container.append(groupElement);
  });
}

function createButton(spec: ButtonSpec, getView: () => EditorView | null): HTMLButtonElement {
  const shortcut = formatShortcutLabel(spec.command);
  const button = createElement('button', {
    className:
      spec.face.kind === 'glyph'
        ? `format-button format-button--glyph${spec.face.modifier === undefined ? '' : ` format-button--${spec.face.modifier}`}`
        : 'format-button',
    title: shortcut.length > 0 ? `${spec.label} (${shortcut})` : spec.label,
  });
  button.type = 'button';
  button.setAttribute('aria-label', spec.label);

  if (spec.face.kind === 'glyph') {
    button.textContent = spec.face.text;
  } else {
    button.append(createIcon(spec.face.path));
  }

  // `mousedown` rather than `click`, so the editor never loses its selection to the button: by
  // the time `click` fires the document selection has already collapsed.
  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const view = getView();
    if (view === null) {
      return;
    }
    MarkdownCommands[spec.command](view);
    view.focus();
  });

  return button;
}
