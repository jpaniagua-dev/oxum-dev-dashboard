/** Narrowest width at which an interactive terminal remains useful. */
const MIN_TERMINAL_WIDTH = 280;
/** Space always kept for the Cards canvas on the right. */
const BOARD_RESERVE = 360;

export const BOARD_PREVIEW_DEFAULT_WIDTH = 420;

export interface BoardPreviewGeometry {
  /** Pointer position in viewport coordinates. */
  readonly pointerX: number;
  /** Left and right edges of the complete terminal/board pane. */
  readonly paneLeft: number;
  readonly paneRight: number;
}

/** Clamps a requested terminal width while preserving a usable Cards canvas. */
export function clampBoardPreviewWidth(width: number, available: number): number {
  const max = Math.max(MIN_TERMINAL_WIDTH, available - BOARD_RESERVE);
  return Math.min(Math.max(width, MIN_TERMINAL_WIDTH), max);
}

/** Resolves the right sidebar width from a vertical separator following the pointer. */
export function resolveBoardPreviewWidth(geometry: BoardPreviewGeometry): number {
  return clampBoardPreviewWidth(
    geometry.paneRight - geometry.pointerX,
    geometry.paneRight - geometry.paneLeft,
  );
}

/**
 * Makes the live-terminal sidebar horizontally resizable.
 *
 * The chosen width is renderer-local, like board positions and board mode. Pointer capture keeps a
 * fast drag alive outside the narrow handle, while arrow keys make the separator fully operable
 * without a pointer.
 */
export function attachBoardPreviewResizer(options: {
  handle: HTMLElement;
  pane: HTMLElement;
  initialWidth?: number;
  onResize: () => void;
}): { refresh: () => void } {
  let dragging = false;
  let width = options.initialWidth ?? BOARD_PREVIEW_DEFAULT_WIDTH;

  const available = (): number => options.pane.getBoundingClientRect().width;

  function apply(nextWidth: number): void {
    const room = available();
    if (room <= 0) {
      return;
    }
    width = clampBoardPreviewWidth(nextWidth, room);
    options.pane.style.setProperty('--board-preview-width', `${width}px`);
    options.handle.setAttribute('aria-valuemin', String(MIN_TERMINAL_WIDTH));
    options.handle.setAttribute(
      'aria-valuemax',
      String(Math.max(MIN_TERMINAL_WIDTH, room - BOARD_RESERVE)),
    );
    options.handle.setAttribute('aria-valuenow', String(Math.round(width)));
    options.onResize();
  }

  apply(width);

  options.handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    options.handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  options.handle.addEventListener('pointermove', (event) => {
    if (!dragging) {
      return;
    }
    const pane = options.pane.getBoundingClientRect();
    apply(
      resolveBoardPreviewWidth({
        pointerX: event.clientX,
        paneLeft: pane.left,
        paneRight: pane.right,
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
  };

  options.handle.addEventListener('pointerup', end);
  options.handle.addEventListener('pointercancel', end);

  options.handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 60 : 20;
    // The arrow follows the separator: left grows the right-hand terminal, right shrinks it.
    if (event.key === 'ArrowLeft') {
      apply(width + step);
    } else if (event.key === 'ArrowRight') {
      apply(width - step);
    } else {
      return;
    }
    event.preventDefault();
  });

  window.addEventListener('resize', () => apply(width));

  return { refresh: () => apply(width) };
}
