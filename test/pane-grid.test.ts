import { describe, expect, it } from 'vitest';
import { splitterLine, stripLine, viewLine } from '../src/renderer/ui/terminal-pane.js';

/**
 * A pane occupies two cells of the surface grid: its tab strip and its terminal view. Side by side
 * they share the two fixed rows and a pane is one column; stacked, a pane is two rows of a single
 * column. Getting a line wrong draws one pane on top of another, which reads as a pane that simply
 * failed to appear, so the arithmetic is pinned rather than eyeballed.
 */
describe('grid lines, side by side', () => {
  it('gives a pane one column, shared by its strip and its view', () => {
    expect(stripLine(0, true)).toBe(1);
    expect(viewLine(0, true)).toBe(1);
    expect(stripLine(1, true)).toBe(3);
    expect(viewLine(1, true)).toBe(3);
  });

  it('leaves the splitter its own column between two panes', () => {
    expect(splitterLine(0, true)).toBe(2);
    expect(splitterLine(1, true)).toBe(4);
  });

  it('never puts a splitter on a pane column', () => {
    for (let index = 0; index < 6; index += 1) {
      expect(splitterLine(index, true)).not.toBe(stripLine(index, true));
      expect(splitterLine(index, true)).not.toBe(stripLine(index + 1, true));
    }
  });
});

describe('grid lines, stacked', () => {
  it('gives a pane two rows, the strip above its view', () => {
    expect(stripLine(0, false)).toBe(1);
    expect(viewLine(0, false)).toBe(2);
    expect(stripLine(1, false)).toBe(4);
    expect(viewLine(1, false)).toBe(5);
  });

  it('puts the splitter on the row right after a pane', () => {
    expect(splitterLine(0, false)).toBe(3);
    expect(splitterLine(1, false)).toBe(6);
  });

  it('never overlaps two panes', () => {
    const used = new Set<number>();
    for (let index = 0; index < 6; index += 1) {
      for (const line of [stripLine(index, false), viewLine(index, false), splitterLine(index, false)]) {
        expect(used.has(line)).toBe(false);
        used.add(line);
      }
    }
  });
});
