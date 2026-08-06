import { EditorSelection, type ChangeSpec, type EditorState, type SelectionRange } from '@codemirror/state';
import type { Command, EditorView } from '@codemirror/view';

/**
 * Markdown formatting commands.
 *
 * Two invariants govern everything here:
 *
 * 1. **One transaction per action.** Every command dispatches a single update, so a single
 *    `Ctrl+Z` undoes it. Applying a prefix to twelve selected lines must not cost twelve
 *    undo steps.
 * 2. **Every command toggles.** Pressing bold on already-bold text removes the markers
 *    rather than nesting them into `****text****`, which is what naive wrapping produces.
 *
 * Commands operate on all selection ranges, because the editor allows multiple cursors.
 */

/* ------------------------------------------------------------------ *
 * Inline wrapping (bold, italic, strikethrough, inline code)
 * ------------------------------------------------------------------ */

/**
 * Characters that do not belong to a "word" when expanding a bare cursor.
 *
 * Markdown markers (`*`, `~`, backtick, `_`) are boundaries on purpose: with the caret inside
 * `**mot**`, the word must come out as `mot` so the surrounding markers are recognised and the
 * command unwraps. Treating them as word characters instead yields `****mot****`.
 */
const WORD_BOUNDARY = /[\s.,;:!?()[\]{}'"«»*~`_]/;

/**
 * Builds a command wrapping each selection in `marker`, or unwrapping it when already wrapped.
 *
 * With an empty selection the surrounding word is used as the target; if there is no word
 * either, the markers are inserted and the caret is parked between them so typing continues
 * inside the emphasis.
 */
export function toggleInlineMarker(marker: string): Command {
  return (view: EditorView): boolean => {
    view.dispatch(
      view.state.changeByRange((range) => {
        const target = expandToWord(view.state, range);
        const text = view.state.sliceDoc(target.from, target.to);

        if (isWrapped(view.state, target, marker)) {
          // Unwrap: drop the markers on both sides and keep the inner text selected.
          return {
            changes: [
              { from: target.from - marker.length, to: target.from, insert: '' },
              { from: target.to, to: target.to + marker.length, insert: '' },
            ],
            range: EditorSelection.range(
              target.from - marker.length,
              target.to - marker.length,
            ),
          };
        }

        if (text.length === 0) {
          // Nothing to wrap: leave the caret between the markers.
          const caret = target.from + marker.length;
          return {
            changes: { from: target.from, insert: marker + marker },
            range: EditorSelection.cursor(caret),
          };
        }

        return {
          changes: { from: target.from, to: target.to, insert: marker + text + marker },
          range: EditorSelection.range(
            target.from + marker.length,
            target.to + marker.length,
          ),
        };
      }),
      { scrollIntoView: true, userEvent: 'input.format' },
    );
    return true;
  };
}

/** True when `marker` sits immediately before and after the range. */
function isWrapped(
  state: EditorState,
  range: { from: number; to: number },
  marker: string,
): boolean {
  const before = state.sliceDoc(Math.max(0, range.from - marker.length), range.from);
  const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + marker.length));
  if (before !== marker || after !== marker) {
    return false;
  }
  // `*a*` wrapped in `*` would read as bold from the outside; require the inner text to be
  // non-empty so toggling italic on `**` does not silently strip a bold marker.
  return range.to > range.from;
}

/**
 * Grows an empty selection to the word under the caret.
 *
 * Non-empty selections are returned untouched: the user's explicit choice always wins.
 */
function expandToWord(state: EditorState, range: SelectionRange): { from: number; to: number } {
  if (!range.empty) {
    return { from: range.from, to: range.to };
  }

  const line = state.doc.lineAt(range.head);
  const offset = range.head - line.from;
  let from = offset;
  let to = offset;

  while (from > 0 && !WORD_BOUNDARY.test(line.text.charAt(from - 1))) {
    from -= 1;
  }
  while (to < line.text.length && !WORD_BOUNDARY.test(line.text.charAt(to))) {
    to += 1;
  }

  return { from: line.from + from, to: line.from + to };
}

/* ------------------------------------------------------------------ *
 * Line prefixes (headings, lists, quote)
 * ------------------------------------------------------------------ */

/**
 * Prefixes that belong to the same family and therefore replace one another.
 *
 * Without this, turning an `## H2` into an `### H3` would yield `### ## H2`. Headings replace
 * headings, list markers replace list markers, and a quote can coexist with either.
 */
const PREFIX_FAMILIES: readonly RegExp[] = [
  /^#{1,6}\s+/, // headings
  /^(?:[-*+]\s\[[ xX]\]\s|[-*+]\s|\d+\.\s)/, // bullet, task and ordered lists
  /^>\s?/, // quote
];

/**
 * Builds a command applying `prefix` to every line touched by the selection.
 *
 * If all those lines already carry the prefix, it is removed instead, so the button reads as
 * a toggle. Ordered lists renumber from 1 across the affected block.
 */
export function toggleLinePrefix(prefix: string): Command {
  const family = familyOf(prefix);

  return (view: EditorView): boolean => {
    const lines = selectedLines(view.state);
    const alreadyApplied = lines.every((line) => carriesPrefix(family, line.text, prefix));
    const changes: ChangeSpec[] = [];

    let ordinal = 1;
    for (const line of lines) {
      const existing = family.exec(line.text);
      const existingLength = existing === null ? 0 : existing[0].length;

      if (alreadyApplied) {
        if (existingLength > 0) {
          changes.push({ from: line.from, to: line.from + existingLength, insert: '' });
        }
        continue;
      }

      const insert = prefix === ORDERED_PREFIX ? `${ordinal}. ` : prefix;
      ordinal += 1;
      changes.push({ from: line.from, to: line.from + existingLength, insert });
    }

    if (changes.length === 0) {
      return true;
    }

    view.dispatch(view.state.update({
      changes,
      // `map` keeps the selection anchored to the same text after the prefixes shift it.
      selection: view.state.selection.map(view.state.changes(changes)),
      scrollIntoView: true,
      userEvent: 'input.format',
    }));
    return true;
  };
}

/** Sentinel for ordered lists, whose visible prefix depends on the line index. */
export const ORDERED_PREFIX = '1. ';

/** Every line intersecting the selection, deduplicated across multiple ranges. */
function selectedLines(state: EditorState): { from: number; text: string }[] {
  const seen = new Set<number>();
  const lines: { from: number; text: string }[] = [];

  for (const range of state.selection.ranges) {
    let position = range.from;
    while (position <= range.to) {
      const line = state.doc.lineAt(position);
      if (!seen.has(line.from)) {
        seen.add(line.from);
        lines.push({ from: line.from, text: line.text });
      }
      if (line.to >= range.to) {
        break;
      }
      position = line.to + 1;
    }
  }

  return lines.sort((a, b) => a.from - b.from);
}

/** Which family a prefix belongs to, used to replace rather than stack markers. */
function familyOf(prefix: string): RegExp {
  const match = PREFIX_FAMILIES.find((pattern) => pattern.test(prefix));
  // A prefix outside every family only ever replaces itself.
  return match ?? new RegExp(`^${escapeRegExp(prefix)}`);
}

/**
 * True when the line already carries exactly this prefix, and not merely one starting with it.
 *
 * The comparison runs against the prefix the family regex actually matched, not against
 * `startsWith`. A task item `- [ ] x` starts with `- `, so a naive check would report a bullet
 * list as already applied and clear the line instead of converting the task into a bullet.
 */
function carriesPrefix(family: RegExp, text: string, prefix: string): boolean {
  const matched = family.exec(text)?.[0] ?? '';
  if (prefix === ORDERED_PREFIX) {
    return /^\d+\.\s$/.test(matched);
  }
  return matched === prefix;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ *
 * Blocks and links
 * ------------------------------------------------------------------ */

/**
 * Wraps the selection in a fenced code block, or unwraps an existing one.
 *
 * The fence goes on its own lines because ``` inline would not parse as a block.
 */
export const toggleCodeBlock: Command = (view: EditorView): boolean => {
  const { state } = view;
  const range = state.selection.main;
  const startLine = state.doc.lineAt(range.from);
  const endLine = state.doc.lineAt(range.to);

  const lineBefore = startLine.number > 1 ? state.doc.line(startLine.number - 1) : null;
  const lineAfter = endLine.number < state.doc.lines ? state.doc.line(endLine.number + 1) : null;

  if (
    lineBefore !== null &&
    lineAfter !== null &&
    /^```/.test(lineBefore.text) &&
    /^```\s*$/.test(lineAfter.text)
  ) {
    view.dispatch({
      changes: [
        { from: lineBefore.from, to: startLine.from, insert: '' },
        { from: endLine.to, to: lineAfter.to, insert: '' },
      ],
      userEvent: 'input.format',
    });
    return true;
  }

  const body = state.sliceDoc(startLine.from, endLine.to);
  view.dispatch({
    changes: { from: startLine.from, to: endLine.to, insert: `\`\`\`\n${body}\n\`\`\`` },
    // Caret parked after the opening fence, ready for a language identifier.
    selection: EditorSelection.cursor(startLine.from + 3),
    scrollIntoView: true,
    userEvent: 'input.format',
  });
  return true;
};

/**
 * Turns the selection into a Markdown link.
 *
 * The selected text becomes the label and the caret lands inside the empty parentheses, which
 * is where the user needs to type next. A selection that already looks like a URL becomes the
 * target instead, with the caret in the label.
 */
export const insertLink: Command = (view: EditorView): boolean => {
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);

      if (text.length === 0) {
        return {
          changes: { from: range.from, insert: '[](' + ')' },
          range: EditorSelection.cursor(range.from + 1),
        };
      }

      if (/^(?:https?:\/\/|www\.|mailto:)\S+$/i.test(text)) {
        return {
          changes: { from: range.from, to: range.to, insert: `[](${text})` },
          range: EditorSelection.cursor(range.from + 1),
        };
      }

      return {
        changes: { from: range.from, to: range.to, insert: `[${text}]()` },
        range: EditorSelection.cursor(range.from + text.length + 3),
      };
    }),
    { scrollIntoView: true, userEvent: 'input.format' },
  );
  return true;
};

/* ------------------------------------------------------------------ *
 * Public command set
 * ------------------------------------------------------------------ */

/** Every formatting action, keyed by the id the toolbar and keymap both use. */
export const MarkdownCommands = {
  bold: toggleInlineMarker('**'),
  italic: toggleInlineMarker('*'),
  strikethrough: toggleInlineMarker('~~'),
  code: toggleInlineMarker('`'),
  h1: toggleLinePrefix('# '),
  h2: toggleLinePrefix('## '),
  h3: toggleLinePrefix('### '),
  bulletList: toggleLinePrefix('- '),
  orderedList: toggleLinePrefix(ORDERED_PREFIX),
  taskList: toggleLinePrefix('- [ ] '),
  quote: toggleLinePrefix('> '),
  codeBlock: toggleCodeBlock,
  link: insertLink,
} as const;

export type MarkdownCommandId = keyof typeof MarkdownCommands;
