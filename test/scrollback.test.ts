import { describe, expect, it } from 'vitest';
import { Scrollback } from '../src/main/terminal/scrollback.js';

describe('Scrollback', () => {
  it('replays what it was given, in order', () => {
    const ring = new Scrollback(100);
    ring.push('one ');
    ring.push('two ');
    ring.push('three');
    expect(ring.text()).toBe('one two three');
  });

  it('ignores an empty chunk rather than storing it', () => {
    const ring = new Scrollback(100);
    ring.push('');
    ring.push('a');
    ring.push('');
    expect(ring.text()).toBe('a');
  });

  it('drops the oldest chunks once the character budget is exceeded', () => {
    const ring = new Scrollback(10);
    ring.push('aaaa');
    ring.push('bbbb');
    ring.push('cccc');
    // 12 characters for a budget of 10, so the first chunk goes and the rest stay whole.
    expect(ring.text()).toBe('bbbbcccc');
  });

  it('stays under the budget over a long run', () => {
    const ring = new Scrollback(1000);
    for (let i = 0; i < 5000; i += 1) {
      ring.push('0123456789');
    }
    expect(ring.text().length).toBeLessThanOrEqual(1000);
    expect(ring.text().length).toBeGreaterThan(900);
  });

  /**
   * Trimming keeps whole chunks, which is why the retained text can sit a little under the budget.
   * The alternative, cutting a chunk in half, can slice an ANSI escape sequence down the middle, and
   * xterm then paints a literal `[31m` at the top of the replayed tab.
   */
  it('never cuts a chunk in half', () => {
    const ring = new Scrollback(10);
    ring.push('aaaaaaa');
    ring.push('bbbbbbb');
    expect(ring.text()).toBe('bbbbbbb');
  });

  it('keeps a single chunk that is longer than the whole budget', () => {
    // Dropping it would leave a tab with no history at all after one long line, which reads as a
    // terminal that lost its output.
    const ring = new Scrollback(10);
    ring.push('a'.repeat(50));
    expect(ring.text()).toBe('a'.repeat(50));
  });

  it('forgets everything on clear, so a renderer restart does not replay cleared output', () => {
    const ring = new Scrollback(100);
    ring.push('gone');
    ring.clear();
    expect(ring.text()).toBe('');
    ring.push('kept');
    expect(ring.text()).toBe('kept');
  });

  /**
   * The reason the class exists. The previous shape was
   * `buffer = (buffer + chunk).slice(-LIMIT)`, which recopies the whole retained buffer per chunk:
   * measured at 168 ms for 3000 chunks of 400 bytes against 0.4 ms here. The bound is loose because
   * this is a wall-clock assertion on a shared machine; what it pins is the complexity class, and a
   * quadratic regression here would miss it by two orders of magnitude, not by a few percent.
   */
  it('appends in constant time rather than recopying what it holds', () => {
    const ring = new Scrollback(200_000);
    const chunk = 'x'.repeat(400);
    const started = performance.now();
    for (let i = 0; i < 3000; i += 1) {
      ring.push(chunk);
    }
    expect(performance.now() - started).toBeLessThan(50);
  });
});
