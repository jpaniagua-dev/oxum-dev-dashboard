import { BOARD_PREVIEW_RATIO, sanitizePreviewRatio } from '@shared/board-preview.js';

/** Narrowest width at which an interactive terminal remains useful. */
const MIN_TERMINAL_WIDTH = 280;
/**
 * Space always kept for the Cards canvas on the left: one 240px card and its margin.
 *
 * It was 360px while the sidebar was a fixed 420px. With the terminal taking most of the pane, the
 * canvas only has to show which card is open, and 360px would have held the share well below 80% on
 * any window under 1800px.
 */
const BOARD_RESERVE = 260;

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

/** The sidebar width for a share of the pane, clamped like a dragged one. */
export function previewWidthFor(ratio: number, available: number): number {
  return clampBoardPreviewWidth(sanitizePreviewRatio(ratio) * available, available);
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
 * The sidebar keeps a SHARE of the pane, not a width, so a window resized keeps the split it had.
 * A drag or an arrow key changes the share, and `onCommit` reports it once the gesture is over (the
 * pointer released, a key pressed) and never during the move: the share is a stored setting, and a
 * write per `pointermove` would be a settings save per pixel. Pointer capture keeps a fast drag alive
 * outside the narrow handle, while arrow keys make the separator fully operable without a pointer.
 */
export function attachBoardPreviewResizer(options: {
  handle: HTMLElement;
  pane: HTMLElement;
  initialRatio?: number;
  onResize: () => void;
  onCommit?: (ratio: number) => void;
}): { refresh: () => void } {
  let dragging = false;
  let ratio = sanitizePreviewRatio(options.initialRatio ?? BOARD_PREVIEW_RATIO.default);
  let width = 0;

  const available = (): number => options.pane.getBoundingClientRect().width;

  /** Lays the sidebar out at a width, and records the share it now is when asked to. */
  function apply(nextWidth: number, keepShare: boolean): void {
    const room = available();
    if (room <= 0) {
      return;
    }
    width = clampBoardPreviewWidth(nextWidth, room);
    if (!keepShare) {
      ratio = sanitizePreviewRatio(width / room);
    }
    options.pane.style.setProperty('--board-preview-width', `${width}px`);
    options.handle.setAttribute('aria-valuemin', String(MIN_TERMINAL_WIDTH));
    options.handle.setAttribute(
      'aria-valuemax',
      String(Math.max(MIN_TERMINAL_WIDTH, room - BOARD_RESERVE)),
    );
    options.handle.setAttribute('aria-valuenow', String(Math.round(width)));
    options.onResize();
  }

  // The share decides the width whenever the pane changes size; only a gesture changes the share.
  const follow = (): void => apply(previewWidthFor(ratio, available()), true);

  follow();

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
      false,
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
    options.onCommit?.(ratio);
  };

  options.handle.addEventListener('pointerup', end);
  options.handle.addEventListener('pointercancel', end);

  options.handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 60 : 20;
    // The arrow follows the separator: left grows the right-hand terminal, right shrinks it.
    if (event.key === 'ArrowLeft') {
      apply(width + step, false);
    } else if (event.key === 'ArrowRight') {
      apply(width - step, false);
    } else {
      return;
    }
    event.preventDefault();
    options.onCommit?.(ratio);
  });

  window.addEventListener('resize', follow);

  return { refresh: follow };
}
