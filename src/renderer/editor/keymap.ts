import { keymap } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { MarkdownCommands, type MarkdownCommandId } from './markdown-commands.js';

/*
 * Lifted from `oxum-prompt-editor`. The formatting half is verbatim, including the two comments that
 * explain the layout traps; only the app-level commands are the dashboard's own.
 */

export interface NotesCommands {
  /** Create a new note and put the caret in it. */
  newNote: () => void;
}

/**
 * Formatting shortcuts.
 *
 * `Ctrl+B`, `Ctrl+I` and `Ctrl+K` are universal, so they are kept. The list bindings use
 * **letters** (u/o/t for unordered, ordered, task) rather than the digits the Google Docs
 * convention would suggest, because digit shortcuts are layout dependent: on a Swiss/French
 * keyboard `Shift+7` is physically the `/` key, so `Ctrl+Shift+7` arrives as `Ctrl+/` and gets
 * claimed by CodeMirror's comment toggle. Letters resolve identically on every layout.
 *
 * None collide with the dashboard's own set either, which is `Alt+Shift+{d,b,w}` on `document` in
 * capture phase with an explicit `!event.ctrlKey` guard: nothing Ctrl-based is intercepted before
 * CodeMirror sees it.
 */
const FORMAT_BINDINGS: readonly { key: string; command: MarkdownCommandId }[] = [
  { key: 'Mod-b', command: 'bold' },
  { key: 'Mod-i', command: 'italic' },
  { key: 'Mod-e', command: 'code' },
  { key: 'Mod-Shift-x', command: 'strikethrough' },
  { key: 'Mod-1', command: 'h1' },
  { key: 'Mod-2', command: 'h2' },
  { key: 'Mod-3', command: 'h3' },
  { key: 'Mod-Shift-u', command: 'bulletList' },
  // Not `Mod-Shift-o`: Chromium claims it for its bookmark manager and it never reaches the
  // renderer, verified by the toolbar button working while the shortcut did nothing.
  { key: 'Mod-Shift-n', command: 'orderedList' },
  { key: 'Mod-Shift-t', command: 'taskList' },
  { key: 'Mod-Shift-.', command: 'quote' },
  { key: 'Mod-Shift-c', command: 'codeBlock' },
  { key: 'Mod-k', command: 'link' },
];

/**
 * App-level bindings.
 *
 * One command, and no `Escape`. Escape is handled on the panel element in the bubble phase instead:
 * this keymap runs at `Prec.highest`, so an `Escape` binding here would beat `searchKeymap`'s own and
 * close the whole panel while leaving the find bar open behind it.
 */
export function createAppKeymap(commands: NotesCommands): Extension {
  return keymap.of([
    { key: 'Mod-n', run: () => run(commands.newNote), preventDefault: true },

    ...FORMAT_BINDINGS.map(({ key, command }) => ({
      key,
      run: MarkdownCommands[command],
      preventDefault: true,
    })),
  ]);
}

/** Shortcut label for a formatting button's tooltip. */
export function formatShortcutLabel(command: MarkdownCommandId): string {
  const binding = FORMAT_BINDINGS.find((entry) => entry.command === command);
  if (binding === undefined) {
    return '';
  }
  return binding.key.replace('Mod', 'Ctrl').replace('Shift', 'Maj');
}

/** Runs a command and reports it as handled, so CodeMirror stops propagating the key. */
function run(command: () => void): boolean {
  command();
  return true;
}
