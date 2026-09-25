import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../src/shared/terminal-text.js';

/**
 * Stripping the escape sequences a pty puts around its text.
 *
 * The build parser reads program output through this, so what it must NOT eat matters as
 * much as what it removes.
 */
describe('stripAnsi', () => {
  it('leaves literal brackets alone', () => {
    // Anchored on the escape character. Without that anchor this would eat `[ERROR]`, destroying the
    // very markers the build parser exists to find.
    expect(stripAnsi('[ERROR] it broke')).toBe('[ERROR] it broke');
  });

  it('removes a window title sequence whole', () => {
    expect(stripAnsi('\u001b]0;a title\u0007after')).toBe('after');
  });

  it('removes colours without touching the text between them', () => {
    expect(stripAnsi('\u001b[1m\u001b[31mfail\u001b[0m: two')).toBe('fail: two');
  });
});
