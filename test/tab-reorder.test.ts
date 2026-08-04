import { describe, expect, it } from 'vitest';
import { reorderIds } from '../src/renderer/ui/terminal-pane.js';

const ORDER = ['a', 'b', 'c', 'd'];

describe('reorderIds', () => {
  it('drops a tab before another', () => {
    expect(reorderIds(ORDER, 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('drops a tab after another', () => {
    expect(reorderIds(ORDER, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves a tab rightwards to the exact position aimed at', () => {
    // The arithmetic that is easy to get wrong: the moved id has to leave the list before the target
    // index is read, otherwise a rightwards move lands one position short.
    expect(reorderIds(ORDER, 'a', 'b', 'after')).toEqual(['b', 'a', 'c', 'd']);
  });

  it('moves a tab to the very end', () => {
    expect(reorderIds(ORDER, 'a', 'd', 'after')).toEqual(['b', 'c', 'd', 'a']);
  });

  it('moves a tab to the very start', () => {
    expect(reorderIds(ORDER, 'd', 'a', 'before')).toEqual(['d', 'a', 'b', 'c']);
  });

  it('changes nothing when a tab is dropped on itself', () => {
    expect(reorderIds(ORDER, 'b', 'b', 'before')).toEqual(ORDER);
    expect(reorderIds(ORDER, 'b', 'b', 'after')).toEqual(ORDER);
  });

  it('changes nothing when the target vanished mid-drag', () => {
    // A tab can be closed while another is being dragged over it.
    expect(reorderIds(ORDER, 'a', 'ghost', 'before')).toEqual(ORDER);
  });

  it('never loses or duplicates a tab', () => {
    for (const side of ['before', 'after'] as const) {
      for (const moved of ORDER) {
        for (const target of ORDER) {
          const result = reorderIds(ORDER, moved, target, side);
          expect([...result].sort()).toEqual([...ORDER].sort());
        }
      }
    }
  });
});
