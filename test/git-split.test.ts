import { describe, expect, it } from 'vitest';
import { clampGitDetailWidth, resolveGitDetailWidth } from '../src/renderer/ui/git-split.js';

/**
 * The direction of a resizer is the thing that gets written backwards, and this codebase has the scar:
 * `resolvePaneHeight` got it wrong once and `resolveSidebarWidth` was pinned pre-emptively for the same
 * reason. This one changed side in 11.0.0: it sized the list on the left, it now sizes the detail panel
 * anchored to the **right** edge, so its width grows as the pointer moves left.
 */
describe('resolveGitDetailWidth', () => {
  const panel = { centerLeft: 200, panelRight: 1400 };

  it('grows as the pointer moves left', () => {
    const near = resolveGitDetailWidth({ ...panel, pointerX: 1000 });
    const far = resolveGitDetailWidth({ ...panel, pointerX: 800 });

    expect(near).toBe(400);
    expect(far).toBe(600);
    expect(far).toBeGreaterThan(near);
  });

  it('measures from the right edge of the tab, not from the window', () => {
    // An implementation using `clientX` raw would answer 1100 here.
    expect(resolveGitDetailWidth({ ...panel, pointerX: 1100 })).toBe(300);
  });

  it('never lets the graph fall below its reserve', () => {
    // Dragged to the far left: 1200 available, 320 kept for the graph.
    expect(resolveGitDetailWidth({ ...panel, pointerX: -5000 })).toBe(880);
  });

  it('never lets the panel collapse', () => {
    expect(resolveGitDetailWidth({ ...panel, pointerX: 5000 })).toBe(240);
  });
});

describe('clampGitDetailWidth', () => {
  it('keeps a stored width inside the bounds', () => {
    expect(clampGitDetailWidth(320, 1200)).toBe(320);
    expect(clampGitDetailWidth(50, 1200)).toBe(240);
    expect(clampGitDetailWidth(5000, 1200)).toBe(880);
  });

  it('returns nonsense for zero available room, which is why the caller must not call it then', () => {
    /*
     * Documents the reason `apply` guards on `available() <= 0` instead of clamping anyway. A hidden
     * panel (`display: none`) measures zero, and clamping a perfectly good stored width against that
     * silently collapses it to the minimum, which is exactly how the Git tab once lost the user's
     * chosen width whenever the dashboard started on another tab.
     */
    expect(clampGitDetailWidth(320, 0)).toBe(240);
  });

  it('gives the panel priority when the window is too narrow for both minimums', () => {
    // 300 available cannot satisfy 240 + 320. The panel wins: the commit form is where work gets
    // typed, and a graph squeezed small still scrolls.
    expect(clampGitDetailWidth(400, 300)).toBe(240);
  });
});
