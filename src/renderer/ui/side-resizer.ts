/** Narrowest useful notes panel: below this the list titles stop being readable. */
const MIN_WIDTH = 260;
/**
 * Always leave this much for the workspace, whatever the window width.
 *
 * The horizontal counterpart of `BOTTOM_RESERVE`: it turns "the terminal stays usable" from a hope
 * into a clamp, so the panel cannot be dragged until the terminal is a sliver.
 */
const WORKSPACE_RESERVE = 480;

export interface SidebarGeometry {
  /** Pointer position in viewport coordinates. */
  readonly pointerX: number;
  readonly viewportWidth: number;
}

/**
 * Width the notes panel should take for a pointer at `pointerX`.
 *
 * The panel is the pane on the **right**, so its width is the distance from the pointer to the right
 * edge: moving the pointer left makes it wider. That is the mirror image of `resolvePaneHeight`, whose
 * direction was got wrong once and is now pinned by a test. Same treatment here, before rather than
 * after.
 */
export function resolveSidebarWidth(geometry: SidebarGeometry): number {
  return clampSidebarWidth(geometry.viewportWidth - geometry.pointerX, geometry.viewportWidth);
}

/** Clamps a stored or stepped width against the same bounds, with no pointer involved. */
export function clampSidebarWidth(width: number, viewportWidth: number): number {
  const max = Math.max(MIN_WIDTH, viewportWidth - WORKSPACE_RESERVE);
  return Math.min(Math.max(width, MIN_WIDTH), max);
}

/**
 * Makes the notes panel horizontally resizable by dragging its separator.
 *
 * Same shape as `attachPaneResizer`, deliberately not a generalisation of it: that one hardcodes the
 * vertical axis in five places, and threading an axis through two three-line pure functions would put
 * a branch inside the only thing about them worth having, which is that they have no branches.
 */
export function attachSideResizer(options: {
  handle: HTMLElement;
  panel: HTMLElement;
  initialWidth: number;
  onResize: () => void;
  onCommit: (width: number) => void;
}): { setWidth: (width: number) => void } {
  let dragging = false;

  const currentWidth = (): number => options.panel.getBoundingClientRect().width;

  function apply(width: number): void {
    options.panel.style.width = `${clampSidebarWidth(width, window.innerWidth)}px`;
    options.onResize();
  }

  apply(options.initialWidth);

  options.handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    options.handle.setPointerCapture(event.pointerId);
    // Stops the drag from selecting text in the editor or the terminal it passes over.
    event.preventDefault();
  });

  options.handle.addEventListener('pointermove', (event) => {
    if (!dragging) {
      return;
    }
    apply(resolveSidebarWidth({ pointerX: event.clientX, viewportWidth: window.innerWidth }));
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

  // The arrow follows the separator, not the width: left widens the panel.
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

  // Re-clamp when the window shrinks, so the panel can never end up occluding the terminal.
  window.addEventListener('resize', () => apply(currentWidth()));

  return { setWidth: (width: number) => apply(width) };
}
