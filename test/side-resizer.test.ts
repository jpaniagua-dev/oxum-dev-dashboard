import { describe, expect, it } from 'vitest';
import { clampSidebarWidth, resolveSidebarWidth } from '../src/renderer/ui/side-resizer.js';

describe('resolveSidebarWidth', () => {
  it('widens the panel when the pointer moves left', () => {
    /*
     * The direction test, and the reason this function is pure and exported. The panel is on the
     * right, so its width is measured from the pointer to the right edge. Measuring from the left edge
     * instead would make the panel shrink as the pointer is dragged towards it, which is the bug
     * `pane-resizer.ts` shipped once on the vertical axis.
     */
    const wide = resolveSidebarWidth({ pointerX: 1000, viewportWidth: 1600 });
    const narrow = resolveSidebarWidth({ pointerX: 1200, viewportWidth: 1600 });
    expect(wide).toBe(600);
    expect(narrow).toBe(400);
    expect(wide).toBeGreaterThan(narrow);
  });

  it('never lets the panel go below its minimum', () => {
    expect(resolveSidebarWidth({ pointerX: 1590, viewportWidth: 1600 })).toBe(260);
  });

  it('always leaves the workspace its reserve', () => {
    // Dragging to the far left must stop where the terminal still has 480 px.
    expect(resolveSidebarWidth({ pointerX: 0, viewportWidth: 1600 })).toBe(1120);
  });
});

describe('clampSidebarWidth', () => {
  it('keeps a sane stored width untouched', () => {
    expect(clampSidebarWidth(340, 1600)).toBe(340);
  });

  it('corrects a stored width that no longer fits a narrow window', () => {
    // A width saved on a wide screen, reopened on a laptop: the terminal keeps its reserve.
    expect(clampSidebarWidth(900, 1000)).toBe(520);
  });

  it('prefers the minimum width over the reserve on a very narrow window', () => {
    // Below the sum of both bounds something has to give; a panel too narrow to read would be worse
    // than a workspace slightly under its reserve, and the panel can always be closed.
    expect(clampSidebarWidth(400, 600)).toBe(260);
  });

  it('raises a width below the minimum', () => {
    expect(clampSidebarWidth(10, 1600)).toBe(260);
  });
});
