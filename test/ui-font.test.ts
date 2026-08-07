import { describe, expect, it } from 'vitest';
import { UI_FONT_SIZE } from '../src/shared/contracts.js';
import { clampUiFontSize } from '../src/renderer/ui/ui-font.js';

describe('clampUiFontSize', () => {
  it('keeps a size inside the bounds', () => {
    expect(clampUiFontSize(UI_FONT_SIZE.min)).toBe(UI_FONT_SIZE.min);
    expect(clampUiFontSize(14)).toBe(14);
    expect(clampUiFontSize(UI_FONT_SIZE.max)).toBe(UI_FONT_SIZE.max);
  });

  it('pulls an out-of-range size back to the nearest bound', () => {
    // The store clamps too, but a hot-reloaded renderer can read a bootstrap from an older main
    // process: the value arriving here is not guaranteed to have been through that clamp.
    expect(clampUiFontSize(2)).toBe(UI_FONT_SIZE.min);
    expect(clampUiFontSize(96)).toBe(UI_FONT_SIZE.max);
  });

  it('falls back to the default rather than handing a NaN to CSS', () => {
    /*
     * The failure mode worth a test: `setProperty('--ui-font-size', 'NaNpx')` is an invalid
     * declaration, so every token falls back to its own default and the whole interface silently
     * changes size for a reason nothing reports.
     */
    expect(clampUiFontSize(Number.NaN)).toBe(UI_FONT_SIZE.default);
    expect(clampUiFontSize(Number.POSITIVE_INFINITY)).toBe(UI_FONT_SIZE.default);
  });

  it('rounds, because a fractional base makes every step fractional', () => {
    expect(clampUiFontSize(13.4)).toBe(13);
    expect(clampUiFontSize(13.6)).toBe(14);
  });

  it('has bounds that keep the settings window readable', () => {
    // This size draws the form that changes it, so an unusable value must not be reachable from the
    // field itself. Pinned here so nobody widens the range without meeting that constraint.
    expect(UI_FONT_SIZE.min).toBeGreaterThanOrEqual(10);
    expect(UI_FONT_SIZE.max).toBeLessThanOrEqual(20);
    expect(UI_FONT_SIZE.default).toBeGreaterThanOrEqual(UI_FONT_SIZE.min);
    expect(UI_FONT_SIZE.default).toBeLessThanOrEqual(UI_FONT_SIZE.max);
  });
});
