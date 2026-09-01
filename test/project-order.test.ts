import { describe, expect, it } from 'vitest';
import type { ProjectConfig } from '../src/shared/contracts.js';
import {
  hasAnyTag,
  moveProject,
  sameProjectSet,
  sortProjectsByTag,
} from '../src/shared/project-order.js';

/** A configuration reduced to what an order cares about: an id, and something to prove it travelled. */
const config = (id: string): ProjectConfig => ({
  id,
  label: id.toUpperCase(),
  path: `C:\\repos\\${id}`,
  actions: [],
  kind: null,
  expectedPort: null,
  tags: [],
  enabled: true,
  followPulls: true,
});

const list = (...ids: string[]): ProjectConfig[] => ids.map(config);
const ids = (configs: readonly ProjectConfig[]): string[] => configs.map((entry) => entry.id);

/** A project carrying tags, the first of which is its group. */
const tagged = (id: string, ...tags: string[]): ProjectConfig => ({ ...config(id), tags });

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

describe('sortProjectsByTag', () => {
  it('gathers the projects of one tag together, tags in alphabetical order', () => {
    const configs = [
      tagged('web', 'front'),
      tagged('ratings', 'backend'),
      tagged('admin', 'front'),
      tagged('gateway', 'backend'),
    ];
    expect(ids(sortProjectsByTag(configs))).toEqual(['ratings', 'gateway', 'web', 'admin']);
  });

  it('keeps the order a group already had', () => {
    // The load-bearing property: a group is arranged by drags, and reshuffling it on every click would
    // throw that arrangement away. `Array.prototype.sort` is stable, and this pins that reliance.
    const configs = [
      tagged('third', 'backend'),
      tagged('first', 'backend'),
      tagged('second', 'backend'),
    ];
    expect(ids(sortProjectsByTag(configs))).toEqual(['third', 'first', 'second']);
  });

  it('sends the untagged projects to the end', () => {
    const configs = [config('loose'), tagged('web', 'front'), config('other')];
    expect(ids(sortProjectsByTag(configs))).toEqual(['web', 'loose', 'other']);
  });

  it('groups on the FIRST tag, a project belonging to one group only', () => {
    // `dotnet` is on both, and it decides nothing: the group is the first chip, which the user orders.
    const configs = [tagged('web', 'front', 'dotnet'), tagged('ratings', 'backend', 'dotnet')];
    expect(ids(sortProjectsByTag(configs))).toEqual(['ratings', 'web']);
  });

  it('groups two spellings of one tag together', () => {
    const configs = [tagged('a', 'Backend'), tagged('b', 'front'), tagged('c', 'backend')];
    expect(ids(sortProjectsByTag(configs))).toEqual(['a', 'c', 'b']);
  });

  it('does not mutate the list it is given', () => {
    // `sort` sorts in place, so the copy is not decorative: the caller holds the stored configuration.
    const configs = [tagged('web', 'front'), tagged('ratings', 'backend')];
    sortProjectsByTag(configs);
    expect(ids(configs)).toEqual(['web', 'ratings']);
  });

  it('is a permutation, so the monitors keep their state', () => {
    // `sameProjectSet` is what tells a reorder from a change to the set, and what stops a running dev
    // server from being rebuilt as `stopped` by a grouping click.
    const configs = [tagged('web', 'front'), tagged('ratings', 'backend'), config('loose')];
    expect(sameProjectSet(configs, sortProjectsByTag(configs))).toBe(true);
  });
});

describe('hasAnyTag', () => {
  it('is false while nothing is tagged, which is when grouping cannot do anything', () => {
    expect(hasAnyTag(list('a', 'b'))).toBe(false);
    expect(hasAnyTag([config('a'), tagged('b', 'front')])).toBe(true);
  });
});
