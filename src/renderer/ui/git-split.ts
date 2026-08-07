/** Narrowest useful working column: below this a file path stops being readable at all. */
const MIN_LIST = 240;
/**
 * Room the diff column always keeps.
 *
 * Same idea as `WORKSPACE_RESERVE` for the notes: the point of the third column is to be *read*, so
 * "the diff stays usable" has to be a clamp rather than a hope. Dragging the splitter to the right
 * edge would otherwise leave a column too narrow to hold a line of code.
 */
const DIFF_RESERVE = 280;

export interface GitSplitGeometry {
  /** Pointer position in viewport coordinates. */
  readonly pointerX: number;
  /** Left edge of the working column. */
  readonly listLeft: number;
  /** Right edge of the whole panel, where the diff column ends. */
  readonly panelRight: number;
}

/**
 * Width the working column should take for a pointer at `pointerX`.
 *
 * The working column is the pane on the **left** of this separator, so its width grows as the pointer
 * moves right. That is the opposite direction from `resolveSidebarWidth`, whose panel is anchored to
 * the right edge — and getting a resizer's direction backwards has already happened once in this
 * codebase, which is why all three of them are pure functions with a test rather than arithmetic
 * buried in a pointer handler.
 */
export function resolveGitListWidth(geometry: GitSplitGeometry): number {
  return clampGitListWidth(
    geometry.pointerX - geometry.listLeft,
    geometry.panelRight - geometry.listLeft,
  );
}

/**
 * Clamps a stored or stepped width against the same bounds, with no pointer involved.
 *
 * `available` is everything the two columns share. When the window is too narrow to honour both
 * minimums, `MIN_LIST` wins: a list is what you navigate with, and a diff column of nothing is
 * recoverable by dragging while a list of nothing is not.
 */
export function clampGitListWidth(width: number, available: number): number {
  const max = Math.max(MIN_LIST, available - DIFF_RESERVE);
  return Math.min(Math.max(width, MIN_LIST), max);
}

/**
 * Makes the boundary between the working column and the diff draggable.
 *
 * The width is written to a custom property rather than to the column element: the two columns are
 * cells of one grid, so their share is a property of the **grid**, and setting a width on a grid item
 * would fight the track sizing instead of driving it.
 */
export function attachGitSplitter(options: {
  handle: HTMLElement;
  /** The grid that owns both columns. */
  panel: HTMLElement;
  /** The column being sized, read for its left edge and its current width. */
  list: HTMLElement;
  initialWidth: number;
  onResize: () => void;
  onCommit: (width: number) => void;
}): { setWidth: (width: number) => void } {
  let dragging = false;

  const currentWidth = (): number => options.list.getBoundingClientRect().width;

  const available = (): number => {
    const panel = options.panel.getBoundingClientRect();
    return panel.right - options.list.getBoundingClientRect().left;
  };

  /**
   * Writes the width, unless the panel cannot be measured.
   *
   * The Git tab is `display: none` whenever another strip tab is showing, and a hidden element has a
   * zero-sized box. Both halves of this guard are needed, and both are real failures rather than
   * theory:
   * - clamping a stored 460 against zero available room yields the **minimum**, so a dashboard that
   *   started on the Projets tab would have silently thrown away the width the user had chosen;
   * - the window `resize` listener re-applies `currentWidth()`, which reads zero while hidden, so a
   *   resize with the tab closed would have written a width of nothing at all.
   *
   * Doing nothing is correct here because the value is not lost: the CSS fallback covers the first
   * paint, and the caller re-applies the stored width when the tab is shown, which is the only moment
   * it can be honoured.
   */
  function apply(width: number): void {
    const room = available();
    if (room <= 0) {
      return;
    }
    options.panel.style.setProperty('--git-list-width', `${clampGitListWidth(width, room)}px`);
    options.onResize();
  }

  apply(options.initialWidth);

  options.handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    options.handle.setPointerCapture(event.pointerId);
    // Without this the drag selects the diff text it passes over.
    event.preventDefault();
  });

  options.handle.addEventListener('pointermove', (event) => {
    if (!dragging) {
      return;
    }
    const panel = options.panel.getBoundingClientRect();
    apply(
      resolveGitListWidth({
        pointerX: event.clientX,
        listLeft: options.list.getBoundingClientRect().left,
        panelRight: panel.right,
      }),
    );
  });

  const end = (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    dragging = false;
    if (options.handle.hasPointerCapture(event.pointerId)) {
      options.handle.releasePointerCapture(event.pointerId);
    }
    options.onCommit(currentWidth());
  };

  options.handle.addEventListener('pointerup', end);
  options.handle.addEventListener('pointercancel', end);

  // The arrow follows the separator: right widens the list and shrinks the diff.
  options.handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 60 : 20;
    if (event.key === 'ArrowRight') {
      apply(currentWidth() + step);
    } else if (event.key === 'ArrowLeft') {
      apply(currentWidth() - step);
    } else {
      return;
    }
    event.preventDefault();
    options.onCommit(currentWidth());
  });

  // Re-clamped on resize, so a narrowed window can never leave the diff column unusable.
  window.addEventListener('resize', () => apply(currentWidth()));

  return { setWidth: (width: number) => apply(width) };
}
