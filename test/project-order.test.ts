import { describe, expect, it } from 'vitest';
import type { ProjectConfig } from '../src/shared/contracts.js';
import { moveProject, sameProjectSet } from '../src/shared/project-order.js';

/** A configuration reduced to what an order cares about: an id, and something to prove it travelled. */
const config = (id: string): ProjectConfig => ({
  id,
  label: id.toUpperCase(),
  path: `C:\\repos\\${id}`,
  actions: [],
  kind: null,
  expectedPort: null,
  enabled: true,
  followPulls: true,
});

const list = (...ids: string[]): ProjectConfig[] => ids.map(config);
const ids = (configs: readonly ProjectConfig[]): string[] => configs.map((entry) => entry.id);

describe('moveProject', () => {
  it('inserts in front of the named neighbour', () => {
    expect(ids(moveProject(list('a', 'b', 'c'), 'c', 'a'))).toEqual(['c', 'a', 'b']);
  });

  it('appends when no neighbour is named', () => {
    expect(ids(moveProject(list('a', 'b', 'c'), 'a', null))).toEqual(['b', 'c', 'a']);
  });

  it('counts the position after the moved project is taken out', () => {
    /*
     * The off-by-one this function exists for. Moving `a` in front of `c` has to give `b, a, c`: index
     * 2 in the original list is where `c` sits, but once `a` is out that index is past `c`, and the
     * project would land last instead of in front of the row it was dropped on.
     */
    expect(ids(moveProject(list('a', 'b', 'c'), 'a', 'c'))).toEqual(['b', 'a', 'c']);
  });

  it('is a no-op when a project is dropped on itself', () => {
    expect(ids(moveProject(list('a', 'b', 'c'), 'b', 'b'))).toEqual(['a', 'b', 'c']);
  });

  it('ignores an unknown project rather than emptying the list', () => {
    expect(ids(moveProject(list('a', 'b'), 'ghost', 'a'))).toEqual(['a', 'b']);
  });

  it('appends when the neighbour is unknown', () => {
    // A drop target that has just been deleted elsewhere: last is a defensible answer, losing the
    // project is not.
    expect(ids(moveProject(list('a', 'b'), 'a', 'ghost'))).toEqual(['b', 'a']);
  });

  it('never loses, duplicates or alters a project', () => {
    const before = list('a', 'b', 'c', 'd');
    const after = moveProject(before, 'b', 'd');
    expect(ids(after).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(after).toHaveLength(before.length);
    // The whole configuration travels, not just the id: the table reorders projects, it does not
    // rebuild them.
    expect(after.find((entry) => entry.id === 'b')).toEqual(config('b'));
  });

  it('leaves the input untouched', () => {
    const before = list('a', 'b', 'c');
    moveProject(before, 'a', null);
    expect(ids(before)).toEqual(['a', 'b', 'c']);
  });

  it('handles a single project and an empty list', () => {
    expect(ids(moveProject(list('a'), 'a', null))).toEqual(['a']);
    expect(moveProject([], 'a', null)).toEqual([]);
  });
});

describe('sameProjectSet', () => {
  it('sees a permutation as the same set', () => {
    // This is what lets the monitors keep their state: reordering the table must not read as every
    // dev server having stopped.
    expect(sameProjectSet(list('a', 'b', 'c'), list('c', 'a', 'b'))).toBe(true);
  });

  it('rejects an addition and a removal', () => {
    expect(sameProjectSet(list('a', 'b'), list('a', 'b', 'c'))).toBe(false);
    expect(sameProjectSet(list('a', 'b'), list('a'))).toBe(false);
  });

  it('rejects a swap of the same size', () => {
    // Length alone would call this a permutation, and the state keyed on `b` would survive a project
    // that has left.
    expect(sameProjectSet(list('a', 'b'), list('a', 'c'))).toBe(false);
  });

  it('holds for two empty lists', () => {
    expect(sameProjectSet([], [])).toBe(true);
  });
});
