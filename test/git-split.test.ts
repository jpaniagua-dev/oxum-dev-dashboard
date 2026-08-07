import { describe, expect, it } from 'vitest';
import { clampGitListWidth, resolveGitListWidth } from '../src/renderer/ui/git-split.js';

/**
 * The direction of a resizer is the thing that gets written backwards, and this codebase has the scar:
 * `resolvePaneHeight` got it wrong once and `resolveSidebarWidth` was pinned pre-emptively for the same
 * reason. This one is the third axis — a column anchored to its **left** edge, so its width grows with
 * the pointer, which is the opposite of the notes panel next door.
 */
describe('resolveGitListWidth', () => {
  const panel = { listLeft: 200, panelRight: 1400 };

  it('grows as the pointer moves right', () => {
    const near = resolveGitListWidth({ ...panel, pointerX: 600 });
    const far = resolveGitListWidth({ ...panel, pointerX: 900 });

    expect(near).toBe(400);
    expect(far).toBe(700);
    expect(far).toBeGreaterThan(near);
  });

  it('measures from the column edge, not from the window', () => {
    // The column does not start at x=0: an implementation using `clientX` raw would be off by the
    // width of the repository column on every drag.
    expect(resolveGitListWidth({ ...panel, pointerX: 500 })).toBe(300);
  });

  it('never lets the diff column fall below its reserve', () => {
    // Dragged to the far right: 1200 available, 280 kept for the diff.
    expect(resolveGitListWidth({ ...panel, pointerX: 5000 })).toBe(920);
  });

  it('never lets the list collapse', () => {
    expect(resolveGitListWidth({ ...panel, pointerX: 0 })).toBe(240);
  });
});

describe('clampGitListWidth', () => {
  it('keeps a stored width inside the bounds', () => {
    expect(clampGitListWidth(460, 1200)).toBe(460);
    expect(clampGitListWidth(50, 1200)).toBe(240);
    expect(clampGitListWidth(5000, 1200)).toBe(920);
  });

  it('returns nonsense for zero available room, which is why the caller must not call it then', () => {
    /*
     * Documents the reason `apply` guards on `available() <= 0` instead of clamping anyway. A hidden
     * panel (`display: none`) measures zero, and clamping a perfectly good stored width against that
     * silently collapses it to the minimum — which is exactly how the Git tab lost the user's chosen
     * width whenever the dashboard started on another tab.
     */
    expect(clampGitListWidth(460, 0)).toBe(240);
  });

  it('gives the list priority when the window is too narrow for both minimums', () => {
    // 300 available cannot satisfy 240 + 280. The list wins: a diff column squeezed to nothing is
    // recoverable by dragging, a list squeezed to nothing leaves nothing to drag from.
    expect(clampGitListWidth(400, 300)).toBe(240);
  });
});
