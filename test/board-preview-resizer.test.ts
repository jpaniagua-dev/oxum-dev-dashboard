import { describe, expect, it } from 'vitest';
import {
  clampBoardPreviewWidth,
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
    expect(resolveBoardPreviewWidth({ ...pane, pointerX: 0 })).toBe(640);
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
