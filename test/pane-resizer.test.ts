import { describe, expect, it } from 'vitest';
import { clampPaneHeight, resolvePaneHeight } from '../src/renderer/ui/pane-resizer.js';

// A window of 1000px with the strip starting at 40px, just under the top bar.
const VIEWPORT = 1000;
const PANE_TOP = 40;

function heightAt(pointerY: number): number {
  return resolvePaneHeight({ pointerY, paneTop: PANE_TOP, viewportHeight: VIEWPORT });
}

describe('resolvePaneHeight', () => {
  it('makes the strip end where the pointer is', () => {
    expect(heightAt(340)).toBe(300);
  });

  it('shrinks the strip when the pointer moves UP', () => {
    // The whole point of this test. The first version measured from the bottom of the window, so
    // dragging up grew the strip and pushed the terminal down: the gesture felt inverted.
    expect(heightAt(300)).toBeLessThan(heightAt(400));
  });

  it('grows the strip when the pointer moves DOWN', () => {
    expect(heightAt(500)).toBeGreaterThan(heightAt(400));
  });

  it('never lets the strip swallow the terminal', () => {
    // 1000 - 40 - 220 = 740 of room at most.
    expect(heightAt(990)).toBe(740);
  });

  it('never collapses below a usable strip', () => {
    expect(heightAt(0)).toBe(120);
    expect(heightAt(-500)).toBe(120);
  });

  it('keeps the minimum even in a window too short for the reserve', () => {
    // A tiny window would otherwise produce a negative maximum and a zero-height strip.
    expect(resolvePaneHeight({ pointerY: 200, paneTop: 40, viewportHeight: 250 })).toBe(120);
  });
});

describe('clampPaneHeight', () => {
  it('passes a sane stored height through untouched', () => {
    expect(clampPaneHeight(280, PANE_TOP, VIEWPORT)).toBe(280);
  });

  it('pulls a height stored on a bigger screen back into the window', () => {
    expect(clampPaneHeight(2000, PANE_TOP, VIEWPORT)).toBe(740);
  });
});
