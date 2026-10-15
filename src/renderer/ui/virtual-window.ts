/**
 * Which rows of a fixed-height list are worth building.
 *
 * The graph reads up to four hundred commits and the strip shows about seventeen. One element per row
 * plus an SVG each, rebuilt on every poll, is the freeze the diff's 4000-line cap already exists to
 * avoid, so only the rows in view (and a margin either side, so a scroll does not show empty space
 * before the next frame) are built. The list keeps its full height through a spacer, which is what
 * keeps the scrollbar honest.
 *
 * Pure so it can be tested: off-by-one is the whole risk of this function.
 */
export interface VisibleWindow {
  /** First row to build. */
  readonly start: number;
  /** One past the last row to build. */
  readonly end: number;
}

export function visibleWindow(
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  count: number,
  overscan: number,
): VisibleWindow {
  if (count <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0 };
  }
  const top = Math.max(0, scrollTop);
  const first = Math.floor(top / rowHeight);
  const last = Math.ceil((top + Math.max(0, viewport)) / rowHeight);
  const start = Math.min(count, Math.max(0, first - overscan));
  return { start, end: Math.max(start, Math.min(count, last + overscan)) };
}

/**
 * The scroll position that brings a row into view, or the current one when it already is.
 *
 * Used when a ref is clicked in the panel on the left: the graph scrolls to its commit, but only as
 * far as needed, so a row already on screen does not make the list jump under the pointer.
 */
export function scrollToReveal(
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  index: number,
): number {
  const rowTop = index * rowHeight;
  const rowBottom = rowTop + rowHeight;
  if (rowTop < scrollTop) {
    return rowTop;
  }
  if (rowBottom > scrollTop + viewport) {
    return Math.max(0, rowBottom - viewport);
  }
  return scrollTop;
}
