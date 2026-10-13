/**
 * How much of the terminal pane the Cards sidebar takes, as a share of its width.
 *
 * A share and not pixels, since 2026-10-13: the terminal is what is read once a card is open and the
 * canvas beside it only has to show which card that is, so the split is "most of it for the
 * terminal" at any window size. A fixed 420px was a third of a wide screen and most of a narrow one.
 * Shared because the renderer drags it and the settings store clamps it, and a hand-edited value has
 * to land in the same range either way.
 */
export const BOARD_PREVIEW_RATIO = { default: 0.8, min: 0.3, max: 0.9 } as const;

/** A stored share, clamped, or the default when it is not a number. */
export function sanitizePreviewRatio(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return BOARD_PREVIEW_RATIO.default;
  }
  return Math.min(Math.max(value, BOARD_PREVIEW_RATIO.min), BOARD_PREVIEW_RATIO.max);
}
