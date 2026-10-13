import { describe, expect, it } from 'vitest';
import { BOARD_PREVIEW_RATIO, sanitizePreviewRatio } from '../src/shared/board-preview.js';
import {
  clampBoardPreviewWidth,
  previewWidthFor,
  resolveBoardPreviewWidth,
} from '../src/renderer/ui/board-preview-resizer.js';

describe('resolveBoardPreviewWidth', () => {
  const pane = { paneLeft: 100, paneRight: 1100 };

  it('makes the right terminal wider as the separator moves left', () => {
    const narrow = resolveBoardPreviewWidth({ ...pane, pointerX: 750 });
    const wide = resolveBoardPreviewWidth({ ...pane, pointerX: 500 });

    expect(narrow).toBe(350);
    expect(wide).toBe(600);
    expect(wide).toBeGreaterThan(narrow);
  });

  it('measures from the right pane edge instead of the window', () => {
    expect(resolveBoardPreviewWidth({ ...pane, pointerX: 700 })).toBe(400);
  });

  it('keeps both the terminal and the Cards canvas usable', () => {
    expect(resolveBoardPreviewWidth({ ...pane, pointerX: 5000 })).toBe(280);
    // One 240px card and its margin stay for the canvas.
    expect(resolveBoardPreviewWidth({ ...pane, pointerX: 0 })).toBe(740);
  });
});

describe('clampBoardPreviewWidth', () => {
  it('keeps a sane session width untouched', () => {
    expect(clampBoardPreviewWidth(420, 1000)).toBe(420);
  });

  it('gives the terminal priority when the window cannot satisfy both minimums', () => {
    expect(clampBoardPreviewWidth(420, 500)).toBe(280);
  });
});

describe('the sidebar as a share of the pane', () => {
  it('gives the terminal four fifths of the pane by default, at any width', () => {
    expect(previewWidthFor(BOARD_PREVIEW_RATIO.default, 2000)).toBe(1600);
    expect(previewWidthFor(BOARD_PREVIEW_RATIO.default, 1500)).toBe(1200);
  });

  it('gives way to the canvas reserve on a narrow pane rather than hide the cards', () => {
    expect(previewWidthFor(0.8, 1000)).toBe(740);
  });

  it('reads a stored share back inside its bounds, and the default for anything else', () => {
    expect(sanitizePreviewRatio(0.6)).toBe(0.6);
    expect(sanitizePreviewRatio(0.05)).toBe(BOARD_PREVIEW_RATIO.min);
    expect(sanitizePreviewRatio(1.5)).toBe(BOARD_PREVIEW_RATIO.max);
    expect(sanitizePreviewRatio('0.6')).toBe(BOARD_PREVIEW_RATIO.default);
    expect(sanitizePreviewRatio(Number.NaN)).toBe(BOARD_PREVIEW_RATIO.default);
  });
});
