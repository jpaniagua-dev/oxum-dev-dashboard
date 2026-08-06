import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

/**
 * Markdown styling for a *source* editor.
 *
 * The goal is legibility of structure, not a preview: headings gain weight and size while their
 * `#` markers stay visible but recessed. Nothing is hidden or replaced, so what the user sees is
 * byte-for-byte what gets copied. That is the whole reason this app edits Markdown source
 * instead of using a WYSIWYG surface with a serialiser.
 *
 * Colours are CSS custom properties rather than literals, so this single definition serves both
 * themes and switching costs one attribute change on the root element. Two compiled highlight
 * styles would otherwise need a compartment reconfiguration on every theme change.
 */
export const markdownHighlighting: Extension = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading1, fontSize: '1.5em', fontWeight: '700', color: 'var(--md-heading)' },
    { tag: tags.heading2, fontSize: '1.28em', fontWeight: '700', color: 'var(--md-heading)' },
    { tag: tags.heading3, fontSize: '1.12em', fontWeight: '600', color: 'var(--md-heading)' },
    { tag: tags.heading4, fontWeight: '600', color: 'var(--md-heading)' },
    { tag: tags.heading5, fontWeight: '600', color: 'var(--md-heading)' },
    { tag: tags.heading6, fontWeight: '600', color: 'var(--md-heading)' },

    // Structural punctuation: present, but visually recessed so the prose leads.
    { tag: tags.processingInstruction, color: 'var(--md-marker)' },
    { tag: tags.meta, color: 'var(--md-marker)' },

    { tag: tags.strong, fontWeight: '700', color: 'var(--md-strong)' },
    { tag: tags.emphasis, fontStyle: 'italic', color: 'var(--md-emphasis)' },
    { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--md-strike)' },

    { tag: tags.link, color: 'var(--md-link)', textDecoration: 'underline' },
    { tag: tags.url, color: 'var(--md-link)' },

    { tag: tags.monospace, color: 'var(--md-mono)' },
    { tag: tags.quote, color: 'var(--md-quote)', fontStyle: 'italic' },
    { tag: tags.list, color: 'var(--md-list)' },

    // Code inside fenced blocks, highlighted by the per-language parsers.
    { tag: tags.keyword, color: 'var(--code-keyword)' },
    { tag: tags.controlKeyword, color: 'var(--code-keyword)' },
    { tag: tags.definitionKeyword, color: 'var(--code-keyword)' },
    { tag: tags.string, color: 'var(--code-string)' },
    { tag: tags.number, color: 'var(--code-number)' },
    { tag: tags.bool, color: 'var(--code-number)' },
    { tag: tags.comment, color: 'var(--code-comment)', fontStyle: 'italic' },
    { tag: tags.typeName, color: 'var(--code-type)' },
    { tag: tags.className, color: 'var(--code-type)' },
    { tag: tags.propertyName, color: 'var(--code-property)' },
    { tag: tags.variableName, color: 'var(--text)' },
    { tag: tags.function(tags.variableName), color: 'var(--code-function)' },
    { tag: tags.operator, color: 'var(--code-operator)' },
    { tag: tags.punctuation, color: 'var(--code-punctuation)' },
  ]),
);

/**
 * Base editor theme for a given brightness.
 *
 * Deliberately minimal: the stylesheet already targets the `.cm-*` classes through tokens. The
 * one thing that genuinely has to change per theme is the `dark` flag, which CodeMirror consults
 * for its own built-in defaults, so this is what the theme compartment reconfigures.
 */
export function editorThemeFor(dark: boolean): Extension {
  return EditorView.theme(
    {
      '&': { color: 'var(--text)', backgroundColor: 'var(--surface)' },
      '.cm-line': { padding: '0 2px' },
      '.cm-matchingBracket': { backgroundColor: 'var(--selection)', outline: 'none' },
      // Declared here rather than in the stylesheet: `highlightActiveLine` ships its own
      // `baseTheme` rule, whose generated selector is more specific than a plain `.cm-activeLine`
      // in a stylesheet. Its default is a blue wash that belongs to no palette. Theme rules
      // outrank base-theme rules, so this is the layer where the token actually wins.
      '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
    },
    { dark },
  );
}
