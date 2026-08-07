import { UI_FONT_SIZE } from '@shared/contracts.js';

/**
 * The interface font size, applied to a page.
 *
 * One custom property on the root element, `--ui-font-size`, from which the seven steps of the type
 * ladder in `tokens.css` are computed as ratios. So this is the only line of TypeScript in the app that
 * knows anything about how big the text is: nothing reads a size back, and no component recomputes one.
 *
 * Shared by both renderers on purpose. The dashboard and the settings window are two pages of the same
 * application chrome, and a setting that resized one of them but not the other would be read as a bug —
 * especially this one, since the form that changes it is in the window that would not follow.
 */

/**
 * Clamps a size to what stays usable, the way the store does.
 *
 * Duplicated deliberately rather than trusted: the value arrives from a bootstrap that a
 * hot-reloaded renderer may have fetched from an older main process, and a `NaN` handed to
 * `setProperty` produces an invalid declaration that leaves every size at its fallback. Pure, so the
 * bounds are pinned by a test rather than by looking at the screen.
 */
export function clampUiFontSize(size: number): number {
  if (!Number.isFinite(size)) {
    return UI_FONT_SIZE.default;
  }
  return Math.min(Math.max(Math.round(size), UI_FONT_SIZE.min), UI_FONT_SIZE.max);
}

/** Writes the size on the root element, where every token reads it from. */
export function applyUiFontSize(size: number): void {
  document.documentElement.style.setProperty('--ui-font-size', `${clampUiFontSize(size)}px`);
}
