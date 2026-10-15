/** Narrowest useful detail panel: below this a file path and the commit form stop being usable. */
const MIN_DETAIL = 240;
/**
 * Room the graph always keeps.
 *
 * Same idea as `WORKSPACE_RESERVE` for the notes: the graph is what the tab is for, and its diffs
 * open in the same column, so "the centre stays usable" has to be a clamp rather than a hope.
 * Dragging the splitter to the left edge would otherwise leave a column too narrow for a subject.
 */
const CENTER_RESERVE = 320;

export interface GitSplitGeometry {
  /** Pointer position in viewport coordinates. */
  readonly pointerX: number;
  /** Left edge of the centre column, where the graph starts. */
  readonly centerLeft: number;
  /** Right edge of the detail panel, which is the right edge of the tab. */
  readonly panelRight: number;
}

/**
 * Width the detail panel should take for a pointer at `pointerX`.
 *
 * The detail panel is the pane on the **right** of this separator, so its width grows as the pointer
 * moves **left**: it is measured from the right edge. That is the direction this module had backwards
 * before 11.0.0 by construction (it sized the list on the left), and getting a resizer's direction
 * backwards has already happened once in this codebase, which is why all three of them are pure
 * functions with a test rather than arithmetic buried in a pointer handler.
 */
export function resolveGitDetailWidth(geometry: GitSplitGeometry): number {
  return clampGitDetailWidth(
    geometry.panelRight - geometry.pointerX,
    geometry.panelRight - geometry.centerLeft,
  );
}

/**
 * Clamps a stored or stepped width against the same bounds, with no pointer involved.
 *
 * `available` is everything the two columns share. When the window is too narrow to honour both
 * minimums, `MIN_DETAIL` wins: the commit form is where work gets written, and a centre squeezed
 * small still scrolls, while a form of nothing cannot be typed into.
 */
export function clampGitDetailWidth(width: number, available: number): number {
  const max = Math.max(MIN_DETAIL, available - CENTER_RESERVE);
  return Math.min(Math.max(width, MIN_DETAIL), max);
}

/**
 * Makes the boundary between the graph and the detail panel draggable.
 *
 * The width is written to a custom property rather than to the panel element: the columns are cells
 * of one grid, so their share is a property of the **grid**, and setting a width on a grid item
 * would fight the track sizing instead of driving it.
 */
export function attachGitSplitter(options: {
  handle: HTMLElement;
  /** The grid that owns the columns. */
  panel: HTMLElement;
  /** The centre column, read for its left edge. */
  center: HTMLElement;
  /** The detail panel being sized, read for its current width. */
  detail: HTMLElement;
  initialWidth: number;
  onCommit: (width: number) => void;
}): { setWidth: (width: number) => void } {
  let dragging = false;

  const currentWidth = (): number => options.detail.getBoundingClientRect().width;

  const available = (): number => {
    const panel = options.panel.getBoundingClientRect();
    return panel.right - options.center.getBoundingClientRect().left;
  };

  /**
   * Writes the width, unless the panel cannot be measured.
   *
   * The Git tab is `display: none` whenever another strip tab is showing, and a hidden element has a
   * zero-sized box. Both halves of this guard are real failures rather than theory:
   * - clamping a stored width against zero available room yields the **minimum**, so a dashboard that
   *   started on the Projects tab would have silently thrown away the width the user had chosen;
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
    options.panel.style.setProperty('--git-detail-width', `${clampGitDetailWidth(width, room)}px`);
  }

  apply(options.initialWidth);

  options.handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    options.handle.setPointerCapture(event.pointerId);
    // Without this the drag selects the text it passes over.
    event.preventDefault();
  });

  options.handle.addEventListener('pointermove', (event) => {
    if (!dragging) {
      return;
    }
    apply(
      resolveGitDetailWidth({
        pointerX: event.clientX,
        centerLeft: options.center.getBoundingClientRect().left,
        panelRight: options.panel.getBoundingClientRect().right,
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

  // The arrow follows the separator: left moves it left, which widens the panel on its right.
  options.handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 60 : 20;
    if (event.key === 'ArrowLeft') {
      apply(currentWidth() + step);
    } else if (event.key === 'ArrowRight') {
      apply(currentWidth() - step);
    } else {
      return;
    }
    event.preventDefault();
    options.onCommit(currentWidth());
  });

  // Re-clamped on resize, so a narrowed window can never leave the graph unusable.
  window.addEventListener('resize', () => apply(currentWidth()));

  return { setWidth: (width: number) => apply(width) };
}
