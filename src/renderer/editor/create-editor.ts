import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { bracketMatching, indentUnit } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  keymap,
  placeholder,
  rectangularSelection,
} from '@codemirror/view';
import { editorThemeFor, markdownHighlighting } from './markdown-theme.js';

/*
 * Lifted from `oxum-prompt-editor`, whose editor this is.
 *
 * Kept as close to the source as possible so a future re-sync stays a diff rather than an
 * archaeology exercise. Three deliberate divergences, each marked below: no `@codemirror/language-data`
 * (it is most of that app's bundle and a note has no fenced Rust in it), no font-size compartment (the
 * dashboard's font setting is the terminal's, which has nothing to do with notes), and a `loadDocument`
 * that swaps the whole state rather than the document.
 */

export interface EditorCallbacks {
  /** Fired on every document change, for autosave and the counters. */
  onChange: (text: string) => void;
}

const PLACEHOLDER_TEXT = 'Écris ta note ici. Elle est enregistrée toute seule.';

/** Holds the per-theme extension so it can be swapped without rebuilding the editor. */
const themeCompartment = new Compartment();

export interface EditorOptions {
  parent: HTMLElement;
  initialText: string;
  dark: boolean;
  appKeymap: Extension;
  callbacks: EditorCallbacks;
}

/**
 * The extension list, extracted so `loadDocument` can rebuild a state with exactly the same one.
 *
 * `basicSetup` is deliberately not used: it brings line numbers, a fold gutter, an autocomplete popup
 * and a lint gutter, all of which belong in a code editor and would turn a writing surface into an
 * IDE. Each extension below is here for a reason.
 */
function buildExtensions(options: EditorOptions): Extension[] {
  return [
    // The app's bindings must win over every extension default. Array order is NOT enough:
    // `searchKeymap` also claims `Mod-Shift-l` (and `Mod-d`, `Mod-f`, `Mod-g`), and it was observed
    // swallowing the task-list shortcut even with this keymap listed first. `Prec.highest` is the
    // documented way to state the priority explicitly.
    Prec.highest(options.appKeymap),

    // Markdown, without per-language fenced-block highlighting: `@codemirror/language-data` alone is
    // ~1.4 MB across 120 lazy chunks, and notes are prose. Re-enabling it is one argument:
    // `codeLanguages: languages`.
    markdown({ base: markdownLanguage, addKeymap: false }),
    // List and quote continuation on Enter, which is what makes writing structured notes bearable.
    keymap.of(markdownKeymap),

    history(),
    keymap.of([...historyKeymap, ...searchKeymap, ...defaultKeymap, indentWithTab]),

    // Soft wrap: notes are prose, so a horizontal scrollbar would be a bug.
    EditorView.lineWrapping,
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    bracketMatching(),
    search({ top: true }),
    indentUnit.of('  '),
    placeholder(PLACEHOLDER_TEXT),
    // Required for multi-cursor formatting: without it a state keeps only its main range.
    EditorState.allowMultipleSelections.of(true),

    themeCompartment.of(editorThemeFor(options.dark)),
    markdownHighlighting,

    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        options.callbacks.onChange(update.state.doc.toString());
      }
    }),
  ];
}

/** Builds the editor. */
export function createEditor(options: EditorOptions): EditorView {
  return new EditorView({
    parent: options.parent,
    state: EditorState.create({ doc: options.initialText, extensions: buildExtensions(options) }),
  });
}

/**
 * Shows a different note in an existing editor.
 *
 * `setState`, not `replaceAll`. A whole-document replacement is one transaction on the *existing*
 * state, so the undo history survives it: pressing `Ctrl+Z` after switching notes would type note A's
 * content into note B. Building a fresh state discards that history, which is the correct semantics
 * for "this is a different document".
 *
 * The caret goes to the top rather than the end: coming back to a long note should show its
 * beginning.
 */
export function loadDocument(view: EditorView, options: EditorOptions, text: string): void {
  view.setState(EditorState.create({ doc: text, extensions: buildExtensions(options) }));
  view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
}

/** Swaps the editor's light/dark base theme in place, preserving document and undo history. */
export function applyEditorTheme(view: EditorView, dark: boolean): void {
  view.dispatch({ effects: themeCompartment.reconfigure(editorThemeFor(dark)) });
}

/** Current document text. */
export function getText(view: EditorView): string {
  return view.state.doc.toString();
}

/**
 * Replaces the whole document in a single transaction.
 *
 * One transaction means one undo step: whatever this writes, `Ctrl+Z` takes back in full. For a
 * change *within* a note; switching notes is `loadDocument`.
 */
export function replaceAll(view: EditorView, text: string): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: text.length },
    scrollIntoView: true,
  });
}

/** Puts the caret at the end and focuses. */
export function focusAtEnd(view: EditorView): void {
  view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
  view.focus();
}
