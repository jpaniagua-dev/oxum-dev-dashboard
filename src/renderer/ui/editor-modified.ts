import { editorModified } from '@shared/explorer.js';
import type { TerminalView } from './terminal-view.js';

/** How long the screen has to be quiet before it is read: an editor redraws in bursts. */
const SETTLE_MS = 120;

/**
 * Follows whether the editor in a terminal holds unsaved changes, and says so when it changes.
 *
 * Shared by the Explorer's panel and the editor windows, which both need the same answer from the
 * same screen. The visible rows are read once the output settles, through `editorModified`, and only a
 * change is reported: the status line is redrawn on every keystroke, its meaning rarely.
 */
export function watchModified(
  view: TerminalView,
  onChange: (modified: boolean) => void,
): { reset: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = false;
  const read = (): void => {
    timer = null;
    const buffer = view.term.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < view.term.rows; row += 1) {
      lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
    }
    const modified = editorModified(lines) === true;
    if (modified !== last) {
      last = modified;
      onChange(modified);
    }
  };
  view.term.onWriteParsed(() => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(read, SETTLE_MS);
  });
  return {
    /** Forgets the last answer, for a new editor starting on a clean screen. */
    reset: () => {
      last = false;
    },
  };
}
