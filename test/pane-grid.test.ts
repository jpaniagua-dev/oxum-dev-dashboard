import { describe, expect, it } from 'vitest';
import { PANE_COLUMNS_AUTO, PANE_COLUMNS_MAX } from '../src/shared/contracts.js';
import { paneGrid, panePlacement, sanitizeColumns } from '../src/shared/terminal-groups.js';
import {
  columnSplitterLine,
  paneColumnLine,
  rowSplitterLine,
  stripRowLine,
  viewRowLine,
} from '../src/renderer/ui/terminal-pane.js';

/**
 * A pane occupies two cells of the surface grid: its tab strip and the terminal view under it.
 *
 * The two axes have different track patterns, which is the whole reason this is pinned rather than
 * eyeballed. A column is one `fr` track plus its divider, so it repeats every 2 lines; a row is
 * `auto` for the strip, `fr` for the view and then its divider, so it repeats every 3. Getting a
 * line wrong draws one pane on top of another, which on screen is indistinguishable from a pane that
 * failed to open.
 */
describe('grid lines, the column axis', () => {
  it('puts each column two lines after the last', () => {
    expect(paneColumnLine(0)).toBe(1);
    expect(paneColumnLine(1)).toBe(3);
    expect(paneColumnLine(2)).toBe(5);
  });

  it('leaves the divider its own line between two columns', () => {
    expect(columnSplitterLine(0)).toBe(2);
    expect(columnSplitterLine(1)).toBe(4);
  });

  it('never puts a divider on a pane line', () => {
    for (let column = 0; column < 6; column += 1) {
      expect(columnSplitterLine(column)).not.toBe(paneColumnLine(column));
      expect(columnSplitterLine(column)).not.toBe(paneColumnLine(column + 1));
    }
  });
});

describe('grid lines, the row axis', () => {
  it('gives a row two lines, the strip above its view', () => {
    expect(stripRowLine(0)).toBe(1);
    expect(viewRowLine(0)).toBe(2);
    expect(stripRowLine(1)).toBe(4);
    expect(viewRowLine(1)).toBe(5);
  });

  it('puts the divider on the line right after a row', () => {
    expect(rowSplitterLine(0)).toBe(3);
    expect(rowSplitterLine(1)).toBe(6);
  });

  it('never overlaps two rows', () => {
    const used = new Set<number>();
    for (let row = 0; row < 6; row += 1) {
      for (const line of [stripRowLine(row), viewRowLine(row), rowSplitterLine(row)]) {
        expect(used.has(line)).toBe(false);
        used.add(line);
      }
    }
  });
});

/**
 * The shape itself: one stored number, and the rows derived from how many panes exist.
 *
 * The property that matters more than any single case is that **no pane is ever dropped**. A preset
 * fixing both axes has a maximum panel count and has to hide the rest; hiding a pane here would hide
 * a session, leaving a live process with no tab anywhere to reach or kill it.
 */
describe('paneGrid', () => {
  it('puts every pane on one row when the count is automatic', () => {
    expect(paneGrid(PANE_COLUMNS_AUTO, 1)).toEqual({ columns: 1, rows: 1 });
    expect(paneGrid(PANE_COLUMNS_AUTO, 4)).toEqual({ columns: 4, rows: 1 });
  });

  it('wraps onto as many rows as a fixed column count needs', () => {
    expect(paneGrid(2, 4)).toEqual({ columns: 2, rows: 2 });
    expect(paneGrid(2, 5)).toEqual({ columns: 2, rows: 3 });
    expect(paneGrid(3, 6)).toEqual({ columns: 3, rows: 2 });
  });

  it('never draws a column with no pane in it', () => {
    // Three columns holding two panes is two half-width cells, not two thirds and an empty third: an
    // empty cell is a rectangle with no gesture in it, and it reads as a pane that failed to open.
    expect(paneGrid(3, 2)).toEqual({ columns: 2, rows: 1 });
  });

  it('answers a single cell for an empty surface', () => {
    // A grid template with no tracks collapses the surface to nothing on the frame before the first
    // session lands.
    expect(paneGrid(PANE_COLUMNS_AUTO, 0)).toEqual({ columns: 1, rows: 1 });
    expect(paneGrid(2, 0)).toEqual({ columns: 1, rows: 1 });
  });

  it('fits every pane, whatever the shape', () => {
    for (const columns of [PANE_COLUMNS_AUTO, 1, 2, 3]) {
      for (let count = 1; count <= 9; count += 1) {
        const grid = paneGrid(columns, count);
        expect(grid.columns * grid.rows).toBeGreaterThanOrEqual(count);
      }
    }
  });
});

describe('panePlacement', () => {
  it('fills left to right, then top to bottom', () => {
    const grid = paneGrid(2, 4);
    expect(panePlacement(0, 4, grid)).toEqual({ row: 0, column: 0, span: 1 });
    expect(panePlacement(1, 4, grid)).toEqual({ row: 0, column: 1, span: 1 });
    expect(panePlacement(2, 4, grid)).toEqual({ row: 1, column: 0, span: 1 });
  });

  it('stretches the last pane across a short row', () => {
    // Five panes in three columns leaves the last row holding two. Without the stretch the fifth
    // pane draws at a third of the width with a hole beside it.
    const grid = paneGrid(3, 5);
    expect(panePlacement(3, 5, grid)).toEqual({ row: 1, column: 0, span: 1 });
    expect(panePlacement(4, 5, grid)).toEqual({ row: 1, column: 1, span: 2 });
  });

  it('leaves a full last row alone', () => {
    const grid = paneGrid(2, 4);
    expect(panePlacement(3, 4, grid)).toEqual({ row: 1, column: 1, span: 1 });
  });
});

describe('sanitizeColumns', () => {
  it('keeps the values the picker can produce', () => {
    expect(sanitizeColumns(PANE_COLUMNS_AUTO)).toBe(PANE_COLUMNS_AUTO);
    expect(sanitizeColumns(1)).toBe(1);
    expect(sanitizeColumns(PANE_COLUMNS_MAX)).toBe(PANE_COLUMNS_MAX);
  });

  it('falls back to the default rather than clamping to the nearest legal value', () => {
    // A hand-edited `7` read as `3` is a layout nobody asked for; read as the default it is at least
    // a shape the user recognises.
    expect(sanitizeColumns(7)).toBe(PANE_COLUMNS_AUTO);
    expect(sanitizeColumns(-2)).toBe(PANE_COLUMNS_AUTO);
    expect(sanitizeColumns(1.5)).toBe(PANE_COLUMNS_AUTO);
    expect(sanitizeColumns('2')).toBe(PANE_COLUMNS_AUTO);
    expect(sanitizeColumns(undefined)).toBe(PANE_COLUMNS_AUTO);
    expect(sanitizeColumns(null)).toBe(PANE_COLUMNS_AUTO);
  });
});
