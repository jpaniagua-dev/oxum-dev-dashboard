/** Smallest useful projects strip: below this the header and one row no longer fit. */
const MIN_HEIGHT = 120;
/** Always leave this much for the terminal below, whatever the window height. */
const BOTTOM_RESERVE = 220;

export interface PaneGeometry {
  /** Pointer position in viewport coordinates. */
  readonly pointerY: number;
  /** Top of the resized pane in viewport coordinates, i.e. just under the top bar. */
  readonly paneTop: number;
  readonly viewportHeight: number;
}

/**
 * Height the projects strip should take for a pointer at `pointerY`.
 *
 * The strip is the pane **above** the separator, so its height is the distance from its own top down
 * to the pointer. The first version measured from the bottom of the window instead
 * (`viewportHeight - pointerY`), which is the height of the pane *below*: dragging up then grew the
 * strip and pushed the terminal down, the exact opposite of the gesture. Kept pure and exported so
 * that direction is locked by a test rather than by eye.
 */
export function resolvePaneHeight(geometry: PaneGeometry): number {
  const available = geometry.viewportHeight - geometry.paneTop - BOTTOM_RESERVE;
  const max = Math.max(MIN_HEIGHT, available);
  return clamp(geometry.pointerY - geometry.paneTop, MIN_HEIGHT, max);
}

/** Clamps a stored or stepped height against the same bounds, with no pointer involved. */
export function clampPaneHeight(
  height: number,
  paneTop: number,
  viewportHeight: number,
): number {
  const max = Math.max(MIN_HEIGHT, viewportHeight - paneTop - BOTTOM_RESERVE);
  return clamp(height, MIN_HEIGHT, max);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Makes the projects strip vertically resizable by dragging the separator.
 *
 * Pointer events rather than mouse events: they capture correctly, so a fast drag that leaves the
 * strip does not detach mid-gesture. The height is reported only when the drag ends, which keeps the
 * settings file from being rewritten on every pixel.
 */
export function attachPaneResizer(options: {
  handle: HTMLElement;
  pane: HTMLElement;
  initialHeight: number;
  onResize: () => void;
  onCommit: (height: number) => void;
}): { setHeight: (height: number) => void } {
  let dragging = false;

  const paneTop = (): number => options.pane.getBoundingClientRect().top;
  const currentHeight = (): number => options.pane.getBoundingClientRect().height;

  function apply(height: number): void {
    options.pane.style.height = `${clampPaneHeight(height, paneTop(), window.innerHeight)}px`;
    options.onResize();
  }

  apply(options.initialHeight);

  options.handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    options.handle.setPointerCapture(event.pointerId);
    // Stops the drag from selecting text in the table it passes over.
    event.preventDefault();
  });

  options.handle.addEventListener('pointermove', (event) => {
    if (!dragging) {
      return;
    }
    // The separator follows the pointer: the strip ends where the pointer is.
    apply(
      resolvePaneHeight({
        pointerY: event.clientY,
        paneTop: paneTop(),
        viewportHeight: window.innerHeight,
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
    options.onCommit(currentHeight());
  };

  options.handle.addEventListener('pointerup', end);
  options.handle.addEventListener('pointercancel', end);

  // Keyboard support, since the separator is focusable and a drag is not always possible. Up moves the
  // separator up, which makes the strip shorter: the arrow follows the separator, not the height.
  options.handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 60 : 20;
    if (event.key === 'ArrowUp') {
      apply(currentHeight() - step);
    } else if (event.key === 'ArrowDown') {
      apply(currentHeight() + step);
    } else {
      return;
    }
    event.preventDefault();
    options.onCommit(currentHeight());
  });

  // Re-clamp when the window shrinks, so the strip cannot end up taller than the window.
  window.addEventListener('resize', () => apply(currentHeight()));

  // Handed back so switching strip tabs can apply that tab's own remembered height. Applying it from
  // outside would have to duplicate the clamping, which is exactly where a resizer goes wrong.
  return { setHeight: (height: number) => apply(height) };
}
